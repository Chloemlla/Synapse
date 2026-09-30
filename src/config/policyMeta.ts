/**
 * 政策元信息的单一来源：版本号、同意有效期、四份必读文件的键名与锚点。
 *
 * 这里刻意不 import 任何其他模块 —— `config/policyDocument.ts`（条文正文）与
 * `services/policyConsentService.ts`（同意记录）都要用它，而条文正文又被同意记录服务引用
 * （同意记录要落「条文指纹」）。元信息独立成叶节点后两边都只依赖它，
 * 既避免 `policyConsentService → policyDocument → policyConsentService` 的循环 import，
 * 也让版本号只有一个定义处。
 */

/** 当前条文版本；版本变化会让此前记录的同意不再覆盖新条文。 */
export const CURRENT_POLICY_VERSION = process.env.POLICY_VERSION?.trim() || "2.1";

const DEFAULT_CONSENT_VALIDITY_DAYS = 30;
const MIN_CONSENT_VALIDITY_DAYS = 1;
const MAX_CONSENT_VALIDITY_DAYS = 3650;

/**
 * 同意有效期来自环境变量，必须收敛到有限正整数：
 * `POLICY_CONSENT_VALIDITY_DAYS=abc` 会算出 `new Date(NaN)`，
 * 写库时 Mongoose 校验失败 → `POST /api/policy/verify` 恒 500（RECORD_FAILED），
 * cookie 的 maxAge 与 `expiresAt` TTL 索引也一起失去意义。
 * 非法值一律回落到默认 30 天，而不是把错误带进运行时。
 */
export function resolveConsentValidityDays(raw: unknown): number {
  const parsed = typeof raw === "number" ? raw : Number(typeof raw === "string" ? raw.trim() : raw);
  if (!Number.isFinite(parsed)) return DEFAULT_CONSENT_VALIDITY_DAYS;
  const days = Math.trunc(parsed);
  if (days < MIN_CONSENT_VALIDITY_DAYS || days > MAX_CONSENT_VALIDITY_DAYS) return DEFAULT_CONSENT_VALIDITY_DAYS;
  return days;
}

export const CONSENT_VALIDITY_DAYS = resolveConsentValidityDays(process.env.POLICY_CONSENT_VALIDITY_DAYS);

// 登录/注册必须逐项勾选的四份文件。键名同时是政策页锚点（policy-agreement-<key>）
// 与同意记录里 agreements 字段的取值，改键名等于让历史记录与新条文对不上。
export const POLICY_AGREEMENT_KEYS = ["terms", "usage", "specific-terms", "supported-regions"] as const;
export type PolicyAgreementKey = (typeof POLICY_AGREEMENT_KEYS)[number];
export const POLICY_AGREEMENT_ANCHOR_PREFIX = "policy-agreement-";

export function policyAgreementAnchor(key: string): string {
  return `${POLICY_AGREEMENT_ANCHOR_PREFIX}${key}`;
}

export function isPolicyAgreementKey(value: unknown): value is PolicyAgreementKey {
  return typeof value === "string" && (POLICY_AGREEMENT_KEYS as readonly string[]).includes(value);
}

/**
 * 一条同意记录是否覆盖当前版本要求的全部文件。
 * 早期记录（`agreements` 字段尚未引入）版本号可能等于当前版本却只勾了部分文件，
 * 这类记录不应再被当作有效同意 —— 见 hasValidPolicyConsent。
 */
export function isCompleteAgreementSet(agreements: readonly string[] | null | undefined): boolean {
  if (!Array.isArray(agreements)) return false;
  const seen = new Set(agreements.filter((item): item is string => typeof item === "string"));
  return POLICY_AGREEMENT_KEYS.every((key) => seen.has(key));
}

/** 记录里缺少（或多余）的勾选项，用于面板提示与排查。 */
export function missingAgreementKeys(agreements: readonly string[] | null | undefined): PolicyAgreementKey[] {
  const seen = new Set(Array.isArray(agreements) ? agreements : []);
  return POLICY_AGREEMENT_KEYS.filter((key) => !seen.has(key));
}

/**
 * 设备指纹在日志里的可读短标识：前 6 位 + 长度。
 * 指纹在本系统里就是设备凭据本体，日志只保留可定位性，不保留可回放性。
 */
export function describeFingerprintForLog(fingerprint: string | null | undefined): string {
  const trimmed = typeof fingerprint === "string" ? fingerprint.trim() : "";
  if (!trimmed) return "(empty)";
  return `${trimmed.slice(0, 6)}…(${trimmed.length})`;
}
