import type { LotteryRound, UserLotteryRecord } from "../lotteryService";

/**
 * 资金与库存对账（PRD §3）：
 * - T+0：逐轮次对比「数据库剩余库存」与「按中奖记录推算的应有剩余」，可选对比 Redis 预热计数；
 * - T+1：对比「用户记录里的累计价值」与「按中奖记录推算的价值」，标出不一致用户。
 *
 * 纯函数（不读库），由 lotteryService 取数后调用，便于单测与离线跑批复用。
 */

export interface T0PrizeDrift {
  prizeId: string;
  name: string;
  quantity: number;
  dbRemaining: number;
  awarded: number;
  expectedRemaining: number;
  drift: number;
  redisRemaining: number | null;
}

export interface T0ReconciliationReport {
  roundId: string;
  roundName: string;
  checkedAt: number;
  prizes: T0PrizeDrift[];
  driftPrizes: number;
}

export function buildT0Report(
  round: LotteryRound,
  redisRemaining: Record<string, number | null> = {},
  checkedAt: number = Date.now(),
): T0ReconciliationReport {
  const awardedByPrize = new Map<string, number>();
  for (const winner of round.winners) {
    awardedByPrize.set(winner.prizeId, (awardedByPrize.get(winner.prizeId) ?? 0) + 1);
  }

  const prizes = round.prizes.map((prize) => {
    const awarded = awardedByPrize.get(prize.id) ?? 0;
    const expectedRemaining = Math.max(0, Math.floor(prize.quantity) - awarded);
    const dbRemaining = Math.max(0, Math.floor(prize.remaining));
    return {
      prizeId: prize.id,
      name: prize.name,
      quantity: Math.floor(prize.quantity),
      dbRemaining,
      awarded,
      expectedRemaining,
      drift: dbRemaining - expectedRemaining,
      redisRemaining: redisRemaining[prize.id] ?? null,
    };
  });

  return {
    roundId: round.id,
    roundName: round.name,
    checkedAt,
    prizes,
    driftPrizes: prizes.filter((prize) => prize.drift !== 0).length,
  };
}

export interface T1ReconciliationReport {
  generatedAt: number;
  roundCount: number;
  winnerCount: number;
  winnerTotalValue: number;
  userCount: number;
  userTotalValue: number;
  valueDrift: number;
  mismatchedUsers: string[];
}

export function buildT1Report(
  rounds: LotteryRound[],
  records: UserLotteryRecord[],
  generatedAt: number = Date.now(),
): T1ReconciliationReport {
  const prizeValue = new Map<string, number>();
  for (const round of rounds) {
    for (const prize of round.prizes) {
      prizeValue.set(`${round.id}:${prize.id}`, Number(prize.value) || 0);
    }
  }

  const perUserWinnerValue = new Map<string, number>();
  let winnerCount = 0;
  let winnerTotalValue = 0;
  for (const round of rounds) {
    for (const winner of round.winners) {
      const value = prizeValue.get(`${round.id}:${winner.prizeId}`) ?? 0;
      winnerCount += 1;
      winnerTotalValue += value;
      perUserWinnerValue.set(winner.userId, (perUserWinnerValue.get(winner.userId) ?? 0) + value);
    }
  }

  const mismatchedUsers: string[] = [];
  let userTotalValue = 0;
  for (const record of records) {
    const actual = Number(record.totalValue) || 0;
    userTotalValue += actual;
    const expected = perUserWinnerValue.get(record.userId) ?? 0;
    if (Math.abs(expected - actual) > 1e-6) mismatchedUsers.push(record.userId);
  }

  return {
    generatedAt,
    roundCount: rounds.length,
    winnerCount,
    winnerTotalValue,
    userCount: records.length,
    userTotalValue,
    valueDrift: userTotalValue - winnerTotalValue,
    mismatchedUsers,
  };
}
