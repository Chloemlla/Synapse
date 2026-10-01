import crypto from "node:crypto";
import type { Request, Response } from "express";
import { config } from "../config/config";
import { CONSENT_VALIDITY_DAYS } from "../config/policyMeta";
import IpVerificationService from "./ipVerificationService";
import { parseCookieHeader } from "../utils/authCookie";
import { getClientIP } from "../utils/ipUtils";

/**
 * 政策同意的「设备凭据」：签发、校验与归属断言。
 *
 * G3-12：verify 时下发与指纹绑定的 HMAC 凭据，check / status / history / revoke 必须携带它才能操作，
 * 防止拿别人指纹（日志里就有）就查、撤、删除别人的同意记录。
 * 刻意不接受「已登录会话」：会话只证明调用者是谁，不证明他是这台设备——指纹在本系统里就是
 * 设备凭据本身。写路径额外承认首访验证令牌（首次写入时还没有同意 cookie，后者正是该端点签发的）。
 */

const CONSENT_TOKEN_COOKIE = "policy_consent_token";
// 用独立派生密钥签名，避免把 JWT 签名密钥直接用于 UI 状态签名
const CONSENT_TOKEN_SECRET = crypto.createHmac("sha256", config.jwtSecret).update("policy-consent-token").digest();
// 凭据自身带签发时间并据此判龄：cookie 的 maxAge 拦得住「浏览器继续回传」，
// 拦不住「凭据被复制走后在任意客户端重放」。上限取与同意记录一致的有效期。
const CONSENT_TOKEN_TTL_MS = CONSENT_VALIDITY_DAYS * 24 * 60 * 60 * 1000;
// 容忍客户端/服务端时钟偏移，避免刚签发的凭据被判成「来自未来」
const CONSENT_TOKEN_CLOCK_SKEW_MS = 5 * 60 * 1000;

function signConsentTokenPayload(payload: string): string {
  return crypto.createHmac("sha256", CONSENT_TOKEN_SECRET).update(payload).digest("hex");
}

function timingSafeHexEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// 新形态：`base64url({f,iat}).hmac`。默认不把指纹原文写进 cookie 值。
function buildConsentToken(fingerprint: string): string {
  const payload = Buffer.from(JSON.stringify({ f: fingerprint, iat: Date.now() }), "utf8").toString("base64url");
  return `${payload}.${signConsentTokenPayload(payload)}`;
}

export function verifyConsentToken(token: string | undefined, fingerprint: string): boolean {
  if (!token || typeof token !== "string") return false;
  const separator = token.lastIndexOf(".");
  if (separator <= 0) return false;
  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  // 签名先过：旧形态的签名原文就是指纹本身，这一步对两种形态都成立
  if (!timingSafeHexEqual(signature, signConsentTokenPayload(payload))) return false;

  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      f?: unknown;
      iat?: unknown;
    };
    if (parsed.f !== fingerprint) return false;
    const issuedAt = typeof parsed.iat === "number" ? parsed.iat : Number.NaN;
    if (!Number.isFinite(issuedAt)) return false;
    const age = Date.now() - issuedAt;
    return age >= -CONSENT_TOKEN_CLOCK_SKEW_MS && age <= CONSENT_TOKEN_TTL_MS;
  } catch {
    // 旧形态 `<fingerprint>.<sig>`：继续接受。指纹仍被逐一比对，重放上限由库中记录自身的
    // expiresAt 兜住——升级即让所有在线设备掉凭据，代价大于收益。
    return payload === fingerprint;
  }
}

export function readConsentTokenCookie(req: Request): string | undefined {
  const cookies = parseCookieHeader(typeof req.headers.cookie === "string" ? req.headers.cookie : undefined);
  const fromReqCookies = (req as Request & { cookies?: Record<string, string> }).cookies?.[CONSENT_TOKEN_COOKIE];
  return fromReqCookies || cookies[CONSENT_TOKEN_COOKIE];
}

function isSecureRequest(req: Request): boolean {
  return req.secure || process.env.NODE_ENV === "production";
}

export function setConsentTokenCookie(req: Request, res: Response, fingerprint: string): void {
  res.cookie(CONSENT_TOKEN_COOKIE, buildConsentToken(fingerprint), {
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureRequest(req),
    path: "/",
    maxAge: CONSENT_VALIDITY_DAYS * 24 * 60 * 60 * 1000,
  });
}

export function clearConsentTokenCookie(req: Request, res: Response): void {
  res.clearCookie(CONSENT_TOKEN_COOKIE, {
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureRequest(req),
    path: "/",
  });
}

/** 校验调用者是否持有该指纹对应的设备凭据；不通过时直接写 403 响应。 */
export function assertDeviceOwnership(req: Request, res: Response, fingerprint: string): boolean {
  if (verifyConsentToken(readConsentTokenCookie(req), fingerprint)) return true;
  res.status(403).json({ success: false, error: "缺少设备凭据，无法完成操作", code: "DEVICE_CREDENTIAL_REQUIRED" });
  return false;
}

/**
 * 写同意记录前的设备归属证明：本模块下发的凭据 cookie，或首访验证令牌。
 * 令牌为空时同样交给 verifyRequestToken 判定，不能在这里先短路掉：首访验证关闭（闸门关闭或
 * IPQS/proxycheck 都关）时它恒为 true，与中间件放行 TTS 请求用的是同一判据。若在此处要求
 * 非空令牌，「TTS 门禁开启 + 首访验证关闭」这个组合下匿名端就没有任何可用证明，门禁记录不出来。
 */
export async function assertConsentWriteOwnership(
  req: Request,
  res: Response,
  fingerprint: string,
): Promise<boolean> {
  if (verifyConsentToken(readConsentTokenCookie(req), fingerprint)) return true;

  const tokenHeader = req.headers["x-ip-verification-token"];
  const token = typeof tokenHeader === "string" ? tokenHeader.trim() : "";
  if (await IpVerificationService.verifyRequestToken(token, fingerprint, getClientIP(req))) {
    return true;
  }

  res.status(403).json({ success: false, error: "缺少设备凭据，无法完成操作", code: "DEVICE_CREDENTIAL_REQUIRED" });
  return false;
}
