export {};

import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { redisService } from "../services/redisService";
import {
  exportRedisAdminSnapshot,
  getRedisAdminOverview,
  getRedisAdminScope,
  isRedisKeyInAdminScope,
  readRedisAdminKey,
  scanRedisAdminKeys,
  type RedisSnapshotRecord,
} from "../services/redisAdminService";

jest.mock("../services/redisService", () => ({
  redisService: {
    isAvailable: jest.fn(() => true),
    getStatus: jest.fn(() => ({ configured: true, enabled: true, ready: true, available: true })),
    getServerStats: jest.fn(async () => ({ dbsize: 7, usedMemoryBytes: 2048 })),
    scanKeysPage: jest.fn(),
    readKeyMeta: jest.fn(),
    readKeyContent: jest.fn(),
    dumpKeyForExport: jest.fn(),
  },
}));

const mockedRedis = redisService as unknown as {
  isAvailable: jest.Mock;
  getStatus: jest.Mock;
  getServerStats: jest.Mock;
  scanKeysPage: jest.Mock;
  readKeyMeta: jest.Mock;
  readKeyContent: jest.Mock;
  dumpKeyForExport: jest.Mock;
};

const KEY_CONTENT = {
  type: "string",
  ttlMs: -1,
  encoding: "embstr",
  sizeBytes: 16,
  stringLength: 5,
  value: "hello",
  entries: null,
  totalEntries: null,
  truncated: false,
};

async function withPrefixes<T>(value: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env.ADMIN_REDIS_KEY_PREFIXES;
  if (value === undefined) delete process.env.ADMIN_REDIS_KEY_PREFIXES;
  else process.env.ADMIN_REDIS_KEY_PREFIXES = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.ADMIN_REDIS_KEY_PREFIXES;
    else process.env.ADMIN_REDIS_KEY_PREFIXES = previous;
  }
}

describe("redisAdminService 命名空间范围", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ADMIN_REDIS_KEY_PREFIXES;
  });

  it("未配置白名单时浏览整个当前 DB", () => {
    expect(getRedisAdminScope()).toEqual({ restricted: false, prefixes: [], source: "all" });
    expect(isRedisKeyInAdminScope("anything:1")).toBe(true);
  });

  it("配置白名单后只放行这些前缀，并去重去空", () => {
    process.env.ADMIN_REDIS_KEY_PREFIXES = " cache: , ipban: , cache: ,, ";
    const scope = getRedisAdminScope();
    expect(scope).toEqual({ restricted: true, prefixes: ["cache:", "ipban:"], source: "env" });
    expect(isRedisKeyInAdminScope("cache:user:1", scope)).toBe(true);
    expect(isRedisKeyInAdminScope("ipban:1.2.3.4", scope)).toBe(true);
    // 前缀匹配是 startsWith，不做「同前缀兄弟」的模糊放行。
    expect(isRedisKeyInAdminScope("cacheX:user:1", scope)).toBe(false);
    expect(isRedisKeyInAdminScope("other:1", scope)).toBe(false);
  });

  it("白名单只写了逗号/空格时退回整个 DB，而不是变成「什么都看不到」", () => {
    process.env.ADMIN_REDIS_KEY_PREFIXES = " , , ";
    expect(getRedisAdminScope()).toEqual({ restricted: false, prefixes: [], source: "all" });
  });
});

describe("redisAdminService 概览", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ADMIN_REDIS_KEY_PREFIXES;
  });

  it("返回连接状态、体量与页面额度", async () => {
    const overview = await getRedisAdminOverview();
    expect(overview.status.available).toBe(true);
    expect(overview.dbsize).toBe(7);
    expect(overview.usedMemoryBytes).toBe(2048);
    expect(overview.scope.restricted).toBe(false);
    expect(overview.defaultPageLimit).toBeLessThanOrEqual(overview.maxPageLimit);
  });
});

describe("redisAdminService 按键分页", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ADMIN_REDIS_KEY_PREFIXES;
    mockedRedis.scanKeysPage.mockResolvedValue({ cursor: "0", keys: [] });
    mockedRedis.readKeyMeta.mockResolvedValue({ type: "string", ttlMs: -1 });
  });

  it("无过滤条件时匹配全库，并带上每个键的类型与 TTL", async () => {
    mockedRedis.scanKeysPage.mockResolvedValue({ cursor: "0", keys: ["cache:a", "ipban:1.2.3.4"] });
    mockedRedis.readKeyMeta.mockImplementation(async (key: string) =>
      key.startsWith("cache") ? { type: "string", ttlMs: 5000 } : { type: "hash", ttlMs: -1 },
    );

    const result = await scanRedisAdminKeys({ limit: "10" });
    if (!result.ok) throw new Error(`expected ok, got ${result.code}`);
    expect(result.match).toBe("*");
    expect(result.done).toBe(true);
    expect(result.keys).toEqual([
      { key: "cache:a", type: "string", ttlMs: 5000 },
      { key: "ipban:1.2.3.4", type: "hash", ttlMs: -1 },
    ]);
  });

  it("过滤串会剥掉 glob 元字符，避免一次请求放大成全库遍历", async () => {
    await scanRedisAdminKeys({ filter: "a*b?[c]\\d" });
    expect(mockedRedis.scanKeysPage).toHaveBeenCalledWith("0", "*abcd*", expect.any(Number));
  });

  it("把每页条数钳制在上限内", async () => {
    await scanRedisAdminKeys({ limit: 100000 });
    const scanCount = mockedRedis.scanKeysPage.mock.calls[0]?.[2] as number;
    expect(scanCount).toBeLessThanOrEqual(500);
  });

  it("收窄范围后只允许白名单内的命名空间", async () => {
    await withPrefixes("cache:,ipban:", async () => {
      const denied = await scanRedisAdminKeys({ namespace: "other:" });
      expect(denied).toMatchObject({ ok: false, code: "REDIS_NAMESPACE_NOT_ALLOWED" });

      mockedRedis.scanKeysPage.mockResolvedValue({ cursor: "0", keys: ["cache:a"] });
      const allowed = await scanRedisAdminKeys({ namespace: "cache:" });
      if (!allowed.ok) throw new Error("expected ok");
      expect(allowed.namespace).toBe("cache:");
      expect(allowed.match).toBe("cache:*");
    });
  });

  it("MATCH 之外再挡一次范围（防止未来改 SCAN 参数时把范围外键带出来）", async () => {
    await withPrefixes("cache:", async () => {
      mockedRedis.scanKeysPage.mockResolvedValue({ cursor: "0", keys: ["cache:a", "other:b"] });
      const result = await scanRedisAdminKeys({});
      if (!result.ok) throw new Error("expected ok");
      expect(result.keys.map((entry) => entry.key)).toEqual(["cache:a"]);
      expect(result.outOfScope).toBe(1);
    });
  });

  it("Redis 不可用时返回明确错误而不是空列表", async () => {
    mockedRedis.scanKeysPage.mockResolvedValue(null);
    expect(await scanRedisAdminKeys({})).toMatchObject({ ok: false, code: "REDIS_UNAVAILABLE" });
  });

  it("元信息读不到的键标记为 unknown，不影响整页返回", async () => {
    mockedRedis.scanKeysPage.mockResolvedValue({ cursor: "0", keys: ["cache:gone"] });
    mockedRedis.readKeyMeta.mockResolvedValue(null);
    const result = await scanRedisAdminKeys({});
    if (!result.ok) throw new Error("expected ok");
    expect(result.keys).toEqual([{ key: "cache:gone", type: "unknown", ttlMs: -1 }]);
  });
});

describe("redisAdminService 单键读取", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ADMIN_REDIS_KEY_PREFIXES;
    mockedRedis.readKeyContent.mockResolvedValue(KEY_CONTENT);
  });

  it("拒绝空键名与超长键名（不触达 Redis）", async () => {
    expect(await readRedisAdminKey("   ")).toMatchObject({ ok: false, code: "INVALID_KEY" });
    expect(await readRedisAdminKey("k".repeat(513))).toMatchObject({ ok: false, code: "INVALID_KEY" });
    expect(mockedRedis.readKeyContent).not.toHaveBeenCalled();
  });

  it("收窄范围时拒绝范围外的键", async () => {
    await withPrefixes("cache:", async () => {
      expect(await readRedisAdminKey("other:1")).toMatchObject({ ok: false, code: "REDIS_KEY_OUT_OF_SCOPE" });
      expect(mockedRedis.readKeyContent).not.toHaveBeenCalled();
    });
  });

  it("键已不存在与 Redis 不可用返回不同错误码", async () => {
    mockedRedis.readKeyContent.mockResolvedValue({ ...KEY_CONTENT, type: "none" });
    expect(await readRedisAdminKey("cache:gone")).toMatchObject({ ok: false, code: "REDIS_KEY_NOT_FOUND" });

    mockedRedis.readKeyContent.mockResolvedValue(null);
    expect(await readRedisAdminKey("cache:x")).toMatchObject({ ok: false, code: "REDIS_UNAVAILABLE" });
  });

  it("成功时返回键名、范围与内容，并把读取上限钳制后传给 Redis", async () => {
    const result = await readRedisAdminKey("  cache:a  ", { maxValueChars: 999999, maxEntries: 0 });
    if (!result.ok) throw new Error("expected ok");
    expect(result.key).toBe("cache:a");
    expect(result.content.value).toBe("hello");
    expect(mockedRedis.readKeyContent).toHaveBeenCalledWith("cache:a", {
      maxValueChars: 20000,
      maxEntries: 1,
    });
  });
});

describe("redisAdminService 快照导出", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ADMIN_REDIS_KEY_PREFIXES;
    mockedRedis.scanKeysPage.mockResolvedValue({ cursor: "0", keys: [] });
    mockedRedis.dumpKeyForExport.mockResolvedValue({ ok: true, dumpBase64: "AAEC", ttlMs: 1500 });
  });

  async function collect(): Promise<RedisSnapshotRecord[]> {
    const records: RedisSnapshotRecord[] = [];
    for await (const record of exportRedisAdminSnapshot({})) records.push(record);
    return records;
  }

  it("产出 meta → key → summary 三段，并保留 TTL 与 DUMP 原文", async () => {
    mockedRedis.scanKeysPage.mockResolvedValue({ cursor: "0", keys: ["cache:a"] });
    const records = await collect();

    expect(records[0]).toMatchObject({ kind: "meta", version: 1, encoding: "dump-base64" });
    expect(records[1]).toEqual({ kind: "key", key: "cache:a", ttlMs: 1500, dumpBase64: "AAEC" });
    expect(records[2]).toMatchObject({ kind: "summary", exported: 1, skipped: 0, truncated: false });
  });

  it("达到 maxKeys 上限时停在中途并标记 truncated", async () => {
    mockedRedis.scanKeysPage.mockResolvedValue({ cursor: "0", keys: ["cache:a", "cache:b", "cache:c"] });
    const records: RedisSnapshotRecord[] = [];
    for await (const record of exportRedisAdminSnapshot({ maxKeys: 2 })) records.push(record);

    expect(records.filter((record) => record.kind === "key")).toHaveLength(2);
    expect(records[records.length - 1]).toMatchObject({ kind: "summary", exported: 2, truncated: true });
  });

  it("DUMP 整体不可用时提前中止并报明确错误，而不是产出一份全 skip 的空快照", async () => {
    mockedRedis.scanKeysPage.mockResolvedValue({
      cursor: "0",
      keys: ["cache:a", "cache:b", "cache:c", "cache:d", "cache:e"],
    });
    mockedRedis.dumpKeyForExport.mockResolvedValue({ ok: false, reason: "dump-failed" });

    const records = await collect();
    expect(records[records.length - 1]).toMatchObject({ kind: "error", code: "DUMP_UNSUPPORTED" });
    expect(records.some((record) => record.kind === "summary")).toBe(false);
  });

  it("二进制读取不安全时逐键记录 skip，且不写进 key 记录", async () => {
    mockedRedis.scanKeysPage.mockResolvedValue({ cursor: "0", keys: ["cache:a", "cache:b", "cache:c", "cache:d", "cache:e", "cache:f"] });
    mockedRedis.dumpKeyForExport.mockResolvedValueOnce({ ok: true, dumpBase64: "AAEC", ttlMs: -1 });
    mockedRedis.dumpKeyForExport.mockResolvedValue({ ok: false, reason: "binary-unsafe" });

    const records = await collect();
    expect(records.filter((record) => record.kind === "key")).toHaveLength(1);
    expect(records.some((record) => record.kind === "skip" && record.reason === "binary-unsafe")).toBe(true);
    expect(records[records.length - 1]).toMatchObject({ kind: "summary", exported: 1 });
  });

  it("扫描到读取之间过期的键只计入 skipped，不刷 skip 行", async () => {
    mockedRedis.scanKeysPage.mockResolvedValue({ cursor: "0", keys: ["cache:a"] });
    mockedRedis.dumpKeyForExport.mockResolvedValue({ ok: false, reason: "missing" });

    const records = await collect();
    expect(records.some((record) => record.kind === "skip")).toBe(false);
    expect(records[records.length - 1]).toMatchObject({ kind: "summary", exported: 0, skipped: 1 });
  });

  it("收窄范围后只导出白名单命名空间", async () => {
    await withPrefixes("cache:", async () => {
      const records = await collect();
      expect(records[0]).toMatchObject({ kind: "meta" });
      expect(mockedRedis.scanKeysPage).toHaveBeenCalledWith("0", "cache:*", expect.any(Number));
    });
  });

  it("收窄范围后指定白名单外的命名空间直接报错，不读任何键", async () => {
    await withPrefixes("cache:", async () => {
      const records: RedisSnapshotRecord[] = [];
      for await (const record of exportRedisAdminSnapshot({ namespace: "other:" })) records.push(record);
      expect(records).toEqual([
        { kind: "error", code: "REDIS_NAMESPACE_NOT_ALLOWED", error: "命名空间不在允许范围内" },
      ]);
      expect(mockedRedis.scanKeysPage).not.toHaveBeenCalled();
    });
  });

  it("Redis 不可用时中止导出并报错", async () => {
    mockedRedis.scanKeysPage.mockResolvedValue(null);
    const records = await collect();
    expect(records[records.length - 1]).toMatchObject({ kind: "error", code: "REDIS_UNAVAILABLE" });
  });
});
