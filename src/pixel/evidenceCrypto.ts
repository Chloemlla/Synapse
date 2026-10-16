import crypto from "node:crypto";
import { masterIkm } from "../config/keyDerivation";

// 内容级取证的加密：与「上游卡密」**不同**的子密钥与 AAD。
//
// 为什么必须独立子密钥而不是复用 upstream-cdk 的那把：
//   · 用途隔离：卡密泄露不应连带解密取证内容，反之亦然；
//   · 轮换独立：将来轮换任意一侧不需要同时重加密另一侧；
//   · 证据链清楚：AAD 里写明用途与版本，跨用途重放（把卡密密文塞进取证表）会在解密时直接失败。
const EVIDENCE_SECRET_ALGORITHM = "aes-256-gcm";
export const PIXEL_EVIDENCE_CRYPTO_VERSION = 1;
const EVIDENCE_KEY_SALT = Buffer.from("synapse-key-v1", "utf8");
const EVIDENCE_KEY_INFO = Buffer.from("pixel-account-evidence-v1", "utf8");
const EVIDENCE_AAD = Buffer.from(`pixel:account-evidence:v${PIXEL_EVIDENCE_CRYPTO_VERSION}`, "utf8");
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

function evidenceKey(): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", masterIkm(), EVIDENCE_KEY_SALT, EVIDENCE_KEY_INFO, 32));
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
  const decipher = crypto.createDecipheriv(EVIDENCE_SECRET_ALGORITHM, evidenceKey(), iv);
  decipher.setAAD(EVIDENCE_AAD);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(Buffer.from(doc.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
