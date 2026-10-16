import { fingerprintOfSource, masterKeyInfo } from "../config/keyDerivation";
import PixelCdkMappingModel from "../models/pixelCdkMappingModel";
import PixelEvidenceModel from "../models/pixelEvidenceModel";
import logger from "../utils/logger";
import {
  decryptPixelSecret,
  encryptPixelSecret,
  isPixelSecretEncryptedWithCurrentKey,
} from "./runtime";
import {
  decryptPixelEvidence,
  encryptPixelEvidence,
  isPixelEvidenceEncryptedWithCurrentKey,
} from "./evidenceCrypto";
import { PixelDomainError } from "./types";

// 主密钥轮换的**后半程**：把存量密文重写成「当前主密钥加密」。
//
// 为什么必须有这一步：HKDF 单向，换了 AES_KEY 就无法反推旧子密钥，旧密文只能靠
// AES_KEY_PREV 撑住「只解不写」。没有重加密，AES_KEY_PREV 就永远退不掉 ——
// 于是「轮换」只做了一半：旧钥一旦泄露，风险照样在。
//
// 边界：只处理 Pixel 自己的两处密文（上游卡密、取证内容）。全站其它用途的密文
// （password-kek / bilibili / short-url / proxycheck …）各有自己的迁移路径，不在这里越界。
const DEFAULT_BATCH = 200;
const MAX_BATCH = 1_000;

export type PixelKeyRotationStatus = {
  master: {
    /** 仅来源名（AES_KEY / JWT_SECRET / ephemeral），不是密钥本身。 */
    origin: string;
    /** sha256 前 16 位 hex，用于核对「是不是同一把钥匙」。 */
    fingerprint: string;
    previousConfigured: boolean;
    previousFingerprint: string | null;
  };
  mappings: { total: number; encryptedWithCurrentKey: number; needsReencrypt: number; undecryptable: number };
  evidence: { total: number; encryptedWithCurrentKey: number; needsReencrypt: number; undecryptable: number };
};

export type PixelReencryptResult = {
  apply: boolean;
  scanned: number;
  reencrypted: number;
  pending: number;
  undecryptable: number;
  remaining: number;
};

function previousFingerprint(): string | null {
  const prev = (process.env.AES_KEY_PREV || "").trim();
  return prev ? fingerprintOfSource(prev) : null;
}

async function scanMappings(apply: boolean, limit: number) {
  const docs = await PixelCdkMappingModel.find({})
    .select("mappingId upstreamCdkCiphertext upstreamCdkIv upstreamCdkTag upstreamCdkCryptoVersion")
    .limit(limit)
    .lean();

  let encryptedWithCurrentKey = 0;
  let needsReencrypt = 0;
  let undecryptable = 0;
  let reencrypted = 0;

  for (const doc of docs) {
    const cipher = {
      ciphertext: doc.upstreamCdkCiphertext,
      iv: doc.upstreamCdkIv,
      tag: doc.upstreamCdkTag,
      cryptoVersion: doc.upstreamCdkCryptoVersion,
    };
    if (isPixelSecretEncryptedWithCurrentKey(cipher)) {
      encryptedWithCurrentKey += 1;
      continue;
    }
    let plain: string;
    try {
      // 候选链（当前 → AES_KEY_PREV → 旧命名 env）任一代能解开就说明只需重加密。
      plain = decryptPixelSecret(cipher);
    } catch {
      // 谁都解不开：要么密文损坏，要么把上一代主密钥弄丢了。计数上报，不猜、不覆盖。
      undecryptable += 1;
      continue;
    }
    needsReencrypt += 1;
    if (!apply) continue;
    const next = encryptPixelSecret(plain);
    await PixelCdkMappingModel.updateOne(
      { mappingId: doc.mappingId },
      {
        $set: {
          upstreamCdkCiphertext: next.ciphertext,
          upstreamCdkIv: next.iv,
          upstreamCdkTag: next.tag,
          upstreamCdkCryptoVersion: next.cryptoVersion,
        },
      },
    );
    reencrypted += 1;
  }

  const total = await PixelCdkMappingModel.countDocuments({});
  return { total, encryptedWithCurrentKey, needsReencrypt, undecryptable, reencrypted };
}

async function scanEvidence(apply: boolean, limit: number) {
  const docs = await PixelEvidenceModel.find({})
    .select("evidenceId ciphertext iv tag cryptoVersion")
    .limit(limit)
    .lean();

  let encryptedWithCurrentKey = 0;
  let needsReencrypt = 0;
  let undecryptable = 0;
  let reencrypted = 0;

  for (const doc of docs) {
    const cipher = { ciphertext: doc.ciphertext, iv: doc.iv, tag: doc.tag, cryptoVersion: doc.cryptoVersion };
    if (isPixelEvidenceEncryptedWithCurrentKey(cipher)) {
      encryptedWithCurrentKey += 1;
      continue;
    }
    let plain: string;
    try {
      plain = decryptPixelEvidence(cipher);
    } catch {
      undecryptable += 1;
      continue;
    }
    needsReencrypt += 1;
    if (!apply) continue;
    const next = encryptPixelEvidence(plain);
    await PixelEvidenceModel.updateOne(
      { evidenceId: doc.evidenceId },
      { $set: { ciphertext: next.ciphertext, iv: next.iv, tag: next.tag, cryptoVersion: next.cryptoVersion } },
    );
    reencrypted += 1;
  }

  const total = await PixelEvidenceModel.countDocuments({});
  return { total, encryptedWithCurrentKey, needsReencrypt, undecryptable, reencrypted };
}

/** 轮换前后的体检：当前是哪一代主密钥、上一代有没有留、两处密文各有多少还没迁完。 */
export async function getPixelKeyRotationStatus(): Promise<PixelKeyRotationStatus> {
  const master = masterKeyInfo();
  const [mappings, evidence] = await Promise.all([scanMappings(false, MAX_BATCH), scanEvidence(false, MAX_BATCH)]);
  return {
    master: {
      origin: master.origin,
      fingerprint: fingerprintOfSource(master.value),
      previousConfigured: previousFingerprint() !== null,
      previousFingerprint: previousFingerprint(),
    },
    mappings: {
      total: mappings.total,
      encryptedWithCurrentKey: mappings.encryptedWithCurrentKey,
      needsReencrypt: mappings.needsReencrypt,
      undecryptable: mappings.undecryptable,
    },
    evidence: {
      total: evidence.total,
      encryptedWithCurrentKey: evidence.encryptedWithCurrentKey,
      needsReencrypt: evidence.needsReencrypt,
      undecryptable: evidence.undecryptable,
    },
  };
}

/**
 * 重加密一批。**必须显式 apply**：默认只扫描并报告，不会动任何密文 —— 迁移操作应当先看清数量。
 * 分批（limit）返回 remaining，运维可以反复调用直到 0，再考虑退役 AES_KEY_PREV。
 */
export async function reencryptPixelSecretsWithCurrentKey(options: {
  apply: boolean;
  limit?: number;
}): Promise<PixelReencryptResult> {
  const limit = Math.min(Math.max(1, Math.floor(options.limit ?? DEFAULT_BATCH) || DEFAULT_BATCH), MAX_BATCH);
  const [mappings, evidence] = await Promise.all([
    scanMappings(options.apply, limit),
    scanEvidence(options.apply, limit),
  ]);

  const pending = mappings.needsReencrypt + evidence.needsReencrypt;
  const undecryptable = mappings.undecryptable + evidence.undecryptable;
  const reencrypted = mappings.reencrypted + evidence.reencrypted;
  const scanned = mappings.encryptedWithCurrentKey + mappings.needsReencrypt + mappings.undecryptable
    + evidence.encryptedWithCurrentKey + evidence.needsReencrypt + evidence.undecryptable;
  // remaining 用「还没重加密」的计数近似（本批最多 limit 条/集合，因此 ≥0）。
  const remaining = Math.max(0, pending - reencrypted);

  logger.warn("[Pixel] 主密钥重加密扫描", {
    apply: options.apply,
    scanned,
    reencrypted,
    pending,
    undecryptable,
  });

  if (undecryptable > 0) {
    // 不抛错（其余数据已处理），但要把这件事喊出来：有密文连上一代密钥都解不开。
    logger.error("[Pixel] 存在无法解密的密文，请确认 AES_KEY_PREV 是否丢失", { undecryptable });
  }

  return { apply: options.apply, scanned, reencrypted, pending, undecryptable, remaining };
}

/** 显式判断：现在能不能退役 AES_KEY_PREV（两处密文都已由当前主密钥加密，且没有解不开的）。 */
export async function canRetirePreviousMasterKey(): Promise<{ canRetire: boolean; reason: string }> {
  const status = await getPixelKeyRotationStatus();
  if (!status.master.previousConfigured) {
    return { canRetire: false, reason: "当前没有配置 AES_KEY_PREV（无需退役）。" };
  }
  if (status.mappings.undecryptable > 0 || status.evidence.undecryptable > 0) {
    return { canRetire: false, reason: "存在无法解密的密文：退役上一代密钥会让它们永久不可读。" };
  }
  if (status.mappings.needsReencrypt > 0 || status.evidence.needsReencrypt > 0) {
    return { canRetire: false, reason: "还有密文仍由上一代密钥加密，请先重加密。" };
  }
  return { canRetire: true, reason: "Pixel 范围内两处密文均已完成重加密。" };
}

/** 供路由在参数非法时统一报同一种错。 */
export function assertReencryptLimit(value: unknown): void {
  if (value === undefined || value === null || value === "") return;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new PixelDomainError("批次大小必须是正整数。", 400, "PIXEL_REENCRYPT_LIMIT_INVALID");
  }
}
