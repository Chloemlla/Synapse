/**
 * 主密钥轮换的连续性用例（Pixel 两处密文：上游卡密 + 取证内容）。
 *
 * 这个文件回答两个具体问题：
 *   a) **归位不会破存量**：把本地派生换成 KL 注册表标签后，派生出的子密钥是否与原先逐字节相同？
 *      （相同 ⇒ 已有密文照旧可解，不需要迁移）
 *   b) **轮换之后旧密文还读得出来吗**：AES_KEY 换掉、旧钥留在 AES_KEY_PREV 时，
 *      旧密文必须能解（候选链生效），且新写的数据归当前主密钥；没留旧钥则响亮失败。
 */
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import crypto from "node:crypto";
import { KL, deriveKey, resetDerivationCacheForTest } from "../config/keyDerivation";
import {
  decryptPixelSecret,
  encryptPixelSecret,
  isPixelSecretEncryptedWithCurrentKey,
} from "../pixel/runtime";
import {
  decryptPixelEvidence,
  encryptPixelEvidence,
  isPixelEvidenceEncryptedWithCurrentKey,
} from "../pixel/evidenceCrypto";
import PixelCdkMappingModel from "../models/pixelCdkMappingModel";
import PixelEvidenceModel from "../models/pixelEvidenceModel";
import { canRetirePreviousMasterKey, reencryptPixelSecretsWithCurrentKey } from "../pixel/reencryptService";

jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock("../models/pixelCdkMappingModel", () => ({
  __esModule: true,
  default: { find: jest.fn(), updateOne: jest.fn(), countDocuments: jest.fn() },
}));
jest.mock("../models/pixelEvidenceModel", () => ({
  __esModule: true,
  default: { find: jest.fn(), updateOne: jest.fn(), countDocuments: jest.fn() },
}));

const OLD_MASTER = "old-master-key-0123456789abcdef0123456789abcdef";
const NEW_MASTER = "new-master-key-0123456789abcdef0123456789abcdef";
const SECRET = "upstream-cdk-value";
const EVIDENCE = "user@example.test----PW----r@example.test----TOTP";

const originalEnv = { ...process.env };

function setMaster(aes: string, prev?: string): void {
  process.env.AES_KEY = aes;
  if (prev === undefined) delete process.env.AES_KEY_PREV;
  else process.env.AES_KEY_PREV = prev;
  // 派生有进程内缓存（按来源串缓存，正常会自动失效；这里显式清一次，避免用例间串味）。
  resetDerivationCacheForTest();
}

beforeEach(() => {
  jest.clearAllMocks();
  setMaster(OLD_MASTER);
});

afterEach(() => {
  process.env = { ...originalEnv };
  resetDerivationCacheForTest();
});

describe("KL 归位的字节一致性（决定是否需要迁移）", () => {
  it("KL.PIXEL_UPSTREAM_CDK 派生与原先就地派生逐字节相同", () => {
    const salt = Buffer.from("synapse-key-v1", "utf8");
    const ikm = crypto.createHash("sha256").update(OLD_MASTER).digest();
    const legacy = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("pixel-upstream-cdk-v1", "utf8"), 32));
    expect(deriveKey(KL.PIXEL_UPSTREAM_CDK).toString("hex")).toBe(legacy.toString("hex"));
  });

  it("KL.PIXEL_ACCOUNT_EVIDENCE 派生与原先就地派生逐字节相同", () => {
    const salt = Buffer.from("synapse-key-v1", "utf8");
    const ikm = crypto.createHash("sha256").update(OLD_MASTER).digest();
    const legacy = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("pixel-account-evidence-v1", "utf8"), 32));
    expect(deriveKey(KL.PIXEL_ACCOUNT_EVIDENCE).toString("hex")).toBe(legacy.toString("hex"));
  });

  it("两个用途拿到不同子密钥（用途隔离没被归位破坏）", () => {
    expect(deriveKey(KL.PIXEL_UPSTREAM_CDK).toString("hex"))
      .not.toBe(deriveKey(KL.PIXEL_ACCOUNT_EVIDENCE).toString("hex"));
  });
});

describe("上游卡密密文：轮换后的可读性", () => {
  it("轮换后靠 AES_KEY_PREV 仍能解开旧密文，新密文归当前主密钥", () => {
    const oldCipher = encryptPixelSecret(SECRET);
    expect(isPixelSecretEncryptedWithCurrentKey(oldCipher)).toBe(true);

    setMaster(NEW_MASTER, OLD_MASTER);

    // 旧密文：候选链回退到上一代主密钥 → 可解
    expect(decryptPixelSecret(oldCipher)).toBe(SECRET);
    // 但它不属于当前主密钥（迁移器据此判定「需重加密」）
    expect(isPixelSecretEncryptedWithCurrentKey(oldCipher)).toBe(false);
    // 新写入的密文归当前主密钥
    const newCipher = encryptPixelSecret(SECRET);
    expect(isPixelSecretEncryptedWithCurrentKey(newCipher)).toBe(true);
    expect(newCipher.ciphertext).not.toBe(oldCipher.ciphertext);
  });

  it("没有 AES_KEY_PREV 时旧密文响亮失败，不返回明文也不静默放过", () => {
    const oldCipher = encryptPixelSecret(SECRET);
    setMaster(NEW_MASTER);
    expect(() => decryptPixelSecret(oldCipher)).toThrow(/解密失败/);
  });
});

describe("取证密文：轮换后的可读性", () => {
  it("轮换后旧取证仍可解（这比卡密更不能丢：那是配合法律程序留的证据）", () => {
    const oldCipher = encryptPixelEvidence(EVIDENCE);
    setMaster(NEW_MASTER, OLD_MASTER);
    expect(decryptPixelEvidence(oldCipher)).toBe(EVIDENCE);
    expect(isPixelEvidenceEncryptedWithCurrentKey(oldCipher)).toBe(false);
    const newCipher = encryptPixelEvidence(EVIDENCE);
    expect(isPixelEvidenceEncryptedWithCurrentKey(newCipher)).toBe(true);
    expect(decryptPixelEvidence(newCipher)).toBe(EVIDENCE);
  });
});

describe("重加密迁移器", () => {
  function leanList<T>(rows: T[]) {
    return { select: () => ({ limit: () => ({ lean: () => Promise.resolve(rows) }) }) };
  }

  it("apply=false 只报告不动数据", async () => {
    const oldCipher = encryptPixelSecret(SECRET);
    setMaster(NEW_MASTER, OLD_MASTER);
    (PixelCdkMappingModel.find as jest.Mock).mockReturnValue(leanList([{
      mappingId: "pcm_1", upstreamCdkCiphertext: oldCipher.ciphertext, upstreamCdkIv: oldCipher.iv,
      upstreamCdkTag: oldCipher.tag, upstreamCdkCryptoVersion: oldCipher.cryptoVersion,
    }]));
    (PixelCdkMappingModel.countDocuments as jest.Mock).mockResolvedValue(1);
    (PixelEvidenceModel.find as jest.Mock).mockReturnValue(leanList([]));
    (PixelEvidenceModel.countDocuments as jest.Mock).mockResolvedValue(0);

    const result = await reencryptPixelSecretsWithCurrentKey({ apply: false });

    expect(result.pending).toBeGreaterThanOrEqual(1);
    expect(result.reencrypted).toBe(0);
    expect(PixelCdkMappingModel.updateOne).not.toHaveBeenCalled();
  });

  it("apply=true 就地重加密为当前主密钥", async () => {
    const oldCipher = encryptPixelSecret(SECRET);
    setMaster(NEW_MASTER, OLD_MASTER);
    (PixelCdkMappingModel.find as jest.Mock).mockReturnValue(leanList([{
      mappingId: "pcm_1", upstreamCdkCiphertext: oldCipher.ciphertext, upstreamCdkIv: oldCipher.iv,
      upstreamCdkTag: oldCipher.tag, upstreamCdkCryptoVersion: oldCipher.cryptoVersion,
    }]));
    (PixelCdkMappingModel.countDocuments as jest.Mock).mockResolvedValue(1);
    (PixelCdkMappingModel.updateOne as jest.Mock).mockResolvedValue({ modifiedCount: 1 });
    (PixelEvidenceModel.find as jest.Mock).mockReturnValue(leanList([]));
    (PixelEvidenceModel.countDocuments as jest.Mock).mockResolvedValue(0);

    const result = await reencryptPixelSecretsWithCurrentKey({ apply: true });

    expect(result.reencrypted).toBe(1);
    const [, update] = (PixelCdkMappingModel.updateOne as jest.Mock).mock.calls[0] as [
      Record<string, unknown>,
      { $set: Record<string, unknown> },
    ];
    expect(update.$set.upstreamCdkCiphertext).not.toBe(oldCipher.ciphertext);
    // 重加密后的密文必须能被「仅当前主密钥」解开。
    const rewritten = {
      ciphertext: String(update.$set.upstreamCdkCiphertext),
      iv: String(update.$set.upstreamCdkIv),
      tag: String(update.$set.upstreamCdkTag),
      cryptoVersion: Number(update.$set.upstreamCdkCryptoVersion),
    };
    expect(isPixelSecretEncryptedWithCurrentKey(rewritten)).toBe(true);
    expect(decryptPixelSecret(rewritten)).toBe(SECRET);
  });

  it("谁都解不开的密文只计数、不覆盖（不猜、不丢）", async () => {
    setMaster(NEW_MASTER, OLD_MASTER);
    (PixelCdkMappingModel.find as jest.Mock).mockReturnValue(leanList([{
      mappingId: "pcm_broken", upstreamCdkCiphertext: Buffer.from("junk").toString("base64"),
      upstreamCdkIv: Buffer.alloc(12).toString("base64"), upstreamCdkTag: Buffer.alloc(16).toString("base64"),
      upstreamCdkCryptoVersion: 1,
    }]));
    (PixelCdkMappingModel.countDocuments as jest.Mock).mockResolvedValue(1);
    (PixelEvidenceModel.find as jest.Mock).mockReturnValue(leanList([]));
    (PixelEvidenceModel.countDocuments as jest.Mock).mockResolvedValue(0);

    const result = await reencryptPixelSecretsWithCurrentKey({ apply: true });

    expect(result.undecryptable).toBe(1);
    expect(PixelCdkMappingModel.updateOne).not.toHaveBeenCalled();
  });

  it("退役上一代密钥的判据：还有待重加密或解不开的就不许退", async () => {
    setMaster(NEW_MASTER, OLD_MASTER);
    const oldCipher = encryptPixelSecret(SECRET);
    (PixelCdkMappingModel.find as jest.Mock).mockReturnValue(leanList([{
      mappingId: "pcm_1", upstreamCdkCiphertext: oldCipher.ciphertext, upstreamCdkIv: oldCipher.iv,
      upstreamCdkTag: oldCipher.tag, upstreamCdkCryptoVersion: oldCipher.cryptoVersion,
    }]));
    (PixelCdkMappingModel.countDocuments as jest.Mock).mockResolvedValue(1);
    (PixelEvidenceModel.find as jest.Mock).mockReturnValue(leanList([]));
    (PixelEvidenceModel.countDocuments as jest.Mock).mockResolvedValue(0);

    const blocked = await canRetirePreviousMasterKey();
    expect(blocked.canRetire).toBe(false);
    expect(blocked.reason).toMatch(/重加密/);

    // 全部迁完后才允许退役。
    setMaster(NEW_MASTER, OLD_MASTER);
    const newCipher = encryptPixelSecret(SECRET);
    (PixelCdkMappingModel.find as jest.Mock).mockReturnValue(leanList([{
      mappingId: "pcm_1", upstreamCdkCiphertext: newCipher.ciphertext, upstreamCdkIv: newCipher.iv,
      upstreamCdkTag: newCipher.tag, upstreamCdkCryptoVersion: newCipher.cryptoVersion,
    }]));
    const allowed = await canRetirePreviousMasterKey();
    expect(allowed.canRetire).toBe(true);
  });

  it("扫描不完整时一律不许退役（不能拿未扫到的数据赌）", async () => {
    setMaster(NEW_MASTER, OLD_MASTER);
    const newCipher = encryptPixelSecret(SECRET);
    (PixelCdkMappingModel.find as jest.Mock).mockReturnValue(leanList([{
      mappingId: "pcm_1", upstreamCdkCiphertext: newCipher.ciphertext, upstreamCdkIv: newCipher.iv,
      upstreamCdkTag: newCipher.tag, upstreamCdkCryptoVersion: newCipher.cryptoVersion,
    }]));
    // 库里其实还有更多条没扫到（上限 1000；这里模拟 total > scanned）。
    (PixelCdkMappingModel.countDocuments as jest.Mock).mockResolvedValue(5_000);
    (PixelEvidenceModel.find as jest.Mock).mockReturnValue(leanList([]));
    (PixelEvidenceModel.countDocuments as jest.Mock).mockResolvedValue(0);

    const blocked = await canRetirePreviousMasterKey();
    expect(blocked.canRetire).toBe(false);
    expect(blocked.reason).toMatch(/未扫描/);
  });
});
