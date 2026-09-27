import crypto from "node:crypto";

/**
 * 统一密钥派生层（设计见 docs/design/aes-key-unification-2026-09-27.md）。
 *
 * 全后端内部签名/加密密钥都由**单一主密钥** `AES_KEY` 派生：
 *   masterIkm   = sha256(AES_KEY)
 *   subkey(lbl) = HKDF-SHA256(ikm=masterIkm, salt=HKDF_SALT, info=lbl, len=32)
 *
 * 这样运维只需维护一个 `AES_KEY`，同时各用途拿到相互独立的子密钥，避免跨算法裸复用同一份密钥。
 * 旧密钥（迁移前用别的 env 加密/签名的数据）通过 legacyRawSecrets / legacyDecryptKeys 汇聚成
 * 「仅解密 / 双接受」候选链，保证存量数据可读、存量客户端签名过渡期仍被接受。
 */

export const KL = {
  JWT: "jwt",
  REPLAY_SIGN: "replay-sign",
  PASSWORD_KEK: "password-kek",
  BILIBILI_CRED: "bilibili-cred",
  VERIFICATION_META: "verification-metadata",
  DATA_COLLECTION_RAW: "data-collection-raw",
  POLICY_SALT: "policy-salt",
  TTS_ASSET: "tts-asset",
  LEGACY_API_CHOICE: "legacy-api-choice",
  SMART_HUMAN_CHECK: "smart-human-check",
  PROXYCHECK_HMAC: "proxycheck-hmac",
  PROXYCHECK_PAYLOAD: "proxycheck-payload",
  SHORT_URL: "short-url-aes",
  // D-1 双接受：与客户端共享的 app-sign 密钥，签发用派生子密钥，校验同时接受旧值。
  NEXAI_SIGN: "nexai-app-sign",
  CDICT_SIGN: "cdict-app-sign",
  QQGUARD_SIGN: "qqguard-shared",
  LUMEN_SIGN: "lumen-request-sign",
} as const;

export type KeyLabel = (typeof KL)[keyof typeof KL];

/** HKDF salt 兼作域版本号：将来整体轮换派生方案时递增它即可与 v1 派生区分。 */
const HKDF_SALT = Buffer.from("synapse-key-v1", "utf8");

/**
 * 各标签对应的「旧命名 env」候选（优先级从高到低），用于向后兼容解密 / 签名双接受。
 * 只列 env 名；DB 运行时配置（runtime_config_settings）里的旧值由调用方（迁移 / 签名校验）
 * 另行叠加，见设计文档 §3.3。
 */
const LEGACY_ENV_NAMES: Partial<Record<KeyLabel, readonly string[]>> = {
  [KL.JWT]: ["JWT_SECRET"],
  [KL.REPLAY_SIGN]: ["SIGN_SECRET_KEY"],
  [KL.PASSWORD_KEK]: ["PASSWORD_ENCRYPTION_KEY", "AES_KEY", "JWT_SECRET"],
  [KL.BILIBILI_CRED]: ["BILIBILI_COOKIE_ENCRYPTION_KEY", "PASSWORD_ENCRYPTION_KEY", "AES_KEY", "JWT_SECRET"],
  [KL.VERIFICATION_META]: ["VERIFICATION_TOKEN_SECRET", "JWT_SECRET", "AES_KEY"],
  [KL.DATA_COLLECTION_RAW]: ["DATA_COLLECTION_RAW_SECRET"],
  [KL.POLICY_SALT]: ["POLICY_SECRET_SALT", "JWT_SECRET"],
  [KL.TTS_ASSET]: ["TTS_ASSET_ACCESS_SECRET", "JWT_SECRET"],
  [KL.LEGACY_API_CHOICE]: ["LEGACY_API_CHOICE_SECRET"],
  [KL.SMART_HUMAN_CHECK]: ["SMART_HUMAN_CHECK_SECRET"],
  [KL.PROXYCHECK_HMAC]: ["PROXYCHECK_HMAC_SECRET"],
  [KL.PROXYCHECK_PAYLOAD]: ["PROXYCHECK_PAYLOAD_VERIFICATION_KEY"],
  [KL.SHORT_URL]: ["AES_KEY"],
  [KL.NEXAI_SIGN]: ["NEXAI_APP_SIGN_SECRET", "NEXAI_APP_SIGN_SECRET_PREV"],
  [KL.CDICT_SIGN]: ["CDICT_APP_SIGN_SECRET", "CDICT_APP_SIGN_SECRET_PREV"],
  [KL.QQGUARD_SIGN]: ["QQ_GUARD_SHARED_SECRET", "QQ_GUARD_BOT_TOKEN"],
  [KL.LUMEN_SIGN]: ["LUMEN_REQUEST_SIGNING_SECRET"],
};

/**
 * 非生产/测试环境下 `AES_KEY` 缺失时的进程级临时源：进程内固定（保证派生确定性），
 * 进程重启即变。生产环境由 config.ts 的校验强制要求 `AES_KEY`，不会走到这里。
 */
const EPHEMERAL_SOURCE = crypto.randomBytes(32).toString("hex");

let cached: { source: string; ikm: Buffer } | null = null;

/** 惰性读取主密钥源：优先 AES_KEY；过渡期允许回退到旧 JWT_SECRET（避免存量部署因未配
 * AES_KEY 而启动失败）；都缺失时用进程级临时源兑底。尊重 admin/env 面板运行期覆盖。 */
function currentMasterSource(): string {
  return (process.env.AES_KEY || "").trim() || (process.env.JWT_SECRET || "").trim() || EPHEMERAL_SOURCE;
}

/** master 派生的输入密钥材料（IKM）= sha256(AES_KEY)。带进程内缓存，`AES_KEY` 变更时自动失效。 */
export function masterIkm(): Buffer {
  const source = currentMasterSource();
  if (cached && cached.source === source) return cached.ikm;
  const ikm = crypto.createHash("sha256").update(source).digest();
  cached = { source, ikm };
  return ikm;
}

/** 按用途派生 32 字节子密钥（AES-256-GCM 直接用；HMAC 亦可用作 key）。 */
export function deriveKey(label: KeyLabel): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", masterIkm(), HKDF_SALT, Buffer.from(label, "utf8"), 32));
}

/** 子密钥的小写 hex（供以字符串为密钥契约的签名点，如 JWT_SECRET 替代）。 */
export function deriveSecretHex(label: KeyLabel): string {
  return deriveKey(label).toString("hex");
}

/**
 * 旧密钥「原始字符串」候选（env 来源，去空去重），供签名双接受 / 短链导入兜底。
 * 不含新派生值——签名校验点应自行把 deriveSecretHex(label) 放在首位。
 */
export function legacyRawSecrets(label: KeyLabel): string[] {
  const names = LEGACY_ENV_NAMES[label] ?? [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const value = (process.env[name] || "").trim();
    if (value && !seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

/**
 * 静态加密解密候选密钥（32B sha256），新派生子密钥在前，其后是各旧命名 env 的 sha256，去重。
 * 迁移 / 解密时依次尝试（AES-GCM auth tag 判定命中）。DB 运行时配置里的旧值由调用方叠加。
 */
export function legacyDecryptKeys(label: KeyLabel): Buffer[] {
  const primary = deriveKey(label);
  const keys: Buffer[] = [primary];
  const seen = new Set<string>([primary.toString("hex")]);
  for (const raw of legacyRawSecrets(label)) {
    const derived = crypto.createHash("sha256").update(raw).digest();
    const fingerprint = derived.toString("hex");
    if (!seen.has(fingerprint)) {
      seen.add(fingerprint);
      keys.push(derived);
    }
  }
  return keys;
}

/** 把任意「原始字符串密钥」归一为 32B sha256（与 legacyDecryptKeys 同口径）。 */
export function hashSecretToKey(raw: string): Buffer {
  return crypto.createHash("sha256").update(raw).digest();
}

/** 测试 / AES_KEY 运行期变更后清缓存。 */
export function resetDerivationCacheForTest(): void {
  cached = null;
}
