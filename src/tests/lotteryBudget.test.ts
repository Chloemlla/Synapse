import { describe, expect, it } from "@jest/globals";
import { awardedValueOf, evaluateBudget, findPlaceholderPrize } from "../services/lottery/budget";
import type { LotteryRound } from "../services/lotteryService";

function round(overrides: Partial<LotteryRound> = {}): LotteryRound {
  return {
    id: "r1",
    name: "轮次",
    description: "",
    startTime: 0,
    endTime: 0,
    isActive: true,
    prizes: [
      { id: "big", name: "大奖", description: "", value: 100, probability: 0.1, quantity: 1, remaining: 1, category: "legendary" },
      { id: "air", name: "谢谢参与", description: "", value: 0, probability: 0.9, quantity: 100, remaining: 100, category: "common" },
    ],
    participants: [],
    winners: [],
    blockchainHeight: 1,
    seed: "",
    ...overrides,
  };
}

describe("lottery/budget 预算熔断", () => {
  it("awardedValueOf 按奖品价值累计历史中奖", () => {
    const r = round({ winners: [{ userId: "u1", username: "a", prizeId: "big", prizeName: "大奖", drawTime: 1 }] });
    expect(awardedValueOf(r)).toBe(100);
  });

  it("未配置预算时不限制", () => {
    expect(evaluateBudget(undefined, 9999, 100).action).toBe("allow");
  });

  it("会超预算的本次出奖降级为未中奖（downgrade）；已超预算则停用（pause）", () => {
    const budget = { maxTotalValue: 100, warningRatio: 0.8 };
    // 已发 50，再出 100 会超 → 降级
    const downgrade = evaluateBudget(budget, 50, 100);
    expect(downgrade.action).toBe("downgrade");
    expect(downgrade.projectedValue).toBe(150);

    // 已发 100 → 停用
    expect(evaluateBudget(budget, 100, 1).action).toBe("pause");
  });

  it("跨过预警线时给出 crossedWarning", () => {
    const decision = evaluateBudget({ maxTotalValue: 100, warningRatio: 0.8 }, 70, 20);
    expect(decision.action).toBe("allow");
    expect(decision.crossedWarning).toBe(true);
  });

  it("findPlaceholderPrize 找价值为 0 且有库存的空奖", () => {
    expect(findPlaceholderPrize(round().prizes)?.id).toBe("air");
    expect(findPlaceholderPrize([round().prizes[0]])).toBeNull();
  });
});
