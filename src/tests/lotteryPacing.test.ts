import { describe, expect, it } from "@jest/globals";
import { applyPacing, isPrizeWithinPacingQuota, pacingWindowIndex } from "../services/lottery/pacing";
import type { LotteryPrize } from "../services/lotteryService";

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

describe("lottery/pacing", () => {
  it("pacingWindowIndex：相对轮次开始按窗宽取整", () => {
    expect(pacingWindowIndex(1000, 1000, 3600_000)).toBe(0);
    expect(pacingWindowIndex(1000, 1000 + 3600_000, 3600_000)).toBe(1);
    expect(pacingWindowIndex(1000, 1000 + 3600_000 * 3 + 5, 3600_000)).toBe(3);
    // 传 0/负数窗宽退化为 0，不抛错
    expect(pacingWindowIndex(0, 999, 0)).toBe(0);
  });

  it("isPrizeWithinPacingQuota：无配置不限；配额用尽即超出", () => {
    const unlimited = prize({ id: "a" });
    expect(isPrizeWithinPacingQuota(unlimited, 0)).toBe(true);

    const paced = prize({ id: "b", pacing: { periodMs: 3600_000, quotaPerWindow: 2 }, pacingAwards: { "0": 2 } });
    expect(isPrizeWithinPacingQuota(paced, 0)).toBe(false);
    expect(isPrizeWithinPacingQuota(paced, 1)).toBe(true);
  });

  it("applyPacing：窗口用尽的奖品被剔除（等价权重 0）", () => {
    const common = prize({ id: "common" });
    const big = prize({ id: "big", pacing: { periodMs: 3600_000, quotaPerWindow: 1 }, pacingAwards: { "0": 1 } });
    const start = 0;
    const now = 1000;

    const filtered = applyPacing([common, big], start, now);
    expect(filtered.map((item) => item.id)).toEqual(["common"]);
  });

  it("applyPacing：没有 pacing 配置时原样返回（不产生额外分配）", () => {
    const prizes = [prize({ id: "a" }), prize({ id: "b" })];
    expect(applyPacing(prizes, 0, 1000)).toBe(prizes);
  });
});
