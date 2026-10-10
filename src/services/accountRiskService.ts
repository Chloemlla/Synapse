import { config } from "../config/config";
import { AccountIpSignal } from "../models/accountIpSignalModel";
import { DeviceTracking } from "../models/deviceTrackingModel";
import { SecurityEvent } from "../models/securityEventModel";
import {
  computeStepUpUntil,
  evaluateAccountRiskScore,
  tierRank,
  type AccountIpRiskFact,
  type AccountRiskAssessment,
  type AccountRiskTier,
} from "../utils/accountRiskScoring";
import logger from "../utils/logger";
import type { User as UserType } from "../utils/userStorageTypes";
import { getLatestAuthSessionIpLocation } from "./authSessionService";
import { getCachedIpRisk, getIpRisk, type IpRiskResult } from "./ipRiskService";
import { mongoose } from "./mongoService";
import { isRiskExempt } from "./riskExemption";
import { getAccountRiskState, updateUser } from "./userService";

/**
 * 账户风险聚合与登录 IP 沉淀（RC-06 / RC-12 / §4.2）。
 *
 * 两条互相独立的职责：
 * 1. **沉淀**：每次登录成功把 `(userId, ip)` 写进 `account_ip_signals`，顺带把该 IP 当下的
 *    风险分快照下来。缓存未命中时**只记「暂无结论」**，补查在后台异步做 —— 登录是热路径，
 *    不允许同步外呼上游（RC-06.2）。
 * 2. **聚合**：`evaluateAccountRisk` 把 IP 信号 + 设备台账 + 账户级滥用事件折算成
 *    「风险分 + 档位」，并按 §3 的升降级规则落库：**自动只升不降**，且升档上限由运行时
 *    配置 `accountRisk.autoEscalationCap` 控制（默认 `watch`，避免第一版就误封真实用户）。
 *
 * 判据的方向提醒：本模块的分数**越高越危险**，与 `accountSecuritySummaryService`
 *（越高越安全，驱动「建议你开 MFA」）方向相反，两者刻意不合并（RC-06.4）。
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** 账户级滥用事件的 eventType 前缀（RC-20：违规拦截要按账户聚合，不能只按 IP 记）。 */
export const ACCOUNT_ABUSE_EVENT_PREFIX = "ACCOUNT_ABUSE";

export interface RecordLoginIpSignalInput {
  ipAddress: string;
  /** IP 属地（来自会话台账/属地查询结果）；取不到留空，不要用 "未知" 之外的编造值。 */
  ipLocation?: string;
  /** 归属地查询与设备无关时的补充说明，仅进日志。 */
  reason?: string;
}

function normalizeSignalIp(ip: unknown): string {
  return typeof ip === "string" ? ip.trim().slice(0, 128) : "";
}

/**
 * Mongo 就绪探针。
 *
 * 风控钩子挂在登录路径上，大量单元测试会加载这些模块但**不连库**：
 * 不做检查时，一次 `updateOne` 会先在 mongoose 缓冲里挂 10 秒（bufferTimeoutMS）
 * 再失败，把“替身没连库”变成“用例变慢/超时”的假故障。
 * 与 `ipRiskService.ensureMongoIfEnabled` 同口径：只探就绪，绝不在这里建连。
 */
function mongoReady(): boolean {
  return mongoose.connection.readyState === 1;
}

function isDatacenterResult(result: IpRiskResult): boolean {
  if (result.detections?.hosting) return true;
  if (Array.isArray(result.flags) && result.flags.includes("datacenter")) return true;
  return /datacenter|data center|hosting|\bidc\b/i.test(result.networkType || "");
}

function riskPatchFromResult(result: IpRiskResult, now: Date): Record<string, unknown> {
  return {
    riskScore: result.risk,
    riskLevel: result.level,
    flags: Array.isArray(result.flags) ? result.flags.slice(0, 32) : [],
    networkType: result.networkType || "",
    asn: result.asn || "",
    organisation: result.organisation || "",
    isDatacenter: isDatacenterResult(result),
    source: result.source === "cache" ? "cache" : "proxycheck",
    riskCheckedAt: now,
  };
}

// 补查的单飞集合：同一 (user, ip) 在补查未落定时不重复打上游（登录高峰会出现同一 IP 连打）。
const inFlightRefreshes = new Set<string>();

/**
 * 后台补查：缓存未命中时把结论异步补上。失败只记日志 —— 风险分是增强信号，
 * 不能因为上游不可用就让登录链路出现未捕获异常。
 */
async function refreshSignalRiskInBackground(userId: string, ipAddress: string): Promise<void> {
  const key = `${userId}|${ipAddress}`;
  if (inFlightRefreshes.has(key)) return;
  inFlightRefreshes.add(key);
  try {
    const result = await getIpRisk(ipAddress, "api");
    if (result.source === "unavailable") return;
    const now = new Date();
    await AccountIpSignal.updateOne(
      { userId, ipAddress },
      { $set: riskPatchFromResult(result, now) },
    ).exec();
  } catch (error) {
    logger.debug("[AccountRisk] 登录 IP 风险补查失败（不影响登录）", {
      userId,
      ipAddress,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    inFlightRefreshes.delete(key);
  }
}

/**
 * 记录一次登录 IP 事实（幂等 upsert）。
 *
 * `loginCount` 用 `$inc` 而不是读改写：同一账户多端并发登录时会互相覆盖计数，
 * 而计数正是「高危登录占比」判据的权重（RC-06.3）。
 */
export async function recordAccountIpSignal(
  userId: string,
  input: RecordLoginIpSignalInput,
): Promise<void> {
  const ipAddress = normalizeSignalIp(input.ipAddress);
  if (!userId || !ipAddress || ipAddress === "unknown") return;

  const cfg = config.accountRisk;
  if (!cfg.enabled) return;
  if (!mongoReady()) return;

  try {
    const cached = await getCachedIpRisk(ipAddress);
    const now = new Date();
    const setPatch: Record<string, unknown> = { lastSeenAt: now };
    if (input.ipLocation) setPatch.ipLocation = String(input.ipLocation).slice(0, 256);
    if (cached) Object.assign(setPatch, riskPatchFromResult(cached, now));

    await AccountIpSignal.updateOne(
      { userId, ipAddress },
      {
        $set: setPatch,
        $setOnInsert: { firstSeenAt: now },
        $inc: { loginCount: 1 },
      },
      { upsert: true },
    ).exec();

    // 只读缓存拿不到结论时才补查；缓存命中的场景已经在上面写完了。
    if (!cached && config.proxycheck.enabled) {
      void refreshSignalRiskInBackground(userId, ipAddress);
    }
  } catch (error) {
    // 沉淀失败不能影响登录：登录已经成功了，这里只是风控证据。
    logger.warn("[AccountRisk] 登录 IP 信号写入失败", {
      userId,
      ipAddress,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * 登录成功后的风控钩子（RC-06）：沉淀本次登录 IP + 聚合一次账户风险。
 *
 * 整个过程在后台异步执行：登录是热路径，风控只是增强证据，既不能让它拖慢登录响应，
 * 也不能因失败让登录报错（登录本身已经成功并已下发令牌）。
 * 属地不在此重新查询，而是读 `createAuthSession` 刚写下的那条会话（省一次上游调用）。
 */
export function scheduleLoginRiskSignals(userId: string, ipAddress: string): void {
  const cfg = config.accountRisk;
  if (!cfg.enabled) return;

  const normalized = normalizeSignalIp(ipAddress);
  if (!userId || !normalized || normalized === "unknown") return;
  if (!mongoReady()) return;

  void (async () => {
    try {
      let ipLocation: string | undefined;
      try {
        const location = await getLatestAuthSessionIpLocation(userId);
        if (location) ipLocation = location;
      } catch {
        // 属地只是展示字段，取不到就留空，不影响风险判定。
      }

      await recordAccountIpSignal(userId, { ipAddress: normalized, ipLocation });
      if (cfg.evaluateOnLogin) {
        await evaluateAccountRisk(userId, { reason: "login" });
      }
    } catch (error) {
      logger.warn("[AccountRisk] 登录风控钩子失败（不影响登录）", {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
}

interface DeviceRiskFacts {
  deviceMaxRiskScore: number;
  compromisedDeviceCount: number;
}

async function loadDeviceRiskFacts(userId: string): Promise<DeviceRiskFacts> {
  try {
    const rows = (await DeviceTracking.aggregate([
      { $match: { userId } },
      {
        $group: {
          _id: null,
          deviceMaxRiskScore: { $max: "$riskScore" },
          compromisedDeviceCount: { $sum: { $cond: ["$isCompromised", 1, 0] } },
        },
      },
    ]).exec()) as Array<{ deviceMaxRiskScore?: number; compromisedDeviceCount?: number }>;
    const row = rows[0];
    return {
      deviceMaxRiskScore: typeof row?.deviceMaxRiskScore === "number" ? row.deviceMaxRiskScore : 0,
      compromisedDeviceCount:
        typeof row?.compromisedDeviceCount === "number" ? row.compromisedDeviceCount : 0,
    };
  } catch (error) {
    logger.warn("[AccountRisk] 设备风险聚合失败（按无信号处理）", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { deviceMaxRiskScore: 0, compromisedDeviceCount: 0 };
  }
}

async function countRecentAbuseEvents(userId: string, since: Date): Promise<number> {
  try {
    return await SecurityEvent.countDocuments({
      userId,
      createdAt: { $gte: since },
      // 前缀匹配，`(userId, createdAt)` 复合索引负责过滤与范围，eventType 在内存里筛。
      eventType: { $regex: `^${ACCOUNT_ABUSE_EVENT_PREFIX}` },
    }).exec();
  } catch (error) {
    logger.warn("[AccountRisk] 账户级滥用事件统计失败（按 0 处理）", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 0;
  }
}

async function loadIpRiskFacts(userId: string, since: Date): Promise<AccountIpRiskFact[]> {
  const rows = (await AccountIpSignal.find({ userId, lastSeenAt: { $gte: since } })
    .select("ipAddress riskScore loginCount lastSeenAt isDatacenter")
    .sort({ lastSeenAt: -1 })
    .limit(200)
    .lean()) as Array<{
    ipAddress?: string;
    riskScore?: number | null;
    loginCount?: number;
    lastSeenAt?: Date | string;
    isDatacenter?: boolean;
  }>;

  return rows.map((row) => ({
    ipAddress: typeof row.ipAddress === "string" ? row.ipAddress : "",
    riskScore: typeof row.riskScore === "number" ? row.riskScore : null,
    loginCount: typeof row.loginCount === "number" ? row.loginCount : 0,
    lastSeenAt: row.lastSeenAt ? new Date(row.lastSeenAt).getTime() : 0,
    isDatacenter: row.isDatacenter === true,
  }));
}

function sameFlags(a: string[] | undefined, b: string[]): boolean {
  const left = Array.isArray(a) ? [...a].sort() : [];
  const right = [...b].sort();
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

export interface AccountRiskEvaluationResult extends AccountRiskAssessment {
  /** 落库后的生效档位（自动升档不会降级，因此可能高于本次算出的 `cappedTier`）。 */
  effectiveTier: AccountRiskTier;
  /** 本次是否发生了自动升档。 */
  escalated: boolean;
  /** 超管豁免：分数照算，档位与 step-up 不动。 */
  exempt: boolean;
}

/**
 * 账户风险聚合的入口（§4.2）。
 *
 * 调用时机：登录成功后（同步、只读缓存与外呼无关的库）、风险事件上报后（异步）、
 * 管理端打开账户详情时、定时任务。**幂等**：同分同档不重复写事件。超管豁免（RC-44）
 * 只影响档位与 step-up，分照算、事照记。
 */
export async function evaluateAccountRisk(
  userId: string,
  options: { reason?: string } = {},
): Promise<AccountRiskEvaluationResult | null> {
  const cfg = config.accountRisk;
  if (!cfg.enabled) return null;
  if (!mongoReady()) return null;

  const state = await getAccountRiskState(userId);
  if (!state) return null;

  const now = Date.now();
  const since = new Date(now - cfg.windowDays * DAY_MS);

  const [ipSignals, deviceFacts, abuseEventCount] = await Promise.all([
    loadIpRiskFacts(userId, since),
    loadDeviceRiskFacts(userId),
    countRecentAbuseEvents(userId, since),
  ]);

  const createdAt = state.createdAt ? Date.parse(state.createdAt) : Number.NaN;

  const assessment = evaluateAccountRiskScore(
    {
      now,
      accountCreatedAt: Number.isFinite(createdAt) ? createdAt : null,
      ipSignals,
      deviceMaxRiskScore: deviceFacts.deviceMaxRiskScore,
      compromisedDeviceCount: deviceFacts.compromisedDeviceCount,
      recentAbuseEventCount: abuseEventCount,
      // RC-15（跨地域跳变）在 B7 接线；此处显式传 false，避免「没接线却像接了」。
      geoJump: false,
    },
    cfg,
  );

  const currentTier: AccountRiskTier = state.riskTier ?? "normal";
  const exempt = isRiskExempt({ role: state.role });

  // 自动只升不降：降级必须人工（§3 升降级规则 / D1 未裁决前不做自动降级）。
  const shouldEscalate = !exempt && tierRank(assessment.cappedTier) > tierRank(currentTier);
  const effectiveTier = shouldEscalate ? assessment.cappedTier : currentTier;

  const flagsChanged = !sameFlags(state.riskFlags, assessment.flags);
  const patch: Partial<UserType> = {
    riskScore: assessment.riskScore,
    riskUpdatedAt: now,
  };
  if (flagsChanged || assessment.flags.length > 0) {
    patch.riskFlags = assessment.flags;
  }

  if (shouldEscalate) {
    patch.riskTier = effectiveTier;
    patch.flaggedBy = "auto";
    patch.flagReason = assessment.reasons.join("; ").slice(0, 512) || options.reason || "auto escalation";
    patch.stepUpUntil = computeStepUpUntil(cfg, now);
    patch.stepUpMode = cfg.stepUpMode;
  } else if (
    !exempt &&
    (effectiveTier === "restricted" || effectiveTier === "danger") &&
    (state.stepUpUntil ?? 0) <= now
  ) {
    // 已在受限/危险档但 step-up 窗口过期：续期而不是永久要求验证（避免把用户卡死）。
    patch.stepUpUntil = computeStepUpUntil(cfg, now);
    patch.stepUpMode = state.stepUpMode ?? cfg.stepUpMode;
  }

  try {
    await updateUser(userId, patch);
  } catch (error) {
    logger.warn("[AccountRisk] 账户风险写回失败", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  if (shouldEscalate || flagsChanged) {
    await recordAccountRiskEvent({
      userId,
      fromTier: currentTier,
      toTier: effectiveTier,
      assessment,
      reason: options.reason,
      exempt,
    });
  }

  logger.info("[AccountRisk] 聚合完成", {
    userId,
    riskScore: assessment.riskScore,
    currentTier,
    effectiveTier,
    escalated: shouldEscalate,
    exempt,
  });

  return {
    ...assessment,
    effectiveTier,
    escalated: shouldEscalate,
    exempt,
  };
}

async function recordAccountRiskEvent(params: {
  userId: string;
  fromTier: AccountRiskTier;
  toTier: AccountRiskTier;
  assessment: AccountRiskAssessment;
  reason?: string;
  exempt: boolean;
}): Promise<void> {
  const { userId, fromTier, toTier, assessment, reason, exempt } = params;
  try {
    await SecurityEvent.create({
      deviceFingerprint: "account-risk",
      userId,
      eventType: "ACCOUNT_RISK_TIER_CHANGED",
      eventData: {
        fromTier,
        toTier,
        riskScore: assessment.riskScore,
        flags: assessment.flags,
        reasons: assessment.reasons,
        reason,
        exempt,
        source: "auto",
      },
      riskScore: assessment.riskScore,
      ipAddress: "",
      userAgent: "",
      createdAt: new Date(),
    });
  } catch (error) {
    logger.warn("[AccountRisk] 风险事件写入失败", {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
