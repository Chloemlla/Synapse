import type { LotteryPrize, LotteryRound } from "../lotteryService";

/**
 * 预算熔断器（PRD §3.6）：按当期最高中奖成本控制出奖。
 * - 预警线（warningRatio）：累计中奖价值达到 `maxTotalValue * warningRatio` 时记预警（降权由运营决定）；
 * - 熔断线（maxTotalValue）：再出一份就会超预算时**本次降级为未中奖**，并把轮次自动停用。
 */
export interface LotteryBudget {
  /** 本轮最高中奖成本（价值单位）。 */
  maxTotalValue: number;
  /** 预警线比例（0-1，默认 0.8）。 */
  warningRatio?: number;
}

export type LotteryBudgetAction = "allow" | "downgrade" | "pause";

export interface LotteryBudgetDecision {
  action: LotteryBudgetAction;
  awardedValue: number;
  /** 若本次出奖后的累计价值。 */
  projectedValue: number;
  budget: number;
  /** 是否跨过预警线（本次出奖导致）。 */
  crossedWarning: boolean;
}

/** 本轮已发奖价值（按奖品当前价值折算，含历史中奖记录）。 */
export function awardedValueOf(round: LotteryRound): number {
  const valueByPrize = new Map<string, number>();
  for (const prize of round.prizes) valueByPrize.set(prize.id, Number(prize.value) || 0);
  return round.winners.reduce((sum, winner) => sum + (valueByPrize.get(winner.prizeId) ?? 0), 0);
}

export function evaluateBudget(
  budget: LotteryBudget | undefined,
  awardedValue: number,
  prizeValue: number,
): LotteryBudgetDecision {
  const max = Math.max(0, Math.floor(budget?.maxTotalValue ?? 0));
  const warningRatio = Math.min(1, Math.max(0, budget?.warningRatio ?? 0.8));
  const projected = awardedValue + Math.max(0, Number(prizeValue) || 0);

  if (!budget || max <= 0) {
    return { action: "allow", awardedValue, projectedValue: projected, budget: max, crossedWarning: false };
  }
  if (awardedValue >= max) {
    return { action: "pause", awardedValue, projectedValue: projected, budget: max, crossedWarning: false };
  }
  if (projected > max) {
    return { action: "downgrade", awardedValue, projectedValue: projected, budget: max, crossedWarning: false };
  }
  return {
    action: "allow",
    awardedValue,
    projectedValue: projected,
    budget: max,
    crossedWarning: awardedValue < max * warningRatio && projected >= max * warningRatio,
  };
}

/** 找一件价值为 0（空奖）的可用奖品；没有则返回 null（按未中奖处理）。 */
export function findPlaceholderPrize(prizes: LotteryPrize[]): LotteryPrize | null {
  return prizes.find((prize) => prize.remaining > 0 && (Number(prize.value) || 0) === 0) ?? null;
}
