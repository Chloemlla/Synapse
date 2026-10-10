import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockCreateRound = jest.fn();
const mockGetRounds = jest.fn();
const mockParticipate = jest.fn();

jest.mock("../middleware/auth", () => ({
  isAdminRole: (role: unknown) => role === "admin" || role === "superadmin",
  isSuperAdmin: (req: { user?: { role?: string } }) => req?.user?.role === "superadmin",
}));

jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock("../services/lotteryService", () => ({
  lotteryService: {
    createLotteryRound: (...a: unknown[]) => mockCreateRound(...a),
    getLotteryRounds: (...a: unknown[]) => mockGetRounds(...a),
    getActiveRounds: jest.fn(),
    getRoundDetails: jest.fn(),
    getStatistics: jest.fn(),
    getLeaderboard: jest.fn(),
    getUserRecord: jest.fn(),
    updateRoundStatus: jest.fn(),
    resetRound: jest.fn(),
    deleteAllRounds: jest.fn(),
    getBlockchainData: jest.fn(),
    participateInLottery: (...a: unknown[]) => mockParticipate(...a),
  },
}));

import { lotteryController } from "../controllers/lotteryController";

interface FakeRes {
  statusCode: number;
  body?: any;
  status: (code: number) => FakeRes;
  json: (body: unknown) => FakeRes;
}

function createRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 200,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
  };
  return res;
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    name: "国庆抽奖",
    description: "一起抽奖",
    startTime: "2026-10-01T00:00:00Z",
    endTime: "2026-10-02T00:00:00Z",
    prizes: [{ name: "一等奖", description: "大奖", value: 100, probability: 0.5, quantity: 2, remaining: 0 }],
    ...overrides,
  };
}

const superadminReq = (body: unknown) => ({ user: { id: "a1", role: "superadmin" }, body }) as any;

beforeEach(() => {
  jest.clearAllMocks();
  mockCreateRound.mockResolvedValue({ id: "r1" });
  mockGetRounds.mockResolvedValue([]);
  mockParticipate.mockResolvedValue(null);
});

describe("createLotteryRound 入参硬化", () => {
  it("库存由服务端按数量初始化，不采信客户端传的 remaining", async () => {
    const res = createRes();
    await lotteryController.createLotteryRound(superadminReq(validBody()), res as any);

    expect(res.body.success).toBe(true);
    const arg = mockCreateRound.mock.calls[0][0] as any;
    expect(arg.prizes[0]).toMatchObject({ remaining: 2, quantity: 2, probability: 0.5 });
  });

  it("概率和 > 1 时归一化并回传 warning", async () => {
    const res = createRes();
    const body = validBody({
      prizes: [
        { name: "a", description: "d", value: 1, probability: 0.8, quantity: 1 },
        { name: "b", description: "d", value: 1, probability: 0.8, quantity: 1 },
      ],
    });
    await lotteryController.createLotteryRound(superadminReq(body), res as any);

    const arg = mockCreateRound.mock.calls[0][0] as any;
    expect(arg.prizes[0].probability).toBeCloseTo(0.5, 6);
    expect(arg.prizes[1].probability).toBeCloseTo(0.5, 6);
    expect(res.body.warning).toContain("归一化");
  });

  it("开始时间晚于结束时间时自动交换并给出 warning", async () => {
    const res = createRes();
    const body = validBody({ startTime: "2026-10-05T00:00:00Z", endTime: "2026-10-02T00:00:00Z" });
    await lotteryController.createLotteryRound(superadminReq(body), res as any);

    const arg = mockCreateRound.mock.calls[0][0] as any;
    expect(arg.startTime).toBeLessThan(arg.endTime);
    expect(res.body.warning).toContain("自动调整");
  });

  it("时间不可解析时拒绝（NaN 落库会让轮次永远不活跃）", async () => {
    const res = createRes();
    await lotteryController.createLotteryRound(superadminReq(validBody({ startTime: "not-a-date" })), res as any);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("时间格式非法");
    expect(mockCreateRound).not.toHaveBeenCalled();
  });

  it("概率超出 0-1 时拒绝", async () => {
    const res = createRes();
    const body = validBody({ prizes: [{ name: "a", description: "d", value: 1, probability: 1.5, quantity: 1 }] });
    await lotteryController.createLotteryRound(superadminReq(body), res as any);

    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain("概率");
    expect(mockCreateRound).not.toHaveBeenCalled();
  });

  it("非超管拒绝", async () => {
    const res = createRes();
    await lotteryController.createLotteryRound(
      { user: { id: "u1", role: "user" }, body: validBody() } as any,
      res as any,
    );

    expect(res.statusCode).toBe(403);
    expect(mockCreateRound).not.toHaveBeenCalled();
  });
});

describe("轮次视图隐私", () => {
  const round = {
    id: "r1",
    name: "轮次",
    description: "d",
    startTime: 1,
    endTime: 2,
    isActive: true,
    prizes: [],
    participants: ["u1", "u2"],
    winners: [{ userId: "u1", username: "alice", prizeId: "p1", prizeName: "奖品", drawTime: 1 }],
    blockchainHeight: 1,
    seed: "seed",
  };

  it("普通用户只拿到「本人是否已参与 + 计数」，不含内部用户 id", async () => {
    mockGetRounds.mockResolvedValue([round]);
    const res = createRes();
    await lotteryController.getLotteryRounds({ user: { id: "u1", role: "user" } } as any, res as any);

    const view = res.body.data[0];
    expect(view).toMatchObject({ participants: [], hasParticipated: true, participantCount: 2, winnerCount: 1 });
    expect(view.winners[0]).not.toHaveProperty("userId");
    expect(view.participants).toEqual([]);
  });

  it("管理员拿完整数据（要按 id 排查异常）", async () => {
    mockGetRounds.mockResolvedValue([round]);
    const res = createRes();
    await lotteryController.getLotteryRounds(superadminReq(undefined), res as any);

    expect(res.body.data[0].participants).toEqual(["u1", "u2"]);
    expect(res.body.data[0].winners[0]).toHaveProperty("userId", "u1");
  });
});

describe("参与抽奖的幂等入参", () => {
  it("把 requestId 与请求元信息透传给服务层（PRD §4）", async () => {
    const res = createRes();
    await lotteryController.participateInLottery(
      {
        user: { id: "u1", username: "alice", role: "user" },
        params: { roundId: "r1" },
        body: { requestId: "rid-1" },
        ip: "1.2.3.4",
        headers: { "user-agent": "ua-1" },
      } as any,
      res as any,
    );

    expect(mockParticipate).toHaveBeenCalledWith(
      "r1",
      "u1",
      "alice",
      undefined,
      "user",
      undefined,
      { requestId: "rid-1", ip: "1.2.3.4", userAgent: "ua-1" },
    );
  });

  it("缺失 requestId 时传 undefined（幂等为可选能力）", async () => {
    const res = createRes();
    await lotteryController.participateInLottery(
      { user: { id: "u1", username: "alice", role: "user" }, params: { roundId: "r1" }, body: {}, ip: "1.2.3.4", headers: {} } as any,
      res as any,
    );

    expect(mockParticipate.mock.calls[0][6]).toMatchObject({ requestId: undefined, ip: "1.2.3.4" });
  });
});
