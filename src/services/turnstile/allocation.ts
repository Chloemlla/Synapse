import crypto from "node:crypto";
import {
  CAPTCHA_ALLOCATION_STRATEGIES,
  CAPTCHA_PROVIDER_IDS,
  CAPTCHA_SCENARIOS,
  type CaptchaAllocationPolicyDoc,
  type CaptchaAllocationStrategy,
  type CaptchaProviderId,
  type CaptchaScenario,
  type CaptchaWidgetProviderOverride,
  type CaptchaWidgetSettingsDoc,
  type CaptchaWidgetSize,
  type CaptchaWidgetTheme,
} from "./types";

/**
 * 供应商分配体系的**纯函数**内核：归一化、加权区间、粘性哈希、时间轮换、优先级故障转移、灰度。
 *
 * 约束（见 docs/plans/captcha-allocation-console-2026-10-01.md R2）：
 * 除 `weighted` 用注入的随机源外，其余策略都必须是**确定性**的 —— 粘性/轮换/灰度只看
 * 指纹与时间，因此多实例部署下同一用户在窗口内必然得到同一家，不需要共享状态。
 */

export const DEFAULT_PROVIDER_WEIGHT = 50;
export const MIN_PROVIDER_WEIGHT = 0;
export const MAX_PROVIDER_WEIGHT = 1000;
/** 故障转移顺序：数值小的优先。 */
export const DEFAULT_PROVIDER_PRIORITY = 50;
export const MIN_PROVIDER_PRIORITY = 0;
export const MAX_PROVIDER_PRIORITY = 100;

export const MIN_ROTATION_SECONDS = 30;
export const MAX_ROTATION_SECONDS = 86_400;
export const MIN_STICKY_TTL_MINUTES = 5;
export const MAX_STICKY_TTL_MINUTES = 1_440;
export const MIN_FAILOVER_ATTEMPTS = 1;
export const MAX_FAILOVER_ATTEMPTS = 3;

export interface CaptchaAllocationPolicyView {
  strategy: CaptchaAllocationStrategy;
  rotationSeconds: number;
  stickyEnabled: boolean;
  stickyTtlMinutes: number;
  /** 0 = 关闭灰度；100 = 全量走策略。 */
  rolloutPercent: number;
  rolloutControlProvider: CaptchaProviderId;
  failoverMaxAttempts: number;
  scenarioStrategies: Partial<Record<CaptchaScenario, CaptchaAllocationStrategy>>;
  /** 每场景的供应商白名单（RC-24）。未设置的场景不受约束。 */
  scenarioProviderAllowlist: Partial<Record<CaptchaScenario, CaptchaProviderId[]>>;
  updatedAt?: string;
}

/**
 * 归一化入参：既接受落库文档（updatedAt 是 Date），也接受已归一化过的视图（updatedAt 是 ISO 字符串）——
 * 调用点会把「当前策略」与「草稿补丁」叠加后一起传来。
 */
export type CaptchaAllocationPolicyInput = Partial<Omit<CaptchaAllocationPolicyDoc, "updatedAt">> & {
  updatedAt?: Date | string;
};

/** 统一把 Date / ISO 字符串 / 无效值收敛成 ISO 字符串或 undefined。 */
function toIsoOrUndefined(value: unknown): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export interface CaptchaWidgetSettingsView {
  theme: CaptchaWidgetTheme;
  size: CaptchaWidgetSize;
  language: string;
  showProviderLabel: boolean;
  perProvider: Partial<Record<CaptchaProviderId, CaptchaWidgetProviderOverride>>;
  updatedAt?: string;
}

export type CaptchaWidgetSettingsInput = Partial<Omit<CaptchaWidgetSettingsDoc, "updatedAt">> & {
  updatedAt?: Date | string;
};

export interface ResolvedWidgetSettings {
  theme: CaptchaWidgetTheme;
  size: CaptchaWidgetSize;
  language: string;
  showProviderLabel: boolean;
}

export const DEFAULT_ALLOCATION_POLICY: CaptchaAllocationPolicyView = {
  strategy: "weighted",
  rotationSeconds: 300,
  stickyEnabled: false,
  stickyTtlMinutes: 30,
  rolloutPercent: 0,
  rolloutControlProvider: "turnstile",
  failoverMaxAttempts: 2,
  scenarioStrategies: {},
  // RC-24 / D12：被标记账户的逐步验证**恒等于**这两家（自托管 Cap + Turnstile），
  // 不允许 hCaptcha 后备 —— 白名单外零候选（耗尽时 fail_closed，见 providers.ts）。
  scenarioProviderAllowlist: { step_up: ["trycap", "turnstile"] },
};

export const DEFAULT_WIDGET_SETTINGS: CaptchaWidgetSettingsView = {
  theme: "auto",
  size: "normal",
  language: "auto",
  showProviderLabel: true,
  perProvider: {},
};

const WIDGET_THEMES: readonly CaptchaWidgetTheme[] = ["auto", "light", "dark"];
const WIDGET_SIZES: readonly CaptchaWidgetSize[] = ["normal", "compact", "flexible"];
/** BCP-47 粗校验：`auto` 或 `zh-CN` 这类 2–3 字母主标签 + 可选子标签。 */
const LANGUAGE_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export function isCaptchaScenario(value: unknown): value is CaptchaScenario {
  return typeof value === "string" && (CAPTCHA_SCENARIOS as readonly string[]).includes(value);
}

export function isCaptchaAllocationStrategy(value: unknown): value is CaptchaAllocationStrategy {
  return typeof value === "string" && (CAPTCHA_ALLOCATION_STRATEGIES as readonly string[]).includes(value);
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = toFiniteNumber(value);
  if (parsed === null) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

export function clampProviderWeight(value: unknown): number {
  return clampNumber(value, MIN_PROVIDER_WEIGHT, MAX_PROVIDER_WEIGHT, DEFAULT_PROVIDER_WEIGHT);
}

export function clampProviderPriority(value: unknown): number {
  return clampNumber(value, MIN_PROVIDER_PRIORITY, MAX_PROVIDER_PRIORITY, DEFAULT_PROVIDER_PRIORITY);
}

export function clampRotationSeconds(value: unknown): number {
  return clampNumber(value, MIN_ROTATION_SECONDS, MAX_ROTATION_SECONDS, DEFAULT_ALLOCATION_POLICY.rotationSeconds);
}

export function clampStickyTtlMinutes(value: unknown): number {
  return clampNumber(value, MIN_STICKY_TTL_MINUTES, MAX_STICKY_TTL_MINUTES, DEFAULT_ALLOCATION_POLICY.stickyTtlMinutes);
}

export function clampRolloutPercent(value: unknown): number {
  return clampNumber(value, 0, 100, DEFAULT_ALLOCATION_POLICY.rolloutPercent);
}

export function clampFailoverAttempts(value: unknown): number {
  return clampNumber(
    value,
    MIN_FAILOVER_ATTEMPTS,
    MAX_FAILOVER_ATTEMPTS,
    DEFAULT_ALLOCATION_POLICY.failoverMaxAttempts,
  );
}

export function normalizeWidgetTheme(value: unknown): CaptchaWidgetTheme {
  return typeof value === "string" && (WIDGET_THEMES as readonly string[]).includes(value)
    ? (value as CaptchaWidgetTheme)
    : DEFAULT_WIDGET_SETTINGS.theme;
}

export function normalizeWidgetSize(value: unknown): CaptchaWidgetSize {
  return typeof value === "string" && (WIDGET_SIZES as readonly string[]).includes(value)
    ? (value as CaptchaWidgetSize)
    : DEFAULT_WIDGET_SETTINGS.size;
}

/** `auto` 或合法 BCP-47；其余一律回落 `auto`（避免把注入式字符串下发给浏览器）。 */
export function normalizeWidgetLanguage(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_WIDGET_SETTINGS.language;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "auto") return DEFAULT_WIDGET_SETTINGS.language;
  return LANGUAGE_PATTERN.test(trimmed) ? trimmed : DEFAULT_WIDGET_SETTINGS.language;
}

export function normalizeScenarioStrategies(value: unknown): Partial<Record<CaptchaScenario, CaptchaAllocationStrategy>> {
  const result: Partial<Record<CaptchaScenario, CaptchaAllocationStrategy>> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  const source = value as Record<string, unknown>;
  for (const scenario of CAPTCHA_SCENARIOS) {
    const entry = source[scenario];
    if (isCaptchaAllocationStrategy(entry)) result[scenario] = entry;
  }
  return result;
}

/** 场景权重：只保留已知场景的有限非负数（0 合法）。 */
export function normalizeScenarioWeights(value: unknown): Partial<Record<CaptchaScenario, number>> | undefined {
  const result: Partial<Record<CaptchaScenario, number>> = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const source = value as Record<string, unknown>;
    for (const scenario of CAPTCHA_SCENARIOS) {
      const entry = source[scenario];
      if (entry === null || entry === undefined || entry === "") continue;
      const parsed = toFiniteNumber(entry);
      if (parsed === null) continue;
      result[scenario] = clampProviderWeight(parsed);
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function normalizeWidgetOverrides(
  value: unknown,
): Partial<Record<CaptchaProviderId, CaptchaWidgetProviderOverride>> {
  const result: Partial<Record<CaptchaProviderId, CaptchaWidgetProviderOverride>> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  const source = value as Record<string, unknown>;
  for (const provider of CAPTCHA_PROVIDER_IDS) {
    const entry = source[provider];
    if (entry === null) {
      // 显式 null = 清掉该家覆盖（回落全局）
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const raw = entry as Record<string, unknown>;
    const override: CaptchaWidgetProviderOverride = {};
    if (raw.theme !== undefined) override.theme = normalizeWidgetTheme(raw.theme);
    if (raw.size !== undefined) override.size = normalizeWidgetSize(raw.size);
    if (raw.language !== undefined) override.language = normalizeWidgetLanguage(raw.language);
    if (Object.keys(override).length > 0) result[provider] = override;
  }
  return result;
}

/**
 * 场景供应商白名单归一化（RC-24.2）。
 *
 * 规则：只保留已知场景；每项去重、剔除非法 provider；**空数组视为“未设置”**
 * —— 否则一次误保存的空数组会把该场景变成“零候选”，把所有被标记账户直接锁死。
 * （真要“锁死”应该靠 fail_closed 的显式告警路径，而不是一个看起来像配置错误的状态。）
 */
export function normalizeScenarioProviderAllowlist(
  value: unknown,
): Partial<Record<CaptchaScenario, CaptchaProviderId[]>> {
  const result: Partial<Record<CaptchaScenario, CaptchaProviderId[]>> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  const source = value as Record<string, unknown>;
  for (const scenario of CAPTCHA_SCENARIOS) {
    const entry = source[scenario];
    if (!Array.isArray(entry)) continue;
    const providers = Array.from(
      new Set(
        entry.filter(
          (item): item is CaptchaProviderId =>
            typeof item === "string" && (CAPTCHA_PROVIDER_IDS as readonly string[]).includes(item),
        ),
      ),
    );
    if (providers.length > 0) result[scenario] = providers;
  }
  return result;
}

/** 取某场景生效的白名单；`null` = 该场景不受白名单约束（历史行为）。 */
export function resolveScenarioProviderAllowlist(
  policy: CaptchaAllocationPolicyView,
  scenario: CaptchaScenario,
): readonly CaptchaProviderId[] | null {
  const list = policy.scenarioProviderAllowlist?.[scenario];
  return Array.isArray(list) && list.length > 0 ? list : null;
}

/**
 * 带**默认白名单**的归一化。
 *
 * 为什么不能只调 normalizeScenarioProviderAllowlist：那个函数对缺失字段返回 `{}`，
 * 而 `normalizeAllocationPolicy` 是「读库缺字段 ⇒ 用默认值」的语义（strategy / rotationSeconds … 都这么写）。
 * 若这里不补默认，则（a）存量部署（库里的 policy 文档没有该字段）拿到空白名单，
 * 需求要的「被标记账户一律走 trycap/Turnstile」静默失效；（b）管理员一保存策略，
 * 白名单就被写成 `{}` —— 而这正是 RC-24 要堵的「权重/配置看着在、实际不生效」。
 *
 * 多例：某个场景显式给了合法名单 ⇒ 以显式值为准（管理员仍可改，比如把 hCaptcha 加进 step_up）；
 * 显式空数组 ⇒ 视为未设置 ⇒ 回落默认（空数组不能等于“零候选”，否则一次误保存就锁死被标记账户）。
 */
function normalizeScenarioProviderAllowlistWithDefaults(
  value: unknown,
): Partial<Record<CaptchaScenario, CaptchaProviderId[]>> {
  const merged: Partial<Record<CaptchaScenario, CaptchaProviderId[]>> = {
    ...normalizeScenarioProviderAllowlist(value),
  };
  for (const scenario of CAPTCHA_SCENARIOS) {
    const preset = DEFAULT_ALLOCATION_POLICY.scenarioProviderAllowlist[scenario];
    if (preset && !merged[scenario]) {
      // 复制数组：默认常量不能被调用方写回或改写。
      merged[scenario] = [...preset];
    }
  }
  return merged;
}

export function normalizeAllocationPolicy(raw: CaptchaAllocationPolicyInput | null | undefined): CaptchaAllocationPolicyView {
  const source = raw ?? {};
  return {
    strategy: isCaptchaAllocationStrategy(source.strategy) ? source.strategy : DEFAULT_ALLOCATION_POLICY.strategy,
    rotationSeconds: clampRotationSeconds(source.rotationSeconds),
    stickyEnabled: source.stickyEnabled === true,
    stickyTtlMinutes: clampStickyTtlMinutes(source.stickyTtlMinutes),
    rolloutPercent: clampRolloutPercent(source.rolloutPercent),
    rolloutControlProvider:
      typeof source.rolloutControlProvider === "string" &&
      (CAPTCHA_PROVIDER_IDS as readonly string[]).includes(source.rolloutControlProvider)
        ? (source.rolloutControlProvider as CaptchaProviderId)
        : DEFAULT_ALLOCATION_POLICY.rolloutControlProvider,
    failoverMaxAttempts: clampFailoverAttempts(source.failoverMaxAttempts),
    scenarioStrategies: normalizeScenarioStrategies(source.scenarioStrategies),
    scenarioProviderAllowlist: normalizeScenarioProviderAllowlistWithDefaults(source.scenarioProviderAllowlist),
    updatedAt: toIsoOrUndefined(source.updatedAt),
  };
}

export function normalizeWidgetSettings(raw: CaptchaWidgetSettingsInput | null | undefined): CaptchaWidgetSettingsView {
  const source = raw ?? {};
  return {
    theme: normalizeWidgetTheme(source.theme),
    size: normalizeWidgetSize(source.size),
    language: normalizeWidgetLanguage(source.language),
    showProviderLabel: source.showProviderLabel !== false,
    perProvider: normalizeWidgetOverrides(source.perProvider),
    updatedAt: toIsoOrUndefined(source.updatedAt),
  };
}

/** 该场景实际生效的策略：场景覆盖优先，否则全局。 */
export function resolveScenarioStrategy(
  policy: CaptchaAllocationPolicyView,
  scenario: CaptchaScenario,
): CaptchaAllocationStrategy {
  return policy.scenarioStrategies[scenario] ?? policy.strategy;
}

/** 该供应商实际生效的外观：逐家覆盖优先，否则全局。 */
export function resolveWidgetSettings(
  settings: CaptchaWidgetSettingsView,
  provider: CaptchaProviderId | null,
): ResolvedWidgetSettings {
  const override = provider ? settings.perProvider[provider] : undefined;
  return {
    theme: override?.theme ?? settings.theme,
    size: override?.size ?? settings.size,
    language: override?.language ?? settings.language,
    showProviderLabel: settings.showProviderLabel,
  };
}

/** sha256 → [0, 1)。用于粘性与灰度分桶：确定性、无状态、跨实例一致。 */
export function hashToUnitInterval(input: string): number {
  const digest = crypto.createHash("sha256").update(input).digest();
  // 取前 48 bit，避免 32 bit 取模带来的可见偏差
  const bucket = digest.readUIntBE(0, 6);
  return bucket / 0x1000000000000;
}

export function getStickyWindowIndex(nowMs: number, ttlMinutes: number): number {
  const windowMs = Math.max(1, Math.round(ttlMinutes)) * 60_000;
  return Math.floor(nowMs / windowMs);
}

/** 灰度命中「实验组」返回 false（走策略）；落在对照组返回 true。percent = 0 时永远走策略。 */
export function isRolloutControl(
  policy: CaptchaAllocationPolicyView,
  scenario: CaptchaScenario,
  fingerprint: string | undefined,
): boolean {
  if (policy.rolloutPercent <= 0) return false;
  if (policy.rolloutPercent >= 100) return false;
  if (!fingerprint) return false;
  return hashToUnitInterval(`rollout|${scenario}|${fingerprint}`) * 100 >= policy.rolloutPercent;
}

export interface WeightedEntry {
  weight: number;
}

/**
 * 无偏加权抽取。权重全 0（或全为非法值）时退化为等概率，绝不返回 null 之外的意外结果。
 * 传 entries.length === 0 返回 null。
 */
export function pickWeightedProvider<T extends WeightedEntry>(
  entries: readonly T[],
  randomInt: (min: number, max: number) => number = crypto.randomInt,
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

/**
 * 按 [0,1) 的确定值落进权重区间（粘性分桶用）。
 * 与 `pickWeightedProvider` 同一套区间语义：权重全 0 时退化为均匀分区。
 */
export function pickWeightedProviderByUnit<T extends WeightedEntry>(
  entries: readonly T[],
  unit: number,
): T | null {
  if (entries.length === 0) return null;

  const weights = entries.map((entry) => (Number.isFinite(entry.weight) && entry.weight > 0 ? entry.weight : 0));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const clampedUnit = Math.min(0.999_999, Math.max(0, unit));

  if (total <= 0) {
    const index = Math.min(entries.length - 1, Math.floor(clampedUnit * entries.length));
    return entries[index];
  }

  let cursor = 0;
  for (let index = 0; index < entries.length; index += 1) {
    cursor += weights[index] / total;
    if (clampedUnit < cursor) return entries[index];
  }
  return entries[entries.length - 1];
}

/** 按时间窗轮换：无状态、跨实例一致。 */
export function pickRoundRobinProvider<T>(entries: readonly T[], nowMs: number, rotationSeconds: number): T | null {
  if (entries.length === 0) return null;
  const windowMs = Math.max(1, Math.round(rotationSeconds)) * 1_000;
  const index = Math.floor(nowMs / windowMs) % entries.length;
  return entries[((index % entries.length) + entries.length) % entries.length];
}

export interface PriorityEntry {
  provider: CaptchaProviderId;
  priority: number;
}

/** 故障转移：按 priority 升序（同优先级按供应商固定顺序），可排除已失败的几家。 */
export function orderByPriority<T extends PriorityEntry>(entries: readonly T[]): T[] {
  const providerOrder = new Map(CAPTCHA_PROVIDER_IDS.map((provider, index) => [provider, index]));
  return [...entries].sort((a, b) => {
    const priorityDiff = a.priority - b.priority;
    if (priorityDiff !== 0) return priorityDiff;
    return (providerOrder.get(a.provider) ?? 99) - (providerOrder.get(b.provider) ?? 99);
  });
}

export function pickFailoverProvider<T extends PriorityEntry>(
  entries: readonly T[],
  exclude: readonly CaptchaProviderId[] = [],
): T | null {
  const remaining = orderByPriority(entries).filter((entry) => !exclude.includes(entry.provider));
  return remaining[0] ?? null;
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

export interface SimulationCandidate {
  provider: CaptchaProviderId;
  weight: number;
  priority: number;
}

export interface SimulationEntry {
  provider: CaptchaProviderId;
  count: number;
  percentage: number;
}

export interface SimulationOptions {
  scenario: CaptchaScenario;
  draws: number;
  nowMs: number;
  fingerprint?: string;
  exclude?: readonly CaptchaProviderId[];
  randomInt?: (min: number, max: number) => number;
}

/**
 * 管理端「分配模拟」：用与线上同一套纯函数抽 `draws` 次（不写库、不改任何状态）。
 * 粘性开启时，没有指纹就没有固定结论 —— 用 `simulate-fp-<i>` 合成分桶，让直方图反映真实分布。
 */
export function simulateAllocation(
  candidates: readonly SimulationCandidate[],
  policy: CaptchaAllocationPolicyView,
  options: SimulationOptions,
): SimulationEntry[] {
  const draws = Math.max(1, Math.min(20_000, Math.round(options.draws)));
  const randomInt = options.randomInt ?? crypto.randomInt;
  const strategy = resolveScenarioStrategy(policy, options.scenario);
  const excluded = options.exclude ?? [];
  const pool = candidates.filter((candidate) => !excluded.includes(candidate.provider));
  const counts = new Map<CaptchaProviderId, number>();
  const bump = (provider: CaptchaProviderId | undefined) => {
    if (!provider) return;
    counts.set(provider, (counts.get(provider) ?? 0) + 1);
  };

  for (let index = 0; index < draws; index += 1) {
    const fingerprint = options.fingerprint ?? `simulate-fp-${index % 1000}`;
    // pickCandidate 返回的是候选（T | null），计数的键必须是供应商 id —— 早期漏了 .provider，
    // 靠放宽 bump 参数类型把编译错压下去，会让直方图按对象实例分桶（每次抽样都是新键，全为 1）。
    bump(pickCandidate(pool, policy, strategy, options.scenario, fingerprint, options.nowMs, randomInt)?.provider);
  }

  const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
  return [...counts.entries()]
    .map(([provider, count]) => ({
      provider,
      count,
      percentage: total > 0 ? Math.round((count / total) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.count - a.count);
}

/** 三条策略汇合点（sticky → 灰度 → 策略本身），线上与模拟共用，保证「模拟即所见」。 */
function pickCandidate<T extends SimulationCandidate>(
  pool: readonly T[],
  policy: CaptchaAllocationPolicyView,
  strategy: CaptchaAllocationStrategy,
  scenario: CaptchaScenario,
  fingerprint: string | undefined,
  nowMs: number,
  randomInt: (min: number, max: number) => number,
): T | null {
  if (pool.length === 0) return null;
  if (pool.length === 1) return pool[0];

  if (isRolloutControl(policy, scenario, fingerprint)) {
    const control = pool.find((candidate) => candidate.provider === policy.rolloutControlProvider);
    // 对照组不在可用候选（已下线/额度用尽）时忽略灰度，避免把人送进死角。
    if (control) return control;
  }

  if (policy.stickyEnabled && fingerprint) {
    const windowIndex = getStickyWindowIndex(nowMs, policy.stickyTtlMinutes);
    const unit = hashToUnitInterval(`sticky|${scenario}|${fingerprint}|${windowIndex}`);
    return pickWeightedProviderByUnit(pool, unit);
  }

  if (strategy === "round_robin") return pickRoundRobinProvider(pool, nowMs, policy.rotationSeconds);
  if (strategy === "failover") return pickFailoverProvider(pool);
  return pickWeightedProvider(pool, randomInt);
}

/** 线上选择入口：返回候选 + 选中项 + 命中理由，供控制器/诊断接口复用。 */
export function chooseCandidate<T extends SimulationCandidate>(
  candidates: readonly T[],
  policy: CaptchaAllocationPolicyView,
  options: {
    scenario: CaptchaScenario;
    fingerprint?: string;
    nowMs: number;
    exclude?: readonly CaptchaProviderId[];
    randomInt?: (min: number, max: number) => number;
  },
): { candidate: T | null; strategy: CaptchaAllocationStrategy; rolloutControl: boolean; sticky: boolean; pool: T[] } {
  const strategy = resolveScenarioStrategy(policy, options.scenario);
  const excluded = options.exclude ?? [];
  const pool = candidates.filter((candidate) => !excluded.includes(candidate.provider));
  const randomInt = options.randomInt ?? crypto.randomInt;
  const rolloutControl = isRolloutControl(policy, options.scenario, options.fingerprint);
  const sticky = policy.stickyEnabled && Boolean(options.fingerprint);

  if (pool.length === 0) return { candidate: null, strategy, rolloutControl, sticky, pool };

  const candidate = pickCandidate(
    pool,
    policy,
    strategy,
    options.scenario,
    options.fingerprint,
    options.nowMs,
    randomInt,
  );
  return { candidate, strategy, rolloutControl, sticky, pool };
}
