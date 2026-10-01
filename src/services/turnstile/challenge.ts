import { normalizeCaptchaProviderId, type CaptchaProviderId } from "./types";

/**
 * 请求侧的挑战载荷：**所有前后端页面共用这一套字段名**（见 docs/plans/captcha-page-takeover-2026-10-01.md）。
 *
 * 令牌字段按历史顺序回退，保证老客户端（只发 cfToken / turnstileToken）无需改动；
 * 供应商字段刻意**不含裸 `provider`**：TTS 请求体里的 `provider` 表示 TTS 提供商，含义冲突。
 */
const TOKEN_FIELDS = ["captchaToken", "cfToken", "turnstileToken", "hcaptchaToken", "capToken"] as const;
/** 只有「独立验证页 / Cloudflare 挑战页」这类验收端点的历史载荷用裸 `token`。 */
const GENERIC_TOKEN_FIELD = "token";
const PROVIDER_FIELDS = ["captchaProvider", "captchaType"] as const;

export interface CaptchaChallengeInput {
  /** 挑战令牌；缺失时为空串（调用方据此回「请先完成人机验证」）。 */
  token: string;
  /** 归一化后的供应商；缺失/非法时回落 turnstile。 */
  provider: CaptchaProviderId;
  /** 客户端是否显式声明了供应商（用于诊断日志，判定「老客户端」）。 */
  providerDeclared: boolean;
}

function readFirstString(source: Record<string, unknown>, fields: readonly string[]): string {
  for (const field of fields) {
    const value = source[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

function readFirstProvider(source: Record<string, unknown>): { provider: unknown; declared: boolean } {
  for (const field of PROVIDER_FIELDS) {
    const value = source[field];
    if (typeof value === "string" && value.length > 0) return { provider: value, declared: true };
    // 显式声明了字段但值非法（例如空串之外的非字符串）时也记为「已声明」，
    // 便于诊断；归一化仍会回落到 turnstile。
    if (value !== undefined && value !== null) return { provider: value, declared: true };
  }
  return { provider: undefined, declared: false };
}

/** 从任意请求体（JSON body / multipart 字段）里读出挑战令牌与供应商。 */
export function readCaptchaChallenge(
  source: unknown,
  options: { genericToken?: boolean } = {},
): CaptchaChallengeInput {
  const record: Record<string, unknown> =
    source && typeof source === "object" ? (source as Record<string, unknown>) : {};
  const { provider, declared } = readFirstProvider(record);
  const tokenFields = options.genericToken ? [...TOKEN_FIELDS, GENERIC_TOKEN_FIELD] : TOKEN_FIELDS;
  return {
    token: readFirstString(record, tokenFields),
    provider: normalizeCaptchaProviderId(provider),
    providerDeclared: declared,
  };
}

/** 只要令牌（不需要供应商时用，例如仅做存在性判断）。 */
export function readCaptchaToken(source: unknown, options: { genericToken?: boolean } = {}): string {
  return readCaptchaChallenge(source, options).token;
}
