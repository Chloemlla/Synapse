import crypto from "node:crypto";
import {
  KL,
  deriveKey,
  deriveSecretHex,
  hashSecretToKey,
  legacyDecryptKeys,
  legacyRawSecrets,
  masterIkm,
  resetDerivationCacheForTest,
} from "../config/keyDerivation";

describe("keyDerivation（单一主密钥 + HKDF 派生）", () => {
  const ORIGINAL_AES_KEY = process.env.AES_KEY;

  beforeEach(() => {
    resetDerivationCacheForTest();
  });

  afterAll(() => {
    if (ORIGINAL_AES_KEY === undefined) delete process.env.AES_KEY;
    else process.env.AES_KEY = ORIGINAL_AES_KEY;
    resetDerivationCacheForTest();
  });

  it("同一 AES_KEY 下派生确定、长度 32B", () => {
    process.env.AES_KEY = "unit-test-master-key-0123456789abcdef";
    resetDerivationCacheForTest();
    const a = deriveKey(KL.BILIBILI_CRED);
    const b = deriveKey(KL.BILIBILI_CRED);
    expect(a.length).toBe(32);
    expect(a.equals(b)).toBe(true);
    expect(masterIkm().length).toBe(32);
  });

  it("不同标签派生互不相同（域分隔）", () => {
    process.env.AES_KEY = "unit-test-master-key-0123456789abcdef";
    resetDerivationCacheForTest();
    const labels = Object.values(KL);
    const seen = new Set<string>();
    for (const label of labels) {
      seen.add(deriveKey(label).toString("hex"));
    }
    expect(seen.size).toBe(labels.length);
  });

  it("AES_KEY 变更后派生随之改变（缓存失效）", () => {
    process.env.AES_KEY = "key-one-0123456789abcdef0123456789";
    resetDerivationCacheForTest();
    const before = deriveSecretHex(KL.JWT);
    process.env.AES_KEY = "key-two-0123456789abcdef0123456789";
    resetDerivationCacheForTest();
    const after = deriveSecretHex(KL.JWT);
    expect(before).not.toBe(after);
  });

  it("AES-256-GCM 用派生子密钥加解密可逆", () => {
    process.env.AES_KEY = "unit-test-master-key-0123456789abcdef";
    resetDerivationCacheForTest();
    const key = deriveKey(KL.DATA_COLLECTION_RAW);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update("hello 明文", "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    expect(pt).toBe("hello 明文");
  });

  it("legacyDecryptKeys：派生子密钥在首位，且包含旧 env 的 sha256", () => {
    process.env.AES_KEY = "unit-test-master-key-0123456789abcdef";
    process.env.BILIBILI_COOKIE_ENCRYPTION_KEY = "legacy-bili-key";
    resetDerivationCacheForTest();
    const keys = legacyDecryptKeys(KL.BILIBILI_CRED);
    expect(keys[0].equals(deriveKey(KL.BILIBILI_CRED))).toBe(true);
    const legacyHash = hashSecretToKey("legacy-bili-key").toString("hex");
    expect(keys.some((k) => k.toString("hex") === legacyHash)).toBe(true);
    delete process.env.BILIBILI_COOKIE_ENCRYPTION_KEY;
  });

  it("legacyRawSecrets：去空去重，仅返回配置过的旧值", () => {
    process.env.NEXAI_APP_SIGN_SECRET = "nexai-current";
    process.env.NEXAI_APP_SIGN_SECRET_PREV = "nexai-current"; // 与上相同 → 去重
    resetDerivationCacheForTest();
    expect(legacyRawSecrets(KL.NEXAI_SIGN)).toEqual(["nexai-current"]);
    delete process.env.NEXAI_APP_SIGN_SECRET;
    delete process.env.NEXAI_APP_SIGN_SECRET_PREV;
  });
});
