export interface TurnstileResponse {
  success: boolean;
  "error-codes"?: string[];
  challenge_ts?: string;
  hostname?: string;
}

export interface HCaptchaResponse {
  success: boolean;
  "error-codes"?: string[];
  challenge_ts?: string;
  hostname?: string;
  credit?: boolean;
  score?: number;
  score_reason?: string[];
}

export interface RiskAssessment {
  riskLevel: string;
  riskScore: number;
  riskReasons: string[];
}

export interface RiskAssessmentDetail {
  riskLevel: "low" | "medium" | "high";
  riskScore: number;
  riskReasons: string[];
  scoreBreakdown: any;
}

export interface TurnstileVerificationFailure {
  success: false;
  reason: string;
  errorCode: string;
  errorMessage: string;
  retryable: boolean;
  timestamp: string;
  clientInfo: {
    ip: string;
    userAgent?: string;
    fingerprint?: string;
  };
  riskAssessment?: RiskAssessment;
  violationInfo?: {
    violationCount: number;
    banned: boolean;
    banExpiresAt?: Date;
  };
  traceId?: string;
}

export interface TurnstileVerificationSuccess {
  success: true;
  timestamp: string;
  clientInfo: {
    ip: string;
    userAgent?: string;
    fingerprint?: string;
  };
  riskAssessment?: RiskAssessment;
  accessToken?: string;
  traceId?: string;
}

export type TurnstileVerificationResult = TurnstileVerificationSuccess | TurnstileVerificationFailure;

export interface TurnstileSettingDoc {
  key: string;
  value: string;
  updatedAt?: Date;
}

export interface HCaptchaSettingDoc {
  key: string;
  value: string;
  updatedAt?: Date;
}

export interface CapSettingDoc {
  key: string;
  value: string;
  updatedAt?: Date;
}

/** 人机验证供应商标识。前端仅需 siteKey，secret 只留在服务端。 */
export type CaptchaProviderId = "turnstile" | "hcaptcha" | "trycap";

/** 三家供应商的固定顺序（下发顺序、管理端展示顺序都以它为准）。 */
export const CAPTCHA_PROVIDER_IDS: readonly CaptchaProviderId[] = ["turnstile", "hcaptcha", "trycap"];

/** 下发场景：default 是其余调用点（旧行为），first_visit / standalone 是两条前端入口，
 * step_up 是「被标记账户的逐步验证」（RC-02/RC-24）——它是唯一带**供应商白名单**的场景。 */
export type CaptchaScenario = "default" | "first_visit" | "standalone" | "step_up";

export const CAPTCHA_SCENARIOS: readonly CaptchaScenario[] = [
  "default",
  "first_visit",
  "standalone",
  "step_up",
];

export const CAPTCHA_SCENARIO_LABELS: Record<CaptchaScenario, string> = {
  default: "默认（其它调用点）",
  first_visit: "首访门禁",
  standalone: "独立验证页",
  step_up: "被标记账户逐步验证",
};

/** 分配策略：加权随机 / 按时间轮换 / 优先级故障转移。 */
export type CaptchaAllocationStrategy = "weighted" | "round_robin" | "failover";

export const CAPTCHA_ALLOCATION_STRATEGIES: readonly CaptchaAllocationStrategy[] = [
  "weighted",
  "round_robin",
  "failover",
];

export const CAPTCHA_ALLOCATION_STRATEGY_LABELS: Record<CaptchaAllocationStrategy, string> = {
  weighted: "加权随机",
  round_robin: "按时间轮换",
  failover: "优先级故障转移",
};

/**
 * 供应商调度配置（与凭据解耦）：enabled 是上线/下线开关，weight 是相对权重。
 * 凭据仍存在各自的 *_settings 集合里，这里只管「用不用、用多少、排第几、哪个场景」。
 */
export interface CaptchaProviderSettingDoc {
  provider: CaptchaProviderId;
  enabled: boolean;
  weight: number;
  /** 每月调用上限；0 或缺失 = 不限额。hCaptcha 默认 10000（见 quota.ts）。 */
  monthlyQuota?: number;
  /** 故障转移顺序：数值小的优先；缺省按 CAPTCHA_PROVIDER_IDS 顺序。 */
  priority?: number;
  /** 按场景覆盖权重；缺省场景回落 weight。 */
  scenarioWeights?: Partial<Record<CaptchaScenario, number>>;
  updatedAt?: Date;
}

/**
 * 全局分配策略（单文档 key=global）。
 * sticky / round_robin / rollout 全部基于确定性哈希或无状态时间窗，多实例结论一致。
 */
export interface CaptchaAllocationPolicyDoc {
  key: string;
  strategy: CaptchaAllocationStrategy;
  /** round_robin 的轮换周期（秒）。 */
  rotationSeconds: number;
  stickyEnabled: boolean;
  stickyTtlMinutes: number;
  /** 0 = 关闭灰度（全部走策略）；100 = 等价于全量走策略。 */
  rolloutPercent: number;
  rolloutControlProvider: CaptchaProviderId;
  /** 前端控件失败后最多换几家（含首次）。 */
  failoverMaxAttempts: number;
  scenarioStrategies: Partial<Record<CaptchaScenario, CaptchaAllocationStrategy>>;
  /**
   * 每场景的供应商白名单（RC-24）。
   *
   * 为什么不能用「权重 0」表达排除：`pickWeightedProvider` 在总权重为 0 时**退化为等概率**，
   * 而 `failover` / `round_robin` 策略根本不算权重 —— 所以“权重 0”既不确定、也不生效。
   * 白名单是硬约束：候选集恒等于白名单交集（空交集 → fail_closed，不回落其它供应商）。
   * 未设置的场景行为与历史逐字节一致（向后兼容）。
   */
  scenarioProviderAllowlist: Partial<Record<CaptchaScenario, CaptchaProviderId[]>>;
  updatedAt?: Date;
}

export type CaptchaWidgetTheme = "auto" | "light" | "dark";
export type CaptchaWidgetSize = "normal" | "compact" | "flexible";

export interface CaptchaWidgetProviderOverride {
  theme?: CaptchaWidgetTheme;
  size?: CaptchaWidgetSize;
  language?: string;
}

/** 前端人机验证控件的统一外观设置（单文档 key=global）；公开下发，不得含敏感项。 */
export interface CaptchaWidgetSettingsDoc {
  key: string;
  theme: CaptchaWidgetTheme;
  size: CaptchaWidgetSize;
  language: string;
  /** 是否在页面展示「本次验证方式 / 技术支持」文案。 */
  showProviderLabel: boolean;
  perProvider: Partial<Record<CaptchaProviderId, CaptchaWidgetProviderOverride>>;
  updatedAt?: Date;
}

/** Cap Standalone 的 /siteverify 响应（与 reCAPTCHA 同构）。 */
export interface CapVerifyResponse {
  success: boolean;
  error?: string;
}

/**
 * 请求侧供应商归一：只有明确落在三家枚举里才采信，其余一律回落到 Turnstile
 * ——即历史调用点（登录/注册/TTS/图床/抽奖/CDK…）在客户端不带供应商字段时的既有语义。
 */
export function normalizeCaptchaProviderId(value: unknown): CaptchaProviderId {
  return typeof value === "string" && (CAPTCHA_PROVIDER_IDS as readonly string[]).includes(value)
    ? (value as CaptchaProviderId)
    : "turnstile";
}
