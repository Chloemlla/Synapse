import { readCaptchaChallenge } from "../../services/turnstile/challenge";
import { TurnstileService } from "../../services/turnstileService";
import logger from "../../utils/logger";

// 登录失败尝试次数限制
export const LOGIN_ATTEMPT_LIMIT = 5;
// 多次登录失败预警阈值（低于锁定阈值）
export const LOGIN_FAILURE_ALERT_THRESHOLD = 3;
export const LOGIN_LOCKOUT_DURATION = 15 * 60 * 1000; // 15分钟
export const loginAttempts = new Map<string, { count: number; lastAttempt: number; lockedUntil?: number }>();

export function getLoginRetrySeconds(lockedUntil: number): number {
  return Math.max(1, Math.ceil((lockedUntil - Date.now()) / 1000));
}

// 支持的主流邮箱后缀。
//
// 这里存的是**已转义的正则片段**（点号写成 `\.`），下面直接 join 进 RegExp。
// 旧写法是存纯域名、再在运行时 `d.replace(/\./g, "\\.")` 现转义，被 CodeQL
// js/incomplete-sanitization 判为「只转义元字符、未转义反斜杠」的不完整转义
// （而且更早的 `d.replace(".", "\\.")` 连多点域名都只替第一个点）。
// 数组本身就是字面量，不再有任何运行时 replace，也就不存在转义遗漏。
const allowedDomainPatterns = [
  "gmail\\.com",
  "outlook\\.com",
  "qq\\.com",
  "163\\.com",
  "126\\.com",
  "hotmail\\.com",
  "yahoo\\.com",
  "icloud\\.com",
  "foxmail\\.com",
  "chloemlla\\.com",
];
export const emailPattern = new RegExp(`^[\\w.-]+@(${allowedDomainPatterns.join("|")})$`);

// 临时存储验证码和注册信息
export const emailCodeMap = new Map<string, { code: string; time: number; regInfo: any; attempts: number }>(); // email -> { code, time, regInfo, attempts }
// 临时存储密码重置验证码（含设备指纹和IP用于验证一致性）
export const resetPasswordCodeMap = new Map<
  string,
  { code: string; time: number; userId: string; attempts: number; fingerprint?: string; ipAddress?: string }
>(); // email -> { code, time, userId, attempts, fingerprint, ipAddress }

// G2-20: 给模块级认证状态 Map 加 TTL 清理 + 容量上限，避免攻击者用随机 identifier 持续放大内存。
const AUTH_STATE_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const LOGIN_ATTEMPTS_MAX_ENTRIES = 20_000;
const CODE_MAP_MAX_ENTRIES = 5_000;

function cleanupLoginAttempts(now = Date.now()): void {
  if (loginAttempts.size <= LOGIN_ATTEMPTS_MAX_ENTRIES) {
    // 仍然清理已过锁定期的条目
    for (const [key, value] of loginAttempts) {
      if (!value.lockedUntil || value.lockedUntil <= now) {
        if (!value.lockedUntil && now - value.lastAttempt > 24 * 60 * 60 * 1000) {
          loginAttempts.delete(key);
        } else if (value.lockedUntil && value.lockedUntil <= now) {
          loginAttempts.delete(key);
        }
      }
    }
    return;
  }
  // 超上限：整体清空（保守兜底，防止内存无限增长）
  loginAttempts.clear();
}

function cleanupCodeMap<K>(map: Map<K, { time: number }>, maxEntries: number, ttlMs: number, now = Date.now()): void {
  if (map.size <= maxEntries) {
    for (const [key, value] of map) {
      if (now - value.time > ttlMs) {
        map.delete(key);
      }
    }
    return;
  }
  // 超上限：先按时间排序淘汰最旧的，直到回落到上限
  const ordered = [...map.entries()].sort((a, b) => a[1].time - b[1].time);
  const excess = map.size - maxEntries;
  for (const [key] of ordered.slice(0, excess)) {
    map.delete(key);
  }
}

setInterval(() => {
  try {
    cleanupLoginAttempts();
    cleanupCodeMap(emailCodeMap, CODE_MAP_MAX_ENTRIES, 10 * 60 * 1000);
    cleanupCodeMap(resetPasswordCodeMap, CODE_MAP_MAX_ENTRIES, 10 * 60 * 1000);
  } catch (error) {
    logger.warn("[Auth] 认证状态清理异常", { error: error instanceof Error ? error.message : String(error) });
  }
}, AUTH_STATE_CLEANUP_INTERVAL_MS).unref();

// 最大验证码失败次数（防暴力枚举）
export const MAX_CODE_ATTEMPTS = 5;

// 获取前端基础URL
export function getFrontendBaseUrl(): string {
  return process.env.FRONTEND_URL || "https://chloemlla.com";
}

/**
 * 请求侧人机验证闸门：所有页面（登录/注册/忘记密码/重置密码/TTS/图床/抽奖/CDK…）共用这一段判定。
 *
 * 与历史 `verifyRequiredTurnstile` 的区别：
 * - 「要不要验」不再看 Turnstile 凭据是否存在，而是看三家供应商里有没有任一家真正可下发
 *   （已上线 + 凭据齐 + 本月额度未用尽）；三家全下线 ⇒ 放行，与历史「开关关掉即放行」等价。
 * - 「验哪家」由客户端声明的 `captchaProvider` 决定（缺失/非法 → turnstile，兼容老客户端）。
 * - 客户端声明的供应商已不在可下发名单（管理端在用户答题期间把它下线了）时不再卡人：
 *   该家的凭据可能已被清掉，再怎么验都会失败，此时放行与「管理端关掉这家」语义一致。
 */
export async function verifyRequiredCaptcha(
  challenge: unknown,
  ip: string,
  logTag: string,
  subject?: string,
): Promise<string | null> {
  const { token, provider } = readCaptchaChallenge(challenge);
  const policy = await TurnstileService.getCaptchaRequestPolicy();
  if (!policy.required) {
    return null;
  }

  if (typeof token !== "string" || token.length === 0) {
    logger.warn(`[${logTag}] 缺少人机验证令牌`, { subject, ip, provider });
    return "请先完成人机验证";
  }

  const isValid = await TurnstileService.verifyCaptchaChallenge({ token, provider, remoteIp: ip });
  if (isValid) {
    return null;
  }

  if (!policy.enabledProviders.includes(provider)) {
    logger.warn(`[${logTag}] 声明的供应商已下线，本次放行`, {
      subject,
      ip,
      provider,
      enabledProviders: policy.enabledProviders,
    });
    return null;
  }

  logger.warn(`[${logTag}] 人机验证失败`, { subject, ip, provider });
  return "人机验证失败，请重试";
}

/**
 * @deprecated 保留给尚未接入统一链路的调用点：只接受 Turnstile 令牌。
 * 新代码一律用 `verifyRequiredCaptcha`（三家共用）。
 */
export async function verifyRequiredTurnstile(
  token: unknown,
  ip: string,
  logTag: string,
  subject?: string,
): Promise<string | null> {
  return verifyRequiredCaptcha({ token, captchaProvider: "turnstile" }, ip, logTag, subject);
}
