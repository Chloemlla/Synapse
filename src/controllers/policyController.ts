import type { Request, Response } from "express";
import { POLICY_DOCUMENT, POLICY_DOCUMENT_HASH } from "../config/policyDocument";
import { PolicyConsent } from "../models/policyConsentModel";
import {
  CONSENT_VALIDITY_DAYS,
  CURRENT_POLICY_VERSION,
  POLICY_AGREEMENT_KEYS,
  describeFingerprintForLog,
  writePolicyConsent,
} from "../services/policyConsentService";
import {
  assertConsentWriteOwnership,
  assertDeviceOwnership,
  clearConsentTokenCookie,
  setConsentTokenCookie,
} from "../services/policyDeviceCredential";
import { parseFingerprint, parseVersionInput, readFingerprintFromRequest } from "../utils/policyRequest";
import { getClientIP } from "../utils/ipUtils";
import { policyArchiveFilename, renderPolicyDocumentMarkdown } from "../utils/policyDocumentMarkdown";
import logger from "../utils/logger";

// 本文件只保留「写」与「条文/统计」端点：同意记录的读取状态（check/status/history）与
// 设备凭据实现分别落在 controllers/policyStatusController.ts 与 services/policyDeviceCredential.ts，
// 避免单文件继续膨胀（仓库有 800 行的 TS 文件闸门）。

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
// `?format=md`（或 Accept: text/markdown）返回同一份内容的 Markdown 存档副本，供用户离线保存。
export const getPolicyDocument = async (req: Request, res: Response): Promise<void> => {
  const requestedFormat = typeof req.query.format === "string" ? req.query.format.trim().toLowerCase() : "";
  const acceptsMarkdown = typeof req.headers.accept === "string" && req.headers.accept.includes("text/markdown");

  if (requestedFormat === "md" || requestedFormat === "markdown" || (!requestedFormat && acceptsMarkdown)) {
    const markdown = renderPolicyDocumentMarkdown(POLICY_DOCUMENT);
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${policyArchiveFilename(POLICY_DOCUMENT)}"`);
    res.setHeader("Cache-Control", "public, max-age=300, must-revalidate");
    res.setHeader("X-Policy-Document-Hash", POLICY_DOCUMENT_HASH);
    res.send(markdown);
    return;
  }

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
