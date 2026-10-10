import type { Request, Response } from "express";
import { TurnstileService } from "../services/turnstileService";
import { readCaptchaChallenge } from "../services/turnstile/challenge";
import { createStepUpGrant, discardStepUpGrant } from "../services/stepUpService";
import { getAccountRiskState } from "../services/userService";
import type { AuthenticatedRequest } from "../types/authRequest";
import { getClientIP } from "../utils/ipUtils";
import logger from "../utils/logger";

/**
 * step-up 票据兑换（RC-46）。前端拿到 `STEP_UP_REQUIRED` 后：
 *   1. 解一次人机验证（jsd_captcha 控件，scenario = step_up）；
 *   2. 把队列里所有被拦请求的 `challengeTicket` 一起提交到这里，换一枚 grant；
 *   3. 用 `X-Step-Up-Grant` 重放那批请求，队列排空后调 `/api/step-up/discard` 主动作废。
 *
 * 两条硬约束：
 * - **供应商必须在 step_up 白名单内**（RC-24.5）：否则客户端声明 `default` 场景就能拿到
 *   更宽松的供应商集，白名单形同虚设。
 * - **次数由服务端票据数决定**（D22）：请求体里的任何数量声明都被忽略。
 */

function getUserId(req: Request): string {
  const user = (req as AuthenticatedRequest).user as { id?: string } | undefined;
  return typeof user?.id === "string" ? user.id : "";
}

export async function createStepUpGrantHandler(req: Request, res: Response) {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ success: false, error: "未授权" });

  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const { token, provider } = readCaptchaChallenge(body);
  const powNonce = typeof body.powNonce === "string" ? body.powNonce : undefined;
  const tickets = body.challengeTickets ?? body.tickets;

  // 账户当前是否仍需要逐步验证：不再需要时直接放行（但票据仍会被消费，避免被攒着用）。
  const state = await getAccountRiskState(userId);

  if (!powNonce) {
    if (!token) {
      return res.status(400).json({
        success: false,
        error: "缺少人机验证令牌",
        code: "STEP_UP_CAPTCHA_REQUIRED",
      });
    }

    // 供应商白名单校验：只接受 step_up 场景当前允许的供应商。
    const { candidates } = await TurnstileService.collectCaptchaProviders({ scenario: "step_up" });
    const allowed = candidates.map((candidate) => candidate.provider);
    if (!allowed.includes(provider)) {
      logger.warn("[StepUp] 兑换使用了不在 step_up 白名单内的供应商", { userId, provider, allowed });
      return res.status(403).json({
        success: false,
        error: "该验证方式当前不可用，请刷新页面重试",
        code: "STEP_UP_PROVIDER_NOT_ALLOWED",
        scenario: "step_up",
      });
    }

    const verified = await TurnstileService.verifyCaptchaChallenge({
      token,
      provider,
      remoteIp: getClientIP(req) || undefined,
    });
    if (!verified) {
      return res.status(403).json({
        success: false,
        error: "人机验证未通过，请重试",
        code: "STEP_UP_CAPTCHA_FAILED",
      });
    }
  }

  const result = await createStepUpGrant({
    userId,
    tickets,
    powNonce,
    ipAddress: getClientIP(req) || "",
    fingerprint: String(req.get("x-device-id") || req.get("x-fingerprint") || "").slice(0, 128),
  });

  if ("error" in result) {
    return res.status(400).json({ success: false, error: result.error, code: "STEP_UP_TICKET_INVALID" });
  }

  logger.info("[StepUp] 已签发 grant", {
    userId,
    remainingUses: result.remainingUses,
    routeKeys: result.routeKeys,
    stillRestricted: state?.riskTier === "restricted" || state?.riskTier === "danger",
  });

  return res.json({ success: true, ...result });
}

export async function discardStepUpGrantHandler(req: Request, res: Response) {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ success: false, error: "未授权" });
  const body = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  await discardStepUpGrant(body.grantId, userId);
  return res.json({ success: true });
}
