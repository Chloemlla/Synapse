import crypto from "node:crypto";
import { sanitizeCapEndpoint } from "./capEndpoint";
import { getCapKey, getCaptchaProviderSettingDocs, getHCaptchaKey, getTurnstileKey } from "./models";
import { getCaptchaQuotaSnapshots, type CaptchaQuotaSnapshot } from "./quota";
import { CAPTCHA_PROVIDER_IDS, type CaptchaProviderId } from "./types";

// 供应商调度配置的读写落在 models.ts，这里透出给门面（turnstileService）与控制器。
export { getCaptchaProviderSettingDocs, upsertCaptchaProviderSetting } from "./models";

export { CAPTCHA_PROVIDER_IDS };

/**
 * 人机验证供应商注册表 + 加权选择引擎。
 *
 * 设计要点（见 docs/plans/captcha-providers-trycap-2026-10-01.md）：
 * - 「上线/下线」「凭据是否配置」「本月额度是否用尽」三件事各自独立，任一不满足都不下发，
 *   并带可解释的 reason 暴露给管理端，而不是静默消失。
 * - 权重是相对值，选中概率 = w / Σw；全 0 时退化为等概率，避免整条链路被配置错误打死。
 * - 随机源可注入，便于单测断言分布与边界。
 */

export const CAPTCHA_PROVIDER_LABELS: Record<CaptchaProviderId, string> = {
  turnstile: "Cloudflare Turnstile",
  hcaptcha: "hCaptcha",
  trycap: "trycap (Cap)",
};

/** 新建供应商调度配置时的默认权重（进入面板即为可用的等概率初始态）。 */
export const DEFAULT_PROVIDER_WEIGHT = 50;
export const MIN_PROVIDER_WEIGHT = 0;
export const MAX_PROVIDER_WEIGHT = 1000;

export type ProviderSkipReason = "ok" | "scheduling_disabled" | "credentials_missing" | "quota_exhausted";

export interface CaptchaProviderSnapshot {
  provider: CaptchaProviderId;
  label: string;
  /** 调度开关（管理端「上线/下线」）。 */
  enabled: boolean;
  weight: number;
  /** 归一化后的展示概率，0-100，保留一位小数。 */
  percentage: number;
  siteKey: string | null;
  secretConfigured: boolean;
  credentialsConfigured: boolean;
  /** 真正会参与下发的判定（上线 && 凭据齐全 && 有 siteKey && 本月额度未用尽）。 */
  effective: boolean;
  reason: ProviderSkipReason;
  /** 本月额度：limit <= 0 表示不限额，remaining 为 -1。 */
  quota: CaptchaQuotaSnapshot;
  updatedAt?: string;
}

export interface CaptchaProviderCandidate {
  provider: CaptchaProviderId;
  siteKey: string;
  weight: number;
  apiEndpoint: string | null;
}

export interface CaptchaSelectionResult {
  provider: CaptchaProviderId;
  siteKey: string | null;
  apiEndpoint: string | null;
  enabled: boolean;
  reason: "weighted" | "single-available" | "no-candidates";
}

export function isCaptchaProviderId(value: unknown): value is CaptchaProviderId {
  return typeof value === "string" && (CAPTCHA_PROVIDER_IDS as readonly string[]).includes(value);
}

export function clampProviderWeight(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_PROVIDER_WEIGHT;
  return Math.min(MAX_PROVIDER_WEIGHT, Math.max(MIN_PROVIDER_WEIGHT, Math.round(parsed)));
}

/** 把权重换算成展示用百分比；全 0 时按等分显示。 */
export function normalizeWeightPercentages(weights: number[]): number[] {
  const safe = weights.map((weight) => (Number.isFinite(weight) && weight > 0 ? weight : 0));
  const total = safe.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) {
    if (safe.length === 0) return [];
    return safe.map(() => Math.round((100 / safe.length) * 10) / 10);
  }
  return safe.map((weight) => Math.round((weight / total) * 1000) / 10);
}

type RandomInt = (min: number, max: number) => number;

/**
 * 无偏加权抽取。权重全 0（或全为非法值）时退化为等概率，绝不返回 null 之外的意外结果。
 * 传 entries.length === 0 返回 null。
 */
export function pickWeightedProvider<T extends { weight: number }>(
  entries: readonly T[],
  randomInt: RandomInt = crypto.randomInt,
): T | null {
  if (entries.length === 0) return null;

  const total = entries.reduce(
    (sum, entry) => sum + (Number.isFinite(entry.weight) && entry.weight > 0 ? entry.weight : 0),
    0,
  );

  if (total <= 0) {
    const index = Math.min(entries.length - 1, Math.max(0, randomInt(0, entries.length)));
    return entries[index];
  }

  let ticket = Math.min(total - 1, Math.max(0, randomInt(0, total)));
  for (const entry of entries) {
    const weight = Number.isFinite(entry.weight) && entry.weight > 0 ? entry.weight : 0;
    if (ticket < weight) return entry;
    ticket -= weight;
  }

  return entries[entries.length - 1];
}

interface ProviderCredentials {
  siteKey: string | null;
  secretConfigured: boolean;
  apiEndpoint: string | null;
}

async function readProviderCredentials(provider: CaptchaProviderId): Promise<ProviderCredentials> {
  if (provider === "turnstile") {
    const [siteKey, secretKey] = await Promise.all([
      getTurnstileKey("TURNSTILE_SITE_KEY"),
      getTurnstileKey("TURNSTILE_SECRET_KEY"),
    ]);
    return { siteKey, secretConfigured: !!secretKey, apiEndpoint: null };
  }

  if (provider === "hcaptcha") {
    const [siteKey, secretKey] = await Promise.all([
      getHCaptchaKey("HCAPTCHA_SITE_KEY"),
      getHCaptchaKey("HCAPTCHA_SECRET_KEY"),
    ]);
    return { siteKey, secretConfigured: !!secretKey, apiEndpoint: null };
  }

  const [siteKey, secretKey, apiEndpoint] = await Promise.all([
    getCapKey("CAP_SITE_KEY"),
    getCapKey("CAP_SECRET_KEY"),
    getCapKey("CAP_API_ENDPOINT"),
  ]);
  return {
    siteKey,
    secretConfigured: !!secretKey,
    apiEndpoint: sanitizeCapEndpoint(apiEndpoint),
  };
}

/** 管理端展示用：只回「是否已设置」，绝不回明文 secret。 */
export async function getProviderSecretPresence(): Promise<Record<CaptchaProviderId, string | null>> {
  const entries = await Promise.all(
    CAPTCHA_PROVIDER_IDS.map(async (provider) => {
      const credential = await readProviderCredentials(provider);
      return [provider, credential.secretConfigured ? "***已设置***" : null] as const;
    }),
  );
  return Object.fromEntries(entries) as Record<CaptchaProviderId, string | null>;
}

/** 供应商的月度额度上限（0 = 不限额），由管理端设置覆盖默认值。 */
export async function getProviderQuotaLimits(): Promise<Record<CaptchaProviderId, number | null>> {
  const settingsDocs = await getCaptchaProviderSettingDocs();
  const settingsMap = new Map(settingsDocs.map((doc) => [doc.provider, doc]));
  return Object.fromEntries(
    CAPTCHA_PROVIDER_IDS.map((provider) => [provider, settingsMap.get(provider)?.monthlyQuota ?? null]),
  ) as Record<CaptchaProviderId, number | null>;
}

/**
 * 汇总三家供应商的完整状态（调度 + 凭据 + 本月额度），供管理端展示与选择使用。
 * 权重缺失时按 DEFAULT_PROVIDER_WEIGHT 参与计算，但不会写库（避免读接口产生副作用）。
 */
export async function collectCaptchaProviders(): Promise<{
  providers: CaptchaProviderSnapshot[];
  candidates: CaptchaProviderCandidate[];
}> {
  const settingsDocs = await getCaptchaProviderSettingDocs();
  const settingsMap = new Map(settingsDocs.map((doc) => [doc.provider, doc]));
  const quotaLimits = Object.fromEntries(
    CAPTCHA_PROVIDER_IDS.map((provider) => [provider, settingsMap.get(provider)?.monthlyQuota ?? null]),
  ) as Record<CaptchaProviderId, number | null>;

  const [credentials, quotaSnapshots] = await Promise.all([
    Promise.all(
      CAPTCHA_PROVIDER_IDS.map(async (provider) => [provider, await readProviderCredentials(provider)] as const),
    ),
    getCaptchaQuotaSnapshots(quotaLimits),
  ]);
  const credentialsMap = new Map(credentials);

  const rows = CAPTCHA_PROVIDER_IDS.map((provider) => {
    const setting = settingsMap.get(provider);
    const credential = credentialsMap.get(provider) ?? { siteKey: null, secretConfigured: false, apiEndpoint: null };
    const quota = quotaSnapshots[provider];
    const enabled = setting ? setting.enabled !== false : true;
    const weight = clampProviderWeight(setting?.weight ?? DEFAULT_PROVIDER_WEIGHT);
    const credentialsConfigured = !!credential.siteKey && credential.secretConfigured;
    const effective = enabled && credentialsConfigured && !quota.exhausted;
    const reason: ProviderSkipReason = quota.exhausted
      ? "quota_exhausted"
      : !enabled
        ? "scheduling_disabled"
        : credentialsConfigured
          ? "ok"
          : "credentials_missing";

    return { provider, enabled, weight, credential, quota, effective, reason, updatedAt: setting?.updatedAt };
  });

  const effectiveRows = rows.filter((row) => row.effective);
  const percentages = normalizeWeightPercentages(effectiveRows.map((row) => row.weight));

  const providers: CaptchaProviderSnapshot[] = rows.map((row) => {
    const index = effectiveRows.indexOf(row);
    return {
      provider: row.provider,
      label: CAPTCHA_PROVIDER_LABELS[row.provider],
      enabled: row.enabled,
      weight: row.weight,
      percentage: index >= 0 ? percentages[index] : 0,
      siteKey: row.credential.siteKey,
      secretConfigured: row.credential.secretConfigured,
      credentialsConfigured: !!row.credential.siteKey && row.credential.secretConfigured,
      effective: row.effective,
      reason: row.reason,
      quota: row.quota,
      updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : undefined,
    };
  });

  const candidates: CaptchaProviderCandidate[] = effectiveRows.map((row) => ({
    provider: row.provider,
    siteKey: row.credential.siteKey as string,
    weight: row.weight,
    apiEndpoint: row.credential.apiEndpoint,
  }));

  return { providers, candidates };
}

/**
 * 按权重选出本次要下发的供应商。
 * 无候选时沿用历史兜底（turnstile + enabled:false），让前端走「验证未启用」分支而不是崩掉。
 */
export async function selectCaptchaProvider(randomInt: RandomInt = crypto.randomInt): Promise<CaptchaSelectionResult> {
  const { candidates } = await collectCaptchaProviders();

  if (candidates.length === 0) {
    return { provider: "turnstile", siteKey: null, apiEndpoint: null, enabled: false, reason: "no-candidates" };
  }

  if (candidates.length === 1) {
    const only = candidates[0];
    return {
      provider: only.provider,
      siteKey: only.siteKey,
      apiEndpoint: only.apiEndpoint,
      enabled: true,
      reason: "single-available",
    };
  }

  const picked = pickWeightedProvider(candidates, randomInt);
  if (!picked) {
    return { provider: "turnstile", siteKey: null, apiEndpoint: null, enabled: false, reason: "no-candidates" };
  }

  return {
    provider: picked.provider,
    siteKey: picked.siteKey,
    apiEndpoint: picked.apiEndpoint,
    enabled: true,
    reason: "weighted",
  };
}
