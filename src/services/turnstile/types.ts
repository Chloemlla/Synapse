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

/**
 * 供应商调度配置（与凭据解耦）：enabled 是上线/下线开关，weight 是相对权重。
 * 凭据仍存在各自的 *_settings 集合里，这里只管「用不用、用多少」。
 */
export interface CaptchaProviderSettingDoc {
  provider: CaptchaProviderId;
  enabled: boolean;
  weight: number;
  /** 每月调用上限；0 或缺失 = 不限额。hCaptcha 默认 10000（见 quota.ts）。 */
  monthlyQuota?: number;
  updatedAt?: Date;
}

/** Cap Standalone 的 /siteverify 响应（与 reCAPTCHA 同构）。 */
export interface CapVerifyResponse {
  success: boolean;
  error?: string;
}
