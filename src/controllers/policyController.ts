import crypto from "node:crypto";
import type { Request, Response } from "express";
import { POLICY_DOCUMENT } from "../config/policyDocument";
import { PolicyConsent } from "../models/policyConsentModel";
import {
  CONSENT_VALIDITY_DAYS,
  CURRENT_POLICY_VERSION,
  writePolicyConsent,
} from "../services/policyConsentService";
import IpVerificationService from "../services/ipVerificationService";
import { config } from "../config/config";
import { parseCookieHeader } from "../utils/authCookie";
import { getClientIP } from "../utils/ipUtils";
import logger from "../utils/logger";

// G3-12: 把"指纹归属"变成可验证的。verify 时下发与指纹绑定的 HMAC 凭据，
// revoke/check 必须携带该凭据（或已登录会话）才能操作，防止拿别人指纹就能撤销同意。
const CONSENT_TOKEN_COOKIE = "policy_consent_token";
// 用独立派生密钥签名，避免把 JWT 签名密钥直接用于 UI 状态签名
const CONSENT_TOKEN_SECRET = crypto.createHmac("sha256", config.jwtSecret).update("policy-consent-token").digest();

function buildConsentToken(fingerprint: string): string {
  const signature = crypto.createHmac("sha256", CONSENT_TOKEN_SECRET).update(fingerprint).digest("hex");
  return `${fingerprint}.${signature}`;
}

function verifyConsentToken(token: string | undefined, fingerprint: string): boolean {
  if (!token || typeof token !== "string") return false;
  const separator = token.lastIndexOf(".");
  if (separator <= 0) return false;
  const fp = token.slice(0, separator);
  const sig = token.slice(separator + 1);
  if (fp !== fingerprint) return false;
  const expected = crypto.createHmac("sha256", CONSENT_TOKEN_SECRET).update(fingerprint).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readConsentTokenCookie(req: Request): string | undefined {
  const cookies = parseCookieHeader(typeof req.headers.cookie === "string" ? req.headers.cookie : undefined);
  const fromReqCookies = (req as Request & { cookies?: Record<string, string> }).cookies?.[CONSENT_TOKEN_COOKIE];
  return fromReqCookies || cookies[CONSENT_TOKEN_COOKIE];
}

function setConsentTokenCookie(req: Request, res: Response, fingerprint: string): void {
  res.cookie(CONSENT_TOKEN_COOKIE, buildConsentToken(fingerprint), {
    httpOnly: true,
    sameSite: "lax",
    secure: req.secure || process.env.NODE_ENV === "production",
    path: "/",
    maxAge: CONSENT_VALIDITY_DAYS * 24 * 60 * 60 * 1000,
  });
}

// 校验调用者是否持有该指纹对应的凭据（已登录会话也算）
function assertDeviceOwnership(req: Request, res: Response, fingerprint: string): boolean {
  if ((req as any).user?.id) return true;
  if (verifyConsentToken(readConsentTokenCookie(req), fingerprint)) return true;
  res.status(403).json({ success: false, error: "缺少设备凭据，无法完成操作", code: "DEVICE_CREDENTIAL_REQUIRED" });
  return false;
}

// 写同意记录前的设备归属证明：已登录会话、本端点下发的凭据 cookie，或首访验证令牌。
// 首次写入时既没有会话也没有 consent cookie（后者正是本端点签发的），所以必须承认首访验证
// 令牌——它由 /api/ip-verification/session 签发并与指纹绑定。
// 令牌为空时同样交给 verifyRequestToken 判定，不能在这里先短路掉：首访验证关闭（闸门关闭或
// IPQS/proxycheck 都关）时它恒为 true，与中间件放行 TTS 请求用的是同一判据。若在此处要求
// 非空令牌，「TTS 门禁开启 + 首访验证关闭」这个组合下匿名端就没有任何可用证明，门禁记录不出来，
// 等于把这次要修的问题又原地复现一遍。
async function assertConsentWriteOwnership(req: Request, res: Response, fingerprint: string): Promise<boolean> {
  if ((req as any).user?.id) return true;
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
    const { fingerprint, version } = req.body;
    const clientIP = getClientIP(req);
    const userAgent = req.headers["user-agent"];

    if (
      typeof fingerprint !== "string" ||
      fingerprint.trim().length === 0 ||
      fingerprint.trim().length > 100
    ) {
      res.status(400).json({
        success: false,
        error: "Invalid fingerprint format",
        code: "INVALID_FINGERPRINT",
      });
      return;
    }

    const sanitizedFingerprint = fingerprint.trim();

    // 版本可省略（默认当前版本）；显式给出但与当前版本不符时拒绝，
    // 免得客户端以为自己在同意旧条文、却拿到一条标着新版本的记录。
    if (version !== undefined) {
      if (typeof version !== "string" || version.trim().length === 0 || version.trim().length > 50) {
        res.status(400).json({
          success: false,
          error: "Invalid version format",
          code: "INVALID_VERSION",
        });
        return;
      }
      if (version.trim() !== CURRENT_POLICY_VERSION) {
        res.status(400).json({
          success: false,
          error: "Unsupported policy version",
          currentVersion: CURRENT_POLICY_VERSION,
          providedVersion: version.trim(),
          code: "UNSUPPORTED_VERSION",
        });
        return;
      }
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
      logger.error("Policy consent write returned no record", { fingerprint: sanitizedFingerprint, ip: clientIP });
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
      fingerprint: sanitizedFingerprint,
      ip: clientIP,
      source: "feature",
      expiresAt: written.expiresAt,
    });

    res.json({
      success: true,
      message: "Consent recorded successfully",
      consentId: written.id,
      version: CURRENT_POLICY_VERSION,
      expiresAt: written.expiresAt,
    });
  } catch (error) {
    logger.error("Error recording policy consent", {
      error: error instanceof Error ? error.message : "Unknown error",
      stack: error instanceof Error ? error.stack : undefined,
      body: req.body,
    });

    res.status(500).json({
      success: false,
      error: "Internal server error",
      code: "INTERNAL_ERROR",
    });
  }
};

// 验证隐私政策同意状态
export const verifyPolicyConsent = async (req: Request, res: Response): Promise<void> => {
  try {
    const { fingerprint, version } = req.query;
    const clientIP = getClientIP(req);

    // 输入验证和清理
    if (!fingerprint || typeof fingerprint !== "string") {
      res.status(400).json({
        success: false,
        error: "Missing or invalid fingerprint",
        code: "MISSING_FINGERPRINT",
      });
      return;
    }

    if (!version || typeof version !== "string") {
      res.status(400).json({
        success: false,
        error: "Missing or invalid version",
        code: "MISSING_VERSION",
      });
      return;
    }

    // 清理和验证输入
    const sanitizedFingerprint = fingerprint.trim();
    const sanitizedVersion = version.trim();

    if (sanitizedFingerprint.length === 0 || sanitizedFingerprint.length > 100) {
      res.status(400).json({
        success: false,
        error: "Invalid fingerprint format",
        code: "INVALID_FINGERPRINT",
      });
      return;
    }

    if (sanitizedVersion.length === 0 || sanitizedVersion.length > 50) {
      res.status(400).json({
        success: false,
        error: "Invalid version format",
        code: "INVALID_VERSION",
      });
      return;
    }

    // G3-12: 必须持有该指纹对应的设备凭据（或已登录会话），防止查询他人同意记录
    if (!assertDeviceOwnership(req, res, sanitizedFingerprint)) {
      return;
    }

    // 查找有效的同意记录
    const consent = await PolicyConsent.findValidConsent(sanitizedFingerprint, sanitizedVersion);

    if (!consent) {
      res.json({
        success: false,
        hasValidConsent: false,
        message: "No valid consent found",
        currentVersion: CURRENT_POLICY_VERSION,
      });
      return;
    }

    // 检查是否过期
    if (consent.isExpired()) {
      // 标记为无效
      consent.isValid = false;
      await consent.save();

      res.json({
        success: false,
        hasValidConsent: false,
        message: "Consent expired",
        currentVersion: CURRENT_POLICY_VERSION,
      });
      return;
    }

    logger.info("Policy consent verified", {
      consentId: consent.id,
      fingerprint,
      ip: clientIP,
      expiresAt: consent.expiresAt,
    });

    // 响应收敛，不再回 consentId/recordedAt，避免枚举用户行为侧信道
    res.json({
      success: true,
      hasValidConsent: true,
      version: consent.version,
      expiresAt: consent.expiresAt,
    });
  } catch (error) {
    logger.error("Error verifying policy consent", {
      error: error instanceof Error ? error.message : "Unknown error",
      fingerprint: req.query.fingerprint,
      version: req.query.version,
    });

    res.status(500).json({
      success: false,
      error: "Internal server error",
      code: "INTERNAL_ERROR",
    });
  }
};

// 撤销隐私政策同意
export const revokePolicyConsent = async (req: Request, res: Response): Promise<void> => {
  try {
    const { fingerprint, version } = req.body;
    const clientIP = getClientIP(req);

    // 输入验证和清理
    if (!fingerprint || typeof fingerprint !== "string") {
      res.status(400).json({
        success: false,
        error: "Missing or invalid fingerprint",
        code: "MISSING_FINGERPRINT",
      });
      return;
    }

    // 清理和验证指纹
    const sanitizedFingerprint = fingerprint.trim();
    if (sanitizedFingerprint.length === 0 || sanitizedFingerprint.length > 100) {
      res.status(400).json({
        success: false,
        error: "Invalid fingerprint format",
        code: "INVALID_FINGERPRINT",
      });
      return;
    }

    // G3-12: 必须持有该指纹对应的设备凭据（或已登录会话），防止撤销他人同意
    if (!assertDeviceOwnership(req, res, sanitizedFingerprint)) {
      return;
    }

    // 验证版本号（如果提供）
    let sanitizedVersion: string | undefined;
    if (version) {
      if (typeof version !== "string") {
        res.status(400).json({
          success: false,
          error: "Invalid version format",
          code: "INVALID_VERSION",
        });
        return;
      }
      sanitizedVersion = version.trim();
      if (sanitizedVersion.length === 0 || sanitizedVersion.length > 50) {
        res.status(400).json({
          success: false,
          error: "Invalid version format",
          code: "INVALID_VERSION",
        });
        return;
      }
    }

    // 构建安全的查询对象
    const queryFilter: any = {
      fingerprint: sanitizedFingerprint,
      isValid: true,
    };

    // 只有在版本号有效时才添加到查询中
    if (sanitizedVersion) {
      queryFilter.version = sanitizedVersion;
    }

    // 查找并撤销同意记录
    const result = await PolicyConsent.updateMany(queryFilter, {
      isValid: false,
      revokedAt: new Date(),
      revokedIP: clientIP,
    });

    logger.info("Policy consent revoked", {
      fingerprint: sanitizedFingerprint,
      version: sanitizedVersion,
      ip: clientIP,
      modifiedCount: result.modifiedCount,
    });

    res.json({
      success: true,
      message: "Consent revoked successfully",
      revokedCount: result.modifiedCount,
    });
  } catch (error) {
    logger.error("Error revoking policy consent", {
      error: error instanceof Error ? error.message : "Unknown error",
      fingerprint: req.body.fingerprint,
    });

    res.status(500).json({
      success: false,
      error: "Internal server error",
      code: "INTERNAL_ERROR",
    });
  }
};

// 获取隐私政策统计信息（管理员接口）
export const getPolicyStats = async (req: Request, res: Response): Promise<void> => {
  try {
    const { startDate, endDate } = req.query;

    const start = startDate ? new Date(startDate as string) : undefined;
    const end = endDate ? new Date(endDate as string) : undefined;

    // 获取统计信息
    const stats = await PolicyConsent.getStats(start, end);

    // 获取总体统计
    const totalConsents = await PolicyConsent.countDocuments({ isValid: true });
    const expiredConsents = await PolicyConsent.countDocuments({
      $or: [{ expiresAt: { $lt: new Date() } }, { isValid: false }],
    });

    // 获取版本分布
    const versionStats = await PolicyConsent.aggregate([
      { $match: { isValid: true } },
      { $group: { _id: "$version", count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]);

    // 获取最近7天的同意趋势
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recentTrend = await PolicyConsent.aggregate([
      { $match: { recordedAt: { $gte: sevenDaysAgo } } },
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
          currentVersion: CURRENT_POLICY_VERSION,
        },
        versions: versionStats,
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
export const getCurrentPolicyVersion = async (_req: Request, res: Response): Promise<void> => {
  res.json({
    success: true,
    version: CURRENT_POLICY_VERSION,
    validityDays: CONSENT_VALIDITY_DAYS,
  });
};

// 获取完整政策条文（公开）
// 条文由 src/config/policyDocument.ts 单点维护，前端页面直接渲染返回值；
// 版本号与 /version 同源，避免「同意的是哪个版本」与「页面上读到的条文」分叉。
export const getPolicyDocument = async (_req: Request, res: Response): Promise<void> => {
  res.json({
    success: true,
    document: POLICY_DOCUMENT,
  });
};
