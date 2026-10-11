import type { LotteryPrize } from "../lotteryService";

/**
 * Pacing（出奖速度控制）：把贵重奖品按固定时间窗配额发放，窗口未到或用尽时该奖品权重为 0，
 * 防止上线即被脚本一次性刷空。
 *
 * 设计取舍：时间窗以**轮次开始时间**为原点（不是自然日/整点），所以在管理端配置
 * `periodMs`（窗宽）与 `quotaPerWindow`（每窗最多发几份）即可；剩余库存仍由 DB 权威。
 */
export interface LotteryPacing {
  /** 时间窗宽度（毫秒）。 */
  periodMs: number;
  /** 每个时间窗内最多发放数量。 */
  quotaPerWindow: number;
}

/** 当前处于第几个时间窗（相对轮次开始，从 0 起）。 */
export function pacingWindowIndex(roundStartTime: number, now: number, periodMs: number): number {
  if (!Number.isFinite(periodMs) || periodMs <= 0) return 0;
  return Math.max(0, Math.floor((now - roundStartTime) / periodMs));
}

/** 该奖品在当前时间窗是否还有 pacing 配额（无配置视为不限制）。 */
export function isPrizeWithinPacingQuota(prize: LotteryPrize, windowIndex: number): boolean {
  const pacing = prize.pacing;
  if (!pacing || pacing.quotaPerWindow <= 0 || pacing.periodMs <= 0) return true;
  const used = prize.pacingAwards?.[String(windowIndex)] ?? 0;
  return used < pacing.quotaPerWindow;
}

/** 过滤出当前时间窗仍有 pacing 配额的奖品（其余视为权重 0）。 */
export function applyPacing(prizes: LotteryPrize[], roundStartTime: number, now: number): LotteryPrize[] {
  if (!prizes.some((prize) => prize.pacing)) return prizes;
  return prizes.filter((prize) =>
    isPrizeWithinPacingQuota(prize, pacingWindowIndex(roundStartTime, now, prize.pacing?.periodMs ?? 0)),
  );
}
