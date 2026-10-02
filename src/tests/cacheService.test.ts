import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { cacheService } from "../services/cacheService";

/**
 * 缓存层的进程内存档契约（RD-2 / RD-4）。
 *
 * 这里把 Redis 整个 mock 成不可用，专门验证「没有 Redis 时缓存仍然正确降级」：
 * 否则线上未配 REDIS_URL 的部署会静默退化成「每次都 miss 且不报错」，很难从现象倒推。
 * Redis 档的行为由 CI 的 MongoDB/Redis 集成 job 覆盖。
 */
jest.mock("../services/redisService", () => ({
  __esModule: true,
  redisService: {
    isAvailable: () => false,
    getKey: jest.fn(async () => null),
    setKey: jest.fn(async () => true),
    deleteKeys: jest.fn(async () => 0),
    deleteByPrefix: jest.fn(async () => 0),
    getStatus: () => ({ configured: false, enabled: false, ready: false, available: false }),
    getServerStats: jest.fn(async () => ({ dbsize: null, usedMemoryBytes: null })),
  },
}));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  cacheService.clearMemory();
});

describe("cacheService 内存档", () => {
  it("buildKey 统一补 cache: 前缀并丢弃空片段", () => {
    expect(cacheService.buildKey("recommendation", "user", "u1", undefined)).toBe("cache:recommendation:user:u1");
    expect(cacheService.buildKey("recommendation", "popular", 5)).toBe("cache:recommendation:popular:5");
    expect(cacheService.buildKey("")).toBe("cache:");
  });

  it("set/get 往返 JSON 值", async () => {
    await expect(cacheService.set("k1", { a: 1, b: ["x"] }, 60_000)).resolves.toBe(true);
    expect(await cacheService.get("k1")).toEqual({ a: 1, b: ["x"] });
  });

  it("ttl 过期后返回未命中", async () => {
    await cacheService.set("k2", "v", 1);
    await sleep(15);
    expect(await cacheService.get("k2")).toBeNull();
  });

  it("ttl <= 0 视为不缓存，不写永久 key", async () => {
    await expect(cacheService.set("k3", "v", 0)).resolves.toBe(false);
    expect(await cacheService.get("k3")).toBeNull();
  });

  it("getOrSet 并发同 key 只回源一次（单飞）", async () => {
    const loader = jest.fn(async () => {
      await sleep(20);
      return "value";
    });

    const first = cacheService.getOrSet("single-flight", 60_000, loader);
    const second = cacheService.getOrSet("single-flight", 60_000, loader);

    await expect(Promise.all([first, second])).resolves.toEqual(["value", "value"]);
    expect(loader).toHaveBeenCalledTimes(1);
    // 后续读走缓存，不再回源。
    expect(await cacheService.getOrSet("single-flight", 60_000, loader)).toBe("value");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("getOrSet 回源抛错时不写缓存并原样抛出", async () => {
    await expect(
      cacheService.getOrSet("failing", 60_000, () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
    expect(await cacheService.get("failing")).toBeNull();
  });

  it("getOrSet 不缓存 null/undefined（下次仍回源）", async () => {
    const loader = jest.fn(async () => null);
    expect(await cacheService.getOrSet("nullable", 60_000, loader)).toBeNull();
    expect(await cacheService.getOrSet("nullable", 60_000, loader)).toBeNull();
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("delByPrefix 只删匹配前缀的条目", async () => {
    await cacheService.set(cacheService.buildKey("recommendation", "user", "u1"), "a", 60_000);
    await cacheService.set(cacheService.buildKey("recommendation", "user", "u2"), "b", 60_000);
    await cacheService.set(cacheService.buildKey("recommendation", "popular"), "c", 60_000);

    const deleted = await cacheService.delByPrefix(cacheService.buildKey("recommendation", "user"));

    expect(deleted).toBe(2);
    expect(await cacheService.get(cacheService.buildKey("recommendation", "user", "u1"))).toBeNull();
    expect(await cacheService.get(cacheService.buildKey("recommendation", "popular"))).toBe("c");
  });

  it("stats 记录命中/未命中并给出命中率", async () => {
    const before = cacheService.stats();
    await cacheService.set("s1", "v", 60_000);
    await cacheService.get("s1"); // hit
    await cacheService.get("s-missing"); // miss

    const after = cacheService.stats();
    expect(after.hits - before.hits).toBe(1);
    expect(after.misses - before.misses).toBe(1);
    expect(after.sets - before.sets).toBe(1);
    expect(after.tier).toBe("memory");
    expect(after.hitRate).toBeGreaterThan(0);
  });

  it("clearMemory 清空条目但不清统计", async () => {
    await cacheService.set("c1", "v", 60_000);
    expect(cacheService.clearMemory()).toBeGreaterThanOrEqual(1);
    expect(await cacheService.get("c1")).toBeNull();
  });
});
