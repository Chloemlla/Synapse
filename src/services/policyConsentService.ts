import crypto from "node:crypto";
import { PolicyConsent } from "../models/policyConsentModel";
import { KL, deriveSecretHex } from "../config/keyDerivation";
import { POLICY_DOCUMENT_HASH } from "../config/policyDocument";
import {
  CONSENT_VALIDITY_DAYS,
  CURRENT_POLICY_VERSION,
  POLICY_AGREEMENT_KEYS,
  type PolicyAgreementKey,
  isCompleteAgreementSet,
  missingAgreementKeys,
} from "../config/policyMeta";
import logger from "../utils/logger";
import { uuidv4 } from "../utils/uuid";

// 版本号 / 有效期 / 勾选清单的定义处是 config/policyMeta（叶节点模块），这里原样再导出，
// 让既有调用方（controllers / tests / tts pipeline）继续从本模块拿到同一份值。
// 2.1：条文实质扩充（数据保存期限、用户权利行使路径、Cookie 与本地存储、第三方与跨境、
// 自动化风控处置、条款变更机制）。版本号变化会让此前记录的同意不再覆盖新条文，
// 依赖同意的功能因此要求重新同意——这正是条文变更后应有的行为。
export {
  CONSENT_VALIDITY_DAYS,
  CURRENT_POLICY_VERSION,
  POLICY_AGREEMENT_ANCHOR_PREFIX,
  POLICY_AGREEMENT_KEYS,
  describeFingerprintForLog,
  isCompleteAgreementSet,
  isPolicyAgreementKey,
  missingAgreementKeys,
  policyAgreementAnchor,
  resolveConsentValidityDays,
} from "../config/policyMeta";
// 类型必须单独再导出一次：`export { type X } from` 不会在本地作用域引入 X，
// 而下面的 normalizeAuthPolicyConsent 需要它作为局部类型。
export type { PolicyAgreementKey };
// 原实现把盐硬编码在源码里，等于公开密钥。现优先用显式配置；缺失时统一从单一主密钥
// AES_KEY 派生（KL.POLICY_SALT），不再单独依赖 POLICY_SECRET_SALT / JWT_SECRET。
function resolveSecretSalt(): string {
  const configured = process.env.POLICY_SECRET_SALT?.trim();
  if (configured) return configured;
  return deriveSecretHex(KL.POLICY_SALT);
}

// 惰性解析盐：模块加载时定格会让 admin/env 面板运行期保存的 POLICY_SECRET_SALT 不生效，
// 改为每次签名时调用 resolveSecretSalt()（JWT_SECRET 派生回退不变）。
// 只做服务端签名：盐不下发，浏览器无从计算，因此这个值不能作为「客户端自证同意」的凭据，
// 只能作为库里那条记录未被外部改写的标记（见 writePolicyConsent）。
export function generatePolicyChecksum(consent: {
  timestamp: number;
  version: string;
  fingerprint: string;
}): string {
  const data = `${consent.timestamp}|${consent.version}|${consent.fingerprint}`;
  return crypto.createHmac("sha256", resolveSecretSalt()).update(data).digest("hex");
}

export function shouldRequireTtsPolicyConsent(): boolean {
  if (process.env.NODE_ENV === "test") {
    return false;
  }
  return process.env.TTS_REQUIRE_POLICY_CONSENT === "true";
}

// 登录/注册必须逐项勾选的四份文件。键名同时是政策页锚点（policy-agreement-<key>）
// 与同意记录里 agreements 字段的取值，改键名等于让历史记录与新条文对不上。
// （清单本体与类型定义在 config/policyMeta，此处不再重复声明。）

export type PolicyConsentSource = "login" | "register" | "feature";

export interface AuthPolicyConsent {
  accepted: true;
  agreements: PolicyAgreementKey[];
}

export const POLICY_CONSENT_REQUIRED_MESSAGE =
  "请先阅读并勾选同意服务条款、使用政策、服务专项条款与支持地区";

// 校验登录/注册提交的同意载荷：必须显式 accepted:true，且四项一个不少、不重复、无未知项。
// 返回 null 表示无效，调用方据此拒绝请求——只勾前两项就提交的客户端不能靠字段漏传混过去。
export function normalizeAuthPolicyConsent(input: unknown): AuthPolicyConsent | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const raw = input as { accepted?: unknown; agreements?: unknown };
  if (raw.accepted !== true || !Array.isArray(raw.agreements)) {
    return null;
  }
  const seen = new Set<string>();
  for (const item of raw.agreements) {
    if (typeof item !== "string" || !POLICY_AGREEMENT_KEYS.includes(item as PolicyAgreementKey)) {
      return null;
    }
    if (seen.has(item)) {
      return null;
    }
    seen.add(item);
  }
  if (seen.size !== POLICY_AGREEMENT_KEYS.length) {
    return null;
  }
  return { accepted: true, agreements: [...POLICY_AGREEMENT_KEYS] };
}

// 与 TTS_REQUIRE_POLICY_CONSENT 同样的取舍：测试环境关闭，否则既有登录/注册用例
// 全部要改造成携带同意载荷；生产默认开启，可用 AUTH_REQUIRE_POLICY_CONSENT=false 关闭。
export function shouldRequireAuthPolicyConsent(): boolean {
  if (process.env.NODE_ENV === "test") {
    return false;
  }
  const configured = process.env.AUTH_REQUIRE_POLICY_CONSENT?.trim().toLowerCase();
  if (configured === "false") {
    return false;
  }
  if (configured === "true") {
    return true;
  }
  return process.env.NODE_ENV === "production";
}

// 同意记录的指纹取值顺序与 tts.controller 一致：请求头优先（前端拦截器在启用首访验证时
// 统一注入 X-Fingerprint），其次请求体；拿不到有效的设备标识时返回 null，由调用方决定怎么办。
export function resolveRequestFingerprint(req: {
  headers?: Record<string, unknown>;
  body?: unknown;
}): string | null {
  const header = req.headers?.["x-fingerprint"];
  const body = (req.body as { fingerprint?: unknown } | undefined)?.fingerprint;
  const value = typeof header === "string" && header.trim() ? header : typeof body === "string" ? body : "";
  const trimmed = value.trim();
  return trimmed && trimmed !== "unknown" ? trimmed : null;
}

// 唯一的同意记录写入路径：登录、注册，以及显式同意端点（POST /api/policy/verify，
// 供 TTS 这类「先同意再使用」的功能门禁调用）。
// checksum 由服务端签名，客户端无法自行伪造；记录归属于调用方已证明归属的指纹。
// documentHash 记录同意时的条文指纹，使「这条同意对应哪份文本」事后可证。
// 同一指纹+版本已有有效记录时原地续期，避免 unique id 冲突与记录堆积。
// 指纹缺失（客户端拿不到设备信息）时不写库，只记日志：登录环节不能因为
// 指纹采集失败而把已有账户挡在门外，注册环节的指纹是硬要求（缺失已在更早处拒绝）。
export async function writePolicyConsent(params: {
  fingerprint?: string | null;
  source: PolicyConsentSource;
  userAgent?: string;
  ipAddress?: string;
}): Promise<{ id: string; expiresAt: Date } | null> {
  const fingerprint = typeof params.fingerprint === "string" ? params.fingerprint.trim() : "";
  if (!fingerprint || fingerprint === "unknown") {
    logger.warn("[政策同意] 缺少可用设备指纹，未写入同意记录", { source: params.source });
    return null;
  }

  const timestamp = Date.now();
  const expiresAt = new Date(timestamp + CONSENT_VALIDITY_DAYS * 24 * 60 * 60 * 1000);
  const checksum = generatePolicyChecksum({ timestamp, version: CURRENT_POLICY_VERSION, fingerprint });
  const userAgent = typeof params.userAgent === "string" ? params.userAgent.substring(0, 500) : undefined;
  const agreements = [...POLICY_AGREEMENT_KEYS];

  try {
    const existing = await PolicyConsent.findValidConsent(fingerprint, CURRENT_POLICY_VERSION);
    if (existing) {
      existing.timestamp = timestamp;
      existing.checksum = checksum;
      existing.source = params.source;
      existing.agreements = agreements;
      existing.userAgent = userAgent;
      existing.ipAddress = params.ipAddress;
      existing.recordedAt = new Date(timestamp);
      existing.expiresAt = expiresAt;
      existing.documentHash = POLICY_DOCUMENT_HASH;
      existing.revokedAt = undefined;
      existing.revokedIP = undefined;
      existing.revokedReason = undefined;
      await existing.save();
      return { id: existing.id, expiresAt };
    }

    const consent = new PolicyConsent({
      id: uuidv4(),
      timestamp,
      version: CURRENT_POLICY_VERSION,
      fingerprint,
      checksum,
      userAgent,
      ipAddress: params.ipAddress,
      source: params.source,
      agreements,
      documentHash: POLICY_DOCUMENT_HASH,
      // 与 timestamp 同源写出，而不是依赖 schema 的 default：
      // 趋势统计与管理端排序都读 recordedAt，显式赋值才能保证两侧一致（续期分支也是这么写的）。
      recordedAt: new Date(timestamp),
      expiresAt,
    });
    await consent.save();
    return { id: consent.id, expiresAt };
  } catch (error) {
    logger.warn("[政策同意] 写入同意记录失败", { source: params.source, error: String(error) });
    return null;
  }
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

  // findValidConsent 已经带 isValid:true 与 expiresAt > now 过滤（因此原先那句 isExpired 是死代码）。
  // 这里补的是另一件事：记录必须覆盖当前版本要求的全部文件 —— agreements 字段引入之前写下的
  // 记录版本号可能已经是当前版本，却没有勾满四份文件，放行它们等于让门禁认可一次不存在的勾选。
  if (!isCompleteAgreementSet(consent.agreements)) {
    logger.warn("[政策同意] 记录未覆盖当前版本要求的全部文件，按需重新同意处理", {
      version,
      missing: missingAgreementKeys(consent.agreements),
    });
    consent.isValid = false;
    consent.revokedReason = "incomplete-agreements";
    await consent.save();
    return false;
  }

  return true;
}
