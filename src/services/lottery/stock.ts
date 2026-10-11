import { redisService } from "../redisService";

/**
 * 三层库存防线的第 1、2 层：
 * - 第 1 层：进程内「售罄标记」（带 TTL，快速拒绝，不穿透到存储）；
 * - 第 2 层：Redis 预热库存 + Lua 原子扣减（`decrementIfAtLeast`）；
 * - 第 3 层：DB 权威扣减（在轮次锁内、最新快照上做，见 lotteryService）。
 *
 * Redis 只是加速与兜底：未配置/不可用/未预热时一律返回 `unavailable`/`unseeded`，
 * 调用方回落到 DB 权威逻辑，绝不因为 Redis 抖动而拒绝业务。
 */

const SOLD_OUT_TTL_MS = 30_000;
const STOCK_COUNTER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const soldOutRounds = new Map<string, number>();

/** 标记某轮次售罄（进程内快速拒绝）。 */
export function markRoundSoldOut(roundId: string, now: number = Date.now()): void {
  soldOutRounds.set(roundId, now + SOLD_OUT_TTL_MS);
}

/** 轮次库存恢复（重置/补货）时清除标记。 */
export function clearRoundSoldOut(roundId: string): void {
  soldOutRounds.delete(roundId);
}

/** 是否处于「售罄快速拒绝」窗口内（TTL 到期自动失效）。 */
export function isRoundMarkedSoldOut(roundId: string, now: number = Date.now()): boolean {
  const expiresAt = soldOutRounds.get(roundId);
  if (expiresAt === undefined) return false;
  if (expiresAt <= now) {
    soldOutRounds.delete(roundId);
    return false;
  }
  return true;
}

/** 测试用：清空进程内标记。 */
export function resetSoldOutCache(): void {
  soldOutRounds.clear();
}

export function stockCounterKey(roundId: string, prizeId: string, prefix?: string): string {
  const resolvedPrefix = prefix ?? process.env.LOTTERY_STOCK_REDIS_PREFIX ?? "synapse:lottery:stock:";
  return `${resolvedPrefix}${roundId}:${prizeId}`;
}

export type StockReserveResult = "reserved" | "insufficient" | "unavailable" | "unseeded";

/** 预热 Redis 库存计数器（轮次创建/重置时调用；Redis 不可用则静默跳过）。 */
export async function seedStockCounters(
  roundId: string,
  prizes: Array<{ id: string; remaining: number }>,
  ttlMs: number = STOCK_COUNTER_TTL_MS,
): Promise<void> {
  if (!redisService.isAvailable()) return;
  for (const prize of prizes) {
    await redisService.setKey(stockCounterKey(roundId, prize.id), String(Math.max(0, Math.floor(prize.remaining))), ttlMs);
  }
}

/** 尝试原子预扣库存：`insufficient` 表示 Redis 认为该奖品已空，`unavailable/unseeded` 交回 DB 权威。 */
export async function tryReserveStock(roundId: string, prizeId: string, amount = 1): Promise<StockReserveResult> {
  const result = await redisService.decrementIfAtLeast(stockCounterKey(roundId, prizeId), amount);
  if (result === null) return "unavailable";
  if (result === -2) return "unseeded";
  if (result === -1) return "insufficient";
  return "reserved";
}

/** 预扣后 DB 写入失败时回补 Redis 计数。 */
export async function releaseStock(roundId: string, prizeId: string, amount = 1): Promise<void> {
  try {
    await redisService.incrementBy(stockCounterKey(roundId, prizeId), amount);
  } catch {
    // Redis 回补失败不影响主流程（对账会兜）。
  }
}

/** 读取 Redis 预热库存计数（对账用）；未预热/不可用返回 null。 */
export async function readStockCounter(roundId: string, prizeId: string): Promise<number | null> {
  const raw = await redisService.getKey(stockCounterKey(roundId, prizeId));
  if (raw === null || raw === undefined) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}
