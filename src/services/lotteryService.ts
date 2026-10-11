import crypto from "node:crypto";
import path from "node:path";
import { isAdminRole } from "../middleware/auth";
import { logger } from "./logger";
import { addRound, getAllRounds, getUserRecord, getUserRecordsByIds, updateRound, updateUserRecord, deleteAllRounds, deleteAllUserRecords } from "./lotteryStorage";
import { AuditLogService, type AuditEntry } from "./auditLogService";
import { TurnstileService } from "./turnstileService";
import { readCaptchaChallenge } from "./turnstile/challenge";
import { sharedStateStore } from "./sharedStateStore";
import { type LotteryPacing, applyPacing, pacingWindowIndex } from "./lottery/pacing";
import {
  clearRoundSoldOut,
  isRoundMarkedSoldOut,
  markRoundSoldOut,
  readStockCounter,
  releaseStock,
  seedStockCounters,
  tryReserveStock,
} from "./lottery/stock";
import { LOTTERY_TASK_CATALOG, type LotteryTaskDefinition, canClaimTask, getLotteryTask } from "./lottery/tasks";
import {
  type T0ReconciliationReport,
  type T1ReconciliationReport,
  buildT0Report,
  buildT1Report,
} from "./lottery/reconciliation";
import { evaluateLotteryRisk } from "./lottery/risk";
import { lotteryFulfillmentService } from "./lotteryFulfillmentService";
import { type LotteryBudget, awardedValueOf, evaluateBudget } from "./lottery/budget";
import {
  type LotteryFinanceEntry,
  resolveLotteryFinanceSource,
  shanghaiDateKey,
} from "./lottery/finance";

// 抽奖相关类型定义
export type LotteryPrizeCategory = "common" | "rare" | "epic" | "legendary";

export interface LotteryPrize {
  id: string;
  name: string;
  description: string;
  value: number;
  probability: number; // 中奖概率 (0-1)
  quantity: number; // 奖品数量
  remaining: number; // 剩余数量
  image?: string;
  category: LotteryPrizeCategory;
  /** 出奖速度控制：按时间窗配额发放（可选）。 */
  pacing?: LotteryPacing;
  /** 各时间窗已发放数（窗序号 -> 数量）。 */
  pacingAwards?: Record<string, number>;
  /** 履约配置（可选）：不配则不落履约记录。 */
  fulfillment?: {
    type: "virtual" | "code" | "physical";
    provider?: string;
    params?: Record<string, unknown>;
    redeemValue?: number;
  };
}

/** 保底规则：本轮个人每抽到 everyDraws 的整数倍时，至少出 category 及以上稀有度的奖品。 */
export interface LotteryGuarantee {
  everyDraws: number;
  category: LotteryPrizeCategory;
}

/** 软保底：超过 startsAfterDraws 抽后，每次额外抽奖按 step 线性抬高「至少出该稀有度」的概率。 */
export interface LotterySoftGuarantee {
  startsAfterDraws: number;
  category: LotteryPrizeCategory;
  step: number;
  baseChance?: number;
}

/** 伪随机平滑补偿（暴击机制）：未命中累积概率加成，命中后重置。 */
export interface LotteryPseudoRandom {
  increment: number;
  maxBonus: number;
}

export interface LotteryRound {
  id: string;
  name: string;
  description: string;
  startTime: number;
  endTime: number;
  isActive: boolean;
  prizes: LotteryPrize[];
  participants: string[];
  winners: LotteryWinner[];
  blockchainHeight: number;
  seed: string;
  /** 每人本轮最大抽奖次数（默认 1 = 历史行为）。 */
  maxDrawsPerUser?: number;
  /** 每次抽奖消耗的抽奖机会数（默认 0 = 不消耗，保持历史「免费抽」行为）。 */
  chanceCost?: number;
  /** 硬保底配置（可选）。 */
  guarantee?: LotteryGuarantee;
  /** 软保底配置（可选）。 */
  softGuarantee?: LotterySoftGuarantee;
  /** 伪随机平滑补偿配置（可选）。 */
  pseudoRandom?: LotteryPseudoRandom;
  /** 每个用户本轮已抽次数（保底与次数上限的依据；普通用户视图不回传）。 */
  drawCounts?: Record<string, number>;
  /** 每个用户本轮连续未命中次数（伪随机补偿依据；普通用户视图不回传）。 */
  pityCounters?: Record<string, number>;
  /** 预算熔断配置（可选）。 */
  budget?: LotteryBudget;
}

export interface LotteryWinner {
  userId: string;
  username: string;
  prizeId: string;
  prizeName: string;
  drawTime: number;
  transactionHash?: string;
}

export interface UserLotteryRecord {
  userId: string;
  username: string;
  participationCount: number;
  winCount: number;
  lastDrawTime: number;
  totalValue: number;
  /** 抽奖机会余额（自然日按 LOTTERY_DAILY_FREE_CHANCES 重置）。 */
  chanceBalance?: number;
  /** 上次发放每日免费机会的上海天键（YYYY-MM-DD）。 */
  chanceDay?: string;
  /** 抽奖积分余额（可用积分按汇率兑换机会；由任务/管理员发放）。 */
  assetBalance?: number;
  /** 行为任务领取计数归日键（YYYY-MM-DD）。 */
  taskClaimDay?: string;
  /** 当天各任务已领取次数（taskKey -> count）。 */
  taskClaims?: Record<string, number>;
  history: {
    roundId: string;
    prizeId: string;
    prizeName: string;
    drawTime: number;
    value: number;
  }[];
}

export interface BlockchainData {
  height: number;
  hash: string;
  timestamp: number;
}

/** 一次抽奖的调用上下文（幂等与审计用；不进业务判定）。 */
export interface LotteryDrawContext {
  /** 客户端全局唯一请求 id：同一 id 的重放直接返回上次结果，不再抽一次。 */
  requestId?: string;
  ip?: string;
  userAgent?: string;
  /** 设备指纹（风控信号）。 */
  fingerprint?: string;
  /** 上游可信风控分（0-100）；客户端自报只影响自己，不会造成越权。 */
  riskScore?: number;
  /** 同设备不同账号数（群控特征）。 */
  distinctUsersPerFingerprint?: number;
}

/** 抽取过程产出的完整事实，供审计留痕（随机数快照 / 落点 / 结果）。 */
interface LotteryDrawOutcome {
  winner: LotteryWinner | null;
  prize: LotteryPrize | null;
  randomValue: number;
  drawTime: number;
  round: LotteryRound;
  /** 风控分级与是否被静默降级。 */
  riskLevel?: "allow" | "soft" | "block";
  riskScore?: number;
  downgraded?: boolean;
  /** 是否因预算熔断而降级。 */
  budgetPaused?: boolean;
}

/** 幂等结果保留 10 分钟：足够覆盖客户端/代理的重复投递与短时重试。 */
const LOTTERY_IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
/** 抽奖机会账本的锁 TTL（与轮次锁分开：同用户跨轮次抽奖也要串行化机会扣减）。 */
const LOTTERY_CHANCE_LOCK_TTL_MS = 10 * 1000;

/** 稀有度排序（保底「至少该等级」的判据）。 */
const PRIZE_CATEGORY_RANK: Record<LotteryPrizeCategory, number> = {
  common: 0,
  rare: 1,
  epic: 2,
  legendary: 3,
};

function readNonNegativeIntEnv(name: string, fallback: number, max: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed) || Math.floor(parsed) < 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

/** 每日免费抽奖机会（env 可配，默认 0 = 不发放，保持历史免费抽行为）。 */
export const LOTTERY_DAILY_FREE_CHANCES = readNonNegativeIntEnv("LOTTERY_DAILY_FREE_CHANCES", 0, 1000);

/** 抽奖积分兑换汇率：每 1 次机会需要多少积分（env 可配）。 */
export const LOTTERY_CHANCE_EXCHANGE_COST = Math.max(1, readNonNegativeIntEnv("LOTTERY_CHANCE_EXCHANGE_COST", 100, 1_000_000));

/** 对账周期（默认 5 分钟；`LOTTERY_RECONCILE_ENABLED=false` 可关）。 */
const LOTTERY_RECONCILE_INTERVAL_MS = Math.max(60_000, readNonNegativeIntEnv("LOTTERY_RECONCILE_INTERVAL_MS", 5 * 60 * 1000, 24 * 60 * 60 * 1000));

/** 上海自然日天键（与 userService 的用量归日同口径），机会按此天级别重置。 */
function shanghaiDayKey(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(now);
}

/**
 * 按配置概率抽奖（纯函数，便于单测）。
 *
 * 语义：`probability` 是 0-1 的绝对概率。只有「有库存且概率 > 0」的奖品参与抽取：
 * - 概率和 > 1：按相对权重归一化后必中（管理端已归一化，这里兜底）；
 * - 概率和 ≤ 1：随机值落在总和之外就是「未中奖」（返回 null）。旧实现把这段差额全部
 *   补贴给第一个可用奖品，导致第一个奖品的实际概率被严重放大、且结果由列表顺序决定。
 * - 没有可用库存 / 概率全为 0：也返回 null（调用方要先区分「已抽完」与「未中奖」）。
 */
export function pickPrize(prizes: LotteryPrize[], randomValue: number): LotteryPrize | null {
  const available = prizes.filter((prize) => prize.remaining > 0 && prize.probability > 0);
  if (available.length === 0) return null;
  const total = available.reduce((sum, prize) => sum + prize.probability, 0);
  if (!Number.isFinite(total) || total <= 0) return null;

  const target = total > 1 ? randomValue * total : randomValue;
  let cumulative = 0;
  for (const prize of available) {
    cumulative += prize.probability;
    if (target < cumulative) return prize;
  }

  // total > 1 时因浮点误差可能刚好走完，兜底给最后一项（相对权重下的合法结果）。
  return total > 1 ? available[available.length - 1] : null;
}

/**
 * 保底抽取：只从「稀有度 >= minCategory 且有库存」的奖品里选，且**必中**其中一项
 * （按相对权重归一，不受各自绝对概率和为 1 的约束——否则概率很低的稀有奖会抽不中，"保底"名不副实）。
 * 没有符合条件的奖品时返回 null（调用方回落普通抽取，不能让保底把活动抽死）。
 */
export function pickGuaranteedPrize(
  prizes: LotteryPrize[],
  minCategory: LotteryPrizeCategory,
  randomValue: number,
): LotteryPrize | null {
  const minRank = PRIZE_CATEGORY_RANK[minCategory] ?? 0;
  const eligible = prizes.filter(
    (prize) => prize.remaining > 0 && prize.probability > 0 && (PRIZE_CATEGORY_RANK[prize.category] ?? 0) >= minRank,
  );
  if (eligible.length === 0) return null;
  const total = eligible.reduce((sum, prize) => sum + prize.probability, 0);
  if (!Number.isFinite(total) || total <= 0) return null;

  const target = randomValue * total;
  let cumulative = 0;
  for (const prize of eligible) {
    cumulative += prize.probability;
    if (target < cumulative) return prize;
  }
  return eligible[eligible.length - 1];
}

/**
 * 软保底触发概率：抽数越界越多，线性趋近 1（封顶 1）。
 * `drawIndex` 是本轮个人第几抽（从 1 起）；未到 startsAfterDraws 返回 0。
 */
export function softGuaranteeChance(drawIndex: number, config: LotterySoftGuarantee): number {
  if (drawIndex <= config.startsAfterDraws) return 0;
  const extra = drawIndex - config.startsAfterDraws;
  const chance = Math.max(0, config.baseChance ?? 0) + Math.max(0, config.step) * extra;
  return Math.min(1, Math.max(0, chance));
}

/**
 * 伪随机平滑补偿：把随机值向 0 压（等价于放大命中区间），补偿倍率 = increment × 未命中次数，封顶 maxBonus。
 * 未命中次数为 0 或倍率为 0 时原样返回。
 */
export function applyPityBoost(
  randomValue: number,
  pityCounter: number,
  config: LotteryPseudoRandom,
): number {
  const bonus = Math.min(
    Math.max(0, config.maxBonus),
    Math.max(0, config.increment) * Math.max(0, Math.floor(pityCounter)),
  );
  if (bonus <= 0) return randomValue;
  const boosted = randomValue * (1 - Math.min(1, bonus));
  return Math.min(1, Math.max(0, boosted));
}

class LotteryService {
  private dataDir: string;
  private roundsFile: string;
  private usersFile: string;
  private blockchainCacheFile: string;
  private blockchainCache: BlockchainData | null = null;

  constructor() {
    this.dataDir = path.join(process.cwd(), "data", "lottery");
    this.roundsFile = path.join(this.dataDir, "rounds.json");
    this.usersFile = path.join(this.dataDir, "users.json");
    this.blockchainCacheFile = path.join(this.dataDir, "blockchain-cache.json");
    // 替换原有本地读写/Map操作，全部通过lotteryStorage接口实现
    this.startReconciliationTimer();
  }

  /** T+0 对账定时器（默认 5 分钟；unref 不阻塞进程退出）。 */
  private startReconciliationTimer(): void {
    if (process.env.LOTTERY_RECONCILE_ENABLED === "false") return;
    const timer = setInterval(() => {
      void this.runT0Reconciliation().catch((error) => {
        logger.error("T+0 库存对账失败", { error: error instanceof Error ? error.message : String(error) });
      });
    }, LOTTERY_RECONCILE_INTERVAL_MS);
    timer.unref?.();
  }

  // 获取区块链数据
  // G7-09: 区块链高度只作为展示用的信息源，不再参与开奖随机数。此前把公开的
  // 区块高度 + sha256(高度) + 客户端 userId + 请求时间戳拼成种子，全部成分攻击者
  // 已知或可枚举，开奖结果可被预测。真正的随机由服务端 CSPRNG (crypto.randomInt)
  // 决定（见 participateInLottery）。`difficulty` 这个编造的难度字段已删除。
  public async getBlockchainData(): Promise<BlockchainData> {
    const now = Date.now();

    // 如果缓存存在且未过期（5分钟），直接返回
    if (this.blockchainCache && now - this.blockchainCache.timestamp < 5 * 60 * 1000) {
      return this.blockchainCache;
    }

    // 一次请求同时取高度与哈希（旧实现每次刷新打两次同一个端点）。
    // 取不到就回落时间戳/空哈希：这是展示信息，不该因为第三方接口抖动而让参与抽奖失败。
    let height = Math.floor(now / 1000);
    let hash = "";
    try {
      const response = await fetch("https://api.blockcypher.com/v1/btc/main", {
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        const data = await response.json();
        if (typeof data?.height === "number" && Number.isFinite(data.height)) height = data.height;
        if (typeof data?.hash === "string" && data.hash) hash = data.hash;
      }
    } catch (error) {
      logger.warn("获取区块链数据失败，使用时间戳作为备选:", error);
    }

    this.blockchainCache = { height, hash, timestamp: now };
    return this.blockchainCache;
  }

  // 创建抽奖轮次
  public async createLotteryRound(
    roundData: Omit<LotteryRound, "id" | "participants" | "winners" | "blockchainHeight" | "seed">,
  ): Promise<LotteryRound> {
    const blockchainData = await this.getBlockchainData();
    const round: LotteryRound = {
      ...roundData,
      id: crypto.randomUUID(),
      participants: [],
      winners: [],
      drawCounts: {},
      blockchainHeight: blockchainData.height,
      seed: blockchainData.hash,
    };
    try {
      await addRound(round);
      // 预热 Redis 库存计数器（不阻塞创建；Redis 不可用时内部直接跳过）。
      await seedStockCounters(round.id, round.prizes).catch((error) => {
        logger.warn("预热 Redis 抽奖库存失败", { roundId: round.id, error: error instanceof Error ? error.message : String(error) });
      });
      clearRoundSoldOut(round.id);
      logger.info(`创建抽奖轮次: ${round.id} - ${round.name}`);
      // 创建后强制刷新所有轮次，避免缓存/延迟
      await this.getLotteryRounds();
    } catch (e: any) {
      logger.error(`创建抽奖轮次失败: ${e.message || e}`);
      throw new Error(`数据库写入失败: ${e.message || e}`);
    }
    return round;
  }

  // 获取所有抽奖轮次
  public async getLotteryRounds(): Promise<LotteryRound[]> {
    const rounds = await getAllRounds();
    if (!rounds || !Array.isArray(rounds) || rounds.length === 0) {
      logger.warn("[lottery] getLotteryRounds: 未读取到任何轮次数据");
    } else {
      logger.info(`[lottery] getLotteryRounds: 读取到 ${rounds.length} 条轮次数据`);
    }
    return rounds;
  }

  // 获取活跃的抽奖轮次
  public async getActiveRounds(): Promise<LotteryRound[]> {
    const now = Date.now();
    const rounds = await this.getLotteryRounds();
    return rounds.filter((round) => round.isActive && round.startTime <= now && round.endTime >= now);
  }

  // 参与抽奖
  /**
   * 参与抽奖（临界区包装）。
   *
   * 为什么要加锁：抽奖是「读轮次 → 判断是否已参与 → 扣减奖品库存 → 整体回写轮次」的
   * 读-改-写序列。并发请求（双击、两个设备、两个用户同时抽）会各自读到同一份旧状态，
   * 然后**整体覆盖** participants/winners/prizes —— 后写的那次会静默抹掉前一次的
   * 中奖记录，库存也可能被重复扣减。锁按轮次维度加，只串行化同一轮次的参与动作。
   *
   * 锁层不可用时 `withLock` 会退到进程内存锁（单实例内仍然串行），不会拒绝业务请求。
   */
  public async participateInLottery(
    roundId: string,
    userId: string,
    username: string,
    cfToken?: string,
    userRole?: string,
    captchaProvider?: unknown,
    context: LotteryDrawContext = {},
  ): Promise<LotteryWinner | null> {
    return sharedStateStore.withLock(`lottery:participate:${roundId}`, 15000, () =>
      this.participateInLotteryInternal(roundId, userId, username, cfToken, userRole, captchaProvider, context),
    );
  }

  /**
   * 幂等 + 审计包装：同一 requestId 的重放直接返回上次结果，不产生第二次抽奖/扣库存。
   * 业务拒绝会释放幂等键（此时未写入任何状态），同一 requestId 可安全重试。
   */
  private async participateInLotteryInternal(
    roundId: string,
    userId: string,
    username: string,
    cfToken?: string,
    userRole?: string,
    captchaProvider?: unknown,
    context: LotteryDrawContext = {},
  ): Promise<LotteryWinner | null> {
    const idempotencyKey = context.requestId ? `lottery:idem:${userId}:${context.requestId}` : null;
    if (idempotencyKey) {
      const claimed = await sharedStateStore.claim(idempotencyKey, LOTTERY_IDEMPOTENCY_TTL_MS, "pending");
      if (!claimed) {
        const stored = await sharedStateStore.get<{ roundId?: string; winner?: LotteryWinner | null } | string>(
          idempotencyKey,
        );
        if (stored && typeof stored === "object" && stored.roundId === roundId) {
          return stored.winner ?? null;
        }
        // 仍是 pending（并发同 id）或换了轮次复用同一 id：不给新抽，让调用方稍后重试。
        throw new Error("抽奖请求正在处理中，请稍后重试");
      }
    }

    try {
      const outcome = await this.runLotteryDraw(
        roundId,
        userId,
        username,
        cfToken,
        userRole,
        captchaProvider,
        context,
      );
      if (idempotencyKey) {
        await sharedStateStore.set(idempotencyKey, { roundId, winner: outcome.winner }, LOTTERY_IDEMPOTENCY_TTL_MS);
      }
      this.recordDrawAudit(outcome, { userId, username, userRole, context });
      return outcome.winner;
    } catch (error) {
      if (idempotencyKey) {
        await sharedStateStore.delete(idempotencyKey).catch(() => undefined);
      }
      throw error;
    }
  }

  private async runLotteryDraw(
    roundId: string,
    userId: string,
    username: string,
    cfToken?: string,
    userRole?: string,
    captchaProvider?: unknown,
    context: LotteryDrawContext = {},
  ): Promise<LotteryDrawOutcome> {
    // 第 1 层防线：进程内售罄标记（带 TTL），命中直接拒绝，不穿透到存储/下游。
    if (isRoundMarkedSoldOut(roundId)) {
      throw new Error("没有可用的奖品");
    }

    const round = await this.getRoundDetails(roundId); // 使用新的getRoundDetails
    if (!round) {
      throw new Error("抽奖轮次不存在");
    }

    if (!round.isActive) {
      throw new Error("抽奖轮次已结束");
    }

    const now = Date.now();
    if (now < round.startTime || now > round.endTime) {
      throw new Error("抽奖时间未到或已结束");
    }

    if (Math.max(0, Math.floor(round.drawCounts?.[userId] ?? 0)) >= Math.max(1, Math.floor(round.maxDrawsPerUser || 1))) {
      throw new Error("您已经参与过此轮抽奖");
    }

    // 人机验证（非管理员用户）：三家供应商共用同一套下发链路，验哪家由 captchaProvider 决定。
    const isAdmin = isAdminRole(userRole);
    if (!isAdmin) {
      const policy = await TurnstileService.getCaptchaRequestPolicy();
      if (policy.required) {
        const challenge = readCaptchaChallenge({ captchaToken: cfToken, captchaProvider });
        if (!challenge.token) {
          logger.warn("非管理员用户缺少人机验证 token，拒绝参与抽奖", { userId, userRole });
          throw new Error("需要完成人机验证才能参与抽奖");
        }

        const verified = await TurnstileService.verifyCaptchaChallenge({
          token: challenge.token,
          provider: challenge.provider,
        }).catch((error: unknown) => {
          logger.error("人机验证请求失败", {
            userId,
            userRole,
            error: error instanceof Error ? error.message : String(error),
          });
          throw new Error("人机验证服务暂时不可用，请稍后重试");
        });
        if (!verified) {
          logger.warn("人机验证失败", { userId, userRole, provider: challenge.provider });
          throw new Error("人机验证失败，请重新验证");
        }
        logger.info("人机验证成功", { userId, userRole, provider: challenge.provider });
      }
    } else {
      logger.info("跳过人机验证（管理员用户）", { userId, userRole });
    }

    // 风控：block 硬拦截；soft 静默降级到暗池空奖（不扣库存、不报错）。
    const matches = evaluateLotteryRisk({
      userId,
      fingerprint: context.fingerprint,
      ip: context.ip,
      externalScore: context.riskScore,
      distinctUsersPerFingerprint: context.distinctUsersPerFingerprint,
    });
    if (matches.level === "block") {
      logger.warn("[Lottery] 风控硬拦截抽奖", { userId, score: matches.score });
      throw new Error("操作过于频繁，请稍后再试");
    }
    const riskDowngraded = matches.level === "soft";

    // G7-09: 开奖随机数必须由服务端 CSPRNG 决定，不能用公开区块高度/客户端字段/时间戳
    // 拼种子（那些成分攻击者全部已知或可枚举）。这里直接 crypto.randomInt。
    const randomValue = crypto.randomInt(0, 0xffffffff) / 0xffffffff;

    // 锁只覆盖本实例的并发：跨实例/锁降级时，前面读到的快照可能已经过期。落库前再读一次，
    // 以最新事实判定「已结束 / 重复参与 / 库存已空」，并在这份最新数据上扣减，避免把旧快照写回去。
    const latest = (await this.getRoundDetails(roundId)) ?? round;
    if (!latest.isActive) {
      throw new Error("抽奖轮次已结束");
    }
    const drawNow = Date.now();
    if (drawNow < latest.startTime || drawNow > latest.endTime) {
      throw new Error("抽奖时间未到或已结束");
    }
    const latestMaxDraws = Math.max(1, Math.floor(latest.maxDrawsPerUser || 1));
    const drawsSoFar = Math.max(0, Math.floor(latest.drawCounts?.[userId] ?? 0));
    if (drawsSoFar >= latestMaxDraws) {
      throw new Error("您已经参与过此轮抽奖");
    }
    // Pacing：窗口未到/用尽的贵重奖品权重归 0；可用池 = 未超窗配额 + 有库存 + 有概率。
    const availablePrizes = applyPacing(latest.prizes, latest.startTime, drawNow);
    // 「没库存」与「未中奖」必须分开：前者是运营/配置问题（明确报错），后者是正常结果。
    const hasStock = availablePrizes.some((item) => item.remaining > 0 && item.probability > 0);
    if (!hasStock) {
      markRoundSoldOut(roundId);
      throw new Error("没有可用的奖品");
    }

    // 硬保底：每抽到 guarantee.everyDraws 的整数倍（按本轮个人次数）至少出指定稀有度；
    // 没有符合条件的有库存奖品时回落普通抽取，不让保底把活动抽死。
    const drawIndex = drawsSoFar + 1;
    const guarantee = latest.guarantee;
    const guaranteedPrize =
      guarantee && guarantee.everyDraws > 0 && drawIndex % guarantee.everyDraws === 0
        ? pickGuaranteedPrize(availablePrizes, guarantee.category, randomValue)
        : null;

    // 伪随机平滑补偿：连续未命中累积的概率加成（命中后重置），在普通抽取前把随机值向命中区压。
    const pseudo = latest.pseudoRandom;
    const pityCounter = Math.max(0, Math.floor(latest.pityCounters?.[userId] ?? 0));

    // 风控 soft：静默降级为暗池空奖——照常记录参与与审计，既不报错也不出奖。
    let prize: LotteryPrize | null = riskDowngraded ? null : guaranteedPrize;
    // 软保底：超出手数越多，触发「至少出该稀有度」的概率越高（必中该档，纯权重归一）。
    if (!riskDowngraded && !prize && latest.softGuarantee) {
      const softChance = softGuaranteeChance(drawIndex, latest.softGuarantee);
      if (softChance > 0 && randomValue < softChance) {
        prize = pickGuaranteedPrize(availablePrizes, latest.softGuarantee.category, randomValue);
      }
    }
    // 概率和 < 1 时剩余区间表示「未中奖」：参与照样计数，只是不进 winners。
    if (!riskDowngraded && !prize) {
      const effectiveRandom = pseudo ? applyPityBoost(randomValue, pityCounter, pseudo) : randomValue;
      prize = pickPrize(availablePrizes, effectiveRandom);
    }

    // 预算熔断：再出一份就超预算 → 本次降级为未中奖并把轮次停用。
    let budgetPaused = false;
    if (prize && latest.budget) {
      const budgetDecision = evaluateBudget(latest.budget, awardedValueOf(latest), prize.value);
      if (budgetDecision.action === "pause" || budgetDecision.action === "downgrade") {
        prize = null;
        budgetPaused = budgetDecision.action === "pause";
      } else if (budgetDecision.crossedWarning) {
        logger.warn("[Lottery] 中奖预算达到预警线", {
          roundId,
          budget: budgetDecision.budget,
          projected: budgetDecision.projectedValue,
        });
      }
    }

    // 第 3 层（DB 最终防线）的显式前置校验：快照上该奖品仍有库存才允许扣减。
    if (prize) {
      const freshPrize = latest.prizes.find((item) => item.id === prize.id);
      if (!freshPrize || freshPrize.remaining <= 0) {
        throw new Error("没有可用的奖品");
      }
    }

    // 抽奖机会：chanceCost > 0 的轮次按次原子消耗；管理员豁免（与其它豁免同一口径）。
    let chanceConsumed = 0;
    const chanceCost = Math.max(0, Math.floor(latest.chanceCost || 0));
    if (!isAdmin && chanceCost > 0) {
      const consumed = await this.consumeChances(userId, chanceCost);
      if (!consumed.ok) {
        throw new Error(`抽奖机会不足（需要 ${chanceCost} 次，当前 ${consumed.balance} 次）`);
      }
      chanceConsumed = chanceCost;
    }

    // 第 2 层防线：Redis 预热库存 Lua 原子预扣（并行账本 + 与 DB 对账的依据）。
    // Redis 不可用/未预热/与 DB 不一致时都以 DB 为准，不因此拒绝用户，仅记日志待对账。
    let reservedStock = false;
    if (prize) {
      const reserve = await tryReserveStock(roundId, prize.id, 1);
      if (reserve === "reserved") {
        reservedStock = true;
      } else if (reserve === "insufficient") {
        logger.warn("抽奖库存：Redis 预热计数与 DB 不一致（Redis 认为已空），以 DB 为准，待对账", {
          roundId,
          prizeId: prize.id,
        });
      }
    }

    // 获取最新的区块链数据（仅作展示信息）
    const blockchainData = await this.getBlockchainData();

    const winner: LotteryWinner | null = prize
      ? {
          userId,
          username,
          prizeId: prize.id,
          prizeName: prize.name,
          drawTime: drawNow,
          // G7-09: 本地抽奖标识，不是链上交易哈希。字段名保留以兼容旧契约，但值只是随机 ID。
          transactionHash: `local-${crypto.randomUUID()}`,
        }
      : null;

    const pacingWindow = prize?.pacing ? pacingWindowIndex(latest.startTime, drawNow, prize.pacing.periodMs) : null;
    const nextPrizes = prize
      ? latest.prizes.map((item) => {
          if (item.id !== prize.id) return item;
          const updated: LotteryPrize = { ...item, remaining: item.remaining - 1 };
          if (item.pacing && pacingWindow !== null) {
            updated.pacingAwards = {
              ...(item.pacingAwards || {}),
              [String(pacingWindow)]: (item.pacingAwards?.[String(pacingWindow)] ?? 0) + 1,
            };
          }
          return updated;
        })
      : latest.prizes;
    // participants 是「本轮参与过的用户」去重列表；drawCounts 才是每人次数。
    const nextParticipants = latest.participants.includes(userId)
      ? latest.participants
      : [...latest.participants, userId];
    const nextWinners = winner ? [...latest.winners, winner] : latest.winners;
    const nextDrawCounts = { ...(latest.drawCounts || {}), [userId]: drawIndex };
    // 未命中累加补偿计数，命中即重置。
    const nextPityCounters = pseudo
      ? { ...(latest.pityCounters || {}), [userId]: prize ? 0 : pityCounter + 1 }
      : latest.pityCounters;

    // G7-08: 把本次抽奖的所有状态变更真正落库。此前这里只改内存对象，请求一结束
    // 全部丢弃，导致可无限抽奖、库存永不扣减、中奖记录不存在。
    try {
      await updateRound(roundId, {
        prizes: nextPrizes,
        participants: nextParticipants,
        winners: nextWinners,
        drawCounts: nextDrawCounts,
        ...(nextPityCounters ? { pityCounters: nextPityCounters } : {}),
        ...(budgetPaused ? { isActive: false } : {}),
        blockchainHeight: blockchainData.height,
        seed: blockchainData.hash,
      });

      // 无论中没中奖都记一次参与：记录里的 participationCount 才能反映真实参与次数。
      await this.updateUserRecord(userId, username, { winner, prize, roundId, drawTime: drawNow });

      // 履约：中奖后落一条履约记录（异步队列处理），失败不影响抽奖结果。
      if (winner && prize) {
        await lotteryFulfillmentService.enqueue({ roundId, userId, username, prize }).catch(() => undefined);
      }
    } catch (error) {
      // 扣了机会但状态没落库：把机会退回去，不出现「扣了机会没抽成」。
      if (chanceConsumed > 0) {
        await this.refundChances(userId, chanceConsumed).catch(() => undefined);
      }
      // 预扣的 Redis 库存也要回补。
      if (reservedStock && prize) {
        await releaseStock(roundId, prize.id, 1);
      }
      throw error;
    }

    if (winner) {
      logger.info(`用户 ${username} 在轮次 ${roundId} 中获得了 ${winner.prizeName}`);
    } else {
      logger.info(`用户 ${username} 参与轮次 ${roundId} 未中奖`);
    }
    return {
      winner,
      prize,
      randomValue,
      drawTime: drawNow,
      round: latest,
      riskLevel: matches.level,
      riskScore: matches.score,
      downgraded: riskDowngraded,
      budgetPaused,
    };
  }

  /**
   * 审计留痕（PRD §4）：记录随机数快照、落点与扣减结果。
   * 走既有 `audit_logs`（60 天 TTL + 批量落盘兜底 + 管理端按 `lottery` 模块筛选），不另造流水表。
   * 写入失败不让抽奖失败：履约事实以轮次/用户记录为准，审计是留痕不是账本。
   */
  private recordDrawAudit(
    outcome: LotteryDrawOutcome,
    meta: { userId: string; username: string; userRole?: string; context: LotteryDrawContext },
  ): void {
    const remainingAfter = outcome.prize
      ? (outcome.round.prizes.find((item) => item.id === outcome.prize?.id)?.remaining ?? null)
      : null;
    const entry: AuditEntry = {
      requestId: meta.context.requestId,
      userId: meta.userId,
      username: meta.username,
      role: meta.userRole || "user",
      action: "lottery.draw",
      module: "lottery",
      targetId: outcome.round.id,
      targetName: outcome.round.name,
      result: "success",
      detail: {
        roundId: outcome.round.id,
        outcome: outcome.winner ? "win" : "no_win",
        randomValue: Number(outcome.randomValue.toFixed(8)),
        prizeId: outcome.winner?.prizeId ?? null,
        prizeName: outcome.winner?.prizeName ?? null,
        remainingAfter,
        requestId: meta.context.requestId ?? null,
        drawTime: outcome.drawTime,
        riskLevel: outcome.riskLevel ?? "allow",
        riskScore: outcome.riskScore ?? 0,
        downgraded: Boolean(outcome.downgraded),
        budgetPaused: Boolean(outcome.budgetPaused),
      },
      ip: meta.context.ip || "",
      userAgent: meta.context.userAgent,
      path: "/api/lottery/rounds/:roundId/participate",
      method: "POST",
    };
    void AuditLogService.log(entry).catch(() => undefined);
  }

  // 更新用户记录
  // G7-08: 恢复真实实现。此前函数体整段被注释掉，导致 getLeaderboard/getStatistics 恒为空。
  private async updateUserRecord(
    userId: string,
    username: string,
    outcome: { winner: LotteryWinner | null; prize: LotteryPrize | null; roundId: string; drawTime: number },
  ): Promise<void> {
    const record = await getUserRecord(userId);
    const history = [...(record?.history || [])];
    if (outcome.winner && outcome.prize) {
      history.push({
        roundId: outcome.roundId,
        prizeId: outcome.winner.prizeId,
        prizeName: outcome.winner.prizeName,
        drawTime: outcome.drawTime,
        value: outcome.prize.value,
      });
    }
    await updateUserRecord(userId, {
      userId,
      username: username || record?.username || "",
      participationCount: (record?.participationCount || 0) + 1,
      winCount: (record?.winCount || 0) + (outcome.winner ? 1 : 0),
      lastDrawTime: outcome.drawTime,
      totalValue: (record?.totalValue || 0) + (outcome.prize?.value || 0),
      history,
    });
  }

  // 获取用户抽奖记录
  public async getUserRecord(userId: string): Promise<UserLotteryRecord | null> {
    return getUserRecord(userId);
  }

  /** 读取机会余额（会懒发放当天的免费机会）。 */
  public async getChances(userId: string): Promise<{ balance: number; dailyFree: number; assetBalance: number; exchangeCost: number }> {
    const balance = await this.ensureDailyChances(userId);
    const record = await getUserRecord(userId);
    return {
      balance,
      dailyFree: LOTTERY_DAILY_FREE_CHANCES,
      assetBalance: Math.max(0, Math.floor(record?.assetBalance ?? 0)),
      exchangeCost: LOTTERY_CHANCE_EXCHANGE_COST,
    };
  }

  /** 管理员给用户发抽奖机会；返回发放后余额，并写一条审计。 */
  public async grantChances(
    userId: string,
    amount: number,
    operator?: { userId: string; username: string; role: string; ip?: string },
  ): Promise<number> {
    const delta = Math.max(1, Math.floor(amount));
    const balance = await sharedStateStore.withLock(
      `lottery:chances:${userId}`,
      LOTTERY_CHANCE_LOCK_TTL_MS,
      async () => {
        const record = await getUserRecord(userId);
        const next = Math.max(0, Math.floor(record?.chanceBalance ?? 0)) + delta;
        await updateUserRecord(userId, { userId, chanceBalance: next });
        return next;
      },
    );
    if (operator) {
      void AuditLogService.log({
        userId: operator.userId,
        username: operator.username,
        role: operator.role,
        action: "lottery.chances_grant",
        module: "lottery",
        targetId: userId,
        targetName: userId,
        result: "success",
        detail: { amount: delta, balance },
        ip: operator.ip || "",
        method: "POST",
      }).catch(() => undefined);
    }
    return balance;
  }

  /** 懒发放每日免费机会：同一天不重复发放。 */
  private async ensureDailyChances(userId: string): Promise<number> {
    return sharedStateStore.withLock(`lottery:chances:${userId}`, LOTTERY_CHANCE_LOCK_TTL_MS, async () => {
      const record = await getUserRecord(userId);
      const day = shanghaiDayKey();
      if (record?.chanceDay === day) return Math.max(0, Math.floor(record?.chanceBalance ?? 0));
      const balance = LOTTERY_DAILY_FREE_CHANCES;
      await updateUserRecord(userId, { userId, chanceDay: day, chanceBalance: balance });
      return balance;
    });
  }

  /** 原子扣减机会（跨轮次也在同一把用户锁内串行）。 */
  private async consumeChances(userId: string, cost: number): Promise<{ ok: boolean; balance: number }> {
    return sharedStateStore.withLock(`lottery:chances:${userId}`, LOTTERY_CHANCE_LOCK_TTL_MS, async () => {
      const record = await getUserRecord(userId);
      const day = shanghaiDayKey();
      const sameDay = record?.chanceDay === day;
      const balance = sameDay ? Math.max(0, Math.floor(record?.chanceBalance ?? 0)) : LOTTERY_DAILY_FREE_CHANCES;
      if (balance < cost) {
        // 跨日先归零/发免费额度再回拒因，余额展示才是当日的。
        if (!sameDay) await updateUserRecord(userId, { userId, chanceDay: day, chanceBalance: balance });
        return { ok: false, balance };
      }
      const next = balance - cost;
      await updateUserRecord(userId, { userId, chanceDay: day, chanceBalance: next });
      return { ok: true, balance: next };
    });
  }

  /** 抽奖落库失败时把已扣的机会退回。 */
  private async refundChances(userId: string, cost: number): Promise<void> {
    await sharedStateStore.withLock(`lottery:chances:${userId}`, LOTTERY_CHANCE_LOCK_TTL_MS, async () => {
      const record = await getUserRecord(userId);
      const next = Math.max(0, Math.floor(record?.chanceBalance ?? 0)) + cost;
      await updateUserRecord(userId, { userId, chanceBalance: next });
    });
  }

  /** 发放抽奖积分（超管/任务奖励）；返回发放后积分余额，并写审计。 */
  public async grantAssets(
    userId: string,
    amount: number,
    operator?: { userId: string; username: string; role: string; ip?: string },
  ): Promise<number> {
    const delta = Math.max(1, Math.floor(amount));
    const balance = await sharedStateStore.withLock(
      `lottery:chances:${userId}`,
      LOTTERY_CHANCE_LOCK_TTL_MS,
      async () => {
        const record = await getUserRecord(userId);
        const next = Math.max(0, Math.floor(record?.assetBalance ?? 0)) + delta;
        await updateUserRecord(userId, { userId, assetBalance: next });
        return next;
      },
    );
    if (operator) {
      void AuditLogService.log({
        userId: operator.userId,
        username: operator.username,
        role: operator.role,
        action: "lottery.assets_grant",
        module: "lottery",
        targetId: userId,
        targetName: userId,
        result: "success",
        detail: { amount: delta, balance },
        ip: operator.ip || "",
        method: "POST",
      }).catch(() => undefined);
    }
    return balance;
  }

  /** 用抽奖积分按汇率兑换抽奖机会（与机会扣减同一把锁，原子）。 */
  public async exchangeChances(
    userId: string,
    times: number,
  ): Promise<{ balance: number; assetBalance: number; spent: number }> {
    const count = Math.max(1, Math.floor(times));
    const cost = count * LOTTERY_CHANCE_EXCHANGE_COST;
    return sharedStateStore.withLock(`lottery:chances:${userId}`, LOTTERY_CHANCE_LOCK_TTL_MS, async () => {
      const record = await getUserRecord(userId);
      const day = shanghaiDayKey();
      const sameDay = record?.chanceDay === day;
      const balance = sameDay ? Math.max(0, Math.floor(record?.chanceBalance ?? 0)) : LOTTERY_DAILY_FREE_CHANCES;
      const assets = Math.max(0, Math.floor(record?.assetBalance ?? 0));
      if (assets < cost) {
        throw new Error(`抽奖积分不足（需要 ${cost} 积分，当前 ${assets} 积分）`);
      }
      const nextAssets = assets - cost;
      await updateUserRecord(userId, {
        userId,
        chanceDay: day,
        chanceBalance: balance + count,
        assetBalance: nextAssets,
      });
      return { balance: balance + count, assetBalance: nextAssets, spent: cost };
    });
  }

  /** 行为任务状态：目录 + 今日已领次数 + 是否可领。 */
  public async getTaskStatus(
    userId: string,
  ): Promise<Array<LotteryTaskDefinition & { claimedToday: number; canClaim: boolean }>> {
    const record = await getUserRecord(userId);
    const day = shanghaiDayKey();
    const claims = record?.taskClaimDay === day ? record?.taskClaims || {} : {};
    return LOTTERY_TASK_CATALOG.map((task) => {
      const claimedToday = Math.max(0, Math.floor(claims[task.key] ?? 0));
      return { ...task, claimedToday, canClaim: canClaimTask(task, claimedToday) };
    });
  }

  /**
   * 领取任务机会：前端只能领 `clientClaimable` 任务；
   * 下单这类需外部校验的任务由子系统调用并传 `allowInternal`。
   */
  public async claimTaskChances(
    userId: string,
    taskKey: string,
    options: { allowInternal?: boolean } = {},
  ): Promise<{ balance: number; chances: number; claimedToday: number }> {
    const task = getLotteryTask(taskKey);
    if (!task) throw new Error("任务不存在");
    if (!task.clientClaimable && !options.allowInternal) {
      throw new Error("该任务需由业务系统核销后发放");
    }
    return sharedStateStore.withLock(`lottery:chances:${userId}`, LOTTERY_CHANCE_LOCK_TTL_MS, async () => {
      const record = await getUserRecord(userId);
      const day = shanghaiDayKey();
      const sameDay = record?.taskClaimDay === day;
      const claims = sameDay ? { ...(record?.taskClaims || {}) } : {};
      const claimedToday = Math.max(0, Math.floor(claims[taskKey] ?? 0));
      if (!canClaimTask(task, claimedToday)) {
        throw new Error("今日该任务已领取完毕");
      }
      claims[taskKey] = claimedToday + 1;
      const balance =
        (sameDay ? Math.max(0, Math.floor(record?.chanceBalance ?? 0)) : LOTTERY_DAILY_FREE_CHANCES) + task.chances;
      await updateUserRecord(userId, {
        userId,
        chanceDay: day,
        chanceBalance: balance,
        taskClaimDay: day,
        taskClaims: claims,
      });
      return { balance, chances: task.chances, claimedToday: claimedToday + 1 };
    });
  }

  /** T+0 对账：逐轮次对比 DB 剩余与「按中奖记录推算的应有剩余」，附 Redis 预热计数。 */
  public async runT0Reconciliation(): Promise<T0ReconciliationReport[]> {
    const rounds = await this.getLotteryRounds();
    const reports: T0ReconciliationReport[] = [];
    for (const round of rounds) {
      const redisRemaining: Record<string, number | null> = {};
      for (const prize of round.prizes) {
        redisRemaining[prize.id] = await readStockCounter(round.id, prize.id);
      }
      const report = buildT0Report(round, redisRemaining);
      reports.push(report);
      if (report.driftPrizes > 0) {
        logger.warn("T+0 库存对账发现偏差", { roundId: round.id, driftPrizes: report.driftPrizes });
      }
    }
    return reports;
  }

  /** T+1 对账：对比用户累计价值与按中奖记录推算的价值；可附带外部财务流水全链路核对。 */
  public async runT1Reconciliation(
    date?: string,
  ): Promise<
    T1ReconciliationReport & {
      date: string;
      dailyWinnerValue: number;
      external: LotteryFinanceEntry | null;
      externalDrift: number | null;
    }
  > {
    const rounds = await this.getLotteryRounds();
    const records = await this.getAllUserRecords(rounds);
    const targetDate = date || shanghaiDateKey();
    const report = buildT1Report(rounds, records);

    // 当日发放价值（上海自然日）——与外部财务流水同口径。
    let dailyWinnerValue = 0;
    for (const round of rounds) {
      const valueByPrize = new Map(round.prizes.map((prize) => [prize.id, Number(prize.value) || 0]));
      for (const winner of round.winners) {
        if (shanghaiDateKey(new Date(winner.drawTime)) === targetDate) {
          dailyWinnerValue += valueByPrize.get(winner.prizeId) ?? 0;
        }
      }
    }

    // 外部财务源未配置时返回 null（明确「没有基线」，不伪装成对上了）。
    const source = resolveLotteryFinanceSource();
    const external = source ? await source.fetchDaily(targetDate) : null;

    if (report.valueDrift !== 0 || report.mismatchedUsers.length > 0) {
      logger.warn("T+1 价值对账发现偏差", {
        valueDrift: report.valueDrift,
        mismatched: report.mismatchedUsers.length,
      });
    }
    return {
      ...report,
      date: targetDate,
      dailyWinnerValue,
      external,
      externalDrift: external ? dailyWinnerValue - external.totalValue : null,
    };
  }

  // 获取轮次详情
  public async getRoundDetails(roundId: string): Promise<LotteryRound | null> {
    const rounds = await this.getLotteryRounds();
    return rounds.find((round) => round.id === roundId) || null;
  }

  // 获取排行榜
  public async getLeaderboard(limit: number = 10): Promise<UserLotteryRecord[]> {
    const userRecords = await this.getAllUserRecords(); // 新增方法
    return userRecords.sort((a, b) => b.totalValue - a.totalValue).slice(0, limit);
  }

  // 重置轮次（管理员功能）
  public async resetRound(roundId: string): Promise<void> {
    const round = await this.getRoundDetails(roundId);
    if (!round) {
      throw new Error("抽奖轮次不存在");
    }

    // 重置奖品数量
    round.prizes.forEach((prize) => {
      prize.remaining = prize.quantity;
      prize.pacingAwards = {};
    });

    // 清空参与者和获奖者
    round.participants = [];
    round.winners = [];
    round.drawCounts = {};
    round.pityCounters = {};

    // 替换原有本地读写/Map操作，全部通过lotteryStorage接口实现
    // await this.saveData(); // 移除此行，因为不再直接保存
    await updateRound(roundId, {
      prizes: round.prizes,
      participants: round.participants,
      winners: round.winners,
      drawCounts: round.drawCounts,
      pityCounters: round.pityCounters,
    });
    // 补货后清掉售罄快速拒绝标记，并重新预热 Redis 计数。
    clearRoundSoldOut(roundId);
    await seedStockCounters(roundId, round.prizes).catch(() => undefined);
    logger.info(`重置抽奖轮次: ${roundId}`);
  }

  // G4-22: 补齐真实的状态更新，不再返回假的成功
  public async updateRoundStatus(roundId: string, isActive: boolean): Promise<LotteryRound> {
    const round = await this.getRoundDetails(roundId);
    if (!round) {
      throw new Error("抽奖轮次不存在");
    }
    if (typeof isActive !== "boolean") {
      throw new Error("isActive 必须为布尔值");
    }
    const updated = await updateRound(roundId, { isActive });
    logger.info(`更新抽奖轮次状态: ${roundId}, isActive=${isActive}`);
    return updated;
  }

  // 获取统计信息
  public async getStatistics(): Promise<{
    totalRounds: number;
    activeRounds: number;
    totalParticipants: number;
    totalWinners: number;
    totalValue: number;
  }> {
    // 只读一次轮次：旧实现对同一份数据读了三次（总轮次/参与/中奖各一次），
    // 每次都是一趟存储往返。
    const rounds = await this.getLotteryRounds();
    const now = Date.now();
    const activeRounds = rounds.filter(
      (round) => round.isActive && round.startTime <= now && round.endTime >= now,
    ).length;
    const totalParticipants = rounds.reduce((sum, round) => sum + round.participants.length, 0);
    const totalWinners = rounds.reduce((sum, round) => sum + round.winners.length, 0);
    const totalValue = (await this.getAllUserRecords(rounds)).reduce((sum, record) => sum + record.totalValue, 0);

    return {
      totalRounds: rounds.length,
      activeRounds,
      totalParticipants,
      totalWinners,
      totalValue,
    };
  }

  // 新增方法：获取所有用户记录
  private async getAllUserRecords(rounds?: LotteryRound[]): Promise<UserLotteryRecord[]> {
    const source = rounds ?? (await this.getLotteryRounds());
    const userIds = Array.from(new Set(source.flatMap((round) => round.participants)));
    if (userIds.length === 0) return [];
    // 批量读（$in / IN / 一次读文件）：旧实现按用户逐个查，参与者越多往返越多。
    const records = (await getUserRecordsByIds(userIds)) as Array<UserLotteryRecord | null> | null;
    return (records ?? []).filter((record): record is UserLotteryRecord => Boolean(record));
  }

  // 删除所有抽奖轮次
  public async deleteAllRounds(): Promise<void> {
    // G7-08: 之前用 global 变量 + require 动态查找当逃生舱，混淆构建下脆弱。
    // 改为顶部静态 import。
    await deleteAllRounds();
    // 轮次与用户记录一起清：只删轮次会留下「查得到、却找不到对应轮次」的旧中奖历史。
    await deleteAllUserRecords();
  }
}

export const lotteryService = new LotteryService();
