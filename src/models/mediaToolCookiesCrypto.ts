import crypto from "node:crypto";
import { deriveKey, KL } from "../config/keyDerivation";

export interface EncryptedMediaCookies {
  credentialCiphertext: string;
  credentialIv: string;
  credentialTag: string;
}

const CONTEXT = Buffer.from("media-tool:bilibili-cookies:v1");

export function encryptMediaCookies(content: string): EncryptedMediaCookies {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(KL.BILIBILI_CRED), iv);
  cipher.setAAD(CONTEXT);
  const encrypted = Buffer.concat([cipher.update(content, "utf8"), cipher.final()]);
  return {
    credentialCiphertext: encrypted.toString("base64"),
    credentialIv: iv.toString("base64"),
    credentialTag: cipher.getAuthTag().toString("base64"),
  };
}

export function decryptMediaCookies(doc: Partial<EncryptedMediaCookies>): string {
  if (!doc.credentialCiphertext || !doc.credentialIv || !doc.credentialTag) {
    throw new Error("媒体工具 Cookie 密文不完整");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(KL.BILIBILI_CRED), Buffer.from(doc.credentialIv, "base64"));
  decipher.setAAD(CONTEXT);
  decipher.setAuthTag(Buffer.from(doc.credentialTag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(doc.credentialCiphertext, "base64")), decipher.final()]).toString("utf8");
}
