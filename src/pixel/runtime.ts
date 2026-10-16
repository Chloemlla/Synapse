/**
 * Pixel 域的运行期基础设施：限额、标识、遮罩、卡密哈希、上游 CDK 的可逆加密。
 *
 * 只依赖 node: 内置模块与 config/keyDerivation（纯函数），所以单测与 HTTP 层都能直接用，
 * 不需要 Mongo 连接。生产唯一的可逆加密入口就是这里的 encryptPixelSecret/decryptPixelSecret。
 */
import crypto from "node:crypto";
import { KL, deriveKey, legacyDecryptKeys } from "../config/keyDerivation";

export interface PixelRuntimeLimits {
  /** 单次提交允许的最大账号行数。 */
  maxAccountsPerSubmission: number;
  /** 单行账号文本的最大字符数。 */
  maxAccountLineChars: number;
  /** 账号文本整段的字节上限。 */
  maxAccountsTextBytes: number;
  /** 溯源日志保留天数（TTL，见 models/pixelUsageLogModel.ts）。 */
  usageLogRetentionDays: number;
  /** 单次上游请求超时。 */
  upstreamTimeoutMs: number;
}

function readBoundedInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = (env[name] || "").trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/**
 * 限额默认值的取舍：
 *   · 账号数默认 100：上游按行处理，行数越大单次扣额越多；给一个「误粘贴整份清单也不会秒烧额度」的上限，
 *     真正需要更多时由运维显式调 env。
 *   · 账号文本 128 KB：远超 100 行的合理长度，只用来挡住「把整个文件当账号文本提交」这种事故。
 *   · 日志保留 30 天：溯源够用，且与「不长期保存行为数据」的最小化原则一致。
 */
export function pixelLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): PixelRuntimeLimits {
  return {
    maxAccountsPerSubmission: readBoundedInt(env, "PIXEL_MAX_ACCOUNTS", 100, 1, 5_000),
    maxAccountLineChars: readBoundedInt(env, "PIXEL_MAX_ACCOUNT_LINE_CHARS", 512, 32, 4_096),
    maxAccountsTextBytes: readBoundedInt(env, "PIXEL_MAX_ACCOUNTS_TEXT_BYTES", 128 * 1024, 1_024, 1024 * 1024),
    usageLogRetentionDays: readBoundedInt(env, "PIXEL_USAGE_LOG_RETENTION_DAYS", 30, 1, 3_650),
    upstreamTimeoutMs: readBoundedInt(env, "PIXEL_UPSTREAM_TIMEOUT_MS", 20_000, 1_000, 120_000),
  };
}

/** 稳定 id：前缀 + 32 位 hex（对外可见，不含任何用户输入）。 */
export function newPixelId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

/**
 * 卡密/秘钥遮罩：≤ 8 位全部打码，否则留前 4 后 4。
 * 与来源实现的 mask_cdk 同口径——遮罩值要能在管理端「认出是哪张卡」，但不能还原。
 */
export function maskSecret(value: string): string {
  const text = String(value || "");
  const chars = [...text];
  if (chars.length <= 8) return "********";
  return `${chars.slice(0, 4).join("")}...${chars.slice(-4).join("")}`;
}

/**
 * 分发卡密的规范化：只去首尾空白（复制粘贴常带空格/换行），**不做大小写折叠**——
 * 卡密按大小写敏感处理，避免把两张仅大小写不同的卡密折叠成同一条映射。
 * 规范化结果只用于哈希与去重，明文本身不落库。
 */
export function normalizeDistributionCdk(value: string): string {
  return String(value || "").trim();
}

/** sha256(规范化卡密) —— 唯一索引与查找键；从哈希无法还原卡密。 */
export function hashDistributionCdk(value: string): string {
  return crypto.createHash("sha256").update(normalizeDistributionCdk(value), "utf8").digest("hex");
}

/**
 * 上游 CDK 的静态加密（AES-256-GCM，可逆）。
 *
 * 密钥来自统一注册表 `KL.PIXEL_UPSTREAM_CDK`（HKDF-SHA256，salt = "synapse-key-v1"）。
 * 这个标签的字符串与最初就地派生时逐字相同，所以**存量密文照旧可解**；
 * 而解密改走 `legacyDecryptKeys` 候选链后，轮换 AES_KEY 时旧密文(含只留在 AES_KEY_PREV
 * 里的那一代)仍然解得开。AAD 里再钉一次用途与版本，防止密文跨用途搬运。
 */
const PIXEL_SECRET_ALGORITHM = "aes-256-gcm";
export const PIXEL_SECRET_CRYPTO_VERSION = 1;
const PIXEL_SECRET_AAD = Buffer.from(`pixel:upstream-cdk:v${PIXEL_SECRET_CRYPTO_VERSION}`, "utf8");
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

/**
 * 加密用当前主密钥派生的子密钥；解密用候选链（新 → AES_KEY_PREV → 各旧命名 env）。
 *
 * 用量标签走统一的 KL 注册表：标签字符串与最初就地派生时逐字一致，因此**存量密文继续可解**，
 * 而从此以后轮换 AES_KEY 不会把旧卡密锁死（这正是之前直接调 masterIkm 后的缺口）。
 */
function pixelSecretKey(): Buffer {
  return deriveKey(KL.PIXEL_UPSTREAM_CDK);
}

export interface PixelEncryptedSecret {
  ciphertext: string;
  iv: string;
  tag: string;
  cryptoVersion: number;
}

export function encryptPixelSecret(plain: string): PixelEncryptedSecret {
  const iv = crypto.randomBytes(GCM_IV_BYTES);
  const cipher = crypto.createCipheriv(PIXEL_SECRET_ALGORITHM, pixelSecretKey(), iv);
  cipher.setAAD(PIXEL_SECRET_AAD);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return {
    ciphertext: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    cryptoVersion: PIXEL_SECRET_CRYPTO_VERSION,
  };
}

/**
 * 解密上游 CDK。任何不匹配（版本、字段缺失、tag 校验失败）都抛错而不是回退——
 * 回退到「按明文用」会让一次密钥误配变成把密文当卡密发上游。
 */
export function decryptPixelSecret(doc: Partial<PixelEncryptedSecret>): string {
  if (doc.cryptoVersion !== PIXEL_SECRET_CRYPTO_VERSION) {
    throw new Error("不支持的 Pixel 秘文版本");
  }
  if (!doc.ciphertext || !doc.iv || !doc.tag) {
    throw new Error("Pixel 秘文不完整");
  }
  const iv = Buffer.from(doc.iv, "base64");
  const tag = Buffer.from(doc.tag, "base64");
  if (iv.length !== GCM_IV_BYTES || tag.length !== GCM_TAG_BYTES) {
    throw new Error("Pixel 秘文格式非法");
  }
  const payload = Buffer.from(doc.ciphertext, "base64");
  // 候选链：当前主密钥 → AES_KEY_PREV → 旧命名 env。认证 tag 判定命中；全部失败则报错，
  // 绝不回退到「把密文当明文用」。
  let lastError: unknown = null;
  for (const key of legacyDecryptKeys(KL.PIXEL_UPSTREAM_CDK)) {
    try {
      const decipher = crypto.createDecipheriv(PIXEL_SECRET_ALGORITHM, key, iv);
      decipher.setAAD(PIXEL_SECRET_AAD);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(payload), decipher.final()]).toString("utf8");
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    lastError instanceof Error ? `Pixel 秘文解密失败：${lastError.message}` : "Pixel 秘文解密失败",
  );
}

/** 仅供密钥轮换迁移使用：用「仅当前主密钥」试解，用来区分「已是新钥加密」与「仍需重加密」。 */
export function isPixelSecretEncryptedWithCurrentKey(doc: Partial<PixelEncryptedSecret>): boolean {
  try {
    decryptWithPixelKey(doc, pixelSecretKey());
    return true;
  } catch {
    return false;
  }
}

function decryptWithPixelKey(doc: Partial<PixelEncryptedSecret>, key: Buffer): string {
  const iv = Buffer.from(String(doc.iv ?? ""), "base64");
  const tag = Buffer.from(String(doc.tag ?? ""), "base64");
  const decipher = crypto.createDecipheriv(PIXEL_SECRET_ALGORITHM, key, iv);
  decipher.setAAD(PIXEL_SECRET_AAD);
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(Buffer.from(String(doc.ciphertext ?? ""), "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** 卡密类敏感串的通用校验：非空、长度有界、不含控制字符/空白折叠前的换行。 */
export function isValidSecretShape(value: unknown, maxLength = 256): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return false;
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f]/.test(trimmed);
}
