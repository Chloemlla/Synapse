import type { AccountRiskRuntimeConfig } from "../config/runtimeConfigDefaults";

/**
 * 账户风险聚合的**纯函数层**（RC-06 / §4.2）。
 *
 * 为什么单独一层：仓库里已有同类范式（`mobileTokenRiskService.collectRotationRiskSignals`、
 * `isGeoJump`）—— 把「事实 → 档位」的折算写成不碰 Mongo、不发网络请求的纯函数，
 * 阈值才可能被表驱动单测覆盖（各档边界、缺一条件不触发）。I/O 全部留在
 * `services/accountRiskService.ts`，本文件只做算术。
 *
 * ⚠ 方向：本模块的分数**越高越危险**。`accountSecuritySummaryService` 的分数是
 * 「越高越安全」（驱动「建议你开 MFA」）。两者刻意不合并（RC-06.4 / §4.6）。
 */

export type AccountRiskTier = "normal" | "watch" | "restricted" | "danger";

export const ACCOUNT_RISK_TIER_ORDER: readonly AccountRiskTier[] = ["normal", "watch", "restricted", "danger"];

export function tierRank(tier: AccountRiskTier): number {
  const index = ACCOUNT_RISK_TIER_ORDER.indexOf(tier);
  return index < 0 ? 0 : index;
}

/** 取更危险的一档（单调升级语义）。 */
export function maxTier(a: AccountRiskTier, b: AccountRiskTier): AccountRiskTier {
  return tierRank(a) >= tierRank(b) ? a : b;
}

export function isAccountRiskTier(value: unknown): value is AccountRiskTier {
  return typeof value === "string" && (ACCOUNT_RISK_TIER_ORDER as readonly string[]).includes(value);
}

/** 单个登录 IP 的事实快照（由 account_ip_signals 读出后投影）。 */
export interface AccountIpRiskFact {
  ipAddress: string;
  /** null = 没有结论（缓存未命中且未补查），不等于 0 分。 */
  riskScore: number | null;
  loginCount: number;
  lastSeenAt: number;
  isDatacenter?: boolean;
}

export interface AccountRiskFacts {
  now: number;
  /** 账号创建时间戳；取不到给 null（不据此判「新号」）。 */
  accountCreatedAt?: number | null;
  ipSignals: AccountIpRiskFact[];
  /** 设备台账里的最高风险分（0-100），无设备给 0。 */
  deviceMaxRiskScore?: number | null;
  /** 被判定为失陷/被 root 的设备数。 */
  compromisedDeviceCount?: number;
  /** 窗口内未处理的账户级滥用事件数（ACCOUNT_ABUSE_*）。 */
  recentAbuseEventCount?: number;
  /** 是否命中跨地域跳变（RC-15 的信号，由调用方比对会话台账后传入）。 */
  geoJump?: boolean;
  /**
   * RC-57：自动化痕迹（无头浏览器 / 模拟器 / 调试器）。
   * **只作为加权信号**：客户端可伪造，单独不足以升档（不能让它成为“被封的开关”）。
   */
  automationHint?: boolean;
}

export type AccountRiskFlag =
  | "HIGH_RISK_LOGIN_IP"
  | "MULTI_HIGH_RISK_IPS"
  | "DATACENTER_LOGIN_IP"
  | "NEW_ACCOUNT"
  | "COMPROMISED_DEVICE"
  | "ACCOUNT_ABUSE_EVENTS"
  | "GEO_JUMP"
  | "AUTOMATION_HINT";

export interface AccountRiskAssessment {
  /** 0-100，越高越危险。 */
  riskScore: number;
  /** 按分数与信号算出的原始档位（未受自动升档上限约束）。 */
  riskTier: AccountRiskTier;
  /** 应用 `autoEscalationCap` 后的档位 —— 这才是允许自动落库的值。 */
  cappedTier: AccountRiskTier;
  flags: AccountRiskFlag[];
  /** 可读原因，写进 riskFlags 之外的解释链（管理端与申诉用）。 */
  reasons: string[];
}

function clampScore(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value >= 100) return 100;
  return Math.round(value);
}

function capTier(tier: AccountRiskTier, cap: AccountRiskRuntimeConfig["autoEscalationCap"]): AccountRiskTier {
  const capTierValue: AccountRiskTier = cap === "restricted" ? "restricted" : "watch";
  return tierRank(tier) > tierRank(capTierValue) ? capTierValue : tier;
}

/**
 * 把事实折算成「风险分 + 档位 + 旗标」。
 *
 * 分数构成（刻意做成简单可解释的加权，而不是黑箱模型）：
 * - 最高 IP 风险分 × 0.45：单点信号，权重最高但单独不足以升到 `restricted`；
 * - 高危登录占比 × 25：区分「偶然走了一次机房」与「长期从高危出口登录」；
 * - 设备最高风险分 × 0.2：移动端设备证明已有的结论；
 * - 滥用事件：每件 +10，最多 +30（高频触发违规拦截是账户级特征，RC-20）；
 * - 失陷设备 +15；跨地域跳变 +10。
 * 阈值与权重都是运行时配置的一部分，改阈值不改公式。
 */
export function evaluateAccountRiskScore(
  facts: AccountRiskFacts,
  config: AccountRiskRuntimeConfig,
): AccountRiskAssessment {
  const flags: AccountRiskFlag[] = [];
  const reasons: string[] = [];

  const signals = Array.isArray(facts.ipSignals) ? facts.ipSignals : [];
  const scored = signals.filter((item) => typeof item.riskScore === "number");
  const ipMax = scored.reduce((max, item) => Math.max(max, item.riskScore as number), 0);

  const highRisk = scored.filter((item) => (item.riskScore as number) >= config.highRiskIpScore);
  const distinctHighRiskIps = new Set(highRisk.map((item) => item.ipAddress)).size;
  const highRiskLogins = highRisk.reduce((sum, item) => sum + Math.max(0, item.loginCount || 0), 0);
  const totalLogins = scored.reduce((sum, item) => sum + Math.max(0, item.loginCount || 0), 0);
  const highRiskRatio = totalLogins > 0 ? highRiskLogins / totalLogins : 0;

  if (highRisk.length > 0) {
    flags.push("HIGH_RISK_LOGIN_IP");
    reasons.push(`存在风险分 ≥ ${config.highRiskIpScore} 的登录 IP（最高 ${ipMax}）`);
  }
  if (distinctHighRiskIps >= config.minDistinctHighRiskIps) {
    flags.push("MULTI_HIGH_RISK_IPS");
    reasons.push(`高危登录 IP 达到 ${distinctHighRiskIps} 个（阈值 ${config.minDistinctHighRiskIps}）`);
  }
  if (signals.some((item) => item.isDatacenter === true)) {
    flags.push("DATACENTER_LOGIN_IP");
    reasons.push("存在机房/IDC 出口的登录记录");
  }

  const createdAt = typeof facts.accountCreatedAt === "number" ? facts.accountCreatedAt : null;
  const newAccount =
    createdAt !== null && facts.now - createdAt < config.newAccountWatchDays * 24 * 60 * 60 * 1000;
  if (newAccount) {
    flags.push("NEW_ACCOUNT");
    reasons.push(`注册不足 ${config.newAccountWatchDays} 天`);
  }

  const compromised = Math.max(0, facts.compromisedDeviceCount || 0);
  if (compromised > 0) {
    flags.push("COMPROMISED_DEVICE");
    reasons.push(`有 ${compromised} 台设备被判定为失陷/被篡改`);
  }

  const abuseEvents = Math.max(0, facts.recentAbuseEventCount || 0);
  if (abuseEvents > 0) {
    flags.push("ACCOUNT_ABUSE_EVENTS");
    reasons.push(`窗口内 ${abuseEvents} 次账户级违规拦截`);
  }

  if (facts.geoJump) {
    flags.push("GEO_JUMP");
    reasons.push("登录属地发生跨国家/省份跳变");
  }

  // RC-57：自动化痕迹只进旗标与分数，**不单独决定档位**（权重 8，远小于任一阈值）。
  if (facts.automationHint) {
    flags.push("AUTOMATION_HINT");
    reasons.push("检测到自动化/调试环境痕迹（仅作加权信号）");
  }

  const deviceMax = typeof facts.deviceMaxRiskScore === "number" ? Math.max(0, facts.deviceMaxRiskScore) : 0;
  const score = clampScore(
    ipMax * 0.45 +
      highRiskRatio * 25 +
      deviceMax * 0.2 +
      Math.min(30, abuseEvents * 10) +
      (compromised > 0 ? 15 : 0) +
      (facts.geoJump ? 10 : 0) +
      (facts.automationHint ? 8 : 0),
  );

  let tier: AccountRiskTier = "normal";
  if (score >= config.restrictedScoreThreshold) tier = "restricted";
  else if (score >= config.watchScoreThreshold) tier = "watch";

  // 新号至少进观察档：这是需求 §3 明确列出的触发条件，且与分数无关
  //（一个刚注册 3 分钟、还没用过任何 IP 的账号，分数必然是 0）。
  if (newAccount) tier = maxTier(tier, "watch");

  if (score >= config.dangerScoreThreshold) {
    // 自动升档不落 danger（§3：danger/banned 必须人工确认），只把建议写进原因链。
    reasons.push(`风险分 ${score} ≥ ${config.dangerScoreThreshold}，建议人工复核是否升为 danger`);
  }

  return {
    riskScore: score,
    riskTier: tier,
    cappedTier: capTier(tier, config.autoEscalationCap),
    flags,
    reasons,
  };
}

/** 升档时签发的逐步验证到期时间：到期未续期即退出，避免「永久每次验证」把用户卡死。 */
export function computeStepUpUntil(config: AccountRiskRuntimeConfig, now: number): number {
  const ttlMs = Math.max(60, config.stepUpTtlSeconds) * 1000;
  return now + ttlMs;
}

/** 哪些档位需要逐步验证（`banned` 不给验证机会，直接 403 ACCOUNT_SUSPENDED）。 */
export function tierRequiresStepUp(tier: AccountRiskTier | undefined | null): boolean {
  return tier === "restricted" || tier === "danger";
}
