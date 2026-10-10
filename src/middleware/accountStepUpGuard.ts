import type { Request, Response } from "express";
import { config } from "../config/config";
import { shouldExemptFromRiskControl } from "../services/riskExemption";
import {
  computePayloadHash,
  issueStepUpChallenge,
  redeemStepUpGrant,
  type StepUpChallengeResult,
} from "../services/stepUpService";
import { collectCaptchaProviders } from "../services/turnstile/providers";
import { getAccountRiskState } from "../services/userService";
import type { AuthenticatedRequest } from "../types/authRequest";
import { getClientIP } from "../utils/ipUtils";
import logger from "../utils/logger";
import { routeKeyFromRequest } from "../utils/routeKey";

/**
 * 账户逐步验证闸门（RC-02 / RC-03 / RC-09 / RC-24 / RC-45 / RC-46）。
 *
 * **插在哪里 / 为什么不是 assembly.ts**：审计 §4.4 写的是「assembly.ts 的 API 路由相位，
 * 在 authenticateToken 之后」——但本仓的 `authenticateToken` 是**路由级中间件**
 *（每个 router 自己挂，没有全局认证），所以挂在前面的全局中间件拿不到 `req.user`。
 * 因此闸门由 `authenticateToken` 在“认证已完成、业务 handler 之前”调用（见该文件尾部），
 * 效果与 §4.4 的意图一致：**认证之后、业务之前**。这一点已登记在 §2.10。
 *
 * 契约（`CLAUDE.md` 安全注意事项：处罚类必须带稳定 code）：
 * - `403 { success:false, code:"STEP_UP_REQUIRED", scenario:"step_up", challengeTicket, scope, routeKey }`
 * - `403 { success:false, code:"STEP_UP_UNAVAILABLE" }` —— 白名单耗尽（fail_closed，D11/D12）
 * - 原生/脚本客户端（只带 Bearer、没有 Cookie）额外带 `unsupported:"interactive"`，
 *   客户端据此降级为只读，而不是卡在一个永远弹不出的弹窗上（RC-09）。
 */

/** 只对写方法设闸：GET 类读**永不**逐请求验（轮询/SSE/WS 会被废掉，§4.6）。 */
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * 豁免清单（必须显式，便于审计）。与 §4.4 对齐：
 * OPTIONS 由方法判定天然豁免（非写），健康检查、登出、挑战端点自身必须在列。
 */
const BYPASS_PREFIXES = ["/api/step-up", "/api/auth/logout", "/api/health", "/api/status", "/health", "/static"];

export function isStepUpBypassPath(path: string): boolean {
  const value = typeof path === "string" ? path : "";
  return BYPASS_PREFIXES.some((prefix) => value === prefix || value.startsWith(`${prefix}/`));
}

/** 写方法一律需要；读方法一律不需要（RC-09：读走限流收紧 + 只读降级，不做逐请求 captcha）。 */
export function stepUpRequiredForMethod(method: unknown): boolean {
  return WRITE_METHODS.has(String(method || "").toUpperCase());
}

/** 只带 Bearer、没有会话 Cookie ⇒ 原生客户端：它弹不出人机验证（RC-09）。 */
export function isInteractiveUnsupported(req: Request): boolean {
  const authorization = req.get("authorization");
  if (!authorization || !/^Bearer\s+/i.test(authorization)) return false;
  return !req.headers.cookie || !/synapse_token=/.test(String(req.headers.cookie));
}

/**
 * 请求体绑定（RC-03 的 `payloadHash`）。
 *
 * 只对 **JSON** 请求体做内容绑定：multipart 请求被重放时，multer 会重新解析出
 * 内容相同但**临时路径/文件名不同**的 body（`req.body` 里没有文件内容），
 * 遂字节摘要必然对不上 ⇒ 被标记账户的文件上传类写操作将永远过不了闸。
 * 非 JSON 时改绑「方法 + 路径 + Content-Length」：仍然能防“拿同一枚 grant 重放同一请求”，
 * 只是不能防“换一个等长 body”（对该类请求可接受，且上传本身还有大小/类型校验）。
 */
function stepUpPayloadHash(req: Request): string {
  const contentType = String(req.get("content-type") || "").toLowerCase();
  if (contentType.includes("application/json")) return computePayloadHash(req.body);
  return computePayloadHash({
    method: req.method,
    path: req.path,
    length: req.get("content-length") || "",
  });
}

export interface StepUpDecision {
  required: boolean;
  /** 为何不需要：便于排查“为什么没弹窗”。 */
  reason: "disabled" | "bypass" | "read-method" | "anonymous" | "exempt" | "tier-normal" | "grant-accepted" | "required";
  state?: { riskTier?: string; stepUpMode?: string; stepUpUntil?: number };
}

/**
 * 纯判定（不含响应/签发），便于单测与复用。
 */
export async function evaluateStepUpRequirement(
  req: Request,
): Promise<StepUpDecision> {
  const cfg = config.accountRisk;
  if (!cfg.stepUpEnabled) return { required: false, reason: "disabled" };
  if (isStepUpBypassPath(req.path || req.url || "")) return { required: false, reason: "bypass" };
  if (!stepUpRequiredForMethod(req.method)) return { required: false, reason: "read-method" };

  const user = (req as AuthenticatedRequest).user as { id?: string; role?: string } | undefined;
  if (!user?.id) return { required: false, reason: "anonymous" };
  if (shouldExemptFromRiskControl(user, "stepUp", { path: req.path, method: req.method })) {
    return { required: false, reason: "exempt" };
  }

  const state = await getAccountRiskState(user.id);
  if (!state || state.deletedAt) return { required: false, reason: "anonymous" };

  const needsVerification =
    (state.riskTier === "restricted" || state.riskTier === "danger") && (state.stepUpUntil ?? 0) > Date.now();
  if (!needsVerification) {
    return {
      required: false,
      reason: "tier-normal",
      state: { riskTier: state.riskTier, stepUpMode: state.stepUpMode, stepUpUntil: state.stepUpUntil },
    };
  }

  const routeKey = routeKeyFromRequest(req);
  const payloadHash = stepUpPayloadHash(req);
  const grantId = req.get("x-step-up-grant");
  if (grantId && (await redeemStepUpGrant({ grantId, userId: user.id, routeKey, payloadHash }))) {
    return {
      required: false,
      reason: "grant-accepted",
      state: { riskTier: state.riskTier, stepUpMode: state.stepUpMode, stepUpUntil: state.stepUpUntil },
    };
  }

  return {
    required: true,
    reason: "required",
    state: { riskTier: state.riskTier, stepUpMode: state.stepUpMode, stepUpUntil: state.stepUpUntil },
  };
}

/**
 * 闸门执行体：返回 true 表示**已经回过响应**，调用方必须立刻 return（不得继续 next()）。
 */
export async function enforceAccountStepUp(req: Request, res: Response): Promise<boolean> {
  let decision: StepUpDecision;
  try {
    decision = await evaluateStepUpRequirement(req);
  } catch (error) {
    // 判定本身出错时 fail-closed 到“不拦”会影响安全，fail-closed 到“拦”会断服。
    // 取「不拦 + error 级告警」：本闸门是纵深防御的一层，不是唯一的鉴权层，
    // 而 I/O 抖动就断掉全部写请求，风险大于收益（与 §4.6 的可用性取向一致）。
    logger.error("[StepUp] 闸门判定异常，本次放行（需告警排查）", {
      path: req.path,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }

  if (!decision.required) return false;

  const user = (req as AuthenticatedRequest).user as { id?: string; role?: string } | undefined;
  const userId = user?.id || "";
  const routeKey = routeKeyFromRequest(req);
  const payloadHash = stepUpPayloadHash(req);
  const ip = getClientIP(req) || "unknown";
  const interactiveUnsupported = isInteractiveUnsupported(req);

  // fail_closed（D11/D12）：白名单耗尽时**不回落**其它供应商、不静默放行、不签发绕过令牌。
  const { allowlistExhausted } = await collectCaptchaProviders({ scenario: "step_up" });
  if (allowlistExhausted) {
    logger.error("[StepUp] step_up 供应商白名单已耗尽，拒绝写操作（fail_closed）", {
      userId,
      path: req.path,
    });
    res.status(403).json({
      success: false,
      error: "验证服务暂时不可用，已临时限制写入操作，请稍后重试或联系支持",
      code: "STEP_UP_UNAVAILABLE",
      scenario: "step_up",
      supportEmail: "support@chloemlla.com",
    });
    return true;
  }

  const wantedType = String(req.get("x-step-up-type") || "").toLowerCase() === "pow" ? "pow" : "captcha";
  let challenge: StepUpChallengeResult | null = null;
  try {
    challenge = await issueStepUpChallenge({
      userId,
      riskTier: String(decision.state?.riskTier || "restricted"),
      routeKey,
      payloadHash,
      provider: String(req.get("x-step-up-provider") || ""),
      type: wantedType,
      ipAddress: ip,
      fingerprint: String(req.get("x-device-id") || req.get("x-fingerprint") || "").slice(0, 128),
    });
  } catch (error) {
    logger.error("[StepUp] 挑战签发异常", { userId, error: error instanceof Error ? error.message : String(error) });
  }

  if (!challenge) {
    res.status(503).json({
      success: false,
      error: "验证服务暂时不可用，请稍后重试",
      code: "STEP_UP_UNAVAILABLE",
      scenario: "step_up",
      supportEmail: "support@chloemlla.com",
    });
    return true;
  }

  logger.info("[StepUp] 已拦截写请求并要求逐步验证", {
    userId,
    routeKey,
    riskTier: decision.state?.riskTier,
    scope: decision.state?.stepUpMode,
    interactiveUnsupported,
  });

  res.status(403).json({
    success: false,
    error: "为保护账户安全，请先完成一次人机验证",
    code: "STEP_UP_REQUIRED",
    scenario: "step_up",
    scope: decision.state?.stepUpMode || "sensitive",
    routeKey,
    challengeTicket: challenge.ticket,
    challengeType: challenge.type,
    expiresAt: challenge.expiresAt,
    ...(challenge.pow ? { pow: challenge.pow } : {}),
    ...(interactiveUnsupported ? { unsupported: "interactive" } : {}),
  });
  return true;
}
