import { beforeEach, describe, expect, it, jest } from "@jest/globals";

// —— 依赖替身（不连 Mongo/MySQL/Redis，不外呼网络）——
// 必须为生产代码用到的每个成员都给出替身，漏一个会在调用点抛 TypeError 并伪装成业务坏了。
const mockGetAllRounds = jest.fn();
const mockAddRound = jest.fn();
const mockUpdateRound = jest.fn();
const mockGetUserRecord = jest.fn();
const mockGetUserRecordsByIds = jest.fn();
const mockUpdateUserRecord = jest.fn();
const mockDeleteAllRounds = jest.fn();
const mockDeleteAllUserRecords = jest.fn();
const mockGetCaptchaRequestPolicy = jest.fn();
const mockVerifyCaptchaChallenge = jest.fn();
const mockStateClaim = jest.fn();
const mockStateGet = jest.fn();
const mockStateSet = jest.fn();
const mockStateDelete = jest.fn();
const mockAuditLog = jest.fn();

jest.mock("../middleware/auth", () => ({
  isAdminRole: (role: unknown) => role === "admin" || role === "superadmin",
}));

jest.mock("../services/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock("../services/lotteryStorage", () => ({
  getAllRounds: (...a: unknown[]) => mockGetAllRounds(...a),
  addRound: (...a: unknown[]) => mockAddRound(...a),
  updateRound: (...a: unknown[]) => mockUpdateRound(...a),
  getUserRecord: (...a: unknown[]) => mockGetUserRecord(...a),
  getUserRecordsByIds: (...a: unknown[]) => mockGetUserRecordsByIds(...a),
  updateUserRecord: (...a: unknown[]) => mockUpdateUserRecord(...a),
  deleteAllRounds: (...a: unknown[]) => mockDeleteAllRounds(...a),
  deleteAllUserRecords: (...a: unknown[]) => mockDeleteAllUserRecords(...a),
}));

jest.mock("../services/turnstileService", () => ({
  TurnstileService: {
    getCaptchaRequestPolicy: (...a: unknown[]) => mockGetCaptchaRequestPolicy(...a),
    verifyCaptchaChallenge: (...a: unknown[]) => mockVerifyCaptchaChallenge(...a),
  },
}));

jest.mock("../services/auditLogService", () => ({
  AuditLogService: { log: (...a: unknown[]) => mockAuditLog(...a) },
}));

jest.mock("../services/sharedStateStore", () => ({
  sharedStateStore: {
    withLock: (_key: string, _ttlMs: number, criticalSection: () => unknown) => criticalSection(),
    claim: (...a: unknown[]) => mockStateClaim(...a),
    get: (...a: unknown[]) => mockStateGet(...a),
    set: (...a: unknown[]) => mockStateSet(...a),
    delete: (...a: unknown[]) => mockStateDelete(...a),
  },
}));

import { type LotteryPrize, type LotteryRound, lotteryService, pickPrize } from "../services/lotteryService";

function prize(overrides: Partial<LotteryPrize> & { id: string }): LotteryPrize {
  return {
    name: overrides.id,
    description: "",
    value: 1,
    probability: 1,
    quantity: 10,
    remaining: 10,
    category: "common",
    ...overrides,
  };
}

function makeRound(overrides: Partial<LotteryRound> = {}): LotteryRound {
  const now = Date.now();
  return {
    id: "r1",
    name: "轮次",
    description: "desc",
    startTime: now - 60_000,
    endTime: now + 60_000,
    isActive: true,
    prizes: [],
    participants: [],
    winners: [],
    blockchainHeight: 1,
    seed: "seed",
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // 区块链高度只是展示信息：让 fetch 失败即走时间戳回退，测试不打外网。
  (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({ ok: false, json: async () => ({}) }));
  mockGetAllRounds.mockResolvedValue([]);
  mockGetCaptchaRequestPolicy.mockResolvedValue({ required: false });
  mockVerifyCaptchaChallenge.mockResolvedValue(true);
  mockGetUserRecord.mockResolvedValue(null);
  mockGetUserRecordsByIds.mockResolvedValue([]);
  mockUpdateRound.mockImplementation(async (id: string, data: Record<string, unknown>) => ({ id, ...data }));
  mockUpdateUserRecord.mockResolvedValue(undefined);
  // 默认：幂等键能抢到、审计写入成功（各用例按需覆盖）。
  mockStateClaim.mockResolvedValue(true);
  mockStateGet.mockResolvedValue(null);
  mockStateSet.mockResolvedValue(true);
  mockStateDelete.mockResolvedValue(true);
  mockAuditLog.mockResolvedValue(undefined);
});

describe("pickPrize 概率语义", () => {
  it("概率和 < 1：落在剩余区间就是未中奖，不再补贴给第一个奖品", () => {
    const prizes = [prize({ id: "a", probability: 0.3 }), prize({ id: "b", probability: 0.2 })];

    expect(pickPrize(prizes, 0.1)?.id).toBe("a");
    expect(pickPrize(prizes, 0.4)?.id).toBe("b");
    expect(pickPrize(prizes, 0.5)).toBeNull();
    expect(pickPrize(prizes, 0.99)).toBeNull();
  });

  it("概率和 > 1：按相对权重归一化后必中", () => {
    const prizes = [prize({ id: "a", probability: 0.8 }), prize({ id: "b", probability: 0.8 })];

    expect(pickPrize(prizes, 0.1)?.id).toBe("a");
    expect(pickPrize(prizes, 0.9)?.id).toBe("b");
  });

  it("跳过无库存与零概率的奖品", () => {
    expect(pickPrize([prize({ id: "a", probability: 0.5, remaining: 0 }), prize({ id: "b", probability: 0.5 })], 0.2)?.id).toBe("b");
    expect(pickPrize([prize({ id: "a", probability: 0 })], 0.1)).toBeNull();
    expect(pickPrize([], 0.1)).toBeNull();
  });
});

describe("participateInLottery", () => {
  it("中奖：扣减库存、记入 winners、用户统计 +1", async () => {
    const round = makeRound({ prizes: [prize({ id: "p1", probability: 1, quantity: 2, remaining: 2 })] });
    mockGetAllRounds.mockResolvedValue([round]);
    mockGetUserRecord.mockResolvedValue({ participationCount: 2, winCount: 1, totalValue: 5, history: [] });

    const winner = await lotteryService.participateInLottery(round.id, "u1", "alice", undefined, "user");

    expect(winner).toMatchObject({ userId: "u1", prizeId: "p1" });
    expect(mockUpdateRound).toHaveBeenCalledTimes(1);
    const patch = mockUpdateRound.mock.calls[0][1] as Record<string, any>;
    expect(patch.participants).toEqual(["u1"]);
    expect(patch.prizes).toEqual([expect.objectContaining({ id: "p1", remaining: 1 })]);
    expect(patch.winners).toHaveLength(1);
    expect(mockUpdateUserRecord).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({ participationCount: 3, winCount: 2, totalValue: 6 }),
    );
  });

  it("未中奖：参与仍然计入，但不进 winners、不加中奖统计", async () => {
    // probability 极小 ⇒ 随机值几乎必然落在未中奖区间（无需 mock crypto）。
    const round = makeRound({ prizes: [prize({ id: "p1", probability: 1e-9, quantity: 2, remaining: 2 })] });
    mockGetAllRounds.mockResolvedValue([round]);

    const winner = await lotteryService.participateInLottery(round.id, "u1", "alice", undefined, "user");

    expect(winner).toBeNull();
    const patch = mockUpdateRound.mock.calls[0][1] as Record<string, any>;
    expect(patch.participants).toEqual(["u1"]);
    expect(patch.winners).toEqual([]);
    expect(patch.prizes).toEqual([expect.objectContaining({ remaining: 2 })]);
    expect(mockUpdateUserRecord).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({ participationCount: 1, winCount: 0, totalValue: 0, history: [] }),
    );
  });

  it("奖品全部领完时明确报错（不是「未中奖」）", async () => {
    const round = makeRound({ prizes: [prize({ id: "p1", probability: 1, quantity: 1, remaining: 0 })] });
    mockGetAllRounds.mockResolvedValue([round]);

    await expect(lotteryService.participateInLottery(round.id, "u1", "alice", undefined, "user")).rejects.toThrow(
      "没有可用的奖品",
    );
    expect(mockUpdateRound).not.toHaveBeenCalled();
  });

  it("重复参与被拒，不写库", async () => {
    const round = makeRound({ drawCounts: { u1: 1 }, prizes: [prize({ id: "p1", probability: 1 })] });
    mockGetAllRounds.mockResolvedValue([round]);

    await expect(lotteryService.participateInLottery(round.id, "u1", "alice", undefined, "user")).rejects.toThrow(
      "您已经参与过此轮抽奖",
    );
    expect(mockUpdateRound).not.toHaveBeenCalled();
  });

  it("非活跃轮次被拒", async () => {
    const round = makeRound({ isActive: false, prizes: [prize({ id: "p1", probability: 1 })] });
    mockGetAllRounds.mockResolvedValue([round]);

    await expect(lotteryService.participateInLottery(round.id, "u1", "alice", undefined, "user")).rejects.toThrow(
      "抽奖轮次已结束",
    );
  });

  it("轮次不存在时报错", async () => {
    mockGetAllRounds.mockResolvedValue([]);

    await expect(lotteryService.participateInLottery("nope", "u1", "alice", undefined, "user")).rejects.toThrow(
      "抽奖轮次不存在",
    );
  });

  it("要求人机验证时缺令牌被拒，管理员豁免", async () => {
    const round = makeRound({ prizes: [prize({ id: "p1", probability: 1 })] });
    mockGetAllRounds.mockResolvedValue([round]);
    mockGetCaptchaRequestPolicy.mockResolvedValue({ required: true });

    await expect(lotteryService.participateInLottery(round.id, "u1", "alice", undefined, "user")).rejects.toThrow(
      "需要完成人机验证才能参与抽奖",
    );

    const winner = await lotteryService.participateInLottery(round.id, "admin1", "root", undefined, "admin");
    expect(winner).toMatchObject({ prizeId: "p1" });
    expect(mockVerifyCaptchaChallenge).not.toHaveBeenCalled();
  });
});

describe("幂等与审计（PRD §4）", () => {
  it("同一 requestId 的重放直接返回上次结果，不产生第二次抽奖", async () => {
    const round = makeRound({ prizes: [prize({ id: "p1", probability: 1, quantity: 2, remaining: 2 })] });
    mockGetAllRounds.mockResolvedValue([round]);
    const context = { requestId: "rid-1" };

    const first = await lotteryService.participateInLottery(round.id, "u1", "alice", undefined, "user", undefined, context);
    expect(first).toMatchObject({ prizeId: "p1" });
    expect(mockUpdateRound).toHaveBeenCalledTimes(1);
    expect(mockStateSet).toHaveBeenCalledWith(
      "lottery:idem:u1:rid-1",
      { roundId: round.id, winner: first },
      expect.any(Number),
    );

    // 重放：幂等键已被上次占用，读到上次结果
    mockStateClaim.mockResolvedValueOnce(false);
    mockStateGet.mockResolvedValueOnce({ roundId: round.id, winner: first });
    const replay = await lotteryService.participateInLottery(round.id, "u1", "alice", undefined, "user", undefined, context);

    expect(replay).toEqual(first);
    expect(mockUpdateRound).toHaveBeenCalledTimes(1);
  });

  it("同一 requestId 仍在处理中时拒绝重抽，同一 id 换轮次也被拒", async () => {
    const round = makeRound({ prizes: [prize({ id: "p1", probability: 1 })] });
    mockGetAllRounds.mockResolvedValue([round]);
    mockStateClaim.mockResolvedValueOnce(false);
    mockStateGet.mockResolvedValueOnce("pending");

    await expect(
      lotteryService.participateInLottery(round.id, "u1", "alice", undefined, "user", undefined, { requestId: "rid-1" }),
    ).rejects.toThrow("正在处理中");
    expect(mockUpdateRound).not.toHaveBeenCalled();
  });

  it("业务拒绝会释放幂等键，同一 requestId 可安全重试", async () => {
    const round = makeRound({ drawCounts: { u1: 1 }, prizes: [prize({ id: "p1", probability: 1 })] });
    mockGetAllRounds.mockResolvedValue([round]);

    await expect(
      lotteryService.participateInLottery(round.id, "u1", "alice", undefined, "user", undefined, { requestId: "rid-1" }),
    ).rejects.toThrow("已经参与过");

    expect(mockStateDelete).toHaveBeenCalledWith("lottery:idem:u1:rid-1");
  });

  it("每次抽奖都留一条 lottery.draw 审计：含随机数快照与落点", async () => {
    const round = makeRound({ prizes: [prize({ id: "p1", probability: 1, quantity: 2, remaining: 2 })] });
    mockGetAllRounds.mockResolvedValue([round]);

    await lotteryService.participateInLottery(round.id, "u1", "alice", undefined, "user", undefined, {
      requestId: "rid-1",
      ip: "1.2.3.4",
    });

    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "lottery.draw",
        module: "lottery",
        userId: "u1",
        targetId: round.id,
        ip: "1.2.3.4",
        detail: expect.objectContaining({
          roundId: round.id,
          outcome: "win",
          prizeId: "p1",
          remainingAfter: 1,
          requestId: "rid-1",
        }),
      }),
    );
  });

  it("未中奖也留审计，outcome 为 no_win", async () => {
    const round = makeRound({ prizes: [prize({ id: "p1", probability: 1e-9, quantity: 2, remaining: 2 })] });
    mockGetAllRounds.mockResolvedValue([round]);

    await lotteryService.participateInLottery(round.id, "u1", "alice", undefined, "user");

    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.objectContaining({ outcome: "no_win", prizeId: null }) }),
    );
  });
});

describe("多次抽奖 / 保底 / 机会", () => {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());

  it("maxDrawsPerUser 允许多次抽取，次数用尽后拒绝", async () => {
    const round = makeRound({
      maxDrawsPerUser: 2,
      prizes: [prize({ id: "p1", probability: 1, quantity: 5, remaining: 5 })],
    });
    mockGetAllRounds.mockResolvedValue([round]);

    const first = await lotteryService.participateInLottery(round.id, "u1", "alice", undefined, "user");
    expect(first).toMatchObject({ prizeId: "p1" });
    const patch = mockUpdateRound.mock.calls[0][1] as Record<string, any>;
    expect(patch.drawCounts).toEqual({ u1: 1 });
    expect(patch.participants).toEqual(["u1"]);

    // 第二次：把最新轮次换成已抽 2 次，验证上限
    mockGetAllRounds.mockResolvedValue([
      makeRound({ maxDrawsPerUser: 2, drawCounts: { u1: 2 }, prizes: [prize({ id: "p1", probability: 1 })] }),
    ]);
    await expect(lotteryService.participateInLottery(round.id, "u1", "alice", undefined, "user")).rejects.toThrow(
      "您已经参与过此轮抽奖",
    );
  });

  it("多抽时 participants 去重（仍是“参与过的用户”列表）", async () => {
    const round = makeRound({
      maxDrawsPerUser: 3,
      drawCounts: { u1: 1 },
      participants: ["u1"],
      prizes: [prize({ id: "p1", probability: 1, quantity: 5, remaining: 5 })],
    });
    mockGetAllRounds.mockResolvedValue([round]);

    await lotteryService.participateInLottery(round.id, "u1", "alice", undefined, "user");

    const patch = mockUpdateRound.mock.calls[0][1] as Record<string, any>;
    expect(patch.participants).toEqual(["u1"]);
    expect(patch.drawCounts).toEqual({ u1: 2 });
  });

  it("保底：到指定抽数时至少出该稀有度（没有符合条件的有库存奖品则回落普通抽取）", async () => {
    const common = prize({ id: "common", probability: 0.99, category: "common", quantity: 5, remaining: 5 });
    const epic = prize({ id: "epic", probability: 0.0001, category: "epic", quantity: 5, remaining: 5 });
    const round = makeRound({ guarantee: { everyDraws: 2, category: "epic" }, drawCounts: { u1: 1 }, prizes: [common, epic] });
    mockGetAllRounds.mockResolvedValue([round]);

    const winner = await lotteryService.participateInLottery(round.id, "u1", "alice", undefined, "user");
    expect(winner).toMatchObject({ prizeId: "epic" });
  });

  it("机会不足时拒绝抽取，不写库", async () => {
    const round = makeRound({ chanceCost: 1, prizes: [prize({ id: "p1", probability: 1 })] });
    mockGetAllRounds.mockResolvedValue([round]);
    mockGetUserRecord.mockResolvedValue({ chanceBalance: 0, chanceDay: today, history: [] });

    await expect(lotteryService.participateInLottery(round.id, "u1", "alice", undefined, "user")).rejects.toThrow(
      "抽奖机会不足",
    );
    expect(mockUpdateRound).not.toHaveBeenCalled();
  });

  it("消耗机会后抽取成功（余额按 cost 扣减）", async () => {
    const round = makeRound({ chanceCost: 2, prizes: [prize({ id: "p1", probability: 1 })] });
    mockGetAllRounds.mockResolvedValue([round]);
    mockGetUserRecord.mockResolvedValue({ chanceBalance: 5, chanceDay: today, history: [] });

    const winner = await lotteryService.participateInLottery(round.id, "u1", "alice", undefined, "user");
    expect(winner).toMatchObject({ prizeId: "p1" });
    expect(mockUpdateUserRecord).toHaveBeenCalledWith(
      "u1",
      expect.objectContaining({ chanceBalance: 3, chanceDay: today }),
    );
  });

  it("当天首次读机会时发放每日免费额度并落天键", async () => {
    mockGetUserRecord.mockResolvedValue({ history: [] });
    const result = await lotteryService.getChances("u1");

    expect(result).toEqual({ balance: 0, dailyFree: 0 });
    expect(mockUpdateUserRecord).toHaveBeenCalledWith("u1", expect.objectContaining({ chanceDay: today, chanceBalance: 0 }));
  });

  it("超管发放机会：余额累加并写审计", async () => {
    mockGetUserRecord.mockResolvedValue({ chanceBalance: 2, chanceDay: today, history: [] });
    const balance = await lotteryService.grantChances("u1", 3, { userId: "admin", username: "root", role: "superadmin" });

    expect(balance).toBe(5);
    expect(mockUpdateUserRecord).toHaveBeenCalledWith("u1", expect.objectContaining({ chanceBalance: 5 }));
    expect(mockAuditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "lottery.chances_grant", module: "lottery" }));
  });
});

describe("统计与清理", () => {
  it("统计只读一次轮次，用户记录批量读取", async () => {
    const now = Date.now();
    mockGetAllRounds.mockResolvedValue([
      makeRound({ id: "r1", participants: ["u1", "u2"], winners: [{ userId: "u1", username: "a", prizeId: "p", prizeName: "p", drawTime: now }] }),
      makeRound({ id: "r2", isActive: false, participants: ["u2"], winners: [] }),
    ]);
    mockGetUserRecordsByIds.mockResolvedValue([{ totalValue: 10 }, { totalValue: 5 }]);

    const stats = await lotteryService.getStatistics();

    expect(mockGetAllRounds).toHaveBeenCalledTimes(1);
    expect(mockGetUserRecordsByIds).toHaveBeenCalledWith(["u1", "u2"]);
    expect(stats).toEqual({
      totalRounds: 2,
      activeRounds: 1,
      totalParticipants: 3,
      totalWinners: 1,
      totalValue: 15,
    });
  });

  it("删除所有轮次时同时清空用户记录，避免残留孤儿中奖历史", async () => {
    await lotteryService.deleteAllRounds();

    expect(mockDeleteAllRounds).toHaveBeenCalledTimes(1);
    expect(mockDeleteAllUserRecords).toHaveBeenCalledTimes(1);
  });
});
