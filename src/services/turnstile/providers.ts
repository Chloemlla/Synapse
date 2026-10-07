import crypto from "node:crypto";
import {
  DEFAULT_PROVIDER_PRIORITY,
  DEFAULT_PROVIDER_WEIGHT,
  MAX_PROVIDER_WEIGHT,
  MIN_PROVIDER_WEIGHT,
  chooseCandidate,
  clampProviderPriority,
  clampProviderWeight,
  normalizeAllocationPolicy,
  normalizeScenarioWeights,
  normalizeWeightPercentages,
  normalizeWidgetSettings,
  pickWeightedProvider,
  resolveScenarioStrategy,
  resolveWidgetSettings,
  type CaptchaAllocationPolicyView,
  type CaptchaWidgetSettingsView,
  type ResolvedWidgetSettings,
} from "./allocation";
import { sanitizeCapEndpoint } from "./capEndpoint";
import {
  getCapKey,
  getCaptchaAllocationPolicyDoc,
  getCaptchaProviderSettingDocs,
  getCaptchaWidgetSettingsDoc,
  getHCaptchaKey,
  getTurnstileKey,
  upsertCaptchaAllocationPolicy,
  upsertCaptchaWidgetSettings,
} from "./models";
import { getCaptchaQuotaSnapshots, type CaptchaQuotaSnapshot } from "./quota";
import {
  CAPTCHA_PROVIDER_IDS,
  CAPTCHA_SCENARIOS,
  type CaptchaAllocationStrategy,
  type CaptchaProviderId,
  type CaptchaScenario,
} from "./types";

// 供应商调度配置的读写落在 models.ts，这里透出给门面（turnstileService）与控制器。
export { getCaptchaProviderSettingDocs, upsertCaptchaProviderSetting } from "./models";

export { CAPTCHA_PROVIDER_IDS };
export {
  DEFAULT_PROVIDER_PRIORITY,
  DEFAULT_PROVIDER_WEIGHT,
  MAX_PROVIDER_WEIGHT,
  MIN_PROVIDER_WEIGHT,
  clampProviderPriority,
  clampProviderWeight,
  normalizeWeightPercentages,
  pickWeightedProvider,
};

/**
 * 人机验证供应商注册表 + 分配体系入口。
 *
 * 设计要点（见 docs/plans/captcha-providers-trycap-2026-10-01.md 与
 * docs/plans/captcha-allocation-console-2026-10-01.md）：
 * - 「上线/下线」「凭据是否配置」「本月额度是否用尽」三件事各自独立，任一不满足都不下发，
 *   并带可解释的 reason 暴露给管理端，而不是静默消失。
 * - 权重是相对值，选中概率 = w / Σw；全 0 时退化为等概率，避免整条链路被配置错误打死。
 * - 权重可按场景覆盖（default / first_visit / standalone）；策略、优先级、粘性、灰度都在 allocation.ts。
 * - 随机源可注入，便于单测断言分布与边界。
 */

export const CAPTCHA_PROVIDER_LABELS: Record<CaptchaProviderId, string> = {
  turnstile: "Cloudflare Turnstile",
  hcaptcha: "hCaptcha",
  trycap: "trycap (Cap)",
};

export type ProviderSkipReason = "ok" | "scheduling_disabled" | "credentials_missing" | "quota_exhausted";

export interface CaptchaProviderSnapshot {
  provider: CaptchaProviderId;
  label: string;
  /** 调度开关（管理端「上线/下线」）。 */
  enabled: boolean;
  weight: number;
  /** 归一化后的展示概率，0-100，保留一位小数（按传入场景的权重算）。 */
  percentage: number;
  /** 故障转移顺序：数值小的优先。 */
  priority: number;
  /** 按场景覆盖的权重（原样回显，便于管理端编辑）。 */
  scenarioWeights: Partial<Record<CaptchaScenario, number>>;
  /** 各场景实际生效权重（含回落基础权重）。 */
  effectiveScenarioWeights: Record<CaptchaScenario, number>;
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
  priority: number;
  apiEndpoint: string | null;
}

export type CaptchaSelectionReason =
  | "weighted"
  | "single-available"
  | "no-candidates"
  | "sticky"
  | "round_robin"
  | "failover"
  | "rollout_control";

export interface CaptchaSelectionResult {
  provider: CaptchaProviderId;
  siteKey: string | null;
  apiEndpoint: string | null;
  enabled: boolean;
  reason: CaptchaSelectionReason;
  scenario: CaptchaScenario;
  strategy: CaptchaAllocationStrategy;
}

export interface CaptchaSelectOptions {
  scenario?: CaptchaScenario;
  exclude?: readonly CaptchaProviderId[];
  fingerprint?: string;
  nowMs?: number;
}

export function isCaptchaProviderId(value: unknown): value is CaptchaProviderId {
  return typeof value === "string" && (CAPTCHA_PROVIDER_IDS as readonly string[]).includes(value);
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

/** 全局分配策略（含默认值补齐），供选择引擎与管理端读取。 */
export async function getCaptchaAllocationPolicy(): Promise<CaptchaAllocationPolicyView> {
  const doc = await getCaptchaAllocationPolicyDoc();
  return normalizeAllocationPolicy(doc);
}

/** 前端控件外观设置（含默认值补齐）。 */
export async function getCaptchaWidgetSettings(): Promise<CaptchaWidgetSettingsView> {
  const doc = await getCaptchaWidgetSettingsDoc();
  return normalizeWidgetSettings(doc);
}

export function resolveProviderWidgetSettings(
  settings: CaptchaWidgetSettingsView,
  provider: CaptchaProviderId | null,
): ResolvedWidgetSettings {
  return resolveWidgetSettings(settings, provider);
}

/** 写入全局分配策略（仅接受已归一化的字段）；返回归一化后的最新值，失败返回 null。 */
export async function updateCaptchaAllocationPolicy(
  patch: Partial<Omit<CaptchaAllocationPolicyView, "updatedAt">>,
): Promise<CaptchaAllocationPolicyView | null> {
  const updated = await upsertCaptchaAllocationPolicy(patch);
  if (!updated) {
    // 未落库（数据库不可用）时也回一份归一化视图，方便控制器区分“参数非法”与“存储失败”。
    return null;
  }
  return normalizeAllocationPolicy(updated);
}

/** 写入控件外观设置；perProvider 按整表覆盖（缺项即视为回落全局）。 */
export async function updateCaptchaWidgetSettings(
  patch: Partial<Omit<CaptchaWidgetSettingsView, "updatedAt">>,
): Promise<CaptchaWidgetSettingsView | null> {
  const updated = await upsertCaptchaWidgetSettings(patch);
  if (!updated) return null;
  return normalizeWidgetSettings(updated);
}

/**
 * 汇总三家供应商的完整状态（调度 + 凭据 + 本月额度 + 场景权重），供管理端展示与选择使用。
 * 权重缺失时按 DEFAULT_PROVIDER_WEIGHT 参与计算，但不会写库（避免读接口产生副作用）。
 */
export async function collectCaptchaProviders(options: { scenario?: CaptchaScenario } = {}): Promise<{
  providers: CaptchaProviderSnapshot[];
  candidates: CaptchaProviderCandidate[];
  policy: CaptchaAllocationPolicyView;
  widgets: CaptchaWidgetSettingsView;
  scenario: CaptchaScenario;
}> {
  const scenario = options.scenario ?? "default";

  const [settingsDocs, policy, widgets] = await Promise.all([
    getCaptchaProviderSettingDocs(),
    getCaptchaAllocationPolicy(),
    getCaptchaWidgetSettings(),
  ]);

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
    const scenarioWeights = setting?.scenarioWeights ?? {};
    const effectiveScenarioWeights = Object.fromEntries(
      CAPTCHA_SCENARIOS.map((entry) => [entry, scenarioWeights[entry] ?? weight]),
    ) as Record<CaptchaScenario, number>;
    const credentialsConfigured = !!credential.siteKey && credential.secretConfigured;
    const effective = enabled && credentialsConfigured && !quota.exhausted;
    const reason: ProviderSkipReason = quota.exhausted
      ? "quota_exhausted"
      : !enabled
        ? "scheduling_disabled"
        : credentialsConfigured
          ? "ok"
          : "credentials_missing";

    return {
      provider,
      enabled,
      weight,
      priority: clampProviderPriority(setting?.priority ?? DEFAULT_PROVIDER_PRIORITY),
      scenarioWeights,
      effectiveScenarioWeights,
      credential,
      quota,
      effective,
      reason,
      updatedAt: setting?.updatedAt,
    };
  });

  const effectiveRows = rows.filter((row) => row.effective);
  const effectiveWeights = effectiveRows.map((row) => row.effectiveScenarioWeights[scenario]);
  const percentages = normalizeWeightPercentages(effectiveWeights);

  const providers: CaptchaProviderSnapshot[] = rows.map((row) => {
    const index = effectiveRows.indexOf(row);
    return {
      provider: row.provider,
      label: CAPTCHA_PROVIDER_LABELS[row.provider],
      enabled: row.enabled,
      weight: row.weight,
      percentage: index >= 0 ? percentages[index] : 0,
      priority: row.priority,
      scenarioWeights: row.scenarioWeights,
      effectiveScenarioWeights: row.effectiveScenarioWeights,
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
    weight: row.effectiveScenarioWeights[scenario],
    priority: row.priority,
    apiEndpoint: row.credential.apiEndpoint,
  }));

  return { providers, candidates, policy, widgets, scenario };
}

export interface CaptchaProviderDraftInput {
  provider: CaptchaProviderId;
  enabled?: boolean;
  weight?: number;
  priority?: number;
  /** null = 清掉该家的场景覆盖（回落基础权重）。 */
  scenarioWeights?: Partial<Record<CaptchaScenario, number>> | null;
}

/** 管理端展示/模拟用：把候选列表补上标签与归一化百分比。 */
export interface CaptchaCandidatePlanRow extends CaptchaProviderCandidate {
  label: string;
  percentage: number;
}

export function describeCandidates(candidates: readonly CaptchaProviderCandidate[]): CaptchaCandidatePlanRow[] {
  const percentages = normalizeWeightPercentages(candidates.map((candidate) => candidate.weight));
  return candidates.map((candidate, index) => ({
    ...candidate,
    label: CAPTCHA_PROVIDER_LABELS[candidate.provider],
    percentage: percentages[index] ?? 0,
  }));
}

/**
 * 把管理端草稿（尚未保存的上线/权重/优先级/场景权重）套到当前快照上，算出模拟用的候选集。
 * 凭据是否齐全与本月额度是否用尽仍取实际状态 —— 模拟只回答「按这份草稿会怎么分配」。
 */
export function buildDraftCandidates(
  providers: readonly CaptchaProviderSnapshot[],
  baseCandidates: readonly CaptchaProviderCandidate[],
  drafts: readonly CaptchaProviderDraftInput[],
  scenario: CaptchaScenario,
): CaptchaProviderCandidate[] {
  const draftMap = new Map<CaptchaProviderId, CaptchaProviderDraftInput>();
  for (const draft of drafts) {
    if (isCaptchaProviderId(draft.provider) && !draftMap.has(draft.provider)) draftMap.set(draft.provider, draft);
  }
  const baseMap = new Map(baseCandidates.map((candidate) => [candidate.provider, candidate]));

  const rows: CaptchaProviderCandidate[] = [];
  for (const row of providers) {
    if (!row.credentialsConfigured || row.quota.exhausted) continue;
    const draft = draftMap.get(row.provider);
    const enabled = draft?.enabled ?? row.enabled;
    if (!enabled) continue;

    const weight = draft?.weight !== undefined ? clampProviderWeight(draft.weight) : row.weight;
    const scenarioOverrides =
      draft?.scenarioWeights === undefined
        ? row.scenarioWeights
        : (normalizeScenarioWeights(draft.scenarioWeights) ?? {});
    const priority = draft?.priority !== undefined ? clampProviderPriority(draft.priority) : row.priority;
    const base = baseMap.get(row.provider);

    rows.push({
      provider: row.provider,
      siteKey: base?.siteKey ?? row.siteKey ?? "",
      weight: scenarioOverrides[scenario] ?? weight,
      priority,
      apiEndpoint: base?.apiEndpoint ?? null,
    });
  }
  return rows;
}

/**
 * 按分配策略选出本次要下发的供应商。
 * 无候选时沿用历史兜底（turnstile + enabled:false），让前端走「验证未启用」分支而不是崩掉。
 */
export async function selectCaptchaProvider(
  randomInt: (min: number, max: number) => number = crypto.randomInt,
  options: CaptchaSelectOptions = {},
): Promise<CaptchaSelectionResult> {
  const scenario = options.scenario ?? "default";
  const { candidates, policy } = await collectCaptchaProviders({ scenario });
  const strategy = resolveScenarioStrategy(policy, scenario);
  const excluded = options.exclude ?? [];
  const pool = candidates.filter((candidate) => !excluded.includes(candidate.provider));

  const noCandidates: CaptchaSelectionResult = {
    provider: "turnstile",
    siteKey: null,
    apiEndpoint: null,
    enabled: false,
    reason: "no-candidates",
    scenario,
    strategy,
  };

  if (pool.length === 0) return noCandidates;

  if (pool.length === 1) {
    const only = pool[0];
    return {
      provider: only.provider,
      siteKey: only.siteKey,
      apiEndpoint: only.apiEndpoint,
      enabled: true,
      reason: "single-available",
      scenario,
      strategy,
    };
  }

  const { candidate, rolloutControl, sticky } = chooseCandidate(pool, policy, {
    scenario,
    fingerprint: options.fingerprint,
    nowMs: options.nowMs ?? Date.now(),
    randomInt,
  });

  if (!candidate) return noCandidates;

  const reason: CaptchaSelectionReason = rolloutControl
    ? "rollout_control"
    : sticky
      ? "sticky"
      : strategy === "round_robin"
        ? "round_robin"
        : strategy === "failover"
          ? "failover"
          : "weighted";

  return {
    provider: candidate.provider,
    siteKey: candidate.siteKey,
    apiEndpoint: candidate.apiEndpoint,
    enabled: true,
    reason,
    scenario,
    strategy,
  };
}

/**
 * 请求侧闸门：后台页面（登录/注册/忘记密码/TTS/图床/抽奖/CDK…）共用同一个判据。
 *
 * - `required` = 三家供应商里有任一家**真正可下发**（已上线 + 凭据齐 + 本月额度未用尽）。
 *   三家都不可用时为 false，与历史「Turnstile 开关关闭即放行」等价。
 * - `enabledProviders` 用于诊断和重新分配挑战，不能作为客户端跳过验证的依据。
 *
 * 注意这里与场景无关：请求到达时只关心「现在到底有没有一家人机验证可用」。
 */
export interface CaptchaRequestPolicy {
  required: boolean;
  enabledProviders: CaptchaProviderId[];
}

export async function getCaptchaRequestPolicy(): Promise<CaptchaRequestPolicy> {
  const { providers } = await collectCaptchaProviders();
  const enabledProviders = providers.filter((row) => row.effective).map((row) => row.provider);
  return { required: enabledProviders.length > 0, enabledProviders };
}
