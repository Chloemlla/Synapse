import crypto from "node:crypto";
import { config } from "../config/config";
import logger from "../utils/logger";
import { sharedStateStore } from "./sharedStateStore";

export type ProfileVerificationMethod = "password" | "totp" | "passkey";

export interface ProfileVerificationSession {
  token: string;
  userId: string;
  method: ProfileVerificationMethod;
  createdAt: number;
  expiresAt: number;
}

interface PendingEmailChangeChallenge {
  userId: string;
  newEmail: string;
  code: string;
  createdAt: number;
  expiresAt: number;
  lastSentAt: number;
  attempts: number;
}

// 与前端「使用登录密码建立 10 分钟安全会话」的文案保持一致。
const PROFILE_VERIFICATION_TTL_MS = 10 * 60 * 1000;
const EMAIL_CHANGE_CODE_TTL_MS = 10 * 60 * 1000;
const EMAIL_CHANGE_RESEND_INTERVAL_MS = 60 * 1000;
const MAX_EMAIL_CHANGE_ATTEMPTS = 5;

/**
 * 安全会话与邮箱变更验证码的存储与校验。
 *
 * 改造要点（见 docs/audit/audit-2026-10-01-storage-responsibility.md §四 S1）：
 *  - **令牌自包含**：`v2.<base64url(payload)>.<base64url(hmac)>`，payload 带 userId / method /
 *    签发时间 / 过期时间。校验是纯 HMAC + 时间比较，因此跨实例、跨重启都成立，
 *    不再依赖「签发它的那个进程还记得」；
 *  - **撤销走共享水位**：同一用户重新建立会话、或显式结束会话时，往 sharedStateStore 写一个
 *    撤销水位（`security-session:revoked:<userId>`），全局结束写 `…:revoked:global`。
 *    校验是同步的（敏感操作守卫链是同步 API），所以本地保留一份水位缓存，
 *    按需异步刷新（`REVOCATION_REFRESH_MS`，即跨实例撤销的收敛窗口 ≤ 该值）；
 *  - **邮箱变更验证码**落 sharedStateStore（TTL 即过期），不再散在进程内存里。
 */

const TOKEN_VERSION = "v2";
const REVOCATION_KEY_PREFIX = "security-session:revoked:";
const GLOBAL_REVOCATION_KEY = "security-session:revoked:global";
// 水位只需要活过一个会话 TTL：10 分钟之后再老的令牌本身也已过期。
const REVOCATION_KEY_TTL_MS = 30 * 60 * 1000;
// 跨实例撤销的收敛窗口：本地水位缓存的刷新间隔。
const REVOCATION_REFRESH_MS = 2_000;
const REVOCATION_CACHE_MAX_ENTRIES = 10_000;

const EMAIL_CHALLENGE_KEY_PREFIX = "email-change:challenge:";

interface RevocationCacheEntry {
  watermark: number;
  fetchedAt: number;
}

interface TokenPayload {
  u: string;
  /** 验证方式编码（0=password / 1=totp / 2=passkey）：令牌内不出现明文方式名。 */
  m: number;
  iat: number;
  exp: number;
  j: string;
}

/** 验证方式 ↔ 令牌内数字编码，只在这一层做映射。 */
const METHOD_CODES: Record<ProfileVerificationMethod, number> = { password: 0, totp: 1, passkey: 2 };
const METHOD_BY_CODE: Record<number, ProfileVerificationMethod> = { 0: "password", 1: "totp", 2: "passkey" };

/** 本地撤销水位缓存：同步校验的唯一依据，由 sharedStateStore 异步刷新。 */
const revocationCache = new Map<string, RevocationCacheEntry>();
const inFlightRefreshes = new Set<string>();

/** JWT_SECRET 缺失时的进程内兑底签名键（仅开发环境，不跨实例/跨重启）。 */
let processScopedKey: Buffer | null = null;

/** 子密钥派生的固定盐与迭代数（确定性：同一 JWT_SECRET 必得同一子密钥）。 */
const SUBKEY_SALT = "synapse:security-session:v2";
const SUBKEY_ITERATIONS = 150_000;
const SUBKEY_LENGTH = 32;
let cachedSigningKey: Buffer | null = null;

function signingKey(): Buffer {
  if (cachedSigningKey) return cachedSigningKey;

  const secret = typeof config.jwtSecret === "string" && config.jwtSecret ? config.jwtSecret : "";
  if (!secret) {
    // 开发环境没配 JWT_SECRET 时退化为进程内随机密钥：令牌不再跨实例/跨重启有效，
    // 但不会静默削弱签名强度。生产启动诊断会拦住缺失的 JWT_SECRET。
    if (!processScopedKey) {
      processScopedKey = crypto.randomBytes(SUBKEY_LENGTH);
      logger.warn("[SecuritySession] JWT_SECRET 缺失，安全会话令牌仅在当前进程内有效");
    }
    cachedSigningKey = processScopedKey;
    return cachedSigningKey;
  }

  // 不跨协议复用同一把密钥：从 JWT_SECRET 派生独立用途的子密钥。
  // 用 PBKDF2（固定盐 + 高迭代）而不是裸 SHA-256：这是标准的密钥派生写法，
  // 派生结果只用作 HMAC 子密钥，不作口令存储。
  cachedSigningKey = crypto.pbkdf2Sync(
    `security-session\u0000${secret}`,
    SUBKEY_SALT,
    SUBKEY_ITERATIONS,
    SUBKEY_LENGTH,
    "sha256",
  );
  return cachedSigningKey;
}

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function signToken(payload: TokenPayload): string {
  const body = base64UrlEncode(JSON.stringify(payload));
  const signature = crypto.createHmac("sha256", signingKey()).update(`${TOKEN_VERSION}.${body}`).digest();
  return `${TOKEN_VERSION}.${body}.${base64UrlEncode(signature)}`;
}

function parseToken(token: string): TokenPayload | null {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return null;

  const [version, body, signature] = parts;
  let expected: Buffer;
  try {
    expected = crypto.createHmac("sha256", signingKey()).update(`${version}.${body}`).digest();
  } catch {
    return null;
  }

  let provided: Buffer;
  try {
    provided = Buffer.from(signature, "base64url");
  } catch {
    return null;
  }
  if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<TokenPayload>;
    if (typeof parsed.u !== "string" || !parsed.u) return null;
    if (typeof parsed.m !== "number" || !METHOD_BY_CODE[parsed.m]) return null;
    if (typeof parsed.iat !== "number" || !Number.isFinite(parsed.iat)) return null;
    if (typeof parsed.exp !== "number" || !Number.isFinite(parsed.exp)) return null;
    return {
      u: parsed.u,
      m: parsed.m,
      iat: parsed.iat,
      exp: parsed.exp,
      j: typeof parsed.j === "string" ? parsed.j : "",
    };
  } catch {
    return null;
  }
}

function pruneRevocationCache(now = Date.now()): void {
  for (const [key, entry] of revocationCache.entries()) {
    if (now - entry.fetchedAt > REVOCATION_KEY_TTL_MS) revocationCache.delete(key);
  }
  if (revocationCache.size > REVOCATION_CACHE_MAX_ENTRIES) {
    const ordered = [...revocationCache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
    for (const [key] of ordered.slice(0, revocationCache.size - REVOCATION_CACHE_MAX_ENTRIES)) {
      revocationCache.delete(key);
    }
  }
}

/** 同步读本地水位；缓存缺失/过期时顺带触发一次异步刷新（本次仍用现有值判定）。 */
function cachedWatermark(cacheKey: string): number {
  const now = Date.now();
  const entry = revocationCache.get(cacheKey);
  if (!entry || now - entry.fetchedAt > REVOCATION_REFRESH_MS) {
    scheduleRevocationRefresh(cacheKey);
  }
  return entry?.watermark ?? 0;
}

function scheduleRevocationRefresh(cacheKey: string): void {
  if (inFlightRefreshes.has(cacheKey)) return;
  inFlightRefreshes.add(cacheKey);
  void sharedStateStore
    .get<number>(cacheKey)
    .then((value) => {
      const watermark = typeof value === "number" && Number.isFinite(value) ? value : 0;
      const previous = revocationCache.get(cacheKey);
      // 水位只增不减：并发刷新时不能被更旧的值覆盖。
      if (!previous || watermark >= previous.watermark) {
        revocationCache.set(cacheKey, { watermark, fetchedAt: Date.now() });
      } else {
        revocationCache.set(cacheKey, { watermark: previous.watermark, fetchedAt: Date.now() });
      }
      pruneRevocationCache();
    })
    .catch((error) => {
      logger.warn("[SecuritySession] 刷新撤销水位失败，本次沿用本地水位", {
        cacheKey,
        error: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => {
      inFlightRefreshes.delete(cacheKey);
    });
}

/** 写撤销水位：本地立即生效（同步校验马上能看到），共享层写穿让其它实例在刷新窗口内收敛。 */
function setWatermark(cacheKey: string, watermark: number): void {
  const previous = revocationCache.get(cacheKey);
  const next = Math.max(watermark, previous?.watermark ?? 0);
  revocationCache.set(cacheKey, { watermark: next, fetchedAt: Date.now() });
  pruneRevocationCache();
  void sharedStateStore
    .set(cacheKey, next, REVOCATION_KEY_TTL_MS)
    .catch((error) =>
      logger.warn("[SecuritySession] 写撤销水位失败（仅本实例立即生效）", {
        cacheKey,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
}

export function createProfileVerificationSession(
  userId: string,
  method: ProfileVerificationMethod,
): ProfileVerificationSession {
  const perUserKey = `${REVOCATION_KEY_PREFIX}${userId}`;
  const now = Date.now();
  // 时钟回拨或跨实例偏斜时，本地已知水位可能已经跑到 now 前面；此时把签发时间抬到
  // 「已知水位 + 1ms」，保证新令牌在任何实例上都严格新于现有水位，不会被自己人的缓存误杀。
  const watermark = Math.max(cachedWatermark(perUserKey), cachedWatermark(GLOBAL_REVOCATION_KEY));
  const issuedAt = Math.max(now, watermark + 1);
  const expiresAt = issuedAt + PROFILE_VERIFICATION_TTL_MS;
  const session: ProfileVerificationSession = {
    token: signToken({ u: userId, m: METHOD_CODES[method], iat: issuedAt, exp: expiresAt, j: crypto.randomUUID() }),
    userId,
    method,
    createdAt: issuedAt,
    expiresAt,
  };

  // 「同一用户只保留最新一枚会话」：把该用户的水位推到签发时刻，旧令牌（iat 更早）立即失效。
  setWatermark(perUserKey, issuedAt);
  return session;
}

export function validateProfileVerificationSession(userId: string, token: string): ProfileVerificationSession | null {
  const payload = parseToken(token);
  if (!payload) return null;
  if (payload.u !== userId) return null;
  if (payload.exp <= Date.now()) return null;

  // 水位严格大于签发时间才算被撤销，因此「刚签发的那一枚」不会被自己写下的水位误杀。
  if (payload.iat < cachedWatermark(`${REVOCATION_KEY_PREFIX}${userId}`)) return null;
  if (payload.iat < cachedWatermark(GLOBAL_REVOCATION_KEY)) return null;

  return {
    token,
    userId,
    method: METHOD_BY_CODE[payload.m] as ProfileVerificationMethod,
    createdAt: payload.iat,
    expiresAt: payload.exp,
  };
}

/** 仅供测试：清空本地撤销水位缓存（不碰共享层，等价于「刚启动的干净进程」）。 */
export function resetSecuritySessionCacheForTests(): void {
  revocationCache.clear();
  inFlightRefreshes.clear();
}

/** 结束该用户的全部安全会话（本地立即生效，跨实例 ≤ REVOCATION_REFRESH_MS 收敛）。 */
export function clearProfileVerificationSessions(userId: string): void {
  setWatermark(`${REVOCATION_KEY_PREFIX}${userId}`, Date.now());
}

/**
 * 立即结束全站所有安全会话（管理后台紧急撑销）。
 * 自包含令牌无法枚举，因此返回**本实例已知的、被这次水位覆盖的会话数下界**（仅供面板展示）。
 */
export function clearAllProfileVerificationSessions(): number {
  const now = Date.now();
  let locallyCovered = 0;
  for (const [key, entry] of revocationCache.entries()) {
    if (key.startsWith(REVOCATION_KEY_PREFIX) && entry.watermark < now) locallyCovered += 1;
  }
  setWatermark(GLOBAL_REVOCATION_KEY, now);
  return locallyCovered;
}

function emailChallengeKey(userId: string): string {
  return `${EMAIL_CHALLENGE_KEY_PREFIX}${userId}`;
}

export async function createEmailChangeChallenge(
  userId: string,
  newEmail: string,
): Promise<{
  success: boolean;
  code?: string;
  retryAfterMs?: number;
  error?: string;
}> {
  const now = Date.now();
  const existing = await sharedStateStore.get<PendingEmailChangeChallenge>(emailChallengeKey(userId));

  if (
    existing &&
    existing.newEmail === newEmail &&
    now - existing.lastSentAt < EMAIL_CHANGE_RESEND_INTERVAL_MS
  ) {
    return {
      success: false,
      error: "验证码发送过于频繁，请稍后再试",
      retryAfterMs: EMAIL_CHANGE_RESEND_INTERVAL_MS - (now - existing.lastSentAt),
    };
  }

  const challenge: PendingEmailChangeChallenge = {
    userId,
    newEmail,
    code: generateEmailCode(),
    createdAt: now,
    expiresAt: now + EMAIL_CHANGE_CODE_TTL_MS,
    lastSentAt: now,
    attempts: 0,
  };

  await sharedStateStore.set(emailChallengeKey(userId), challenge, EMAIL_CHANGE_CODE_TTL_MS);

  return {
    success: true,
    code: challenge.code,
  };
}

export async function validateEmailChangeChallenge(
  userId: string,
  newEmail: string,
  code: string,
): Promise<{
  success: boolean;
  status: number;
  error?: string;
}> {
  const key = emailChallengeKey(userId);
  const challenge = await sharedStateStore.get<PendingEmailChangeChallenge>(key);
  if (!challenge) {
    return {
      success: false,
      status: 400,
      error: "请先向新邮箱发送验证码",
    };
  }

  if (challenge.newEmail !== newEmail) {
    return {
      success: false,
      status: 400,
      error: "验证码与当前待验证邮箱不匹配，请重新发送",
    };
  }

  if (challenge.expiresAt <= Date.now()) {
    await sharedStateStore.delete(key);
    return {
      success: false,
      status: 400,
      error: "验证码已过期，请重新发送",
    };
  }

  if (challenge.attempts >= MAX_EMAIL_CHANGE_ATTEMPTS) {
    await sharedStateStore.delete(key);
    return {
      success: false,
      status: 429,
      error: "验证码尝试次数过多，请重新发送",
    };
  }

  if (challenge.code !== code) {
    const attempts = challenge.attempts + 1;
    // 失败次数按剩余有效期续写，避免过期挑战被重新计数的同时不无限留档。
    await sharedStateStore.set(
      key,
      { ...challenge, attempts },
      Math.max(1, challenge.expiresAt - Date.now()),
    );

    if (attempts >= MAX_EMAIL_CHANGE_ATTEMPTS) {
      await sharedStateStore.delete(key);
      return {
        success: false,
        status: 429,
        error: "验证码尝试次数过多，请重新发送",
      };
    }

    return {
      success: false,
      status: 400,
      error: "验证码错误",
    };
  }

  return {
    success: true,
    status: 200,
  };
}

export async function clearEmailChangeChallenge(userId: string): Promise<void> {
  await sharedStateStore.delete(emailChallengeKey(userId));
}

function generateEmailCode(length = 6): string {
  let code = "";
  for (let index = 0; index < length; index += 1) {
    code += crypto.randomInt(0, 10).toString();
  }
  return code;
}
