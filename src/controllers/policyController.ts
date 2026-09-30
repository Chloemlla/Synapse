import crypto from "node:crypto";
import type { Request, Response } from "express";
import { POLICY_DOCUMENT, POLICY_DOCUMENT_HASH } from "../config/policyDocument";
import { PolicyConsent } from "../models/policyConsentModel";
import {
  CONSENT_VALIDITY_DAYS,
  CURRENT_POLICY_VERSION,
  POLICY_AGREEMENT_KEYS,
  describeFingerprintForLog,
  isCompleteAgreementSet,
  missingAgreementKeys,
  writePolicyConsent,
} from "../services/policyConsentService";
import IpVerificationService from "../services/ipVerificationService";
import { config } from "../config/config";
import { parseCookieHeader } from "../utils/authCookie";
import { getClientIP } from "../utils/ipUtils";
import logger from "../utils/logger";

// G3-12: 把"指纹归属"变成可验证的。verify 时下发与指纹绑定的 HMAC 凭据，
// revoke/check 必须携带该凭据才能操作，防止拿别人指纹就能撤销同意。凭据只有设备持有，
// 登录会话不算——见 assertDeviceOwnership 的说明。
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

function verifyConsentToken(token: string | undefined, fingerprint: string): boolean {
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

function readConsentTokenCookie(req: Request): string | undefined {
  const cookies = parseCookieHeader(typeof req.headers.cookie === "string" ? req.headers.cookie : undefined);
  const fromReqCookies = (req as Request & { cookies?: Record<string, string> }).cookies?.[CONSENT_TOKEN_COOKIE];
  return fromReqCookies || cookies[CONSENT_TOKEN_COOKIE];
}

function isSecureRequest(req: Request): boolean {
  return req.secure || process.env.NODE_ENV === "production";
}

function setConsentTokenCookie(req: Request, res: Response, fingerprint: string): void {
  res.cookie(CONSENT_TOKEN_COOKIE, buildConsentToken(fingerprint), {
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureRequest(req),
    path: "/",
    maxAge: CONSENT_VALIDITY_DAYS * 24 * 60 * 60 * 1000,
  });
}

function clearConsentTokenCookie(req: Request, res: Response): void {
  res.clearCookie(CONSENT_TOKEN_COOKIE, {
    httpOnly: true,
    sameSite: "lax",
    secure: isSecureRequest(req),
    path: "/",
  });
}

/**
 * 请求里的设备指纹来源顺序：请求头 → 请求体 → 查询串。
 * 请求头优先是隐私考虑：指纹在本系统里就是设备凭据本体，放进 query 会同时落到访问日志、
 * 代理日志与 Referer（见 docs/audit-2026-09-30-policy-system.md P-04）。前端已统一走 X-Fingerprint。
 */
function readFingerprintFromRequest(req: Request): unknown {
  const header = req.headers["x-fingerprint"];
  if (typeof header === "string" && header.trim()) return header;
  const body = (req.body as { fingerprint?: unknown } | undefined)?.fingerprint;
  if (typeof body === "string" && body.trim()) return body;
  return (req.query as { fingerprint?: unknown } | undefined)?.fingerprint;
}

/** 归一化指纹；`unknown` / 空白 / 超长一律视为无效。 */
function parseFingerprint(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "unknown" || trimmed.length > 100) return null;
  return trimmed;
}

/** 版本参数：可省略（默认当前版本）；显式给出时必须是长度合理的非空字符串。 */
function parseVersionInput(value: unknown): { valid: boolean; version?: string } {
  if (value === undefined || value === null || value === "") return { valid: true };
  if (typeof value !== "string") return { valid: false };
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 50) return { valid: false };
  return { valid: true, version: trimmed };
}

// 校验调用者是否持有该指纹对应的设备凭据。
// 刻意不接受「已登录会话」：会话只证明调用者是谁，不证明他是这台设备。指纹在本系统里就是设备凭据
// 本身（同意 cookie 是它的 HMAC），拿会话替代它，等于让任何登录用户凭一个已知指纹就查/撤别人
// 设备的同意——而指纹会出现在日志与请求 URL 里，不能当作身份之外的东西。
function assertDeviceOwnership(req: Request, res: Response, fingerprint: string): boolean {
  if (verifyConsentToken(readConsentTokenCookie(req), fingerprint)) return true;
  res.status(403).json({ success: false, error: "缺少设备凭据，无法完成操作", code: "DEVICE_CREDENTIAL_REQUIRED" });
  return false;
}

// 写同意记录前的设备归属证明：本端点下发的凭据 cookie，或首访验证令牌。
// 同理不接受「已登录会话」（理由见 assertDeviceOwnership）。
// 首次写入时还没有 consent cookie（后者正是本端点签发的），所以必须承认首访验证
// 令牌——它由 /api/ip-verification/session 签发并与指纹绑定。
// 令牌为空时同样交给 verifyRequestToken 判定，不能在这里先短路掉：首访验证关闭（闸门关闭或
// IPQS/proxycheck 都关）时它恒为 true，与中间件放行 TTS 请求用的是同一判据。若在此处要求
// 非空令牌，「TTS 门禁开启 + 首访验证关闭」这个组合下匿名端就没有任何可用证明，门禁记录不出来，
// 等于把这次要修的问题又原地复现一遍。
async function assertConsentWriteOwnership(req: Request, res: Response, fingerprint: string): Promise<boolean> {
  if (verifyConsentToken(readConsentTokenCookie(req), fingerprint)) return true;

  const tokenHeader = req.headers["x-ip-verification-token"];
  const token = typeof tokenHeader === "string" ? tokenHeader.trim() : "";
  if (await IpVerificationService.verifyRequestToken(token, fingerprint, getClientIP(req))) {
    return true;
  }

  res.status(403).json({ success: false, error: "缺少设备凭据，无法完成操作", code: "DEVICE_CREDENTIAL_REQUIRED" });
  return false;
}

// 记录政策同意（POST /api/policy/verify）。
// 旧实现要求客户端提交 checksum，而签名的盐只在服务端——浏览器无从计算，等于这个端点对真实
// 客户端不可用，TTS_REQUIRE_POLICY_CONSENT 的门禁因此永远拿不到同意记录。现在改由服务端签名
// 并落库，客户端只需证明「我是这个指纹的设备」。时间戳同样由服务端生成，于是原先为防重放而设的
// ±80 秒时间窗校验连同它自己的失效模式一并消失。
export const recordPolicyConsent = async (req: Request, res: Response): Promise<void> => {
  try {
    const { version } = req.body ?? {};
    const clientIP = getClientIP(req);
    const userAgent = req.headers["user-agent"];

    // 指纹可取请求头（前端统一注入）或请求体，取不到可用值时直接拒绝
    const sanitizedFingerprint = parseFingerprint(readFingerprintFromRequest(req));
    if (!sanitizedFingerprint) {
      res.status(400).json({
        success: false,
        error: "Invalid fingerprint format",
        code: "INVALID_FINGERPRINT",
      });
      return;
    }

    // 版本可省略（默认当前版本）；显式给出但与当前版本不符时拒绝，
    // 免得客户端以为自己在同意旧条文、却拿到一条标着新版本的记录。
    const versionInput = parseVersionInput(version);
    if (!versionInput.valid) {
      res.status(400).json({
        success: false,
        error: "Invalid version format",
        code: "INVALID_VERSION",
      });
      return;
    }
    if (versionInput.version && versionInput.version !== CURRENT_POLICY_VERSION) {
      res.status(400).json({
        success: false,
        error: "Unsupported policy version",
        currentVersion: CURRENT_POLICY_VERSION,
        providedVersion: versionInput.version,
        code: "UNSUPPORTED_VERSION",
      });
      return;
    }

    if (!(await assertConsentWriteOwnership(req, res, sanitizedFingerprint))) {
      return;
    }

    // 同一指纹+版本已有有效记录时原地续期，因此这里不必先查再分支
    const written = await writePolicyConsent({
      fingerprint: sanitizedFingerprint,
      source: "feature",
      userAgent: typeof userAgent === "string" ? userAgent : undefined,
      ipAddress: clientIP,
    });

    if (!written) {
      logger.error("Policy consent write returned no record", {
        fingerprint: describeFingerprintForLog(sanitizedFingerprint),
        ip: clientIP,
      });
      res.status(500).json({
        success: false,
        error: "Failed to record consent",
        code: "RECORD_FAILED",
      });
      return;
    }

    // 下发与指纹绑定的凭据，使后续 check/revoke 能证明设备归属
    setConsentTokenCookie(req, res, sanitizedFingerprint);

    logger.info("Policy consent recorded successfully", {
      consentId: written.id,
      version: CURRENT_POLICY_VERSION,
      documentHash: POLICY_DOCUMENT_HASH.slice(0, 12),
      fingerprint: describeFingerprintForLog(sanitizedFingerprint),
      ip: clientIP,
      source: "feature",
      expiresAt: written.expiresAt,
    });

    res.json({
      success: true,
      message: "Consent recorded successfully",
      consentId: written.id,
      version: CURRENT_POLICY_VERSION,
      documentHash: POLICY_DOCUMENT_HASH,
      validityDays: CONSENT_VALIDITY_DAYS,
      expiresAt: written.expiresAt,
    });
  } catch (error) {
    logger.error("Error recording policy consent", {
      error: error instanceof Error ? error.message : "Unknown error",
      stack: error instanceof Error ? error.stack : undefined,
      // 不回显请求体：研发日志同样不应留下可回放的设备指纹
      fingerprint: describeFingerprintForLog(parseFingerprint(readFingerprintFromRequest(req)) ?? ""),
      version: (req.body as { version?: unknown } | undefined)?.version,
    });

    res.status(500).json({
      success: false,
      error: "Internal server error",
      code: "INTERNAL_ERROR",
    });
  }
};

type ConsentStateReason = "active" | "none" | "expired" | "revoked" | "incomplete" | "other-version";

interface ConsentStatePayload {
  hasValidConsent: boolean;
  /** 没有有效同意时给出原因，前端据此区分「从未同意」与「已过期 / 已撤回 / 只勾了一部分」 */
  reason: ConsentStateReason;
  version: string;
  currentVersion: string;
  validityDays: number;
  documentHash: string;
  expiresAt?: string;
  recordedAt?: string;
  source?: string;
  agreements: string[];
  agreementsComplete: boolean;
  missingAgreements: string[];
  /** 该条记录落库时对应的条文指纹；与 documentHash 不一致说明条文已改版 */
  consentDocumentHash?: string;
}

/**
 * 汇总「本设备对某个版本的政策同意状态」。
 * 只对持有设备凭据的调用者开放（见 assertDeviceOwnership），因此可以安全地回带同意时间、来源与
 * 勾选项 —— 这些信息对能证明设备归属的一方没有侧信道价值，却是面板必须展示的内容。
 */
async function collectConsentState(fingerprint: string, version: string): Promise<ConsentStatePayload> {
  const base = {
    version,
    currentVersion: CURRENT_POLICY_VERSION,
    validityDays: CONSENT_VALIDITY_DAYS,
    documentHash: POLICY_DOCUMENT_HASH,
  };

  const consent = await PolicyConsent.findValidConsent(fingerprint, version);
  if (consent && isCompleteAgreementSet(consent.agreements)) {
    return {
      ...base,
      hasValidConsent: true,
      reason: "active",
      expiresAt: consent.expiresAt?.toISOString(),
      recordedAt: consent.recordedAt?.toISOString(),
      source: consent.source,
      agreements: consent.agreements ?? [],
      agreementsComplete: true,
      missingAgreements: [],
      consentDocumentHash: consent.documentHash,
    };
  }

  // 没有有效记录时再取最近一条，用于区分「从未同意」「已过期」「已撤回」「版本不符」
  const latest = await PolicyConsent.findLatestConsent(fingerprint);
  let reason: ConsentStateReason = "none";
  if (consent) {
    reason = "incomplete";
  } else if (latest) {
    if (latest.version !== version) reason = "other-version";
    else if (!latest.isValid || latest.revokedAt) reason = "revoked";
    else reason = "expired";
  }

  return {
    ...base,
    hasValidConsent: false,
    reason,
    expiresAt: latest?.expiresAt?.toISOString(),
    recordedAt: latest?.recordedAt?.toISOString(),
    source: latest?.source,
    agreements: latest?.agreements ?? [],
    agreementsComplete: isCompleteAgreementSet(latest?.agreements),
    missingAgreements: missingAgreementKeys(consent?.agreements ?? latest?.agreements),
    consentDocumentHash: latest?.documentHash,
  };
}

// 验证隐私政策同意状态（GET /api/policy/check）
// 指纹优先从请求头取（隐私考虑，见 readFingerprintFromRequest）；version 可省略，默认当前版本。
export const verifyPolicyConsent = async (req: Request, res: Response): Promise<void> => {
  try {
    const clientIP = getClientIP(req);

    const sanitizedFingerprint = parseFingerprint(readFingerprintFromRequest(req));
    if (!sanitizedFingerprint) {
      res.status(400).json({
        success: false,
        error: "Missing or invalid fingerprint",
        code: "MISSING_FINGERPRINT",
      });
      return;
    }

    const versionInput = parseVersionInput((req.query as { version?: unknown } | undefined)?.version);
    if (!versionInput.valid) {
      res.status(400).json({
        success: false,
        error: "Invalid version format",
        code: "INVALID_VERSION",
      });
      return;
    }
    const sanitizedVersion = versionInput.version ?? CURRENT_POLICY_VERSION;

    // G3-12: 必须持有该指纹对应的设备凭据，防止查询他人同意记录
    if (!assertDeviceOwnership(req, res, sanitizedFingerprint)) {
      return;
    }

    const state = await collectConsentState(sanitizedFingerprint, sanitizedVersion);

    logger.info("Policy consent checked", {
      fingerprint: describeFingerprintForLog(sanitizedFingerprint),
      ip: clientIP,
      version: sanitizedVersion,
      hasValidConsent: state.hasValidConsent,
      reason: state.reason,
    });

    // 兼容既有契约：没有有效同意时 success 为 false（前端与 nightly 用例均按此断言）
    res.json({ success: state.hasValidConsent, ...state });
  } catch (error) {
    logger.error("Error verifying policy consent", {
      error: error instanceof Error ? error.message : "Unknown error",
      fingerprint: describeFingerprintForLog(parseFingerprint(readFingerprintFromRequest(req)) ?? ""),
      version: (req.query as { version?: unknown } | undefined)?.version,
    });

    res.status(500).json({
      success: false,
      error: "Internal server error",
      code: "INTERNAL_ERROR",
    });
  }
};

// 一次取回「当前版本 + 有效期 + 条文指纹 + 本设备同意状态」（GET /api/policy/status）。
// 取代前端「先 /version 再 /check」的两次往返，也让条文指纹与同意记录能在同一份响应里对账。
// 语义与 /check 的差别：这里 success 恒为 true（它是一次成功查询），状态落在 hasValidConsent。
export const getPolicyStatus = async (req: Request, res: Response): Promise<void> => {
  try {
    const sanitizedFingerprint = parseFingerprint(readFingerprintFromRequest(req));
    if (!sanitizedFingerprint) {
      res.status(400).json({
        success: false,
        error: "Missing or invalid fingerprint",
        code: "MISSING_FINGERPRINT",
      });
      return;
    }

    const versionInput = parseVersionInput((req.query as { version?: unknown } | undefined)?.version);
    if (!versionInput.valid) {
      res.status(400).json({
        success: false,
        error: "Invalid version format",
        code: "INVALID_VERSION",
      });
      return;
    }

    if (!assertDeviceOwnership(req, res, sanitizedFingerprint)) {
      return;
    }

    const state = await collectConsentState(sanitizedFingerprint, versionInput.version ?? CURRENT_POLICY_VERSION);
    res.setHeader("Cache-Control", "no-store");
    res.json({ success: true, ...state });
  } catch (error) {
    logger.error("Error reading policy status", {
      error: error instanceof Error ? error.message : "Unknown error",
      fingerprint: describeFingerprintForLog(parseFingerprint(readFingerprintFromRequest(req)) ?? ""),
    });

    res.status(500).json({
      success: false,
      error: "Internal server error",
      code: "INTERNAL_ERROR",
    });
  }
};

// 撤销隐私政策同意（POST /api/policy/revoke）
// 默认软撤回（isValid=false + 留痕 revokedAt/revokedIP/revokedReason，由 TTL 在到期时回收）；
// body 里带 `purge: true` 时硬删除本指纹的全部记录，满足「删除」这项用户权利。
export const revokePolicyConsent = async (req: Request, res: Response): Promise<void> => {
  try {
    const { version, purge: purgeInput } = (req.body ?? {}) as { version?: unknown; purge?: unknown };
    const clientIP = getClientIP(req);

    const sanitizedFingerprint = parseFingerprint(readFingerprintFromRequest(req));
    if (!sanitizedFingerprint) {
      res.status(400).json({
        success: false,
        error: "Missing or invalid fingerprint",
        code: "MISSING_FINGERPRINT",
      });
      return;
    }

    // G3-12: 必须持有该指纹对应的设备凭据，防止撤销他人同意
    if (!assertDeviceOwnership(req, res, sanitizedFingerprint)) {
      return;
    }

    const versionInput = parseVersionInput(version);
    if (!versionInput.valid) {
      res.status(400).json({
        success: false,
        error: "Invalid version format",
        code: "INVALID_VERSION",
      });
      return;
    }
    const sanitizedVersion = versionInput.version;

    // purge：硬删除本指纹的所有记录（含其他版本），并清掉设备凭据 cookie——留一个指向
    // 已删除记录的凭据没有意义，也会让面板显示成「有凭据但查不到」。
    if (purgeInput === true) {
      const deleted = await PolicyConsent.deleteMany({ fingerprint: sanitizedFingerprint });
      clearConsentTokenCookie(req, res);

      logger.info("Policy consent records purged", {
        fingerprint: describeFingerprintForLog(sanitizedFingerprint),
        ip: clientIP,
        deletedCount: deleted.deletedCount ?? 0,
      });

      res.json({
        success: true,
        message: "Consent records deleted",
        purged: true,
        hadActiveConsent: (deleted.deletedCount ?? 0) > 0,
        revokedCount: deleted.deletedCount ?? 0,
      });
      return;
    }

    // 构建安全的查询对象（mongoose 的 FilterQuery 是映射类型，显式 any 避免索引签名互转的噪声）
    const queryFilter: any = {
      fingerprint: sanitizedFingerprint,
      isValid: true,
    };

    // 只有在版本号有效时才添加到查询中
    if (sanitizedVersion) {
      queryFilter.version = sanitizedVersion;
    }

    // 查找并撤销同意记录。revokedAt / revokedIP / revokedReason 已在 schema 上声明，
    // 否则 Mongoose strict 模式会把它们静默丢掉（留痕全丢，见 docs/audit-2026-09-30-policy-system.md P-01）。
    const result = await PolicyConsent.updateMany(queryFilter, {
      isValid: false,
      revokedAt: new Date(),
      revokedIP: clientIP,
      revokedReason: "user-request",
    });
    const revokedCount = result.modifiedCount ?? 0;

    logger.info("Policy consent revoked", {
      fingerprint: describeFingerprintForLog(sanitizedFingerprint),
      version: sanitizedVersion,
      ip: clientIP,
      modifiedCount: revokedCount,
    });

    res.json({
      success: true,
      // 本来就无有效同意时不再假装「撤回成功」：前端据此给出不同提示（P-06）
      message: revokedCount > 0 ? "Consent revoked successfully" : "No active consent to revoke",
      hadActiveConsent: revokedCount > 0,
      purged: false,
      revokedCount,
    });
  } catch (error) {
    logger.error("Error revoking policy consent", {
      error: error instanceof Error ? error.message : "Unknown error",
      fingerprint: describeFingerprintForLog(parseFingerprint(readFingerprintFromRequest(req)) ?? ""),
    });

    res.status(500).json({
      success: false,
      error: "Internal server error",
      code: "INTERNAL_ERROR",
    });
  }
};

// 获取隐私政策统计信息（管理员接口）
// 与 superadmin 只读面板（/api/admin/policy-consents/*）口径对齐：除有效/过期计数外，
// 还要给出「已撤销」计数与来源分布，否则两个入口对同一份数据会给出不同说法。
export const getPolicyStats = async (req: Request, res: Response): Promise<void> => {
  try {
    const { startDate, endDate, days } = req.query;

    const start = startDate ? new Date(startDate as string) : undefined;
    const end = endDate ? new Date(endDate as string) : undefined;

    // 趋势窗口：默认 7 天，收敛到 [1, 90]
    const requestedDays = Number(days);
    const trendDays = Number.isFinite(requestedDays) ? Math.min(Math.max(Math.trunc(requestedDays), 1), 90) : 7;

    // 获取统计信息
    const stats = await PolicyConsent.getStats(start, end);

    // 获取总体统计
    const totalConsents = await PolicyConsent.countDocuments({ isValid: true });
    const expiredConsents = await PolicyConsent.countDocuments({
      $or: [{ expiresAt: { $lt: new Date() } }, { isValid: false }],
    });
    // 已撤销：revokedAt 由 revoke 端点写入（schema 上声明后才会真的落库）
    const revokedConsents = await PolicyConsent.countDocuments({ revokedAt: { $ne: null } });

    // 获取版本分布
    const versionStats = await PolicyConsent.aggregate([
      { $match: { isValid: true } },
      { $group: { _id: "$version", count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);

    // 获取来源分布（登录 / 注册 / 功能门禁）
    const sourceStats = await PolicyConsent.aggregate([
      { $group: { _id: "$source", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    // 获取趋势（窗口由 days 控制）
    const since = new Date(Date.now() - trendDays * 24 * 60 * 60 * 1000);
    const recentTrend = await PolicyConsent.aggregate([
      { $match: { recordedAt: { $gte: since } } },
      {
        $group: {
          _id: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: "$recordedAt",
            },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    res.json({
      success: true,
      stats: {
        total: {
          validConsents: totalConsents,
          expiredConsents,
          revokedConsents,
          currentVersion: CURRENT_POLICY_VERSION,
          documentHash: POLICY_DOCUMENT_HASH,
        },
        versions: versionStats,
        sources: sourceStats,
        trendDays,
        recentTrend,
        detailed: stats,
      },
    });
  } catch (error) {
    logger.error("Error getting policy stats", {
      error: error instanceof Error ? error.message : "Unknown error",
    });

    res.status(500).json({
      success: false,
      error: "Internal server error",
      code: "INTERNAL_ERROR",
    });
  }
};

// 清理过期记录（管理员接口）
export const cleanExpiredConsents = async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await PolicyConsent.cleanExpiredConsents();

    logger.info("Expired policy consents cleaned", {
      deletedCount: result.deletedCount,
    });

    res.json({
      success: true,
      message: "Expired consents cleaned successfully",
      deletedCount: result.deletedCount,
    });
  } catch (error) {
    logger.error("Error cleaning expired consents", {
      error: error instanceof Error ? error.message : "Unknown error",
    });

    res.status(500).json({
      success: false,
      error: "Internal server error",
      code: "INTERNAL_ERROR",
    });
  }
};

// 获取当前政策版本
// 除版本与有效期外一并回带条文指纹与勾选清单，客户端可据此在本地校验「我同意的是哪份文本」。
export const getCurrentPolicyVersion = async (_req: Request, res: Response): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  res.json({
    success: true,
    version: CURRENT_POLICY_VERSION,
    validityDays: CONSENT_VALIDITY_DAYS,
    documentHash: POLICY_DOCUMENT_HASH,
    agreementKeys: [...POLICY_AGREEMENT_KEYS],
  });
};

// 获取完整政策条文（公开）
// 条文由 src/config/policyDocument.ts 单点维护，前端页面直接渲染返回值；
// 版本号与 /version 同源，避免「同意的是哪个版本」与「页面上读到的条文」分叉。
// ETag 由版本号 + 条文指纹拼出：指纹变了就必然换 ETag，客户端不会拿着旧正文当新条文读。
export const getPolicyDocument = async (req: Request, res: Response): Promise<void> => {
  const etag = `"policy-${POLICY_DOCUMENT.version}-${POLICY_DOCUMENT_HASH.slice(0, 12)}"`;
  res.setHeader("ETag", etag);
  res.setHeader("Cache-Control", "public, max-age=300, must-revalidate");

  if (typeof req.headers["if-none-match"] === "string" && req.headers["if-none-match"].includes(etag)) {
    res.status(304).end();
    return;
  }

  res.json({
    success: true,
    document: POLICY_DOCUMENT,
  });
};
