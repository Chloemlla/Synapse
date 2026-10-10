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
import {
  FEATURE_CONSENT_KEYS,
  FEATURE_CONSENT_REQUIREMENTS,
  type FeatureConsentView,
  requiredAgreementsFor,
} from "../config/featureConsent";
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

/** 可选身份字段的归一：空串 / 纯空格一律当作「没传」，避免写出一条挂着空 userId 的记录。 */
function normalizeOptionalIdentity(value: unknown): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : undefined;
}

/** 把日期类值（Mongoose 的 Date、ISO 串，或测试替身里的字符串）安全转成 ISO。 */
function toIsoStringOrNull(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
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
// 带 userId 时记录同时归属于人：功能门禁按人判定（见 hasValidUserConsent），
// 因为指纹只回答「哪台设备」，回答不了「是哪位用户勾的」。
export async function writePolicyConsent(params: {
  fingerprint?: string | null;
  source: PolicyConsentSource;
  userAgent?: string;
  ipAddress?: string;
  /** 已登录时带上的账号身份；未登录保持 undefined，写出的是设备（指纹）级记录 */
  userId?: string;
  username?: string;
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
  const userId = normalizeOptionalIdentity(params.userId);
  const username = normalizeOptionalIdentity(params.username);

  try {
    // 续期查询必须用「同一个归属单位」：
    //  - 带 userId：只找这个用户自己的记录。若按指纹续期，同设备上换个账号会把上一位用户的
    //    记录改写成新用户的（他当即失去同意，而新用户也没真勾过——记录里却写着是他勾的）；
    //  - 不带 userId（未登录）：保持原来的指纹级语义，登录/注册/匿名门禁的写入行为不变。
    const existing = userId
      ? await PolicyConsent.findValidConsentForUser(userId, CURRENT_POLICY_VERSION)
      : await PolicyConsent.findValidConsent(fingerprint, CURRENT_POLICY_VERSION);
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
      // 只在知道「是谁在同意」时写归属：未登录续期把 userId 抹成 undefined 会让那位用户
      // 当场失去同意，而他什么都没做。指纹同样不动 —— 记录里那条是「同意时用的是哪台设备」。
      if (userId) {
        existing.userId = userId;
        existing.username = username;
      }
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
      userId,
      username,
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

/**
 * 用户级有效同意：**只认 userId 命中的有效记录**，且要求勾满全部四份文件。
 *
 * 故意不回落到指纹 —— 这是本方案的核心取舍：一旦用设备级记录兜底，就等于把
 * 「账号 A 同意、同设备上的账号 B 照样通行」重新引回来，而用户级门禁要挡住的正是这件事。
 * 历史只绑指纹的记录（本字段引入之前写的）一律视为未同意，由用户在自己的账号下重新勾一次补齐。
 *
 * 与设备级 hasValidPolicyConsent 的另一个差别：这里对「只勾了一部分」的记录只记日志、不回写
 * isValid=false。门禁是读路径，它不应该顺手改写别人的记录（设备级的改写是为了让管理端面板
 * 一眼筛出问题记录，那是那条路径已有的使命）。
 */
export async function hasValidUserConsent(userId: string, version = CURRENT_POLICY_VERSION): Promise<boolean> {
  const sanitizedUserId = normalizeOptionalIdentity(userId);
  if (!sanitizedUserId) {
    return false;
  }

  const consent = await PolicyConsent.findValidConsentForUser(sanitizedUserId, version);
  if (!consent) {
    return false;
  }

  if (!isCompleteAgreementSet(consent.agreements)) {
    logger.warn("[政策同意] 用户的同意记录未覆盖当前版本要求的全部文件，按需重新同意处理", {
      version,
      missing: missingAgreementKeys(consent.agreements),
    });
    return false;
  }

  return true;
}

/**
 * 每个功能一条状态（前端入口与页面门禁都用它）。
 *
 * 只查一次库：所有功能共用「这位用户的有效同意记录」这一个事实，缺什么文件在内存里按功能算。
 *
 * **刻意不加进程缓存**：撤销同意（POST /api/policy/revoke、管理端改写记录）必须立刻收回访问权，
 * 任何 TTL 缓存都会留下一个「已经撤销但还能用」的窗口 —— 而这个窗口恰好是用户行使撤回权时
 * 最想关掉的东西。代价是每个受保护请求多一次带索引查询（policy_consents 上的
 * { userId: 1, recordedAt: -1 }）；这些功能本身都是重操作（上传文件、跑 pandoc、调第三方），
 * 这次查询不构成瓶颈。
 */
export async function resolveFeatureConsentViews(
  userId: string,
  version = CURRENT_POLICY_VERSION,
): Promise<FeatureConsentView[]> {
  const sanitizedUserId = normalizeOptionalIdentity(userId);
  const consent = sanitizedUserId ? await PolicyConsent.findValidConsentForUser(sanitizedUserId, version) : null;

  // 未勾满的记录不算同意（与 hasValidUserConsent 同一口径）：
  // 「版本号对得上但只勾了一部分」的旧记录不能因为版本号相同就当成有效同意。
  const granted = new Set<string>(
    consent && isCompleteAgreementSet(consent.agreements) ? consent.agreements ?? [] : [],
  );
  const expiresAt = granted.size > 0 ? toIsoStringOrNull(consent?.expiresAt) : null;

  return FEATURE_CONSENT_KEYS.map((key) => {
    const requirement = FEATURE_CONSENT_REQUIREMENTS[key];
    const requiredAgreements = requiredAgreementsFor(key);
    const missingAgreements = requiredAgreements.filter((item) => !granted.has(item));
    return {
      key,
      label: requirement.label,
      category: requirement.category,
      rationale: requirement.rationale,
      message: requirement.message,
      satisfied: missingAgreements.length === 0,
      requiredAgreements,
      missingAgreements,
      policyVersion: version,
      expiresAt,
    };
  });
}

/**
 * 空实现：本方案没有缓存（见 resolveFeatureConsentViews），因此这里没有可重置的状态。
 * 保留这个导出是因为冻结接口 §4.3 预定了它 —— 将来若真的引入缓存，测试与调用点不必改签名。
 * 它就是「这里确实没有缓存」的可执行声明，而不是漏写的桩。
 */
export function __resetFeatureConsentCacheForTests(): void {}
