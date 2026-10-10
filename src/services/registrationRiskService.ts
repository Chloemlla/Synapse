import { RegistrationAttempt } from "../models/registrationAttemptModel";
import { normalizeEmailCanonical } from "./blockedIdentityService";
import { getCachedIpRisk } from "./ipRiskService";
import { mongoose } from "./mongoService";
import logger from "../utils/logger";

/**
 * 注册反滥用闸门（RC-05）。
 *
 * 三条口径（全部对齐审计原文）：
 * 1. **邮箱规范化**：`normalizeEmailCanonical` 把 `User@Gmail.com` / `u.s.e.r@gmail.com` /
 *    `user+1@gmail.com` 折成同一个身份键（与 RC-47 墓碑表共用同一实现，避免两套规范化漂移）；
 * 2. **三维配额**：同 IP / 同指纹 / 同邮箱规范化值各自按时间窗口计数，任一超限即拦；
 * 3. **机房出口 + 无邀请码**：IDC/托管 IP 注册**不使用邀请码**时直接拒绝 —— 这是独立规则，
 *    不与风险分耦合（耦合会被低分掩盖：境外 IDC 出口常常 risk 分并不高）。
 *
 * 阈值走 env（运营参数，改它随重启生效），并做边界收敛：把 NaN/0/负数带进 `$gte` 条件，
 * 会让闸门恒假（等于没有闸门）。
 */

export interface RegistrationRiskInput {
  ipAddress: string;
  fingerprint: string;
  email: string;
  hasInvite: boolean;
}

export interface RegistrationRiskDecision {
  allowed: boolean;
  /** 稳定 code：前端与客服据此解释「为什么被拦」。 */
  code?: "REGISTRATION_IP_QUOTA" | "REGISTRATION_DEVICE_QUOTA" | "REGISTRATION_EMAIL_VARIANTS" | "REGISTRATION_IDC_NO_INVITE";
  reason?: string;
  ipRiskScore: number | null;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function readPositiveIntEnv(name: string, fallback: number, max: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed) || Math.floor(parsed) < 1) return fallback;
  return Math.min(Math.floor(parsed), max);
}

/** 同 IP 24 小时内允许的**成功**注册数（默认 3）。 */
const IP_DAILY_LIMIT = readPositiveIntEnv("REGISTRATION_IP_DAILY_LIMIT", 3, 100);
/** 同指纹 24 小时内允许的成功注册数（默认 2：一台设备正常只会注册一个号）。 */
const DEVICE_DAILY_LIMIT = readPositiveIntEnv("REGISTRATION_DEVICE_DAILY_LIMIT", 2, 100);
/** 同 (IP 或 指纹) 7 天内允许出现过的不同规范化邮箱数（默认 5）。 */
const EMAIL_VARIANT_LIMIT = readPositiveIntEnv("REGISTRATION_EMAIL_VARIANT_LIMIT", 5, 1000);

function mongoReady(): boolean {
  return mongoose.connection.readyState === 1;
}

export interface RecordRegistrationAttemptInput {
  ipAddress: string;
  fingerprint: string;
  email: string;
  inviteCode?: string;
  outcome: "requested" | "succeeded" | "blocked";
  ipRiskScore?: number | null;
  blockCode?: string;
}

export async function recordRegistrationAttempt(input: RecordRegistrationAttemptInput): Promise<void> {
  if (!mongoReady()) return;
  try {
    await RegistrationAttempt.create({
      ipAddress: String(input.ipAddress || "").slice(0, 128),
      fingerprint: String(input.fingerprint || "").slice(0, 512),
      emailCanonical: normalizeEmailCanonical(input.email || ""),
      emailRaw: String(input.email || "").slice(0, 320),
      inviteCode: String(input.inviteCode || "").slice(0, 128),
      outcome: input.outcome,
      ipRiskScore: typeof input.ipRiskScore === "number" ? input.ipRiskScore : null,
      blockCode: input.blockCode || "",
    });
  } catch (error) {
    // 台账写失败不能把注册打成 500：它是计数依据，最坏退化为“这一轮少算一次”。
    logger.warn("[RegistrationRisk] 注册尝试台账写入失败", {
      ip: input.ipAddress,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function isDatacenterIp(flags: string[] | undefined, networkType: string | undefined): boolean {
  if (Array.isArray(flags) && flags.includes("datacenter")) return true;
  return /datacenter|data center|hosting|\bidc\b/i.test(String(networkType || ""));
}

/**
 * 判定这一次注册是否可以继续。
 *
 * 只统计 **succeeded**：把「请求过验证码但没完成」也算进去会让正常用户的失败重试把自己挡在门外
 *（网络抖动、验证码输错一次都很常见），而防滥用的目标是「真的注册出了账号」。
 */
export async function evaluateRegistrationRisk(input: RegistrationRiskInput): Promise<RegistrationRiskDecision> {
  const emailCanonical = normalizeEmailCanonical(input.email);
  const ipRisk = await getCachedIpRisk(input.ipAddress).catch(() => null);
  const ipRiskScore = ipRisk && typeof ipRisk.risk === "number" ? ipRisk.risk : null;

  if (!mongoReady()) {
    // 数据库不可用时**不放行**：注册是写库操作，库不可用本来就写不进去；
    // 这里直接返回拒绝，避免“闸门失效 + 写入失败”叠加成不可解释的 500。
    return { allowed: false, code: "REGISTRATION_IP_QUOTA", reason: "服务暂时不可用，请稍后再试", ipRiskScore };
  }

  const since24h = new Date(Date.now() - DAY_MS);
  const since7d = new Date(Date.now() - 7 * DAY_MS);

  const [sameIp, sameDevice, distinctEmails] = await Promise.all([
    RegistrationAttempt.countDocuments({
      ipAddress: input.ipAddress,
      outcome: "succeeded",
      createdAt: { $gte: since24h },
    }).exec(),
    RegistrationAttempt.countDocuments({
      fingerprint: input.fingerprint,
      outcome: "succeeded",
      createdAt: { $gte: since24h },
    }).exec(),
    RegistrationAttempt.distinct("emailCanonical", {
      $or: [{ ipAddress: input.ipAddress }, { fingerprint: input.fingerprint }],
      outcome: "succeeded",
      createdAt: { $gte: since7d },
    }).exec(),
  ]);

  if (sameIp >= IP_DAILY_LIMIT) {
    return {
      allowed: false,
      code: "REGISTRATION_IP_QUOTA",
      reason: "当前网络注册频率过高，请稍后再试或联系支持",
      ipRiskScore,
    };
  }
  if (sameDevice >= DEVICE_DAILY_LIMIT) {
    return {
      allowed: false,
      code: "REGISTRATION_DEVICE_QUOTA",
      reason: "当前设备注册账号过多，请使用邀请码或联系支持",
      ipRiskScore,
    };
  }
  const alreadySeen = Array.isArray(distinctEmails) ? distinctEmails.filter((item) => item) : [];
  if (!alreadySeen.includes(emailCanonical) && alreadySeen.length >= EMAIL_VARIANT_LIMIT) {
    return {
      allowed: false,
      code: "REGISTRATION_EMAIL_VARIANTS",
      reason: "检测到同一来源批量注册，请使用邀请码或联系支持",
      ipRiskScore,
    };
  }

  // RC-14：机房/IDC 出口 + 未使用邀请码 ⇒ 直接拒绝（独立规则，不与风险分耦合）。
  if (!input.hasInvite && isDatacenterIp(ipRisk?.flags, ipRisk?.networkType)) {
    return {
      allowed: false,
      code: "REGISTRATION_IDC_NO_INVITE",
      reason: "当前网络环境不支持直接注册，请使用邀请码或联系支持",
      ipRiskScore,
    };
  }

  return { allowed: true, ipRiskScore };
}
