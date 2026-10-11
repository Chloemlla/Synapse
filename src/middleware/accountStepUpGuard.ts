import type { Request, Response } from "express";
import { config } from "../config/config";
import { getOrCreateRequestRiskContext } from "../utils/requestRiskContext";
import { shouldExemptFromRiskControl } from "../services/riskExemption";
import { getCachedIpRisk } from "../services/ipRiskService";
import { recordAccountAbuseSignal } from "../services/accountRiskService";
import { manualBanIp } from "../services/turnstile/ipBan";
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

/**
 * 只对写方法设闸：GET 类读**永不**逐请求验（轮询/SSE/WS 会被废掉，§4.6）。
 */
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

/**
 * RC-26 / RC-56：**已登录**请求的 IP 风险中阶复查。
 *
 * 首访闸门只管住第一次进入；登录后换到境外 IDC 出口就没人管了。这里做的是：
 * - 只读**缓存**（不外呼上游，否则每个请求都变慢且烧配额）；
 * - 按用户做频率限制（默认 5 分钟一次），否则变成“每请求一次风险查询”；
 * - 中风险 → 返回 `challenge`（由调用方升级为逐步验证）；高风险 → 写 IP 封禁 + `block`。
 *
 * 只对 watch 及以上档位生效：正常用户不因此被频繁打扰（误报成本远高于漏报成本）。
 */
const IP_RECHECK_INTERVAL_MS = 5 * 60 * 1000;
const lastIpRecheckAt = new Map<string, number>();
const IP_RECHECK_MAX_ENTRIES = 10_000;

type IpRecheckVerdict = "skip" | "allow" | "challenge" | "block";

async function recheckLoggedInIpRisk(params: {
  userId: string;
  ipAddress: string;
  riskTier?: string;
}): Promise<IpRecheckVerdict> {
  const tier = params.riskTier ?? "normal";
  if (tier !== "watch" && tier !== "restricted" && tier !== "danger") return "skip";
  if (!params.ipAddress || params.ipAddress === "unknown") return "skip";

  const last = lastIpRecheckAt.get(params.userId) ?? 0;
  if (Date.now() - last < IP_RECHECK_INTERVAL_MS) return "skip";
  if (lastIpRecheckAt.size >= IP_RECHECK_MAX_ENTRIES) lastIpRecheckAt.clear();
  lastIpRecheckAt.set(params.userId, Date.now());

  const cached = await getCachedIpRisk(params.ipAddress).catch(() => null);
  if (!cached) return "skip";

  const blockThreshold = Number(config.proxycheck.blockRiskScore) || 90;
  const challengeThreshold = Number(config.proxycheck.challengeRiskScore) || 66;
  if (cached.risk >= blockThreshold) {
    // RC-26：高风险→切断连接（并写封禁，让后续请求在 ipBanCheck 就被拦下）。
    await manualBanIp(params.ipAddress, 24, "账号风险档受限期间出现高风险出口（自动阻断）", "auto").catch(
      () => undefined,
    );
    return "block";
  }
  if (cached.risk >= challengeThreshold || cached.flags?.some((flag) => flag === "vpn" || flag === "proxy" || flag === "tor")) {
    recordAccountAbuseSignal({
      userId: params.userId,
      eventType: "ACCOUNT_ABUSE_MID_RISK_IP",
      fingerprint: "ip-recheck",
      action: "logged_in_ip_recheck",
      reason: `登录后出口风险分 ${cached.risk}`,
      riskScore: cached.risk,
      flags: cached.flags,
      ipAddress: params.ipAddress,
    });
    return "challenge";
  }
  return "allow";
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
  reason:
    | "disabled"
    | "bypass"
    | "read-method"
    | "anonymous"
    | "exempt"
    | "tier-normal"
    | "grant-accepted"
    | "required"
    | "ip-risk-blocked";
  /** RC-26：高风险出口 → 直接阻断（不再给验证机会，由调用方回一个带 code 的 403）。 */
  block?: boolean;
  state?: { riskTier?: string; stepUpMode?: string; stepUpUntil?: number };
}

/**
 * 纯判定（不含响应/签发），便于单测与复用。
 */
export async function evaluateStepUpRequirement(
  req: Request,
): Promise<StepUpDecision> {
  const cfg = config.accountRisk;
  // 闸门与 IP 复查各自可关：默认都关 —— 两个都是行为变更，必须先观察期（§5 B7/B9）。
  if (!cfg.stepUpEnabled && !cfg.ipRecheckEnabled) return { required: false, reason: "disabled" };
  if (isStepUpBypassPath(req.path || req.url || "")) return { required: false, reason: "bypass" };
  if (!stepUpRequiredForMethod(req.method)) return { required: false, reason: "read-method" };

  const user = (req as AuthenticatedRequest).user as { id?: string; role?: string } | undefined;
  if (!user?.id) return { required: false, reason: "anonymous" };
  if (shouldExemptFromRiskControl(user, "stepUp", { path: req.path, method: req.method })) {
    return { required: false, reason: "exempt" };
  }

  // RC-55：把「这一次请求的风控上下文」收成一个请求期对象。
  // **同请求内只读一次**账户状态 —— 下面所有分支都复用上下文，不再各自查库（新增闸门不再新增查询）。
  const context = await getOrCreateRequestRiskContext(req, async (userId) => getAccountRiskState(userId));
  if (!context || context.accountDeleted) return { required: false, reason: "anonymous" };
  const state = {
    riskTier: context.riskTier,
    stepUpMode: context.stepUp.mode,
    stepUpUntil: context.stepUp.until,
  };

  let needsVerification =
    cfg.stepUpEnabled &&
    (state.riskTier === "restricted" || state.riskTier === "danger") &&
    (state.stepUpUntil ?? 0) > Date.now();

  // RC-26 / RC-56：即使档位不强制 step-up，也要（按频率）复查一次登录后的出口风险。
  if (!needsVerification && cfg.ipRecheckEnabled) {
    const verdict = await recheckLoggedInIpRisk({
      userId: user.id,
      ipAddress: getClientIP(req) || "",
      riskTier: state.riskTier,
    });
    if (verdict === "block") {
      return {
        required: false,
        reason: "ip-risk-blocked",
        block: true,
        state: { riskTier: state.riskTier, stepUpMode: state.stepUpMode, stepUpUntil: state.stepUpUntil },
      };
    }
    if (verdict === "challenge") needsVerification = true;
  }

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

  if (!decision.required) {
    if (decision.block) {
      res.status(403).json({
        success: false,
        error: "当前网络环境被判定为高风险，已暂时限制访问",
        code: "IP_RISK_BLOCKED",
        supportEmail: "support@chloemella.com",
      });
      return true;
    }
    return false;
  }

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
