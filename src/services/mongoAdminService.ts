import { mongoose } from "./mongoService";
import { sanitizeForExport } from "../utils/credentialRedaction";
import logger from "../utils/logger";

/**
 * 管理端 MongoDB 在库数据浏览器（`/api/admin/system/mongo/*`）。
 *
 * 与 Redis 浏览器（`redisAdminService`）同一套安全模型：只读、超管 + 安全会话、
 * 逐请求写审计且**只记集合名与规模，不记文档内容**。
 *
 * 与 Redis 的差别：
 * - Mongo 里的文档大多是用户 PII，所以服务端**先脱敏再下发**：密码材料、令牌、密钥、
 *   密文与内部存储键一律替换为 `[redacted]`，二进制正文只报大小。前端拿不到原文，
 *   因此不需要像 Redis 那样在会话失效时清空「已拉到的明文」（照样会清，作为第二道防线）。
 * - 列表用「页码 + 每页条数」，并有硬上限：`skip` 在深页是 O(n)，不设上限会把一次浏览
 *   变成全表扫描。超过上限时提示改用过滤条件。
 * - 过滤器是受限的 JSON 查询：只接受普通对象，拒绝 `$where` / `$function` / `$accumulator`
 *   这类可在服务端执行脚本的操作符。
 */

/** 分页与导出的硬上限。 */
export const MONGO_ADMIN_MAX_PAGE_SIZE = 100;
export const MONGO_ADMIN_MAX_PAGE = 200;
export const MONGO_ADMIN_MAX_FILTER_LENGTH = 4000;
export const MONGO_ADMIN_MAX_EXPORT_DOCS = 20000;
export const MONGO_ADMIN_DEFAULT_PAGE_SIZE = 25;

/** 不允许在服务端执行脚本的查询操作符。 */
const FORBIDDEN_OPERATORS = new Set(["$where", "$function", "$accumulator"]);

export interface MongoAdminCollectionSummary {
  name: string;
  type: string;
  /** 估算文档数（`estimatedDocumentCount`，元数据级，不扫表）。读取失败为 null。 */
  estimatedCount: number | null;
  /** 集合选项里的 capped / validator 是否存在等元信息。 */
  capped?: boolean;
  hasValidator?: boolean;
}

export interface MongoAdminOverview {
  connected: boolean;
  database: string | null;
  collections: number;
  estimatedDocuments: number | null;
  dataSizeBytes: number | null;
  indexSizeBytes: number | null;
  serverVersion: string | null;
  maxPageSize: number;
  maxPage: number;
  maxExportDocs: number;
}

export interface MongoAdminDocumentPage {
  collection: string;
  page: number;
  pageSize: number;
  /** 精确匹配数；查询超时或集合过大时为 null（前端回退到估算数）。 */
  total: number | null;
  estimatedTotal: number | null;
  documents: unknown[];
  hasMore: boolean;
  sort: { field: string; order: "asc" | "desc" };
  /** 本次响应是否做了凭据脱敏（默认 false：安全会话下按原样查看）。 */
  redacted: boolean;
}

export type MongoAdminResult<T> =
  | ({ ok: true } & T)
  | { ok: false; code: string; error: string };

function db() {
  const connection = mongoose.connection.db;
  if (!connection) throw new Error("数据库连接不可用");
  return connection;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

export function assertSafeFilter(filter: Record<string, unknown>, depth = 0): string | null {
  if (depth > 8) return "过滤条件嵌套过深";
  for (const [key, value] of Object.entries(filter)) {
    if (FORBIDDEN_OPERATORS.has(key)) return `过滤条件不允许使用 ${key}`;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isPlainObject(item)) {
          const nested = assertSafeFilter(item, depth + 1);
          if (nested) return nested;
        }
      }
      continue;
    }
    if (isPlainObject(value)) {
      const nested = assertSafeFilter(value, depth + 1);
      if (nested) return nested;
    }
  }
  return null;
}

/** 解析过滤器：空串 = 不加条件；非法 JSON / 非对象 / 危险操作符一律拒绝。 */
export function parseMongoAdminFilter(raw: unknown): { ok: true; filter: Record<string, unknown> } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, filter: {} };
  if (typeof raw !== "string") return { ok: false, error: "过滤条件必须是 JSON 字符串" };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true, filter: {} };
  if (trimmed.length > MONGO_ADMIN_MAX_FILTER_LENGTH) {
    return { ok: false, error: `过滤条件不能超过 ${MONGO_ADMIN_MAX_FILTER_LENGTH} 个字符` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: "过滤条件不是合法 JSON" };
  }
  if (!isPlainObject(parsed)) return { ok: false, error: "过滤条件必须是 JSON 对象" };
  const unsafe = assertSafeFilter(parsed);
  if (unsafe) return { ok: false, error: unsafe };
  return { ok: true, filter: parsed };
}

/** 排序字段只允许字母数字、下划线与点（不支持表达式）。 */
const SORT_FIELD_PATTERN = /^[A-Za-z0-9_.]{1,64}$/;

function parseSort(field: unknown, order: unknown): { field: string; order: "asc" | "desc" } {
  const safeField = typeof field === "string" && SORT_FIELD_PATTERN.test(field) ? field : "_id";
  return { field: safeField, order: order === "asc" ? "asc" : "desc" };
}

function parsePositiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

/**
 * BSON → 可序列化的普通值。
 *
 * 必须在 `sanitizeForExport` 之前做：它只认识 Date / ObjectId / Buffer，
 * Long / Decimal128 / BSONRegExp / Timestamp 需要先转成字符串或数字，
 * 否则 `JSON.stringify` 会得到 `{"$numberLong":...}` 这类形状（前端难以阅读）。
 */
export function normalizeMongoValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (depth > 12) return "[max-depth]";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { redacted: true, type: "binary", bytes: (value as Uint8Array).byteLength };
  }
  if (Array.isArray(value)) return value.map((item) => normalizeMongoValue(item, depth + 1));

  const candidate = value as {
    _bsontype?: string;
    toHexString?: () => string;
    toString?: () => string;
    toNumber?: () => number;
  } & Record<string, unknown>;

  // ObjectId 的 `toHexString` 是实例方法；有些驱动版本/替身不带 `_bsontype`，
  // 只要方法在就按十六进制处理，避免把函数本身序列化进 JSON。
  if (typeof candidate._bsontype !== "string" && typeof candidate.toHexString === "function") {
    try {
      return candidate.toHexString();
    } catch {
      return String(value);
    }
  }

  switch (candidate._bsontype) {
    case "ObjectId":
      return typeof candidate.toHexString === "function" ? candidate.toHexString() : String(value);
    case "Long": {
      const numeric = typeof candidate.toNumber === "function" ? candidate.toNumber() : Number.NaN;
      return Number.isSafeInteger(numeric) ? numeric : String(value);
    }
    case "Decimal128":
    case "BSONRegExp":
    case "Timestamp":
    case "MinKey":
    case "MaxKey":
      return typeof candidate.toString === "function" ? candidate.toString() : String(value);
    case "Binary":
      return { redacted: true, type: "binary" };
    default:
      break;
  }

  if (isPlainObject(value) || typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(candidate)) {
      result[key] = normalizeMongoValue(entry, depth + 1);
    }
    return result;
  }
  return String(value);
}

/** 文档级脱敏：先归一 BSON 类型，再套用账户导出同一套凭据脱敏规则。 */
export function sanitizeMongoDocument(document: unknown): unknown {
  return sanitizeForExport(normalizeMongoValue(document));
}

/**
 * 浏览用文档输出：`redact` 为真时脱敏，为假时只做 BSON → JSON 归一。
 *
 * 不脱敏只允许在**已通过超管 + 安全会话**的请求里发生（两个条件都由路由层强制），
 * 即「管理员当场完成了一次身份验证」。即便不脱敏，二进制正文仍然只报大小：
 * 那不是凭据，而是无法在 JSON 里安全承载的内容。
 */
export function presentMongoDocument(document: unknown, redact: boolean): unknown {
  return redact ? sanitizeMongoDocument(document) : normalizeMongoValue(document);
}

export async function getMongoAdminOverview(): Promise<MongoAdminOverview> {
  const connection = mongoose.connection;
  const database = connection.db;
  if (!database) {
    return {
      connected: false,
      database: null,
      collections: 0,
      estimatedDocuments: null,
      dataSizeBytes: null,
      indexSizeBytes: null,
      serverVersion: null,
      maxPageSize: MONGO_ADMIN_MAX_PAGE_SIZE,
      maxPage: MONGO_ADMIN_MAX_PAGE,
      maxExportDocs: MONGO_ADMIN_MAX_EXPORT_DOCS,
    };
  }

  let stats: { dataSize?: number; indexSize?: number; collections?: number } | null = null;
  try {
    // 超时写进命令文档而不是第二个参数：驱动里 `CommandOperationOptions` 只认 `timeoutMS`，
    // 而服务端本身接受命令文档里的 `maxTimeMS`。
    stats = await database.command({ dbStats: 1, scale: 1, maxTimeMS: 5000 });
  } catch (error) {
    logger.warn("[MongoAdmin] dbStats 读取失败", { error: (error as Error)?.message });
  }

  let serverVersion: string | null = null;
  try {
    const build = await database.command({ buildInfo: 1, maxTimeMS: 3000 });
    serverVersion = typeof build?.version === "string" ? build.version : null;
  } catch {
    // 权限不足时 buildInfo 可能被拒绝：不影响浏览。
  }

  const collections = await listMongoAdminCollections();
  const estimatedDocuments = collections.reduce<number | null>((sum, item) => {
    if (item.estimatedCount === null) return sum;
    return (sum ?? 0) + item.estimatedCount;
  }, 0);

  return {
    connected: true,
    database: connection.name ?? null,
    collections: collections.length,
    estimatedDocuments,
    dataSizeBytes: typeof stats?.dataSize === "number" ? stats.dataSize : null,
    indexSizeBytes: typeof stats?.indexSize === "number" ? stats.indexSize : null,
    serverVersion,
    maxPageSize: MONGO_ADMIN_MAX_PAGE_SIZE,
    maxPage: MONGO_ADMIN_MAX_PAGE,
    maxExportDocs: MONGO_ADMIN_MAX_EXPORT_DOCS,
  };
}

/** 列出集合：只取元数据，不读文档；`system.*` 一律隐藏。 */
export async function listMongoAdminCollections(): Promise<MongoAdminCollectionSummary[]> {
  const database = db();
  const raw = await database.listCollections({}, { nameOnly: false }).toArray();
  const entries = raw
    .filter((item) => typeof item?.name === "string" && !item.name.startsWith("system."))
    .map((item) => ({
      name: String(item.name),
      type: typeof item.type === "string" ? item.type : "collection",
      capped: Boolean(item.options?.capped),
      hasValidator: Boolean(item.options?.validator),
    }));

  const withCounts: MongoAdminCollectionSummary[] = [];
  // 并发上限 8：集合多的库一次性打满连接池会把浏览页拖慢，也会影响业务请求。
  const concurrency = 8;
  for (let index = 0; index < entries.length; index += concurrency) {
    const slice = entries.slice(index, index + concurrency);
    const counts = await Promise.all(slice.map(async (entry) => {
      try {
        const count = await database.collection(entry.name).estimatedDocumentCount({ maxTimeMS: 2000 });
        return count;
      } catch {
        return null;
      }
    }));
    slice.forEach((entry, offset) => {
      withCounts.push({ ...entry, estimatedCount: counts[offset] });
    });
  }

  return withCounts.sort((a, b) => a.name.localeCompare(b.name));
}

async function resolveCollection(name: unknown): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  if (typeof name !== "string" || !name.trim()) return { ok: false, error: "缺少集合名" };
  const trimmed = name.trim();
  if (trimmed.length > 200 || trimmed.startsWith("system.")) {
    return { ok: false, error: "集合名无效" };
  }
  const names = await listMongoAdminCollections();
  if (!names.some((entry) => entry.name === trimmed)) {
    return { ok: false, error: "集合不存在" };
  }
  return { ok: true, name: trimmed };
}

export interface MongoAdminDocumentQuery {
  collection: unknown;
  page?: unknown;
  pageSize?: unknown;
  filter?: unknown;
  sortField?: unknown;
  sortOrder?: unknown;
  /** `1` / `true` = 脱敏；缺省 = 原样（仍要求超管 + 安全会话）。 */
  redact?: unknown;
}

/** 查询串里的布尔开关：只认 `1` / `true`。 */
export function parseBooleanFlag(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

/** 分页读取文档（服务端脱敏）。 */
export async function listMongoAdminDocuments(
  query: MongoAdminDocumentQuery,
): Promise<MongoAdminResult<{ page: MongoAdminDocumentPage }>> {
  const resolved = await resolveCollection(query.collection);
  if (!resolved.ok) return { ok: false, code: "MONGO_COLLECTION_NOT_FOUND", error: resolved.error };

  const parsedFilter = parseMongoAdminFilter(query.filter);
  if (!parsedFilter.ok) return { ok: false, code: "MONGO_FILTER_INVALID", error: parsedFilter.error };

  const pageSize = parsePositiveInt(query.pageSize, MONGO_ADMIN_DEFAULT_PAGE_SIZE, MONGO_ADMIN_MAX_PAGE_SIZE);
  const page = parsePositiveInt(query.page, 1, MONGO_ADMIN_MAX_PAGE);
  const sort = parseSort(query.sortField, query.sortOrder);
  const redact = parseBooleanFlag(query.redact);

  const database = db();
  const collection = database.collection(resolved.name);
  const skip = (page - 1) * pageSize;

  // `Record<string, unknown>` 与驱动里的 `Filter<Document>` 不是同一形状，这里显式放宽；
  // 过滤条件已经在 parseMongoAdminFilter 里做过对象与危险操作符校验。
  const filter = parsedFilter.filter as Record<string, any>;
  const sortSpec: Record<string, 1 | -1> = { [sort.field]: sort.order === "asc" ? 1 : -1 };

  const [exactTotal, estimatedTotal] = await Promise.all([
    // 精确计数在有过滤条件时才有意义；大集合 + 复杂条件可能超时，超时就回退到估算数。
    collection.countDocuments(filter, { maxTimeMS: 3000 }).catch(() => null),
    collection.estimatedDocumentCount({ maxTimeMS: 2000 }).catch(() => null),
  ]);

  const documents = await collection
    .find(filter)
    .sort(sortSpec)
    .skip(skip)
    .limit(pageSize + 1)
    .maxTimeMS(8000)
    .toArray();

  const hasMore = documents.length > pageSize;
  const pageDocuments = hasMore ? documents.slice(0, pageSize) : documents;

  return {
    ok: true,
    page: {
      collection: resolved.name,
      page,
      pageSize,
      total: exactTotal,
      estimatedTotal,
      documents: pageDocuments.map((document) => presentMongoDocument(document, redact)),
      hasMore,
      sort,
      redacted: redact,
    },
  };
}

export interface MongoAdminCollectionDetail {
  collection: string;
  indexes: Array<Record<string, unknown>>;
  options: Record<string, unknown>;
  capped: boolean;
  estimatedCount: number | null;
}

/** 集合结构：索引与选项（不返回 validator 正文，避免把规则里的字段名再抄一遍）。 */
export async function getMongoAdminCollectionDetail(
  name: unknown,
): Promise<MongoAdminResult<{ detail: MongoAdminCollectionDetail }>> {
  const resolved = await resolveCollection(name);
  if (!resolved.ok) return { ok: false, code: "MONGO_COLLECTION_NOT_FOUND", error: resolved.error };

  const database = db();
  const indexes = await database.collection(resolved.name).indexes().catch(() => []);
  const info = await database.listCollections({ name: resolved.name }, { nameOnly: false }).next();
  const options = (info?.options ?? {}) as unknown as Record<string, unknown>;
  const estimatedCount = await database.collection(resolved.name)
    .estimatedDocumentCount({ maxTimeMS: 2000 })
    .catch(() => null);

  return {
    ok: true,
    detail: {
      collection: resolved.name,
      indexes: indexes.map((index) => sanitizeMongoDocument(index) as Record<string, unknown>),
      options: {
        capped: Boolean(options.capped),
        ...(typeof options.size === "number" ? { size: options.size } : {}),
        ...(typeof options.max === "number" ? { max: options.max } : {}),
        hasValidator: Boolean(options.validator),
      },
      capped: Boolean(options.capped),
      estimatedCount,
    },
  };
}

/**
 * 导出为 NDJSON 文档流。调用方负责回压；这里只负责「按过滤条件顺序读并脱敏」。
 * 客户端断开时由调用方停止消费，游标随之关闭。
 */
export async function* exportMongoAdminDocuments(options: {
  collection: unknown;
  filter?: unknown;
  sortField?: unknown;
  sortOrder?: unknown;
  maxDocs?: unknown;
  redact?: unknown;
}): AsyncGenerator<Record<string, unknown>> {
  const resolved = await resolveCollection(options.collection);
  if (!resolved.ok) {
    yield { kind: "error", code: "MONGO_COLLECTION_NOT_FOUND", error: resolved.error };
    return;
  }
  const parsedFilter = parseMongoAdminFilter(options.filter);
  if (!parsedFilter.ok) {
    yield { kind: "error", code: "MONGO_FILTER_INVALID", error: parsedFilter.error };
    return;
  }

  const maxDocs = parsePositiveInt(options.maxDocs, 5000, MONGO_ADMIN_MAX_EXPORT_DOCS);
  const sort = parseSort(options.sortField, options.sortOrder);
  const redact = parseBooleanFlag(options.redact);
  const collection = db().collection(resolved.name);

  yield {
    kind: "header",
    collection: resolved.name,
    exportedAt: new Date().toISOString(),
    sort,
    hasFilter: Object.keys(parsedFilter.filter).length > 0,
    maxDocs,
    redacted: redact,
    note: redact
      ? "文档已脱敏：密码材料 / 令牌 / 密钥 / 密文 / 内部存储键替换为 [redacted]，二进制正文只报大小。"
      : "文档按原样导出（请求方已通过超管 + 安全会话）；二进制正文只报大小。",
  };

  const filter = parsedFilter.filter as Record<string, any>;
  const sortSpec: Record<string, 1 | -1> = { [sort.field]: sort.order === "asc" ? 1 : -1 };

  let exported = 0;
  let failure: string | undefined;
  try {
    const cursor = collection
      .find(filter)
      .sort(sortSpec)
      .limit(maxDocs)
      .maxTimeMS(60_000)
      .batchSize(200);
    for await (const document of cursor) {
      exported += 1;
      yield { kind: "document", document: presentMongoDocument(document, redact) };
    }
  } catch (error) {
    failure = "导出过程中发生错误";
    logger.error("[MongoAdmin] 导出失败", { collection: resolved.name, error: (error as Error)?.message });
    yield { kind: "error", code: "EXPORT_FAILED", error: failure };
  } finally {
    yield {
      kind: "summary",
      collection: resolved.name,
      exported,
      truncated: exported >= maxDocs,
      ...(failure ? { failure } : {}),
    };
  }
}
