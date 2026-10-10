import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";

// —— 依赖替身（不连 Mongo、不调 AI）——
// 本套件只验「判定分支」与「服务发出的查询形状」，真实持久化由 CI 里的其它套件覆盖。
// 必须为生产代码用到的每个成员都给出替身，漏一个会让调用点抛 TypeError，伪装成业务坏了：
//   libreChatQuotaService -> UserModel.findOneAndUpdate / UserModel.findOne / getUserUsageDay / updateUser
//   moderationService（真实实现）-> incrementUserTicketViolationCount / updateUser / getUserById（单调护栏读现值）
const mockFindOne = jest.fn();
const mockFindOneAndUpdate = jest.fn();
const mockIncrementTicketViolationCount = jest.fn(async (_userId: string) => 1);
const mockUpdateUser = jest.fn(async (_userId: string, _updates: Record<string, unknown>) => null);
const mockGetUserById = jest.fn(async (_userId: string): Promise<{ ticketBannedUntil?: string } | null> => null);

jest.mock("../services/userService", () => ({
  UserModel: {
    findOne: (...args: unknown[]) => mockFindOne(...args),
    findOneAndUpdate: (...args: unknown[]) => mockFindOneAndUpdate(...args),
  },
  // 上海日界的换算在 userService 自己的用例里钉死，这里只固定天键。
  getUserUsageDay: () => mockToday,
  incrementUserTicketViolationCount: (...args: unknown[]) => mockIncrementTicketViolationCount(...args),
  updateUser: (...args: unknown[]) => mockUpdateUser(...args),
  getUserById: (...args: unknown[]) => mockGetUserById(...args),
}));

// moderationService 在模块作用域建 mongoose Schema；这里不需要真连接，但 readyState 要为 1，
// 否则配额服务会走「数据库不可用则放行」的分支，测不到判定逻辑。
// 工厂内只内联对象字面量：直接引用模块级变量会在 require 阶段就求值（TDZ），
// 需要改 readyState 的用例通过被替换后的 mongoose 出口去改同一个对象。
jest.mock("../services/mongoService", () => ({
  mongoose: {
    connection: { readyState: 1 },
    Schema: function MockSchema(this: Record<string, unknown>) {
      this.index = () => this;
    },
    models: {},
    model: () => ({ create: jest.fn() }),
  },
}));

jest.mock("../services/libreChatService", () => ({
  libreChatService: { sendMessage: jest.fn() },
}));

import {
  clearLibreChatBan,
  consumeLibreChatQuota,
  LIBRECHAT_QUOTA_DEFAULTS,
  readLibreChatQuota,
} from "../services/libreChatQuotaService";
import { ModerationService } from "../services/moderationService";
// 这个导出在运行时指向上面那个替身，用它可把「数据库可用性」切到测试需要的状态。
import { mongoose } from "../services/mongoService";

/** 天键固定为替身时钟那一天（jest.mock 工厂里只能引用 mock* 变量，故这个常量也必须带 mock 前缀）。 */
const mockToday = "2026-10-10";
const YESTERDAY = "2026-10-09";
const NOW = new Date("2026-10-10T04:00:00.000Z"); // 上海 12:00
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** 复刻 mongoose 的链式形状：UserModel.findOneAndUpdate(...).select(...).lean() */
function queryResult(result: unknown) {
  return { select: () => ({ lean: async () => result }) };
}

function userDoc(overrides: Record<string, unknown> = {}) {
  return {
    id: "u1",
    role: "user",
    libreChatDailyUsage: 0,
    libreChatUsageDay: mockToday,
    libreChatViolationCount: 0,
    ...overrides,
  };
}

/** 服务发出的「同一天」判据：字段里直接存上海天键，$eq 即可。 */
function sameDayExpr() {
  return { $eq: [{ $ifNull: ["$libreChatUsageDay", ""] }, mockToday] };
}

function callsOf(mock: unknown): unknown[][] {
  return (mock as jest.Mock).mock.calls;
}

function setDatabaseReady(ready: boolean): void {
  (mongoose.connection as unknown as { readyState: number }).readyState = ready ? 1 : 0;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
  setDatabaseReady(true);
  mockFindOne.mockReset();
  mockFindOneAndUpdate.mockReset();
  mockIncrementTicketViolationCount.mockReset();
  mockIncrementTicketViolationCount.mockResolvedValue(1);
  mockUpdateUser.mockReset();
  mockUpdateUser.mockResolvedValue(null);
});

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe("LibreChat 每日额度", () => {
  it("限额默认值：env 未配置时回落 5 次/3 次警告/24 小时", () => {
    expect(LIBRECHAT_QUOTA_DEFAULTS).toEqual({ dailyLimit: 5, maxWarnings: 3, banHours: 24 });
  });

  it("计数契约：单条 findOneAndUpdate + 聚合管道完成跨日重置/增量/管理员豁免，不做先读再写", async () => {
    mockFindOneAndUpdate.mockImplementationOnce(() => queryResult(userDoc({ libreChatDailyUsage: 3 })));

    const decision = await consumeLibreChatQuota("u1");

    expect(decision.allowed).toBe(true);
    // 命中即「放行且已扣一次」：只有一条写，中间没有 findOne 的读-改-写（并发下会超支）
    expect(callsOf(mockFindOneAndUpdate)).toHaveLength(1);
    expect(mockFindOne).not.toHaveBeenCalled();

    const [filter, pipeline] = callsOf(mockFindOneAndUpdate)[0] as [any, any[]];
    expect(filter.id).toBe("u1");
    // 管理员豁免写在查询条件里（与 incrementUserDailyUsageAtomic 同口径）
    expect(filter.role).toEqual({ $nin: ["admin", "superadmin"] });
    // 封禁中的请求不会命中这条更新，因此不会消耗额度
    expect(JSON.stringify(filter.$and)).toContain("libreChatBannedUntil");
    // 跨日（未命中后再分辨原因）或额度未满才允许消费
    expect(filter.$and).toContainEqual({
      $or: [{ $expr: { $not: [sameDayExpr()] } }, { libreChatDailyUsage: { $lt: 5 } }],
    });

    expect(pipeline).toHaveLength(1);
    expect(pipeline[0].$set.libreChatUsageDay).toBe(mockToday);
    // 同一天 → +1；跨日 → 从 1 起算
    expect(pipeline[0].$set.libreChatDailyUsage).toEqual({
      $cond: [sameDayExpr(), { $add: [{ $ifNull: ["$libreChatDailyUsage", 0] }, 1] }, 1],
    });
    // 警告计数与用量一起按天归零，否则跨日会带着昨天的警告直接触发封禁
    expect(pipeline[0].$set.libreChatViolationCount).toEqual({
      $cond: [sameDayExpr(), { $ifNull: ["$libreChatViolationCount", 0] }, 0],
    });
  });

  it.each([1, 2, 3, 4, 5])("今天的第 %i 次生成放行，used / remaining 同步变化", async (times) => {
    mockFindOneAndUpdate.mockImplementationOnce(() => queryResult(userDoc({ libreChatDailyUsage: times })));

    const decision = await consumeLibreChatQuota("u1");

    expect(decision.allowed).toBe(true);
    expect(decision.code).toBeUndefined();
    expect(decision.view).toMatchObject({
      dailyLimit: 5,
      used: times,
      remaining: 5 - times,
      banned: false,
      maxWarnings: 3,
    });
  });

  it("第 6 次 → 403 LIBRECHAT_DAILY_LIMIT，记第 1 次警告并给出剩余警告次数", async () => {
    mockFindOneAndUpdate
      .mockImplementationOnce(() => queryResult(null)) // 消费未命中：今日额度已满
      .mockImplementationOnce(() => queryResult(userDoc({ libreChatDailyUsage: 5, libreChatViolationCount: 1 })));
    mockFindOne.mockImplementationOnce(() => queryResult(userDoc({ libreChatDailyUsage: 5 })));

    const decision = await consumeLibreChatQuota("u1");

    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("LIBRECHAT_DAILY_LIMIT");
    expect(decision.view).toMatchObject({ used: 5, remaining: 0, warnings: 1, maxWarnings: 3, banned: false });
    expect(decision.message).toContain("今天 5 次已用完，再继续将被封禁一天（第 1 次警告");
    expect(decision.message).toContain("还剩 2 次警告");
    // 警告阶段不封禁、不动工单
    expect(decision.retryAfterSeconds).toBeUndefined();
    expect(mockUpdateUser).not.toHaveBeenCalled();
    expect(mockIncrementTicketViolationCount).not.toHaveBeenCalled();

    // 警告计数同样是原子 +1（不是先读后写）
    const warnWrite = callsOf(mockFindOneAndUpdate)[1] as [any, any[]];
    expect(warnWrite[0]).toEqual({ id: "u1", role: { $nin: ["admin", "superadmin"] } });
    expect(warnWrite[1][0].$set.libreChatViolationCount).toEqual({
      $add: [{ $cond: [sameDayExpr(), { $ifNull: ["$libreChatViolationCount", 0] }, 0] }, 1],
    });
  });

  it("已有更长的工单封禁不会被自动封禁缩短（处罚单调：只进不退）", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    jest.spyOn(ModerationService, "banFromTicket");

    // 该用户此前已被 handleViolation 判到长期封禁（例如 99 年）：远晚于本次的 now+24h
    const longBan = new Date(NOW.getTime() + 365 * 24 * HOUR_MS).toISOString();
    mockGetUserById.mockResolvedValueOnce({ ticketBannedUntil: longBan });

    mockFindOne.mockImplementationOnce(() =>
      queryResult(userDoc({ libreChatDailyUsage: 5, libreChatViolationCount: 2 })),
    );
    mockFindOneAndUpdate
      .mockImplementationOnce(() => queryResult(null))
      .mockImplementationOnce(() => queryResult(userDoc({ libreChatDailyUsage: 5, libreChatViolationCount: 3 })))
      .mockImplementationOnce(() =>
        queryResult(
          userDoc({
            libreChatDailyUsage: 5,
            libreChatViolationCount: 3,
            libreChatBannedUntil: new Date(NOW.getTime() + DAY_MS).toISOString(),
          }),
        ),
      );

    await consumeLibreChatQuota("u1");

    // 关键：不能把长期工单封禁改写成 now+24h；违规计数照旧递增（事实不受影响）
    const ticketWrites = callsOf(mockUpdateUser).map(
      (call) => (call as [string, { ticketBannedUntil?: string }])[1]?.ticketBannedUntil,
    );
    expect(ticketWrites.every((value) => value === undefined)).toBe(true);
    expect(mockIncrementTicketViolationCount).toHaveBeenCalledWith("u1");
  });

  it("已过期的旧封禁不阻挡新写入（护栏只保护仍然生效的封禁）", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    jest.spyOn(ModerationService, "banFromTicket");
    // 旧封禁已经过期 → 应该正常写 now+24h
    mockGetUserById.mockResolvedValueOnce({ ticketBannedUntil: new Date(NOW.getTime() - HOUR_MS).toISOString() });

    await ModerationService.banFromTicket("u1", 24, "测试");

    const written = callsOf(mockUpdateUser).map(
      (call) => (call as [string, { ticketBannedUntil?: string }])[1]?.ticketBannedUntil,
    );
    expect(written).toContain(new Date(NOW.getTime() + DAY_MS).toISOString());
  });

  it("警告累计到第 3 次 → 自动封禁：LibreChat 侧 24 小时 + 工单侧走 moderationService", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    const banSpy = jest.spyOn(ModerationService, "banFromTicket");
    const expectedBan = new Date(NOW.getTime() + DAY_MS).toISOString();

    mockFindOne.mockImplementationOnce(() =>
      queryResult(userDoc({ libreChatDailyUsage: 5, libreChatViolationCount: 2 })),
    );
    mockFindOneAndUpdate
      .mockImplementationOnce(() => queryResult(null)) // 消费未命中：额度已满
      .mockImplementationOnce(() => queryResult(userDoc({ libreChatDailyUsage: 5, libreChatViolationCount: 3 })))
      .mockImplementationOnce(() =>
        queryResult(userDoc({ libreChatDailyUsage: 5, libreChatViolationCount: 3, libreChatBannedUntil: expectedBan })),
      );

    const decision = await consumeLibreChatQuota("u1");

    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("LIBRECHAT_BANNED");
    expect(decision.retryAfterSeconds).toBe(24 * 60 * 60);
    expect(decision.view).toMatchObject({ banned: true, bannedUntil: expectedBan, warnings: 3, remaining: 0 });

    // 工单封禁必须走 moderationService 的既有路径，且时长取 env 的 LIBRECHAT_BAN_HOURS
    expect(banSpy).toHaveBeenCalledTimes(1);
    expect(banSpy).toHaveBeenCalledWith("u1", 24, expect.stringContaining("LibreChat"));
    expect(mockIncrementTicketViolationCount).toHaveBeenCalledWith("u1");
    const ticketBanWrite = (callsOf(mockUpdateUser)[0] as [string, { ticketBannedUntil: string }])[1];
    expect(ticketBanWrite.ticketBannedUntil).toBe(new Date(NOW.getTime() + 24 * HOUR_MS).toISOString());

    // 配额服务自己不许拼工单字段
    const quotaWrites = callsOf(mockFindOneAndUpdate)
      .map((call) => JSON.stringify(call[1]))
      .join("|");
    expect(quotaWrites).not.toContain("ticketBannedUntil");

    // LibreChat 侧封禁：一次 $set 到 now + 24h
    const banWrite = callsOf(mockFindOneAndUpdate)
      .map((call) => call[1] as Record<string, any>)
      .find((update) => !Array.isArray(update) && update?.$set?.libreChatBannedUntil);
    expect((banWrite as Record<string, any>).$set.libreChatBannedUntil).toBe(expectedBan);
  });

  it("封禁中 → 403 LIBRECHAT_BANNED，带剩余秒数，文案不给申诉入口", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(NOW);
    const bannedUntil = new Date(NOW.getTime() + 3 * HOUR_MS).toISOString();
    mockFindOne.mockImplementationOnce(() =>
      queryResult(
        userDoc({ libreChatDailyUsage: 5, libreChatViolationCount: 3, libreChatBannedUntil: bannedUntil }),
      ),
    );
    mockFindOneAndUpdate.mockImplementationOnce(() => queryResult(null));

    const decision = await consumeLibreChatQuota("u1");

    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("LIBRECHAT_BANNED");
    expect(decision.retryAfterSeconds).toBe(3 * 60 * 60);
    expect(decision.view).toMatchObject({ banned: true, bannedUntil, used: 5, remaining: 0, warnings: 3 });
    expect(decision.message).toContain("LibreChat 权限已被暂停");
    expect(decision.message).toContain("恢复");
    // 只讲状态：不给申诉入口、不带支持邮箱（方案 §2.1）
    expect(decision.message).not.toMatch(/申诉|邮箱|邮件|联系|support@|@/);

    // 封禁期间不写库：不加警告、不延长封禁、不再触发工单侧封禁
    expect(callsOf(mockFindOneAndUpdate)).toHaveLength(1);
    expect(mockUpdateUser).not.toHaveBeenCalled();
    expect(mockIncrementTicketViolationCount).not.toHaveBeenCalled();
  });

  it("跨日：昨天用满并攒过警告的用户，消费时归零后放行；只读查询也按归零展示", async () => {
    mockFindOneAndUpdate.mockImplementationOnce(() =>
      queryResult(userDoc({ libreChatDailyUsage: 1, libreChatViolationCount: 0 })),
    );

    const decision = await consumeLibreChatQuota("u1");

    expect(decision.allowed).toBe(true);
    expect(decision.view).toMatchObject({ used: 1, remaining: 4, warnings: 0, banned: false });
    const pipeline = callsOf(mockFindOneAndUpdate)[0][1] as any[];
    expect(pipeline[0].$set.libreChatViolationCount).toEqual({
      $cond: [sameDayExpr(), { $ifNull: ["$libreChatViolationCount", 0] }, 0],
    });

    // 库里还停着昨天的天键时，昨天的用量与警告都不算数
    mockFindOne.mockImplementationOnce(() =>
      queryResult(userDoc({ libreChatUsageDay: YESTERDAY, libreChatDailyUsage: 5, libreChatViolationCount: 2 })),
    );
    const view = await readLibreChatQuota("u1");
    expect(view).toMatchObject({ used: 0, remaining: 5, warnings: 0, banned: false });
  });

  it("管理员豁免：放行且不写用量", async () => {
    mockFindOneAndUpdate.mockImplementationOnce(() => queryResult(null)); // 消费更新被 role 条件排除
    mockFindOne.mockImplementationOnce(() => queryResult(userDoc({ role: "admin" })));

    const decision = await consumeLibreChatQuota("u1");

    expect(decision.allowed).toBe(true);
    expect(decision.view).toMatchObject({ used: 0, remaining: 5, warnings: 0, banned: false });
    // 只有那一次「被 role 条件排除」的尝试，没有任何写用量/写封禁
    expect(callsOf(mockFindOneAndUpdate)).toHaveLength(1);
    expect((callsOf(mockFindOneAndUpdate)[0] as [any, any[]])[0].role).toEqual({
      $nin: ["admin", "superadmin"],
    });
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it("trusted 不在豁免口径里：第 6 次照样只给警告", async () => {
    mockFindOneAndUpdate
      .mockImplementationOnce(() => queryResult(null))
      .mockImplementationOnce(() =>
        queryResult(userDoc({ role: "trusted", libreChatDailyUsage: 5, libreChatViolationCount: 1 })),
      );
    mockFindOne.mockImplementationOnce(() => queryResult(userDoc({ role: "trusted", libreChatDailyUsage: 5 })));

    const decision = await consumeLibreChatQuota("u1");

    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("LIBRECHAT_DAILY_LIMIT");
    expect(decision.view.warnings).toBe(1);
  });

  it("只读查询不消耗额度：封禁中也能读到自己的状态", async () => {
    const bannedUntil = new Date(Date.now() + DAY_MS).toISOString();
    mockFindOne.mockImplementationOnce(() =>
      queryResult(
        userDoc({ libreChatDailyUsage: 5, libreChatViolationCount: 3, libreChatBannedUntil: bannedUntil }),
      ),
    );

    const view = await readLibreChatQuota("u1");

    expect(view).toMatchObject({ banned: true, bannedUntil, used: 5, remaining: 0, warnings: 3 });
    expect(callsOf(mockFindOneAndUpdate)).toHaveLength(0);
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it("Mongo 不可用时放行（额度不是安全边界），不抛错也不写库", async () => {
    setDatabaseReady(false);

    const decision = await consumeLibreChatQuota("u1");

    expect(decision.allowed).toBe(true);
    expect(callsOf(mockFindOneAndUpdate)).toHaveLength(0);
    expect(mockFindOne).not.toHaveBeenCalled();
  });

  it("配额闸门只挂在 /send 与 /retry：只读端点封禁期间也要放行（方案 §2 最后一段）", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src", "routes", "libreChatRoutes.ts"),
      "utf8",
    );
    // 多一个调用点就说明只读端点（history/export/clear/messages 删除/sse）被误挂了闸门
    expect(source.match(/await enforceLibreChatQuota\(/g) || []).toHaveLength(2);
  });

  it("管理员解封：封禁时间与警告计数一起清掉，否则下一次超额会立刻再封", async () => {
    await clearLibreChatBan("u1");

    expect(mockUpdateUser).toHaveBeenCalledWith("u1", {
      libreChatBannedUntil: undefined,
      libreChatViolationCount: undefined,
    });
  });
});
