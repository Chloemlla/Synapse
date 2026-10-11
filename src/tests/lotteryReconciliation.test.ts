import { describe, expect, it } from "@jest/globals";
import { buildT0Report, buildT1Report } from "../services/lottery/reconciliation";
import type { LotteryRound, UserLotteryRecord } from "../services/lotteryService";

function round(overrides: Partial<LotteryRound> = {}): LotteryRound {
  return {
    id: "r1",
    name: "轮次",
    description: "",
    startTime: 0,
    endTime: 0,
    isActive: true,
    prizes: [
      { id: "p1", name: "大奖", description: "", value: 100, probability: 1, quantity: 2, remaining: 2, category: "epic" },
      { id: "p2", name: "小奖", description: "", value: 1, probability: 1, quantity: 5, remaining: 5, category: "common" },
    ],
    participants: [],
    winners: [],
    blockchainHeight: 1,
    seed: "",
    ...overrides,
  };
}

function record(overrides: Partial<UserLotteryRecord> & { userId: string }): UserLotteryRecord {
  return {
    username: overrides.userId,
    participationCount: 1,
    winCount: 1,
    lastDrawTime: 0,
    totalValue: 0,
    history: [],
    ...overrides,
  };
}

describe("对账构建（纯函数）", () => {
  it("T+0：DB 剩余与「按中奖记录推算的应有剩余」逐奖品对比", () => {
    const r = round({
      winners: [
        { userId: "u1", username: "a", prizeId: "p1", prizeName: "大奖", drawTime: 1 },
        { userId: "u2", username: "b", prizeId: "p1", prizeName: "大奖", drawTime: 2 },
      ],
    });
    // DB 少扣了 1 份（应剩 0，实剩 1）→ drift +1
    r.prizes[0].remaining = 1;

    const report = buildT0Report(r, { p1: 0, p2: 5 }, 123);

    expect(report.checkedAt).toBe(123);
    expect(report.driftPrizes).toBe(1);
    const p1 = report.prizes.find((item) => item.prizeId === "p1")!;
    expect(p1).toMatchObject({ quantity: 2, awarded: 2, expectedRemaining: 0, dbRemaining: 1, drift: 1 });
    expect(p1.redisRemaining).toBe(0);
    const p2 = report.prizes.find((item) => item.prizeId === "p2")!;
    expect(p2.drift).toBe(0);
  });

  it("T+0：无偏差时不报 drift", () => {
    const r = round({ winners: [{ userId: "u1", username: "a", prizeId: "p2", prizeName: "小奖", drawTime: 1 }] });
    r.prizes[1].remaining = 4;

    const report = buildT0Report(r);
    expect(report.driftPrizes).toBe(0);
  });

  it("T+1：用户累计价值与按中奖记录推算价值一致则无偏差", () => {
    const rounds = [
      round({
        winners: [{ userId: "u1", username: "a", prizeId: "p1", prizeName: "大奖", drawTime: 1 }],
      }),
    ];
    const records = [record({ userId: "u1", totalValue: 100 })];

    const report = buildT1Report(rounds, records, 456);

    expect(report).toMatchObject({
      generatedAt: 456,
      winnerCount: 1,
      winnerTotalValue: 100,
      userTotalValue: 100,
      valueDrift: 0,
      mismatchedUsers: [],
    });
  });

  it("T+1：价值不一致时列出用户并给出总偏差", () => {
    const rounds = [
      round({
        winners: [{ userId: "u1", username: "a", prizeId: "p1", prizeName: "大奖", drawTime: 1 }],
      }),
    ];
    const records = [record({ userId: "u1", totalValue: 50 }), record({ userId: "u2", totalValue: 0 })];

    const report = buildT1Report(rounds, records);

    expect(report.valueDrift).toBe(-50);
    expect(report.mismatchedUsers).toEqual(["u1"]);
  });
});
