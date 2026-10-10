import { redisService, type RedisKeyContent, type RedisServiceStatus } from "./redisService";

/**
 * 管理端「Redis 在库数据浏览」的编排层（只读）。
 *
 * 分两层职责：
 *   - `redisService` 提供有界的只读原语（SCAN / TYPE / PTTL / 有界内容读取）；
 *   - 本服务负责命名空间范围、分页、参数钳制与错误语义。
 *
 * 生产 Redis 常常是与其它 1Panel 应用共享的实例（见 `deploy/openresty/backup-redis.sh`），
 * 所以「当前服务的数据」默认按**整个当前 DB** 理解，并允许用 `ADMIN_REDIS_KEY_PREFIXES`
 * 收窄到本服务的命名空间；收窄后范围外的键既列不出也读不到（fail-closed，不是过滤提示）。
 *
 * 本文件不写日志、不回显值：查看明文属敏感操作，留痕由路由层显式写审计
 * （`routes/admin/system.ts` 的 `auditRedisAdmin`，只记键名与规模），
 * 且刻意不把键名或值写进日志/错误文案。
 */

const MAX_KEY_LENGTH = 512;
const MAX_FILTER_LENGTH = 200;
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;
const MIN_SCAN_COUNT = 50;
const MAX_SCAN_COUNT = 500;
/** 单次请求最多推进多少次 SCAN 迭代：防止「翻一页」在稀疏匹配下变成全库遍历。 */
const MAX_SCAN_ITERATIONS = 20;

/** 快照导出：键数上限与 SCAN 迭代上限（导出允许跑得久，但仍必须有界）。 */
const DEFAULT_EXPORT_MAX_KEYS = 50_000;
const MAX_EXPORT_MAX_KEYS = 500_000;
const EXPORT_SCAN_COUNT = 1_000;
const MAX_EXPORT_SCAN_ITERATIONS = 100_000;

export interface RedisAdminScope {
  /** true = 只允许 `prefixes` 里的命名空间；false = 整个当前 DB。 */
  restricted: boolean;
  prefixes: string[];
  /** 范围来源：env（显式收窄）或 all（未配置，看整个 DB）。 */
  source: "env" | "all";
}

/** 读取 `ADMIN_REDIS_KEY_PREFIXES`（逗号分隔）。空/未配置 = 看整个当前 DB。 */
export function getRedisAdminScope(): RedisAdminScope {
  const raw = (process.env.ADMIN_REDIS_KEY_PREFIXES || "").trim();
  if (!raw) return { restricted: false, prefixes: [], source: "all" };
  const prefixes = [...new Set(raw.split(",").map((entry) => entry.trim()).filter(Boolean))];
  if (prefixes.length === 0) return { restricted: false, prefixes: [], source: "all" };
  return { restricted: true, prefixes, source: "env" };
}

/** 键是否落在当前允许范围内。未收窄时一律放行。 */
export function isRedisKeyInAdminScope(key: string, scope: RedisAdminScope = getRedisAdminScope()): boolean {
  if (!scope.restricted) return true;
  return scope.prefixes.some((prefix) => key.startsWith(prefix));
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

/**
 * 过滤串只做子串匹配：剥掉 glob 元字符，避免运维输入 `*` / `[...]` 变成
 * 「一次请求把整库拉进内存」的放大操作。
 */
function sanitizeFilter(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[*?[\]\\]/g, "").trim().slice(0, MAX_FILTER_LENGTH);
}

export interface RedisAdminOverview {
  status: RedisServiceStatus;
  dbsize: number | null;
  usedMemoryBytes: number | null;
  scope: RedisAdminScope;
  maxPageLimit: number;
  defaultPageLimit: number;
}

/** 连接状态、体量、当前命名空间范围。 */
export async function getRedisAdminOverview(): Promise<RedisAdminOverview> {
  const status = redisService.getStatus();
  const stats = await redisService.getServerStats();
  return {
    status,
    dbsize: stats.dbsize,
    usedMemoryBytes: stats.usedMemoryBytes,
    scope: getRedisAdminScope(),
    maxPageLimit: MAX_PAGE_LIMIT,
    defaultPageLimit: DEFAULT_PAGE_LIMIT,
  };
}

export interface RedisAdminKeySummary {
  key: string;
  /** 读取元信息失败/键正好过期时为 "unknown"。 */
  type: string;
  ttlMs: number;
}

export type RedisAdminKeysResult =
  | {
      ok: true;
      cursor: string;
      done: boolean;
      keys: RedisAdminKeySummary[];
      /** 本次实际扫描到的键数（含范围外）。 */
      scanned: number;
      /** 范围内但未被列出的键数（仅在收窄范围时可能非 0）。 */
      outOfScope: number;
      match: string;
      hasFilter: boolean;
      namespace: string | null;
      scope: RedisAdminScope;
    }
  | { ok: false; code: "REDIS_UNAVAILABLE" | "REDIS_NAMESPACE_NOT_ALLOWED"; error: string };

/**
 * SCAN 分页列出当前服务在库的键。
 *
 * 为什么不用 KEYS：`KEYS` 是 O(N) 阻塞命令，管理面板误触一次就会卡住整个共享 Redis。
 * 这里每请求最多推进 `MAX_SCAN_ITERATIONS` 次 SCAN，且默认页大小 50、上限 200。
 */
export async function scanRedisAdminKeys(params: {
  cursor?: unknown;
  namespace?: unknown;
  filter?: unknown;
  limit?: unknown;
}): Promise<RedisAdminKeysResult> {
  const scope = getRedisAdminScope();
  const limit = clampInt(params.limit, 1, MAX_PAGE_LIMIT, DEFAULT_PAGE_LIMIT);
  const cursor = typeof params.cursor === "string" ? params.cursor.trim() || "0" : "0";
  const filter = sanitizeFilter(params.filter);

  let namespace: string | null = null;
  let match: string;
  if (scope.restricted) {
    const requested = typeof params.namespace === "string" ? params.namespace.trim() : "";
    namespace = requested || scope.prefixes[0];
    if (!scope.prefixes.includes(namespace)) {
      return { ok: false, code: "REDIS_NAMESPACE_NOT_ALLOWED", error: "命名空间不在允许范围内" };
    }
    match = filter ? `${namespace}*${filter}*` : `${namespace}*`;
  } else {
    match = filter ? `*${filter}*` : "*";
  }

  const scanCount = Math.min(Math.max(limit * 4, MIN_SCAN_COUNT), MAX_SCAN_COUNT);
  const keys: string[] = [];
  let scanned = 0;
  let outOfScope = 0;
  let nextCursor = cursor;

  for (let iteration = 0; iteration < MAX_SCAN_ITERATIONS; iteration += 1) {
    const page = await redisService.scanKeysPage(nextCursor, match, scanCount);
    if (!page) {
      return { ok: false, code: "REDIS_UNAVAILABLE", error: "Redis 暂不可用，无法读取在库数据" };
    }
    scanned += page.keys.length;
    for (const key of page.keys) {
      if (!isRedisKeyInAdminScope(key, scope)) {
        outOfScope += 1;
        continue;
      }
      keys.push(key);
      if (keys.length >= limit) break;
    }
    nextCursor = page.cursor;
    if (keys.length >= limit || nextCursor === "0") break;
  }

  const summaries = await Promise.all(
    keys.map(async (key): Promise<RedisAdminKeySummary> => {
      const meta = await redisService.readKeyMeta(key);
      return { key, type: meta?.type ?? "unknown", ttlMs: meta?.ttlMs ?? -1 };
    }),
  );

  return {
    ok: true,
    cursor: nextCursor,
    done: nextCursor === "0",
    keys: summaries,
    scanned,
    outOfScope,
    match,
    hasFilter: filter.length > 0,
    namespace,
    scope,
  };
}

export type RedisAdminKeyResult =
  | { ok: true; key: string; scope: RedisAdminScope; content: RedisKeyContent }
  | {
      ok: false;
      code: "REDIS_UNAVAILABLE" | "REDIS_KEY_NOT_FOUND" | "REDIS_KEY_OUT_OF_SCOPE" | "INVALID_KEY";
      error: string;
    };

/** 读取单键的类型、TTL 与有界明文内容。 */
export async function readRedisAdminKey(
  key: unknown,
  limits: { maxValueChars?: unknown; maxEntries?: unknown } = {},
): Promise<RedisAdminKeyResult> {
  const normalized = typeof key === "string" ? key.trim() : "";
  if (!normalized || normalized.length > MAX_KEY_LENGTH) {
    return { ok: false, code: "INVALID_KEY", error: "键名无效（空或超长）" };
  }

  const scope = getRedisAdminScope();
  if (!isRedisKeyInAdminScope(normalized, scope)) {
    return { ok: false, code: "REDIS_KEY_OUT_OF_SCOPE", error: "该键不在当前服务允许浏览的命名空间内" };
  }

  const content = await redisService.readKeyContent(normalized, {
    maxValueChars: clampInt(limits.maxValueChars, 1, 20_000, 4_000),
    maxEntries: clampInt(limits.maxEntries, 1, 1_000, 200),
  });
  if (!content) {
    return { ok: false, code: "REDIS_UNAVAILABLE", error: "Redis 暂不可用，无法读取该键" };
  }
  if (content.type === "none") {
    return { ok: false, code: "REDIS_KEY_NOT_FOUND", error: "该键已不存在（可能刚过期）" };
  }

  return { ok: true, key: normalized, scope, content };
}

/**
 * 快照导出记录（NDJSON：一行一条，可边生成边下发）。
 *
 * `dumpBase64` 是 `DUMP` 的原始序列化内容（与 RDB 单键编码一致），字节精确、可直接 `RESTORE`；
 * 之所以要 DUMP 而不是逐条读值再拼：后者会丢失编码/数据类型细节（如 ziplist/intset、
 * 带 TTL 的复合类型），恢复出来不是同一个键。
 */
export type RedisSnapshotRecord =
  | {
      kind: "meta";
      version: 1;
      exportedAt: string;
      scope: RedisAdminScope;
      matches: string[];
      /** 逐键在扫描到的那一刻读取，不是跨键一致的时点快照（与 RDB 的差别，显式声明）。 */
      consistency: "per-key-read";
      encoding: "dump-base64";
      maxKeys: number;
    }
  | { kind: "key"; key: string; ttlMs: number; dumpBase64: string }
  | { kind: "skip"; key: string; reason: "dump-failed" | "binary-unsafe" }
  | {
      kind: "error";
      code: "REDIS_UNAVAILABLE" | "REDIS_NAMESPACE_NOT_ALLOWED" | "DUMP_UNSUPPORTED";
      error: string;
    }
  | {
      kind: "summary";
      exported: number;
      skipped: number;
      scanned: number;
      outOfScope: number;
      truncated: boolean;
      durationMs: number;
    };

/**
 * 流式导出当前服务在库快照（`DUMP` + `PTTL`，NDJSON）。
 *
 * 刻意不实现 `--rdb`：真正的 RDB 文件在 Redis 服务器的数据目录里（本仓生产是 1Panel 的共享
 * Redis 容器），应用进程既看不到那个目录，node-redis 也不支持 PSYNC 拉流；
 * 硬做只能得到一份假的“rdb”。宿主机侧已有真备份：`deploy/openresty/backup-redis.sh`（BGSAVE → 归档 + 真空加载校验）。
 */
export async function* exportRedisAdminSnapshot(params: {
  namespace?: unknown;
  filter?: unknown;
  maxKeys?: unknown;
}): AsyncGenerator<RedisSnapshotRecord, void, void> {
  const startedAt = Date.now();
  const scope = getRedisAdminScope();
  const filter = sanitizeFilter(params.filter);
  const maxKeys = clampInt(params.maxKeys, 1, MAX_EXPORT_MAX_KEYS, DEFAULT_EXPORT_MAX_KEYS);

  const namespaces: Array<string | null> = [];
  if (scope.restricted) {
    const requested = typeof params.namespace === "string" ? params.namespace.trim() : "";
    if (requested) {
      if (!scope.prefixes.includes(requested)) {
        yield { kind: "error", code: "REDIS_NAMESPACE_NOT_ALLOWED", error: "命名空间不在允许范围内" };
        return;
      }
      namespaces.push(requested);
    } else {
      namespaces.push(...scope.prefixes);
    }
  } else {
    namespaces.push(null);
  }

  const matches = namespaces.map((namespace) => {
    if (!namespace) return filter ? `*${filter}*` : "*";
    return filter ? `${namespace}*${filter}*` : `${namespace}*`;
  });

  yield {
    kind: "meta",
    version: 1,
    exportedAt: new Date().toISOString(),
    scope,
    matches,
    consistency: "per-key-read",
    encoding: "dump-base64",
    maxKeys,
  };

  let exported = 0;
  let skipped = 0;
  let scanned = 0;
  let outOfScope = 0;
  let truncated = false;
  let dumpFailures = 0;
  let iterations = 0;

  for (const match of matches) {
    let cursor = "0";
    for (;;) {
      if (iterations >= MAX_EXPORT_SCAN_ITERATIONS) {
        truncated = true;
        break;
      }
      iterations += 1;

      const page = await redisService.scanKeysPage(cursor, match, EXPORT_SCAN_COUNT);
      if (!page) {
        yield { kind: "error", code: "REDIS_UNAVAILABLE", error: "Redis 暂不可用，导出中止" };
        return;
      }
      scanned += page.keys.length;

      for (const key of page.keys) {
        if (!isRedisKeyInAdminScope(key, scope)) {
          outOfScope += 1;
          continue;
        }
        if (exported >= maxKeys) break;

        const dumped = await redisService.dumpKeyForExport(key);
        if (dumped.ok) {
          yield { kind: "key", key, ttlMs: dumped.ttlMs, dumpBase64: dumped.dumpBase64 };
          exported += 1;
          continue;
        }

        if (dumped.reason === "unavailable") {
          yield { kind: "error", code: "REDIS_UNAVAILABLE", error: "Redis 暂不可用，导出中止" };
          return;
        }
        if (dumped.reason === "missing") {
          // 扫描到读取之间过期是正常抖动，不计失败也不出 skip 行（避免刷屏）。
          skipped += 1;
          continue;
        }

        skipped += 1;
        dumpFailures += 1;
        if (dumpFailures >= 5 && exported === 0) {
          yield { kind: "error", code: "DUMP_UNSUPPORTED", error: "DUMP 不可用（可能被服务端禁用），无法生成快照" };
          return;
        }
        yield { kind: "skip", key, reason: dumped.reason === "binary-unsafe" ? "binary-unsafe" : "dump-failed" };
      }

      if (exported >= maxKeys) {
        truncated = true;
        break;
      }
      cursor = page.cursor;
      if (cursor === "0") break;
    }

    if (truncated) break;
  }

  yield {
    kind: "summary",
    exported,
    skipped,
    scanned,
    outOfScope,
    truncated,
    durationMs: Date.now() - startedAt,
  };
}
