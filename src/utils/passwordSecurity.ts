import crypto from "node:crypto";
import bcrypt from "bcrypt";
import { config } from "../config/config";
import { KL, deriveKey, hashSecretToKey, legacyDecryptKeys } from "../config/keyDerivation";
import type { User } from "./userStorageTypes";

const PASSWORD_KEY_VERSION = "v2";
const LEGACY_PASSWORD_KEY_VERSION = "v1";
const PASSWORD_ALGO = "aes-256-gcm";

/** 新写入的 KEK：单一主密钥 AES_KEY 经 HKDF(KL.PASSWORD_KEK) 派生。 */
function currentPasswordKek(): Buffer {
  return deriveKey(KL.PASSWORD_KEK);
}

/** 解密候选 KEK：新派生子密钥在前 + 历史 env（PASSWORD_ENCRYPTION_KEY / AES_KEY / JWT_SECRET）+ config.jwtSecret。 */
function passwordKekCandidates(): Buffer[] {
  const keys = legacyDecryptKeys(KL.PASSWORD_KEK);
  const seen = new Set(keys.map((key) => key.toString("hex")));
  const jwtDerived = hashSecretToKey(config.jwtSecret);
  if (!seen.has(jwtDerived.toString("hex"))) keys.push(jwtDerived);
  return keys;
}

function wrapDek(dek: Buffer): string {
  const kek = currentPasswordKek();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(PASSWORD_ALGO, kek, iv);
  const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    v: PASSWORD_KEY_VERSION,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: ciphertext.toString("base64"),
  });
}

function unwrapDek(wrappedDek: string): Buffer | null {
  let parsed: { iv: string; tag: string; data: string };
  try {
    parsed = JSON.parse(wrappedDek);
  } catch {
    return null;
  }
  const iv = Buffer.from(parsed.iv, "base64");
  const tag = Buffer.from(parsed.tag, "base64");
  const data = Buffer.from(parsed.data, "base64");
  // 依次试候选 KEK：迁移前用旧密钥 wrap 的 DEK 仍可解开。
  for (const kek of passwordKekCandidates()) {
    try {
      const decipher = crypto.createDecipheriv(PASSWORD_ALGO, kek, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]);
    } catch {
      // 密钥不匹配，继续下一个
    }
  }
  return null;
}

function deriveLegacyUserKey(userId: string, keyVersion: string, masterKey: Buffer): Buffer {
  const info = Buffer.from(`user-password:${userId}:${keyVersion}`, "utf8");
  return Buffer.from(crypto.hkdfSync("sha256", masterKey, Buffer.alloc(0), info, 32));
}

export interface ProtectedPasswordPayload {
  passwordHash: string;
  passwordCiphertext: string;
  passwordIv: string;
  passwordTag: string;
  passwordKeyVersion: string;
  passwordWrappedDek: string;
  passwordDekId: string;
}

export async function protectPassword(userId: string, password: string): Promise<ProtectedPasswordPayload> {
  const passwordHash = await bcrypt.hash(password, config.bcryptSaltRounds);
  // 不再把明文密码可逆加密入库，只保留单向 bcrypt 哈希。密文字段置空以保持
  // ProtectedPasswordPayload 契约不变（历史遗留数据的解密走 decryptStoredPassword，不依赖新写入）。
  return {
    passwordHash,
    passwordCiphertext: "",
    passwordIv: "",
    passwordTag: "",
    passwordKeyVersion: PASSWORD_KEY_VERSION,
    passwordWrappedDek: "",
    passwordDekId: "",
  };
}

export async function verifyPasswordHash(passwordHash: string | undefined, password: string): Promise<boolean> {
  if (!passwordHash) {
    return false;
  }
  return bcrypt.compare(password, passwordHash);
}

export function canDecryptPassword(user: Partial<User>): boolean {
  return Boolean(
    user.id &&
      user.passwordCiphertext &&
      user.passwordIv &&
      user.passwordTag &&
      (user.passwordWrappedDek || (user.passwordKeyVersion && user.passwordKeyVersion === LEGACY_PASSWORD_KEY_VERSION)),
  );
}

export function decryptStoredPassword(user: Partial<User>): string | null {
  if (!user.id || !user.passwordCiphertext || !user.passwordIv || !user.passwordTag) {
    return null;
  }

  const iv = Buffer.from(user.passwordIv, "base64");
  const tag = Buffer.from(user.passwordTag, "base64");
  const ciphertext = Buffer.from(user.passwordCiphertext, "base64");
  const tryDecrypt = (dek: Buffer): string | null => {
    try {
      const decipher = crypto.createDecipheriv(PASSWORD_ALGO, dek, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    } catch {
      return null;
    }
  };

  // v2：DEK 被 KEK 包裹，unwrapDek 已内部多候选尝试。
  if (typeof user.passwordWrappedDek === "string" && user.passwordWrappedDek) {
    const dek = unwrapDek(user.passwordWrappedDek);
    return dek ? tryDecrypt(dek) : null;
  }

  // v1 legacy：每个候选 KEK 作为 HKDF ikm 派生每用户密钥，逐个试。
  const keyVersion = user.passwordKeyVersion || LEGACY_PASSWORD_KEY_VERSION;
  for (const kek of passwordKekCandidates()) {
    const dek = deriveLegacyUserKey(user.id, keyVersion, kek);
    const plaintext = tryDecrypt(dek);
    if (plaintext !== null) return plaintext;
  }
  return null;
}
