import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockCreate = jest.fn();
const mockFind = jest.fn();
const mockFindOne = jest.fn();
const mockFindOneAndUpdate = jest.fn();
const mockUpdateMany = jest.fn();
const mockSendAdminAlert = jest.fn();
const mockGetUserRecord = jest.fn();
const mockUpdateUserRecord = jest.fn();

function chain(result: unknown) {
  const q: any = {
    sort: () => q,
    select: () => q,
    limit: () => q,
    lean: () => q,
    exec: async () => result,
  };
  return q;
}

jest.mock("../models/lotteryFulfillmentModel", () => ({
  LotteryFulfillmentModel: {
    create: (...a: unknown[]) => mockCreate(...a),
    find: (...a: unknown[]) => mockFind(...a),
    findOne: (...a: unknown[]) => mockFindOne(...a),
    findOneAndUpdate: (...a: unknown[]) => mockFindOneAndUpdate(...a),
    updateMany: (...a: unknown[]) => mockUpdateMany(...a),
  },
}));

jest.mock("../services/lotteryStorage", () => ({
  getUserRecord: (...a: unknown[]) => mockGetUserRecord(...a),
  updateUserRecord: (...a: unknown[]) => mockUpdateUserRecord(...a),
}));

jest.mock("../services/sharedStateStore", () => ({
  sharedStateStore: {
    withLock: (_key: string, _ttl: number, fn: () => unknown) => fn(),
  },
}));

jest.mock("../services/adminAlertService", () => ({
  sendAdminAlert: (...a: unknown[]) => mockSendAdminAlert(...a),
}));

jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { lotteryFulfillmentService } from "../services/lotteryFulfillmentService";
import type { LotteryPrize } from "../services/lotteryService";

function prize(overrides: Partial<LotteryPrize> & { id: string }): LotteryPrize {
  return {
    name: overrides.id,
    description: "",
    value: 100,
    probability: 1,
    quantity: 1,
    remaining: 1,
    category: "common",
    ...overrides,
  };
}

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: "lf_1",
    roundId: "r1",
    userId: "u1",
    originalUserId: "u1",
    username: "alice",
    prizeId: "p1",
    prizeName: "奖品",
    prizeValue: 100,
    type: "physical",
    status: "awaiting_address",
    attempts: 0,
    createdAt: "2026-10-11T00:00:00.000Z",
    updatedAt: "2026-10-11T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCreate.mockResolvedValue(undefined);
  mockFind.mockReturnValue(chain([]));
  mockFindOne.mockReturnValue(chain(null));
  mockFindOneAndUpdate.mockReturnValue(chain(null));
  mockUpdateMany.mockReturnValue(chain({ modifiedCount: 0 }));
  mockGetUserRecord.mockResolvedValue({ assetBalance: 0 });
  mockUpdateUserRecord.mockResolvedValue(undefined);
  (globalThis as unknown as { fetch: unknown }).fetch = jest.fn();
});

describe("lotteryFulfillmentService 履约中心", () => {
  it("enqueue：虚拟/卡密落 pending，实物落 awaiting_address；无配置不落记录", async () => {
    await lotteryFulfillmentService.enqueue({
      roundId: "r1",
      userId: "u1",
      username: "alice",
      prize: prize({ id: "p1", fulfillment: { type: "virtual" } }),
    });
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ type: "virtual", status: "pending", userId: "u1" }));

    await lotteryFulfillmentService.enqueue({
      roundId: "r1",
      userId: "u1",
      username: "alice",
      prize: prize({ id: "p2", fulfillment: { type: "physical" } }),
    });
    expect(mockCreate).toHaveBeenLastCalledWith(expect.objectContaining({ type: "physical", status: "awaiting_address" }));

    mockCreate.mockClear();
    const none = await lotteryFulfillmentService.enqueue({
      roundId: "r1",
      userId: "u1",
      username: "alice",
      prize: prize({ id: "p3" }),
    });
    expect(none).toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("submitAddress：实物在可动状态才能改地址，改完转 ready", async () => {
    mockFindOne.mockReturnValueOnce(chain(record()));
    mockFindOneAndUpdate.mockReturnValueOnce(chain(record({ status: "ready", address: { name: "张三", phone: "13800000000", detail: "x", submittedAt: "t" } })));

    const updated = await lotteryFulfillmentService.submitAddress("lf_1", "u1", {
      name: "张三",
      phone: "13800000000",
      detail: "x",
    });

    expect(updated.status).toBe("ready");
    const [, update] = mockFindOneAndUpdate.mock.calls[0] as unknown as [unknown, any];
    expect(update.$set.status).toBe("ready");
    expect(update.$set.address).toMatchObject({ name: "张三" });
  });

  it("submitAddress：非实物奖品拒绝", async () => {
    mockFindOne.mockReturnValueOnce(chain(record({ type: "virtual", status: "pending" })));
    await expect(
      lotteryFulfillmentService.submitAddress("lf_1", "u1", { name: "a", phone: "1", detail: "b" }),
    ).rejects.toThrow("该奖品无需填写地址");
  });

  it("transfer：可动状态才能转赠；受赠人非法直接拒", async () => {
    await expect(lotteryFulfillmentService.transfer("lf_1", "u1", "u1")).rejects.toThrow("受赠人非法");

    mockFindOne.mockReturnValueOnce(chain(record({ status: "ready" })));
    mockFindOneAndUpdate.mockReturnValueOnce(chain(record({ userId: "u2", status: "ready" })));
    const updated = await lotteryFulfillmentService.transfer("lf_1", "u1", "u2");
    expect(updated.userId).toBe("u2");
  });

  it("redeem：按价值折成抽奖积分并标记 redeemed", async () => {
    mockFindOne.mockReturnValueOnce(chain(record({ type: "virtual", status: "completed" })));
    // completed 不可折现
    await expect(lotteryFulfillmentService.redeem("lf_1", "u1")).rejects.toThrow("该奖品当前状态不可折现");

    mockFindOne.mockReturnValueOnce(chain(record({ type: "virtual", status: "ready", prizeValue: 100 })));
    mockFindOneAndUpdate.mockReturnValueOnce(chain(record({ status: "redeemed" })));

    const result = await lotteryFulfillmentService.redeem("lf_1", "u1");

    expect(result).toEqual({ value: 100, balance: 100 });
    expect(mockUpdateUserRecord).toHaveBeenCalledWith("u1", expect.objectContaining({ assetBalance: 100 }));
  });

  it("recoverStale：超时且超限进死信并告警，未超限回 pending", async () => {
    mockFind.mockReturnValueOnce(chain([{ id: "lf_dead" }]));
    mockFindOneAndUpdate.mockReturnValueOnce(chain(record({ id: "lf_dead", status: "failed", attempts: 3 })));
    mockUpdateMany.mockReturnValueOnce(chain({ modifiedCount: 2 }));

    const result = await lotteryFulfillmentService.recoverStale(Date.now());
    for (let i = 0; i < 5 && mockSendAdminAlert.mock.calls.length === 0; i += 1) await Promise.resolve();

    expect(result.recovered).toBe(2);
    expect(result.failed.map((item) => item.id)).toEqual(["lf_dead"]);
    expect(mockSendAdminAlert).toHaveBeenCalledWith(expect.objectContaining({ level: "critical" }));
    // 死信条件里必须带「仍超时 + 超限」，不能只按 id 更新
    const [filter] = mockFindOneAndUpdate.mock.calls[0] as unknown as [Record<string, any>];
    expect(filter).toMatchObject({ id: "lf_dead", status: "processing", attempts: { $gte: 3 } });
  });
});
