import { describe, expect, it } from "@jest/globals";
import { applyVariantWeights, assignVariant, buildAbStats, hashToUnit } from "../services/lottery/abTest";
import type { LotteryRound } from "../services/lotteryService";

describe("lottery/abTest", () => {
  it("hashToUnit 稳定且落在 [0,1)", () => {
    const a = hashToUnit("r1:u1");
    expect(a).toBe(hashToUnit("r1:u1"));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(1);
    expect(hashToUnit("r1:u2")).not.toBe(a);
  });

  it("同一用户在轮次内稳定命中同一变体", () => {
    const abTest = { enabled: true, variants: [{ key: "A", weight: 1 }, { key: "B", weight: 3 }] };
    const first = assignVariant(abTest, "r1", "u1");
    for (let i = 0; i < 5; i += 1) {
      expect(assignVariant(abTest, "r1", "u1")?.key).toBe(first?.key);
    }
  });

  it("两个等权变体在样本里都会出现；未启用/零权重返回 null", () => {
    const abTest = { enabled: true, variants: [{ key: "A", weight: 1 }, { key: "B", weight: 1 }] };
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) seen.add(assignVariant(abTest, "r1", `u${i}`)!.key);
    expect([...seen].sort()).toEqual(["A", "B"]);

    expect(assignVariant({ enabled: false, variants: [{ key: "A", weight: 1 }] }, "r1", "u1")).toBeNull();
    expect(assignVariant({ enabled: true, variants: [{ key: "A", weight: 0 }] }, "r1", "u1")).toBeNull();
  });

  it("applyVariantWeights 按乘数调整概率且不改原数组", () => {
    const prizes = [{ id: "p1", probability: 0.2 }, { id: "p2", probability: 0.3 }];
    const result = applyVariantWeights(prizes, { key: "A", weight: 1, prizeWeightOverrides: { p1: 2, p2: 0 } });
    expect(result[0].probability).toBeCloseTo(0.4, 6);
    expect(result[1].probability).toBe(0);
    expect(prizes[0].probability).toBe(0.2);
  });

  it("buildAbStats 汇总抽数/中奖/价值/胜率", () => {
    const round = {
      id: "r1",
      abTest: { enabled: true, variants: [{ key: "A", weight: 1 }, { key: "B", weight: 1 }] },
      drawCountsByVariant: { A: 10, B: 10 },
      prizes: [{ id: "p1", name: "p", description: "", value: 50, probability: 1, quantity: 10, remaining: 5, category: "common" }],
      winners: [
        { userId: "u1", username: "a", prizeId: "p1", prizeName: "p", drawTime: 1, variantKey: "A" },
        { userId: "u2", username: "b", prizeId: "p1", prizeName: "p", drawTime: 2, variantKey: "A" },
        { userId: "u3", username: "c", prizeId: "p1", prizeName: "p", drawTime: 3, variantKey: "B" },
      ],
    } as unknown as LotteryRound;

    const stats = buildAbStats(round);
    const a = stats.find((item) => item.key === "A")!;
    const b = stats.find((item) => item.key === "B")!;
    expect(a).toMatchObject({ draws: 10, wins: 2, value: 100 });
    expect(a.winRate).toBeCloseTo(0.2, 6);
    expect(b).toMatchObject({ draws: 10, wins: 1, value: 50 });
  });
});
