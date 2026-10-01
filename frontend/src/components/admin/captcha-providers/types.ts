/**
 * /admin/captcha-providers 的接口类型（与后端 src/controllers/turnstile/allocationHandlers.ts、
 * providersHandlers.ts 的响应一一对应）。放在独立文件里，避免控制台壳与各页签互相 import 成环。
 */

export type ProviderId = 'turnstile' | 'hcaptcha' | 'trycap';
export type Scenario = 'default' | 'first_visit' | 'standalone';
export type Strategy = 'weighted' | 'round_robin' | 'failover';
export type WidgetTheme = 'auto' | 'light' | 'dark';
export type WidgetSize = 'normal' | 'compact' | 'flexible';
export type SkipReason = 'ok' | 'scheduling_disabled' | 'credentials_missing' | 'quota_exhausted';

export interface Option {
  value: string;
  label: string;
}

export interface QuotaSnapshot {
  monthKey: string;
  limit: number;
  used: number;
  /** -1 表示不限额 */
  remaining: number;
  percentage: number;
  exhausted: boolean;
  resetsAt: string;
  exhaustedAt?: string;
  lastUsedAt?: string;
}

export interface ProviderRow {
  provider: ProviderId;
  label: string;
  enabled: boolean;
  weight: number;
  percentage: number;
  priority: number;
  scenarioWeights: Partial<Record<Scenario, number>>;
  effectiveScenarioWeights: Record<Scenario, number>;
  siteKey: string | null;
  secretKey: string | null;
  secretConfigured: boolean;
  credentialsConfigured: boolean;
  effective: boolean;
  reason: SkipReason;
  quota: QuotaSnapshot;
  updatedAt?: string;
}

export interface AllocationPolicy {
  strategy: Strategy;
  rotationSeconds: number;
  stickyEnabled: boolean;
  stickyTtlMinutes: number;
  rolloutPercent: number;
  rolloutControlProvider: ProviderId;
  failoverMaxAttempts: number;
  scenarioStrategies: Partial<Record<Scenario, Strategy>>;
  updatedAt?: string;
}

export interface WidgetProviderOverride {
  theme?: WidgetTheme;
  size?: WidgetSize;
  language?: string;
}

export interface WidgetSettings {
  theme: WidgetTheme;
  size: WidgetSize;
  language: string;
  showProviderLabel: boolean;
  perProvider: Partial<Record<ProviderId, WidgetProviderOverride>>;
  updatedAt?: string;
}

/** 草稿里的场景权重：'' 表示沿用基础权重（不覆盖）。 */
export type ScenarioWeightDraft = ScenarioOverrideDraft | '';
export type ScenarioOverrideDraft = number;

export interface ProviderDraft {
  provider: ProviderId;
  enabled: boolean;
  weight: number;
  priority: number;
  monthlyQuota: number;
  scenarioWeights: Record<Scenario, ScenarioWeightDraft>;
}

export interface ProviderOverview {
  scenario: Scenario;
  providers: ProviderRow[];
  policy: AllocationPolicy;
  widgets: WidgetSettings;
  scenarios: Option[];
  strategies: Option[];
  defaults: { policy: AllocationPolicy; widgets: WidgetSettings };
  selection: { candidateCount: number; effectiveProviders: ProviderId[] };
}

export interface CandidatePlanRow {
  provider: ProviderId;
  label: string;
  weight: number;
  priority: number;
  percentage: number;
  siteKey: string;
  apiEndpoint: string | null;
}

export interface ResolvedAppearance {
  theme: WidgetTheme;
  size: WidgetSize;
  language: string;
  showProviderLabel: boolean;
}

export interface SelectionPreview {
  scenario: Scenario;
  strategy: Strategy;
  stickyEnabled: boolean;
  stickyTtlMinutes: number;
  rolloutPercent: number;
  rolloutControlProvider: ProviderId;
  failoverMaxAttempts: number;
  candidates: CandidatePlanRow[];
  excluded: ProviderId[];
  selection: {
    provider: ProviderId;
    label: string;
    reason: string;
    enabled: boolean;
    siteKey: string | null;
    apiEndpoint: string | null;
  };
  widget: ResolvedAppearance;
  forced: {
    provider: ProviderId;
    label: string;
    usable: boolean;
    reason: SkipReason;
    siteKey: string | null;
    apiEndpoint: string | null;
    widget: ResolvedAppearance;
  } | null;
}

export interface SimulationResult {
  scenario: Scenario;
  strategy: Strategy;
  draws: number;
  policy: AllocationPolicy;
  candidates: CandidatePlanRow[];
  distribution: Array<{ provider: ProviderId; count: number; percentage: number }>;
  notes: string[];
}

export interface QuotaHistoryEntry {
  provider: ProviderId;
  monthKey: string;
  count: number;
  exhaustedAt?: string;
  lastUsedAt?: string;
}

export interface QuotaHistoryResponse {
  months: number;
  history: QuotaHistoryEntry[];
  quotas: QuotaSnapshot[];
}

export interface ProviderStatRow {
  provider: ProviderId;
  total: number;
  success: number;
  failure: number;
  successRate: number | null;
  lastSeenAt: string | null;
}

export interface ProviderStatsResponse {
  hours: number;
  since: string;
  providers: ProviderStatRow[];
  totals: { total: number; success: number; failure: number; successRate: number | null };
}

export interface CapConfigState {
  siteKey: string | null;
  secretKey: string | null;
  apiEndpoint: string;
  enabled: boolean;
}

export type CapConfigKey = 'CAP_SITE_KEY' | 'CAP_SECRET_KEY' | 'CAP_API_ENDPOINT';

export interface ApiResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
}

export interface TabActions {
  canWrite: boolean;
  notify: (message: string, type: 'success' | 'error' | 'warning' | 'info') => void;
}

export const PROVIDER_ORDER: readonly ProviderId[] = ['turnstile', 'hcaptcha', 'trycap'];

export const REASON_TEXT: Record<SkipReason, string> = {
  ok: '正常参与下发',
  scheduling_disabled: '已下线：不参与下发',
  credentials_missing: '已上线但凭据不全：需补齐 Site Key 与 Secret Key',
  quota_exhausted: '本月额度已用尽：已自动停止下发，下月自动恢复',
};

export const STRATEGY_TEXT: Record<Strategy, string> = {
  weighted: '加权随机（按权重抽）',
  round_robin: '按时间轮换（无状态，跨实例一致）',
  failover: '优先级故障转移（固定主用，失败顺延）',
};

/** 与后端 allocation.ts 的钳制区间保持一致，前端只做即时反馈，最终以服务端为准。 */
export const LIMITS = {
  weight: { min: 0, max: 1000 },
  quota: { min: 0, max: 10_000_000 },
  priority: { min: 0, max: 100 },
  rotationSeconds: { min: 30, max: 86_400 },
  stickyTtlMinutes: { min: 5, max: 1_440 },
  rolloutPercent: { min: 0, max: 100 },
  failoverMaxAttempts: { min: 1, max: 3 },
} as const;

export const LANGUAGE_CHOICES: readonly Option[] = [
  { value: 'auto', label: '跟随浏览器' },
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁体中文' },
  { value: 'en', label: 'English' },
  { value: 'ja', label: '日本語' },
];

export function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function toDateText(value?: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

export function formatQuota(quota: QuotaSnapshot): string {
  if (quota.limit <= 0) return `本月已用 ${quota.used}（不限额度）`;
  return `本月已用 ${quota.used} / ${quota.limit}（剩余 ${Math.max(0, quota.remaining)}）`;
}
