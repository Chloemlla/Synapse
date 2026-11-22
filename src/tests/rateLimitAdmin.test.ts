import { beforeEach, describe, expect, it, jest } from "@jest/globals";

/**
 * `/api/admin/rate-limits/*` 的服务端契约（页面 `/admin/rate-limits`）。
 *
 * 重点验证三件事：
 *   1. 分页与筛选下推 Mongo，limit 钳到 200（面板一次拉太多会让聚合变慢）；
 *   2. 阈值类数据只回「生效值 + env 名」，不回任何凭据；
 *   3. Mongo 未就绪时列表端点 503，而进程内快照（并发/队列/限流器清单）照常可用。
 */

jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockMongo = { connection: { readyState: 1 } };
jest.mock("../services/mongoService", () => ({ mongoose: mockMongo }));

jest.mock("../config/config", () => ({ startupConfig: { redis: { url: "" } } }));

jest.mock("../middleware/routeLimiters", () => ({
  getBurstConcurrencySnapshot: () => ({
    totalActive: 3,
    guards: { ttsGenerateBurstGuard: { active: 3, keys: 2, maxConcurrent: 2 } },
  }),
  getLimiterDefinitionSnapshot: () => [
    {
      name: "admin",
      profile: "admin",
      category: "admin",
      windowMs: 60_000,
      max: 50,
      keyMode: "ip",
      storage: "shared",
      skipLocal: true,
      message: "管理员操作过于频繁，请稍后再试",
    },
  ],
}));

jest.mock("../services/libreChatQuotaService", () => ({
  LIBRECHAT_QUOTA_DEFAULTS: { dailyLimit: 5, maxWarnings: 3, banHours: 24 },
}));

jest.mock("../mediaTool/sandbox", () => ({
  MEDIA_SANDBOX_DEFAULTS: { maxFileBytes: 1, maxFilesPerJob: 2, maxUserDirBytes: 3, maxUserDirFiles: 4 },
  resolveMediaSandboxLimits: () => ({ maxFileBytes: 500, maxFilesPerJob: 5, maxUserDirBytes: 4096, maxUserDirFiles: 500 }),
}));

jest.mock("../utils/processWatchdog", () => ({ resolveWatchdogMode: () => "observe" }));
jest.mock("../docTool/types", () => ({
  docLimitsFromEnv: () => ({ maxUploadBytes: 1024, maxFileBytes: 512, maxFilesPerJob: 8, maxActiveJobs: 3, retentionDays: 7 }),
}));

const mockQuotaCount = jest.fn();
/** countDocuments 返回 Query（调用方会 .exec()），替身要给 exec。 */
const countQuery = (value: number) => ({ exec: jest.fn().mockResolvedValue(value) });
const mockQuotaFind = jest.fn();
const mockQuotaAggregate = jest.fn();
jest.mock("../models/quotaEventModel", () => ({
  QuotaEventModel: {
    countDocuments: (...args: unknown[]) => mockQuotaCount(...args),
    find: (...args: unknown[]) => mockQuotaFind(...args),
    aggregate: (...args: unknown[]) => mockQuotaAggregate(...args),
  },
}));

const mockUserCount = jest.fn();
const mockUserFind = jest.fn();
jest.mock("../services/userService", () => ({
  UserModel: {
    countDocuments: (...args: unknown[]) => mockUserCount(...args),
    find: (...args: unknown[]) => mockUserFind(...args),
  },
}));

const mockListOwners = jest.fn();
jest.mock("../tts/tts.storage", () => ({
  ttsStorage: { listActiveJobOwners: (...args: unknown[]) => mockListOwners(...args) },
}));

const mockGetQueue = jest.fn();
jest.mock("../tts/tts.queueRegistry", () => ({ getRegisteredTtsQueue: () => mockGetQueue() }));

import { RateLimitAdminController } from "../controllers/rateLimitAdminController";

function queryChain(result: unknown) {
  const handle: Record<string, jest.Mock> = {};
  for (const key of ["select", "sort", "skip", "limit", "lean"]) handle[key] = jest.fn().mockReturnValue(handle);
  handle.exec = jest.fn().mockResolvedValue(result);
  return handle;
}

function makeRes() {
  return {
    statusCode: 200,
    body: null as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
  };
}

const asReq = (query: Record<string, unknown> = {}) =>
  ({ query, params: {}, user: { id: "admin-1", role: "superadmin" } }) as never;

beforeEach(() => {
  jest.clearAllMocks();
  mockMongo.connection.readyState = 1;
});

describe("rateLimitAdmin 配额事件", () => {
  it("阈值筛选映射成区间，limit 钳到 200，keyId 打码", async () => {
    mockQuotaCount.mockImplementation(() => countQuery(1));
    mockQuotaFind.mockReturnValue(
      queryChain([
        {
          _id: "qe-1",
          scope: "key",
          keyId: "abcdef0123456789",
          userId: "u-1",
          resource: "api-key-balance",
          threshold: 0.8,
          periodKey: "2026-11",
          cycle: 2,
          code: "QUOTA_WARNING",
          detail: { remaining: 20 },
          createdAt: new Date("2026-11-01T00:00:00Z"),
        },
      ]),
    );

    const res = makeRes();
    await RateLimitAdminController.listQuotaEvents(asReq({ threshold: "0.8", scope: "key", limit: "9999" }), res as never, jest.fn() as never);

    const match = (mockQuotaFind.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(match.threshold).toEqual({ $lt: 1 });
    expect(match.scope).toBe("key");
    const chain = mockQuotaFind.mock.results[0]!.value as Record<string, jest.Mock>;
    expect(chain.limit).toHaveBeenCalledWith(200);

    const body = res.body as { limit: number; events: Array<Record<string, unknown>> };
    expect(body.limit).toBe(200);
    expect(body.events[0]!.keyId).toBe("abcdef0123…");
    expect(res.headers["Cache-Control"]).toBe("no-store");
  });

  it("Mongo 未就绪时回 503 且不查库", async () => {
    mockMongo.connection.readyState = 0;
    const res = makeRes();
    await RateLimitAdminController.listQuotaEvents(asReq(), res as never, jest.fn() as never);
    expect(res.statusCode).toBe(503);
    expect(mockQuotaFind).not.toHaveBeenCalled();
  });
});

describe("rateLimitAdmin 阶梯", () => {
  it("封禁状态筛选写成 bannedUntil 区间", async () => {
    mockUserCount.mockImplementation(() => countQuery(0));
    mockUserFind.mockReturnValue(queryChain([]));

    const res = makeRes();
    await RateLimitAdminController.listLadders(asReq({ state: "banned" }), res as never, jest.fn() as never);

    const match = (mockUserFind.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(match.libreChatBannedUntil).toEqual({ $gt: expect.any(String) });
    const body = res.body as { config: { defaults: Record<string, number>; env: Record<string, string> } };
    expect(body.config.defaults.dailyLimit).toBe(5);
    expect(body.config.env.banHoursTable).toBe("LIBRECHAT_BAN_HOURS_TABLE");
  });
});

describe("rateLimitAdmin 进程内快照", () => {
  it("并发快照在 Mongo 未连接时仍可用，并标出超顶", async () => {
    mockMongo.connection.readyState = 0;
    const res = makeRes();
    await RateLimitAdminController.getBurst(asReq(), res as never, jest.fn() as never);

    const body = res.body as { guards: Array<{ name: string; overCap: boolean }> };
    expect(body.guards[0]!.name).toBe("ttsGenerateBurstGuard");
    expect(body.guards[0]!.overCap).toBe(true);
  });

  it("TTS 队列未注册时给出可读原因而不是 0", async () => {
    mockGetQueue.mockReturnValue(null);
    const res = makeRes();
    await RateLimitAdminController.getTtsOccupancy(asReq({ top: "10" }), res as never, jest.fn() as never);

    const body = res.body as { available: boolean; reason: string; topOwners: unknown[] };
    expect(body.available).toBe(false);
    expect(body.reason).toContain("没有注册");
    expect(body.topOwners).toEqual([]);
  });

  it("TTS 队列已注册时回全局占用与 Top 用户", async () => {
    mockGetQueue.mockReturnValue({
      getOccupancy: () => ({ concurrency: 4, perUserMaxActive: 3, processing: true }),
      getPerUserMaxActive: () => 3,
    });
    mockListOwners.mockResolvedValue([{ userId: "u-1", active: 3 }]);

    const res = makeRes();
    await RateLimitAdminController.getTtsOccupancy(asReq({ top: "5" }), res as never, jest.fn() as never);

    const body = res.body as { available: boolean; global: Record<string, unknown>; topOwners: Array<{ userId: string }> };
    expect(body.available).toBe(true);
    expect(body.global.concurrency).toBe(4);
    expect(body.topOwners[0]!.userId).toBe("u-1");
    expect(mockListOwners).toHaveBeenCalledWith(5);
  });

  it("限流器清单标注共享档在无 Redis 时退化", async () => {
    const res = makeRes();
    await RateLimitAdminController.listLimiters(asReq(), res as never, jest.fn() as never);

    const body = res.body as { limiters: Array<{ effectiveStorage: string }>; storage: { redisConfigured: boolean } };
    expect(body.storage.redisConfigured).toBe(false);
    expect(body.limiters[0]!.effectiveStorage).toBe("memory(fallback)");
  });
});

describe("rateLimitAdmin 概览", () => {
  it("Mongo 未连接时配额部分给原因，闸门生效值照常返回", async () => {
    mockMongo.connection.readyState = 0;
    mockGetQueue.mockReturnValue(null);
    const res = makeRes();
    await RateLimitAdminController.getOverview(asReq(), res as never, jest.fn() as never);

    const body = res.body as {
      quota: { unavailableReason?: string };
      limits: { mediaSandbox: { maxFileBytes: number } };
      burst: { totalActive: number };
    };
    expect(body.quota.unavailableReason).toContain("数据库未连接");
    expect(body.limits.mediaSandbox.maxFileBytes).toBe(500);
    expect(body.burst.totalActive).toBe(3);
  });
});
