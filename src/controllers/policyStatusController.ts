import type { Request, Response } from "express";
import { POLICY_DOCUMENT_HASH } from "../config/policyDocument";
import { PolicyConsent } from "../models/policyConsentModel";
import {
  CONSENT_VALIDITY_DAYS,
  CURRENT_POLICY_VERSION,
  describeFingerprintForLog,
  isCompleteAgreementSet,
  missingAgreementKeys,
} from "../services/policyConsentService";
import { assertDeviceOwnership } from "../services/policyDeviceCredential";
import { parseFingerprint, parseVersionInput, readFingerprintFromRequest } from "../utils/policyRequest";
import { getClientIP } from "../utils/ipUtils";
import logger from "../utils/logger";

// 同意记录的读取面：单设备状态（GET /api/policy/check、/api/policy/status）与本设备同意轨迹
// （GET /api/policy/history）。三个端点共用同一套设备凭据判据与状态汇总逻辑，
// 写入路径在 controllers/policyController.ts。

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

/**
 * 本设备的同意轨迹（GET /api/policy/history）。
 *
 * 只对持有该指纹设备凭据的调用者开放（同 /check、/status），返回按时间倒序的记录：
 * 版本、同意时间、到期、来源、勾选项、条文指纹、是否已撤回。用户据此可以自行核对
 * 「我同意过几次、分别同意的是哪份文本」——透明性的一部分，不需要先发邮件问客服。
 */
export const getPolicyConsentHistory = async (req: Request, res: Response): Promise<void> => {
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

    if (!assertDeviceOwnership(req, res, sanitizedFingerprint)) {
      return;
    }

    const rawLimit = Number((req.query as { limit?: unknown } | undefined)?.limit);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 50) : 20;
    const records = await PolicyConsent.findConsentHistory(sanitizedFingerprint, limit);
    const now = new Date();

    const entries = records.map((record) => {
      const expiresAt = record.expiresAt ? new Date(record.expiresAt) : null;
      const expired = !expiresAt || expiresAt.getTime() <= now.getTime();
      const revoked = !record.isValid || Boolean(record.revokedAt);
      let state: "active" | "expired" | "revoked" | "superseded" = "active";
      if (revoked) state = "revoked";
      else if (expired) state = "expired";
      else if (record.version !== CURRENT_POLICY_VERSION) state = "superseded";

      return {
        id: record.id,
        version: record.version,
        state,
        recordedAt: record.recordedAt ? new Date(record.recordedAt).toISOString() : null,
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
        source: record.source,
        agreements: record.agreements ?? [],
        agreementsComplete: isCompleteAgreementSet(record.agreements),
        missingAgreements: missingAgreementKeys(record.agreements),
        consentDocumentHash: record.documentHash,
        documentHashMatchesCurrent: record.documentHash === POLICY_DOCUMENT_HASH,
        revokedAt: record.revokedAt ? new Date(record.revokedAt).toISOString() : null,
        revokedReason: record.revokedReason,
      };
    });

    res.setHeader("Cache-Control", "no-store");
    res.json({
      success: true,
      currentVersion: CURRENT_POLICY_VERSION,
      documentHash: POLICY_DOCUMENT_HASH,
      limit,
      entries,
    });
  } catch (error) {
    logger.error("Error reading policy consent history", {
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
