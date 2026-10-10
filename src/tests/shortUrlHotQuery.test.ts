// 短链「近期热门查询」缓存：阈值边界、续期、失效与 Redis 缺失时的降级。
//
// 这里只 mock redisService（不连真 Redis）：本服务的全部外部依赖就是它，
// 而判据要回答的正是「什么条件下写缓存、什么条件下必须清缓存」。
// mock 工厂必须导出生产代码用到的每一个成员，漏一个会让调用点抛 TypeError
// 并被上层 catch 成「缓存失效」这类看起来像业务坏了的假象（见 AGENTS §5 替身一致性）。
jest.mock("../services/redisService", () => ({
  redisService: {
    isAvailable: jest.fn(),
    getKey: jest.fn(),
    setKey: jest.fn(),
    incrementBy: jest.fn(),
    deleteKeys: jest.fn(),
    deleteByPrefix: jest.fn(),
  },
}));

import { redisService } from "../services/redisService";
import { ShortUrlHotQueryService } from "../services/shortUrlHotQueryService";

const mocked = redisService as unknown as {
  isAvailable: jest.Mock;
  getKey: jest.Mock;
  setKey: jest.Mock;
  incrementBy: jest.Mock;
  deleteKeys: jest.Mock;
  deleteByPrefix: jest.Mock;
};

const THRESHOLD = 3;
const WINDOW_MS = 60 * 60 * 1000;
const HOT_TTL_MS = 10 * 60 * 1000;
const OPTS = { threshold: THRESHOLD, windowMs: WINDOW_MS, hotTtlMs: HOT_TTL_MS };

describe("短链热门查询缓存", () => {
  let service: ShortUrlHotQueryService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ShortUrlHotQueryService();
    mocked.isAvailable.mockReturnValue(true);
    mocked.getKey.mockResolvedValue(null);
    mocked.setKey.mockResolvedValue(true);
    mocked.incrementBy.mockResolvedValue(1);
    mocked.deleteKeys.mockResolvedValue(1);
  });

  describe("计数与阈值", () => {
    it("窗口内计数未超过阈值时只计数、不写缓存", async () => {
      for (const count of [1, 2, THRESHOLD]) {
        mocked.incrementBy.mockResolvedValueOnce(count);
        await expect(service.recordQuery("abc123", "https://example.com", OPTS)).resolves.toBe("counted");
      }
      expect(mocked.setKey).not.toHaveBeenCalled();
      expect(service.getStats(OPTS).promotions).toBe(0);
    });

    it("第 4 次（超过阈值 3）时把 {code,target} 写进 Redis 并带 TTL", async () => {
      mocked.incrementBy.mockResolvedValueOnce(THRESHOLD + 1);
      await expect(service.recordQuery("abc123", "https://example.com", OPTS)).resolves.toBe("promoted");

      expect(mocked.setKey).toHaveBeenCalledTimes(1);
      const [key, value, ttl] = mocked.setKey.mock.calls[0];
      expect(key).toBe("shorturl:hot:abc123");
      expect(ttl).toBe(HOT_TTL_MS);
      // 值里只允许有 code 与 target：用户身份信息不进 Redis
      expect(JSON.parse(value)).toEqual({ code: "abc123", target: "https://example.com", cachedAt: expect.any(Number) });
      expect(service.getStats(OPTS).promotions).toBe(1);
    });

    it("计数 key 带小时桶与「两倍窗口」的 TTL（跨桶读留余量）", async () => {
      mocked.incrementBy.mockResolvedValueOnce(2);
      await service.recordQuery("abc123", "https://example.com", OPTS);
      const [key, amount, ttl] = mocked.incrementBy.mock.calls[0];
      expect(key).toMatch(/^shorturl:hits:\d+:abc123$/);
      expect(amount).toBe(1);
      expect(ttl).toBe(WINDOW_MS * 2);
    });

    it("已热门的链接每次访问都会重写条目（等价于续期）", async () => {
      mocked.incrementBy.mockResolvedValue(THRESHOLD + 2);
      await service.recordQuery("abc123", "https://example.com", OPTS);
      await service.recordQuery("abc123", "https://example.com", OPTS);
      expect(mocked.setKey).toHaveBeenCalledTimes(2);
      expect(service.getStats(OPTS).promotions).toBe(2);
    });

    it("拒绝非法 code 与空 target，不碰 Redis", async () => {
      await expect(service.recordQuery("../etc/passwd", "https://x.com", OPTS)).resolves.toBe("disabled");
      await expect(service.recordQuery("ok_code", "", OPTS)).resolves.toBe("disabled");
      expect(mocked.incrementBy).not.toHaveBeenCalled();
    });
  });

  describe("读取热点缓存", () => {
    it("命中时返回 target 并计入 hits", async () => {
      mocked.getKey.mockResolvedValueOnce(JSON.stringify({ code: "abc123", target: "https://example.com", cachedAt: 1 }));
      await expect(service.getHotTarget("abc123")).resolves.toBe("https://example.com");
      expect(service.getStats(OPTS).hits).toBe(1);
      expect(mocked.getKey).toHaveBeenCalledWith("shorturl:hot:abc123");
    });

    it("未命中返回 null 并计入 misses", async () => {
      await expect(service.getHotTarget("abc123")).resolves.toBeNull();
      expect(service.getStats(OPTS).misses).toBe(1);
    });

    it("缓存值损坏时当未命中处理，并顺手清掉这条脏值", async () => {
      mocked.getKey.mockResolvedValueOnce("{not json");
      await expect(service.getHotTarget("abc123")).resolves.toBeNull();
      expect(mocked.deleteKeys).toHaveBeenCalled();
    });
  });

  describe("失效（删除短链时必须清）", () => {
    it("同时清热点条目与当前/上一个小小时桶的计数", async () => {
      await service.invalidate("abc123");
      const [keys] = mocked.deleteKeys.mock.calls[0];
      expect(keys).toHaveLength(3);
      expect(keys[0]).toBe("shorturl:hot:abc123");
      expect(keys[1]).toMatch(/^shorturl:hits:\d+:abc123$/);
      // 上一个桶也要清，否则残留计数会让它下次一访问就又被晋升
      const bucketNow = Number(keys[1].split(":")[2]);
      expect(Number(keys[2].split(":")[2])).toBe(bucketNow - 1);
    });

    it("批量失效逐个清", async () => {
      await service.invalidateMany(["a1", "b2", "c3"]);
      expect(mocked.deleteKeys).toHaveBeenCalledTimes(3);
    });
  });

  describe("Redis 缺失时的降级", () => {
    it("读写都不报错：读固定未命中、写直接判 disabled", async () => {
      mocked.isAvailable.mockReturnValue(false);
      await expect(service.getHotTarget("abc123")).resolves.toBeNull();
      await expect(service.recordQuery("abc123", "https://example.com", OPTS)).resolves.toBe("disabled");
      await expect(service.invalidate("abc123")).resolves.toBeUndefined();
      expect(mocked.incrementBy).not.toHaveBeenCalled();
      expect(mocked.setKey).not.toHaveBeenCalled();
      expect(mocked.deleteKeys).not.toHaveBeenCalled();
      expect(service.getStats(OPTS).disabledSkips).toBe(1);
    });

    it("自增返回 null（命令失败）时也不把任务当成成功晋升", async () => {
      mocked.incrementBy.mockResolvedValueOnce(null);
      await expect(service.recordQuery("abc123", "https://example.com", OPTS)).resolves.toBe("disabled");
      expect(mocked.setKey).not.toHaveBeenCalled();
    });
  });
});
