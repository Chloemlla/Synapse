import logger from "../../utils/logger";
import { consumeConfiguredCaptchaQuota } from "./quota";
import { assessClientRisk, recordVerificationOutcome } from "./risk";
import { persistTurnstileTrace } from "./trace";
import type { CaptchaProviderId, TurnstileVerificationFailure } from "./types";

/**
 * 额度闸门：额度型供应商（当前是 hCaptcha）在**外呼之前**先结算本月额度。
 *
 * 抽成独立模块有两个原因：verify.ts 与 hcaptcha.ts 是两条独立的外呼路径，
 * 两边各写一份额度判断迟早会分叉；同时 verify.ts 已贴着 800 行体量闸门，
 * 把这段带 trace 的失败构造搬出来能顺手瘦身。
 *
 * 返回 null = 允许外呼；返回失败结果 = 额度已用尽，调用方必须直接失败（fail-closed）。
 */
export interface QuotaGuardContext {
  traceId: string;
  timestamp: string;
  clientInfo: { ip: string; userAgent?: string; fingerprint?: string };
}

export async function guardCaptchaQuota(
  provider: CaptchaProviderId,
  ctx: QuotaGuardContext,
): Promise<TurnstileVerificationFailure | null> {
  const quota = await consumeConfiguredCaptchaQuota(provider);
  if (quota.allowed) return null;

  const { ip, userAgent, fingerprint } = ctx.clientInfo;
  const riskAssessment = assessClientRisk(ip, userAgent, fingerprint);
  recordVerificationOutcome(ip, userAgent, false, new Date(), fingerprint);

  const errorMessage = `${provider} 本月额度已用尽（${quota.snapshot.used}/${quota.snapshot.limit}）`;

  await persistTurnstileTrace({
    traceId: ctx.traceId,
    time: new Date(),
    ip,
    ua: userAgent,
    success: false,
    reason: "quota_exhausted",
    errorCode: "QUOTA_EXHAUSTED",
    errorMessage,
    fingerprint,
    riskLevel: riskAssessment?.riskLevel,
    riskScore: riskAssessment?.riskScore,
    riskReasons: riskAssessment?.riskReasons,
  });

  logger.warn(`${provider} 本月额度已用尽，本次不外呼`, {
    used: quota.snapshot.used,
    limit: quota.snapshot.limit,
    resetsAt: quota.snapshot.resetsAt,
    traceId: ctx.traceId,
  });

  return {
    success: false,
    reason: "quota_exhausted",
    errorCode: "QUOTA_EXHAUSTED",
    errorMessage: `${provider} 本月额度已用尽`,
    retryable: true,
    timestamp: ctx.timestamp,
    clientInfo: ctx.clientInfo,
    riskAssessment,
    traceId: ctx.traceId,
  };
}
