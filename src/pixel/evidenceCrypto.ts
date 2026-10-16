import crypto from "node:crypto";
import { KL, deriveKey, legacyDecryptKeys } from "../config/keyDerivation";

// 内容级取证的加密：与「上游卡密」**不同**的子密钥与 AAD。
//
// 为什么必须独立子密钥而不是复用 upstream-cdk 的那把：
//   · 用途隔离：卡密泄露不应连带解密取证内容，反之亦然；
//   · 轮换独立：将来轮换任意一侧不需要同时重加密另一侧；
//   · 证据链清楚：AAD 里写明用途与版本，跨用途重放（把卡密密文塞进取证表）会在解密时直接失败。
const EVIDENCE_SECRET_ALGORITHM = "aes-256-gcm";
export const PIXEL_EVIDENCE_CRYPTO_VERSION = 1;
const EVIDENCE_AAD = Buffer.from(`pixel:account-evidence:v${PIXEL_EVIDENCE_CRYPTO_VERSION}`, "utf8");
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

/**
 * 取证内容的子密钥：统一注册表 `KL.PIXEL_ACCOUNT_EVIDENCE`（与上游卡密那把相互独立）。
 * 标签字符串与最初就地派生的 info 逐字相同 ⇒ 存量密文继续可解；
 * 解密走候选链 ⇒ 轮换 AES_KEY 后旧取证不会被锁死（取证被锁死比卡密更不能接受：
 * 那是配合法律程序留下的证据）。
 */
function evidenceKey(): Buffer {
  return deriveKey(KL.PIXEL_ACCOUNT_EVIDENCE);
}

export interface PixelEncryptedEvidence {
  ciphertext: string;
  iv: string;
  tag: string;
  cryptoVersion: number;
}

export function encryptPixelEvidence(plain: string): PixelEncryptedEvidence {
  const iv = crypto.randomBytes(GCM_IV_BYTES);
  const cipher = crypto.createCipheriv(EVIDENCE_SECRET_ALGORITHM, evidenceKey(), iv);
  cipher.setAAD(EVIDENCE_AAD);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return {
    ciphertext: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    cryptoVersion: PIXEL_EVIDENCE_CRYPTO_VERSION,
  };
}

/** 任何不匹配（版本/字段/ tag 校验）都抛错：不回退、不返回半份明文。 */
export function decryptPixelEvidence(doc: Partial<PixelEncryptedEvidence>): string {
  if (doc.cryptoVersion !== PIXEL_EVIDENCE_CRYPTO_VERSION) {
    throw new Error("不支持的取证秘文版本");
  }
  if (!doc.ciphertext || !doc.iv || !doc.tag) {
    throw new Error("取证秘文不完整");
  }
  const iv = Buffer.from(doc.iv, "base64");
  const tag = Buffer.from(doc.tag, "base64");
  if (iv.length !== GCM_IV_BYTES || tag.length !== GCM_TAG_BYTES) {
    throw new Error("取证秘文格式非法");
  }
  const payload = Buffer.from(doc.ciphertext, "base64");
  let lastError: unknown = null;
  for (const key of legacyDecryptKeys(KL.PIXEL_ACCOUNT_EVIDENCE)) {
    try {
      const decipher = crypto.createDecipheriv(EVIDENCE_SECRET_ALGORITHM, key, iv);
      decipher.setAAD(EVIDENCE_AAD);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(payload), decipher.final()]).toString("utf8");
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    lastError instanceof Error ? `取证秘文解密失败：${lastError.message}` : "取证秘文解密失败",
  );
}

/** 仅供密钥轮换迁移使用：用「仅当前主密钥」试解，区分「已是新钥加密」与「仍需重加密」。 */
export function isPixelEvidenceEncryptedWithCurrentKey(doc: Partial<PixelEncryptedEvidence>): boolean {
  try {
    decryptWithEvidenceKey(doc, evidenceKey());
    return true;
  } catch {
    return false;
  }
}

function decryptWithEvidenceKey(doc: Partial<PixelEncryptedEvidence>, key: Buffer): string {
  const iv = Buffer.from(String(doc.iv ?? ""), "base64");
  const tag = Buffer.from(String(doc.tag ?? ""), "base64");
  const decipher = crypto.createDecipheriv(EVIDENCE_SECRET_ALGORITHM, key, iv);
  decipher.setAAD(EVIDENCE_AAD);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(Buffer.from(String(doc.ciphertext ?? ""), "base64")),
    decipher.final(),
  ]).toString("utf8");
}
