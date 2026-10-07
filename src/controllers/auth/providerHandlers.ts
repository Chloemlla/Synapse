import type { Request, Response } from "express";
import { bindProviderIdentityToUser } from "../../services/accountIdentityService";
import { getAuthSessionMetadata } from "../../services/authSessionService";
import {
  getGoogleAuthConfigSummary,
  isGoogleAuthEnabled,
  startGoogleBindSession,
  verifyGoogleIdToken,
} from "../../services/googleAuthService";
import { getLinuxDoConfigSummary } from "../../services/linuxDoAuthService";
import { hasValidSecuritySession } from "../../utils/securitySession";
import {
  confirmProviderBindSession,
  getProviderBindSessionView,
} from "../../services/providerBindSessionService";
import { getClientIP } from "../../utils/ipUtils";
import logger from "../../utils/logger";
import type { User } from "../../utils/userStorage";
import {
  buildAccountSuspendedBody,
  isAccountSuspendedFailure,
} from "../../services/providerAuthErrors";

/**
 * 第三方登录/绑定的统一失败响应。
 *
 * 封停账户必须走全仓统一契约 `403 + code: ACCOUNT_SUSPENDED + supportEmail`（与
 * loginHandlers / sessionHandlers / authenticateToken 一致）——前端
 * `classifyPenaltyAppeal` 靠这个 code 弹申诉入口；此前这几个 handler 一律 400、
 * 只给一句文案，用户既看不懂也拿不到申诉通道。
 * 封停是预期内的拒绝，不打 `logger.error` + 堆栈。
 *
 * `statusFromMessage` 只给还需要保留细分状态的 handler 用（目前是绑定确认页，
 * 它另有 401 密码错 / 410 会话过期两个分支）；不传则非封停错误一律 400（改动前行为）。
 */
function sendProviderAuthFailure(
  res: Response,
  error: unknown,
  options: {
    fallbackMessage: string;
    logLabel: string;
    statusFromMessage?: (message: string) => number;
  },
): Response {
  const message = error instanceof Error ? error.message : options.fallbackMessage;

  if (isAccountSuspendedFailure(error)) {
    logger.warn(options.logLabel, { reason: "account-suspended" });
    return res.status(403).json(buildAccountSuspendedBody(message));
  }

  logger.error(options.logLabel, error);
  const status = options.statusFromMessage ? options.statusFromMessage(message) : 400;
  return res.status(status).json({ error: message || options.fallbackMessage });
}

export function getGoogleAuthConfig(req: Request, res: Response) {
  const target =
    req.query.client === "synapse-android" || req.query.platform === "android"
      ? "synapse-android"
      : "web";
  res.json(getGoogleAuthConfigSummary(target));
}

export function getAuthProvidersPublicConfig(_req: Request, res: Response) {
  res.json({
    google: getGoogleAuthConfigSummary("web"),
    linuxdo: getLinuxDoConfigSummary(),
  });
}

export async function googleAuth(req: Request, res: Response) {
  try {
    if (!isGoogleAuthEnabled()) {
      return res.status(503).json({ error: "Google 登录未配置" });
    }

    const idToken = typeof req.body?.idToken === "string" ? req.body.idToken : "";
    if (!idToken) {
      return res.status(400).json({ error: "缺少 Google idToken" });
    }

    // G2-03: 未绑定的 Google 身份不再按邮箱静默并号，一律返回 requiresBinding，
    // 由前端引导用户验密绑定后再登录。
    const payload = await startGoogleBindSession({
      idToken,
      clientIp: getClientIP(req),
      sessionMetadata: getAuthSessionMetadata(req, { ipAddress: getClientIP(req) }),
    });

    return res.json(payload);
  } catch (error) {
    return sendProviderAuthFailure(res, error, {
      fallbackMessage: "Google 登录失败",
      logLabel: "[Google Auth] Login failed",
    });
  }
}

export async function googleBindSession(req: Request, res: Response) {
  try {
    if (!isGoogleAuthEnabled()) {
      return res.status(503).json({ error: "Google 登录未配置" });
    }

    const idToken = typeof req.body?.idToken === "string" ? req.body.idToken : "";
    if (!idToken) {
      return res.status(400).json({ error: "缺少 Google idToken" });
    }

    const result = await startGoogleBindSession({
      idToken,
      clientIp: getClientIP(req),
      sessionMetadata: getAuthSessionMetadata(req, { ipAddress: getClientIP(req) }),
    });

    return res.json(result);
  } catch (error) {
    return sendProviderAuthFailure(res, error, {
      fallbackMessage: "Google 登录失败",
      logLabel: "[Google Auth] Bind session failed",
    });
  }
}

export async function getProviderBindSession(req: Request, res: Response) {
  const sessionToken = typeof req.body?.sessionToken === "string" ? req.body.sessionToken : "";
  if (!sessionToken) {
    return res.status(400).json({ error: "缺少第三方登录绑定会话" });
  }

  const session = await getProviderBindSessionView(sessionToken);
  if (!session) {
    // 与 confirmProviderBind 的"已过期"分支统一成 410：同一种状态不该在两个接口上
    // 分别表现为 404 与 410（前端两处提示也因此能对齐）。
    return res.status(410).json({
      error: "第三方登录绑定会话已过期，请返回登录页重试",
      code: "PROVIDER_BIND_SESSION_EXPIRED",
    });
  }

  return res.json({ success: true, session });
}

export async function confirmProviderBind(req: Request, res: Response) {
  try {
    const syncProfileInput =
      req.body?.syncProfile && typeof req.body.syncProfile === "object" ? req.body.syncProfile : {};
    const result = await confirmProviderBindSession({
      sessionToken: typeof req.body?.sessionToken === "string" ? req.body.sessionToken : "",
      identifier: typeof req.body?.identifier === "string" ? req.body.identifier : "",
      password: typeof req.body?.password === "string" ? req.body.password : "",
      acceptedTerms: req.body?.acceptedTerms === true,
      syncProfile: {
        username: syncProfileInput.username === true,
        avatar: syncProfileInput.avatar !== false,
      },
      clientIp: getClientIP(req),
      userAgent: String(req.headers["user-agent"] || ""),
      path: req.originalUrl || req.path,
      method: req.method,
      requestId: typeof (req as any).requestId === "string" ? (req as any).requestId : undefined,
    });

    if (result.status === "conflict") {
      return res.status(409).json(result);
    }

    return res.json(result);
  } catch (error) {
    return sendProviderAuthFailure(res, error, {
      fallbackMessage: "第三方登录绑定失败",
      logLabel: "[Auth] Provider bind confirm failed",
      statusFromMessage: (text) =>
        text.includes("尝试次数过多")
          ? 429
          : text.includes("用户名/邮箱或密码错误")
            ? 401
            : text.includes("已过期")
              ? 410
              : 400,
    });
  }
}

export async function googleBind(req: Request, res: Response) {
  try {
    if (!isGoogleAuthEnabled()) {
      return res.status(503).json({ error: "Google 登录未配置" });
    }

    const currentUser = (req as any).user as User | undefined;
    if (!currentUser?.id) {
      return res.status(401).json({ error: "未登录" });
    }

    const idToken = typeof req.body?.idToken === "string" ? req.body.idToken : "";
    if (!idToken) {
      return res.status(400).json({ error: "缺少 Google idToken" });
    }
    if (!hasValidSecuritySession(req)) {
      return res.status(401).json({ error: "请先完成身份验证" });
    }

    const profile = await verifyGoogleIdToken(idToken);
    const result = await bindProviderIdentityToUser({
      targetUser: currentUser,
      profile: {
        provider: "google",
        providerUserId: profile.id,
        providerEmail: profile.email,
        providerUsername: profile.name,
        avatarUrl: profile.avatarUrl,
      },
      actor: {
        userId: currentUser.id,
        username: currentUser.username,
        role: currentUser.role,
        ip: getClientIP(req),
        userAgent: String(req.headers["user-agent"] || ""),
        path: req.originalUrl || req.path,
        method: req.method,
        requestId: typeof (req as any).requestId === "string" ? (req as any).requestId : undefined,
      },
    });

    return res.json(result);
  } catch (error) {
    return sendProviderAuthFailure(res, error, {
      fallbackMessage: "Google 绑定失败",
      logLabel: "[Google Auth] Bind failed",
    });
  }
}
