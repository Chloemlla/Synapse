import crypto from "node:crypto";
import { PolicyConsent } from "../models/policyConsentModel";
import { KL, deriveSecretHex } from "../config/keyDerivation";

export const CURRENT_POLICY_VERSION = process.env.POLICY_VERSION || "2.0";
export const CONSENT_VALIDITY_DAYS = Number(process.env.POLICY_CONSENT_VALIDITY_DAYS || 30);
// 原实现把盐硬编码在源码里，等于公开密钥。现优先用显式配置；缺失时统一从单一主密钥
// AES_KEY 派生（KL.POLICY_SALT），不再单独依赖 POLICY_SECRET_SALT / JWT_SECRET。
function resolveSecretSalt(): string {
  const configured = process.env.POLICY_SECRET_SALT?.trim();
  if (configured) return configured;
  return deriveSecretHex(KL.POLICY_SALT);
}

// 惰性解析盐：模块加载时定格会让 admin/env 面板运行期保存的 POLICY_SECRET_SALT 不生效，
// 改为每次签名时调用 resolveSecretSalt()（JWT_SECRET 派生回退不变）。
export function generatePolicyChecksum(consent: {
  timestamp: number;
  version: string;
  fingerprint: string;
}): string {
  const data = `${consent.timestamp}|${consent.version}|${consent.fingerprint}`;
  return crypto.createHmac("sha256", resolveSecretSalt()).update(data).digest("hex");
}

export function verifyPolicyChecksum(
  consent: { timestamp: number; version: string; fingerprint: string },
  checksum: string,
): boolean {
  const expectedChecksum = generatePolicyChecksum(consent);
  if (typeof checksum !== "string" || checksum.length !== expectedChecksum.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(checksum, "utf8"), Buffer.from(expectedChecksum, "utf8"));
}

export function shouldRequireTtsPolicyConsent(): boolean {
  if (process.env.NODE_ENV === "test") {
    return false;
  }
  return process.env.TTS_REQUIRE_POLICY_CONSENT === "true";
}

export async function hasValidPolicyConsent(
  fingerprint: string,
  version = CURRENT_POLICY_VERSION,
): Promise<boolean> {
  const sanitizedFingerprint = fingerprint.trim();
  if (!sanitizedFingerprint || sanitizedFingerprint === "unknown") {
    return false;
  }

  const consent = await PolicyConsent.findValidConsent(sanitizedFingerprint, version);
  if (!consent) {
    return false;
  }

  if (consent.isExpired()) {
    consent.isValid = false;
    await consent.save();
    return false;
  }

  return true;
}
