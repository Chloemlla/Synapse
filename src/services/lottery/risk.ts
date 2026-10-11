import logger from "../../utils/logger";

/**
 * 抽奖风控引擎（PRD §3.4）。
 *
 * 设计原则：**风控分是输入，处置由本模块决定**。
 * - 分数来源：网关/上游的内部风控分（`riskScore`，仅内部可信来源）+ 服务端信号
 *   （同用户/同指纹/同 IP 的短窗口内抽奖频次）。
 * - 分级：`allow` 正常放行；`soft` **静默降级**（不出奖也不报错，路由到暗池空奖，
 *   抬高黑产逆向成本）；`block` 硬拦截（要求人机验证/直接拒绝）。
 * - 全部阈值与权重走 env，默认值即可用；关闭开关 `LOTTERY_RISK_ENABLED=false`。
 */

export type LotteryRiskLevel = "allow" | "soft" | "block";

export interface LotteryRiskConfig {
  enabled: boolean;
  softThreshold: number;
  blockThreshold: number;
  /** 短窗口内同用户抽奖次数达到该值开始计分。 */
  userWindowLimit: number;
  /** 短窗口内同指纹抽奖次数达到该值开始计分。 */
  fingerprintWindowLimit: number;
  /** 短窗口内同 IP 抽奖次数达到该值开始计分。 */
  ipWindowLimit: number;
  /** 频次窗口。 */
  windowMs: number;
}

function envInt(name: string, fallback: number, max: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed) || Math.floor(parsed) < 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

export const LOTTERY_RISK_DEFAULTS: LotteryRiskConfig = {
  enabled: process.env.LOTTERY_RISK_ENABLED !== "false",
  softThreshold: envInt("LOTTERY_RISK_SOFT_THRESHOLD", 40, 100),
  blockThreshold: envInt("LOTTERY_RISK_BLOCK_THRESHOLD", 80, 100),
  userWindowLimit: envInt("LOTTERY_RISK_USER_WINDOW_LIMIT", 10, 10_000),
  fingerprintWindowLimit: envInt("LOTTERY_RISK_FP_WINDOW_LIMIT", 20, 10_000),
  ipWindowLimit: envInt("LOTTERY_RISK_IP_WINDOW_LIMIT", 60, 100_000),
  windowMs: envInt("LOTTERY_RISK_WINDOW_MS", 60_000, 24 * 60 * 60 * 1000),
};

export interface LotteryRiskSignals {
  /** 上游/内部可信风控分（0-100）；客户端直接传的一律不采信。 */
  externalScore?: number;
  userDrawsInWindow: number;
  fingerprintDrawsInWindow: number;
  ipDrawsInWindow: number;
  /** 同一指纹下出现的不同账号数（群控特征）。 */
  distinctUsersPerFingerprint?: number;
}

export interface LotteryRiskDecision {
  score: number;
  level: LotteryRiskLevel;
  reasons: string[];
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/** 纯函数：把信号折算成 0-100 风控分与分级。 */
export function scoreLotteryRisk(
  signals: LotteryRiskSignals,
  config: LotteryRiskConfig = LOTTERY_RISK_DEFAULTS,
): LotteryRiskDecision {
  const reasons: string[] = [];
  let score = clampScore(signals.externalScore ?? 0);
  if (score > 0) reasons.push(`上游风控分 ${score}`);

  const overBy = (value: number, limit: number) => Math.max(0, value - limit);
  const userOver = overBy(signals.userDrawsInWindow, config.userWindowLimit);
  if (userOver > 0) {
    score += Math.min(30, userOver * 3);
    reasons.push(`短时高频抽奖（用户 ${signals.userDrawsInWindow} 次）`);
  }

  const fpOver = overBy(signals.fingerprintDrawsInWindow, config.fingerprintWindowLimit);
  if (fpOver > 0) {
    score += Math.min(30, fpOver * 2);
    reasons.push(`同设备高频抽奖（${signals.fingerprintDrawsInWindow} 次）`);
  }

  const ipOver = overBy(signals.ipDrawsInWindow, config.ipWindowLimit);
  if (ipOver > 0) {
    score += Math.min(30, ipOver);
    reasons.push(`同 IP 高频抽奖（${signals.ipDrawsInWindow} 次）`);
  }

  if ((signals.distinctUsersPerFingerprint ?? 0) > 1) {
    score += Math.min(30, (signals.distinctUsersPerFingerprint as number) * 5);
    reasons.push(`同设备多账号（${signals.distinctUsersPerFingerprint} 个）`);
  }

  score = clampScore(score);
  const level: LotteryRiskLevel =
    score >= config.blockThreshold ? "block" : score >= config.softThreshold ? "soft" : "allow";
  return { score, level, reasons };
}

// ── 服务端信号：进程内滑动窗口（按窗口 TTL 自动过期，跨实例由 Redis 版本补强） ──

interface WindowEntry {
  hits: number[];
}

const windows = new Map<string, WindowEntry>();

// ── 大盘指标（进程内累计，进程重启归零；跨实例聚合由指标系统/审计补足） ──

export interface LotteryRiskEvent {
  at: number;
  userId: string;
  level: LotteryRiskLevel;
  score: number;
  reasons: string[];
}

export interface LotteryRiskMetrics {
  enabled: boolean;
  thresholds: { soft: number; block: number };
  decisions: { allow: number; soft: number; block: number };
  recent: LotteryRiskEvent[];
  windows: { users: number; fingerprints: number; ips: number };
}

const decisions = { allow: 0, soft: 0, block: 0 };
const recentEvents: LotteryRiskEvent[] = [];
const RECENT_MAX = 50;

/** 记录一次风控判定（大盘用）。 */
export function recordRiskDecision(userId: string, decision: LotteryRiskDecision): void {
  decisions[decision.level] += 1;
  if (decision.level === "allow") return;
  recentEvents.unshift({ at: Date.now(), userId, level: decision.level, score: decision.score, reasons: decision.reasons });
  if (recentEvents.length > RECENT_MAX) recentEvents.length = RECENT_MAX;
}

/** 实时风控大盘指标快照。 */
export function getRiskMetrics(): LotteryRiskMetrics {
  const countByDimension = (dimension: string) =>
    [...windows.keys()].filter((key) => key.startsWith(`lottery:risk:${dimension}:`)).length;
  return {
    enabled: LOTTERY_RISK_DEFAULTS.enabled,
    thresholds: { soft: LOTTERY_RISK_DEFAULTS.softThreshold, block: LOTTERY_RISK_DEFAULTS.blockThreshold },
    decisions: { ...decisions },
    recent: [...recentEvents],
    windows: {
      users: countByDimension("user"),
      fingerprints: countByDimension("fingerprint"),
      ips: countByDimension("ip"),
    },
  };
}

/** 测试用：清空大盘指标。 */
export function resetRiskMetrics(): void {
  decisions.allow = 0;
  decisions.soft = 0;
  decisions.block = 0;
  recentEvents.length = 0;
}

function hit(key: string, now: number, windowMs: number): number {
  const entry = windows.get(key) ?? { hits: [] };
  const cutoff = now - windowMs;
  entry.hits = entry.hits.filter((ts) => ts > cutoff);
  entry.hits.push(now);
  windows.set(key, entry);
  return entry.hits.length;
}

/** 记录一次抽奖尝试并返回该维度窗口内次数。 */
export function recordRiskHit(
  dimension: "user" | "fingerprint" | "ip",
  value: string,
  now: number = Date.now(),
  windowMs: number = LOTTERY_RISK_DEFAULTS.windowMs,
): number {
  if (!value) return 0;
  return hit(`lottery:risk:${dimension}:${value}`, now, windowMs);
}

/** 测试用：清空滑动窗口。 */
export function resetRiskWindows(): void {
  windows.clear();
}

/** 采集服务端信号（不抛错；风控不可用不应阻塞抽奖）。 */
export function collectRiskSignals(params: {
  userId: string;
  fingerprint?: string;
  ip?: string;
  externalScore?: number;
  distinctUsersPerFingerprint?: number;
}): LotteryRiskSignals {
  const now = Date.now();
  const windowMs = LOTTERY_RISK_DEFAULTS.windowMs;
  const userDrawsInWindow = recordRiskHit("user", params.userId, now, windowMs);
  const fingerprintDrawsInWindow = params.fingerprint
    ? recordRiskHit("fingerprint", params.fingerprint, now, windowMs)
    : 0;
  const ipDrawsInWindow = params.ip ? recordRiskHit("ip", params.ip, now, windowMs) : 0;
  return {
    externalScore: params.externalScore,
    userDrawsInWindow,
    fingerprintDrawsInWindow,
    ipDrawsInWindow,
    distinctUsersPerFingerprint: params.distinctUsersPerFingerprint,
  };
}

export function evaluateLotteryRisk(params: {
  userId: string;
  fingerprint?: string;
  ip?: string;
  externalScore?: number;
  distinctUsersPerFingerprint?: number;
}): LotteryRiskDecision {
  if (!LOTTERY_RISK_DEFAULTS.enabled) {
    return { score: 0, level: "allow", reasons: [] };
  }
  const decision = scoreLotteryRisk(collectRiskSignals(params));
  recordRiskDecision(params.userId, decision);
  if (decision.level !== "allow") {
    logger.warn("[LotteryRisk] 命中风控", {
      userId: params.userId,
      level: decision.level,
      score: decision.score,
      reasons: decision.reasons,
    });
  }
  return decision;
}
