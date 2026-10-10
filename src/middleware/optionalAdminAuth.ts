import type { NextFunction, Request, Response } from "express";
import { isAdminRole } from "./auth";
import { optionalAuthenticateToken } from "./optionalAuthenticateToken";
import { assertActiveAuthSession } from "../services/authSessionService";
import { asAuthenticatedRequest, type AuthenticatedRequest } from "../types/authRequest";
import { getTokenFromRequest } from "../utils/authCookie";
import type { User } from "../utils/userStorage";

/**
 * 共享口令闸门上的「可选管理员身份」解析。
 *
 * 用于「一个共享口令守着公开端点」这类接口（公共短链创建、/api/server_status）：
 * 匿名调用照旧凭口令放行；已登录的管理员（admin / superadmin）由会话直接放行，
 * 不必再填一次口令——存活的会话本身就是比共享口令更强的凭证。
 *
 * 不能直接用 optionalAuthenticateToken：它按游客语义解析，不校验账户禁用/封停，
 * 也不校验会话是否仍有效。这个中间件换来的是跳过一道口令校验（等于放宽闸门），
 * 所以必须要求一个仍然存活的管理员会话；任一项不满足都清掉身份退回匿名，
 * 由各端点自己的口令校验决定放行与否。
 *
 * 匿名是这类端点的合法路径，因此这里永不回 401/403。
 */
export const optionalAdminAuth = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authedReq = asAuthenticatedRequest(req);
    if (!authedReq.user) {
      await optionalAuthenticateToken(req, res, () => undefined);
    }

    const user = authedReq.user;
    if (!user || (user as { disabled?: boolean }).disabled || user.accountStatus === "suspended" || !isAdminRole(user.role)) {
      clearResolvedIdentity(authedReq);
      return next();
    }

    const token = getTokenFromRequest(req);
    if (!token) {
      clearResolvedIdentity(authedReq);
      return next();
    }

    // 会话被撤销的管理员不享受免口令。
    await assertActiveAuthSession(user.id, token);
    return next();
  } catch {
    clearResolvedIdentity(asAuthenticatedRequest(req));
    return next();
  }
};

/**
 * 「管理员或匿名」闸门：用在共享口令守着、但**不允许已登录普通用户**使用的公开端点上。
 *
 * 为什么不能直接用 optionalAdminAuth 代替：它在识别出非管理员时会**清掉身份**（这是匿名口令流程
 * 能跑的前提），于是到了 handler 里，已登录的普通用户与真实访客长得一模一样 ——
 * 结果是普通用户只要知道共享口令就能用这个端点。
 *
 * 因此这里把两者区分开：拿到存活会话且角色不是管理员 → 403；其余（真匿名 / 管理员）放行。
 * 身份解析与 optionalAdminAuth 同源（optionalAuthenticateToken + 会话存活校验），
 * 只多一个判断，不再另写一套认证。
 */
export const requireAdminOrAnonymous = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authedReq = asAuthenticatedRequest(req);
    if (!authedReq.user) {
      // 只解析、不报错：解析不出身份就走匿名路径
      await optionalAuthenticateToken(req, res, () => undefined);
    }

    const user = authedReq.user as (User & { disabled?: boolean }) | undefined;
    if (!user) return next();
    if (isAdminRole(user.role)) return next();

    // 已登录的普通用户：直接拒绝，连口令都不必比
    res.status(403).json({
      error: "该功能仅限管理员使用",
      code: "ADMIN_ONLY_FEATURE",
    });
    return undefined;
  } catch {
    // 解析异常按匿名处理，口令闸门仍会拦（fail-closed）
    return next();
  }
};

/**
 * 清掉本次解析出来的身份，避免后续 handler 把「非管理员」误当成「已确认的管理员」
 * （apiKey / oauth 身份不由本中间件负责，保留原样）。
 */
function clearResolvedIdentity(req: AuthenticatedRequest): void {
  delete req.user;
  if (req.auth?.kind === "session") {
    delete req.auth;
  }
}

/** 本次请求是否已由存活会话确认为管理员；返回 null 表示调用方须走口令校验。 */
export function sessionAdmin(req: Request): User | null {
  const user = asAuthenticatedRequest(req).user;
  return user && isAdminRole(user.role) ? user : null;
}
