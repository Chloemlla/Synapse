import type { LotteryRound } from "../lotteryService";

/**
 * 多版本灰度 / AB 测试（PRD §3.6）。
 *
 * 分配方式：`hash(roundId:userId) ∈ [0,1)` 落在按权重切分的区间里 —— 同一个用户在同一轮次
 * **始终拿到同一个变体**（体验稳定、便于归因），且不需要存储分配结果。
 *
 * 变体只能改「参数」，不能改发奖正确性：可覆盖单次机会成本与奖品权重（乘数），
 * 发奖本身仍由同一套 CSPRNG + 保底 + 库存逻辑裁决。
 */

export interface LotteryAbVariant {
  key: string;
  weight: number;
  /** 覆盖该变体下每抽消耗的机会数（缺省用轮次配置）。 */
  chanceCost?: number;
  /** 奖品权重乘数（prizeId -> multiplier；0 表示该变体下剔除该奖品）。 */
  prizeWeightOverrides?: Record<string, number>;
}

export interface LotteryAbTest {
  enabled: boolean;
  variants: LotteryAbVariant[];
}

/** FNV-1a 哈希到 [0,1)。 */
export function hashToUnit(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash >>> 0) / 0x100000000;
}

/** 为用户分配变体（权重和为 0 或未启用时返回 null）。 */
export function assignVariant(abTest: LotteryAbTest | undefined, roundId: string, userId: string): LotteryAbVariant | null {
  if (!abTest?.enabled || !Array.isArray(abTest.variants) || abTest.variants.length === 0) return null;
  const variants = abTest.variants.filter((variant) => Number(variant.weight) > 0);
  if (variants.length === 0) return null;
  const total = variants.reduce((sum, variant) => sum + Number(variant.weight), 0);
  if (!Number.isFinite(total) || total <= 0) return null;

  const target = hashToUnit(`${roundId}:${userId}`) * total;
  let cumulative = 0;
  for (const variant of variants) {
    cumulative += Number(variant.weight);
    if (target < cumulative) return variant;
  }
  return variants[variants.length - 1];
}

/** 把变体的权重乘数作用到奖品概率上（不改原对象）。 */
export function applyVariantWeights<T extends { id: string; probability: number }>(
  prizes: T[],
  variant: LotteryAbVariant | null,
): T[] {
  const overrides = variant?.prizeWeightOverrides;
  if (!overrides) return prizes;
  return prizes.map((prize) => {
    const multiplier = Number(overrides[prize.id]);
    if (!Number.isFinite(multiplier) || multiplier === 1) return prize;
    return { ...prize, probability: Math.max(0, prize.probability * multiplier) };
  });
}

export interface LotteryAbVariantStats {
  key: string;
  draws: number;
  wins: number;
  value: number;
  winRate: number;
}

/** 逐变体统计（抽数来自 drawCountsByVariant，中奖/价值来自 winners）。 */
export function buildAbStats(round: LotteryRound): LotteryAbVariantStats[] {
  const drawsByVariant = round.drawCountsByVariant ?? {};
  const valueByPrize = new Map(round.prizes.map((prize) => [prize.id, Number(prize.value) || 0]));

  const stats = new Map<string, LotteryAbVariantStats>();
  const ensure = (key: string): LotteryAbVariantStats => {
    const existing = stats.get(key);
    if (existing) return existing;
    const created: LotteryAbVariantStats = { key, draws: 0, wins: 0, value: 0, winRate: 0 };
    stats.set(key, created);
    return created;
  };

  for (const variant of round.abTest?.variants ?? []) ensure(variant.key);
  for (const [key, draws] of Object.entries(drawsByVariant)) ensure(key).draws = Math.max(0, Math.floor(draws));
  for (const winner of round.winners) {
    const entry = ensure(winner.variantKey ?? "default");
    entry.wins += 1;
    entry.value += valueByPrize.get(winner.prizeId) ?? 0;
  }

  return [...stats.values()].map((entry) => ({
    ...entry,
    winRate: entry.draws > 0 ? entry.wins / entry.draws : 0,
  }));
}
