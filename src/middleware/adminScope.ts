import type { NextFunction, Request, Response } from "express";
import logger from "../utils/logger";
import { isAdminRole } from "./auth";

/**
 * 普通管理员（role = "admin"）的管理端权限范围收窄。
 *
 * 策略：**只给普通管理员开放三块业务能力**，其余管理端页面与后端接口一律 superadmin：
 *   1. 用户管理          → `/api/admin/users*`（含用户自助端点 `/api/admin/user/profile|avatar|fingerprint`）
 *   2. API Key 管理       → `/api/apikeys*`
 *   3. OAuth 客户端/授权管理 → `/api/oauth*`（历史设计里 admin 的写权限例外也只有这一块）
 *   4. API Key 计费（同一页面视图）→ `/api/admin/apikey-billing*`、`/api/apikeys/billing*`
 *
 * 实现要点：
 *  - **fail-closed**：这个守卫只应该挂在「已完成管理员认证」的位置（如 `authenticateAdmin` 之后，
 *    或 `/api/admin` 的挂载级 adminAuthMiddleware 里）。因此它自己再校一次角色：
 *    匿名 / 非管理员一律 403，不依赖「目标路由应该记得自己加守卫」这个假设。
 *    挂错位置只会更严，不会因为“反正后面有守卫”而漏人。
 *  - 唯一例外是 `/api/admin` 下的**用户自助端点**（`/user/profile|avatar|fingerprint`）：
 *    它们是普通登录用户的接口，只是碰巧住在 `/api/admin` 前缀下，由挂载级 `authMiddleware` 先认证，
 *    因此这里放行。其余任何路径都必须先通过管理员角色校验。
 *  - 判定用挂载后的完整路径（`req.baseUrl + req.path`），所以同一守卫在任意 router 里都能用。
 *  - 新增管理端页面/接口默认落在「未允许」一侧：要么显式加进
 *    `PLAIN_ADMIN_ALLOWED_PREFIXES`，要么就是 superadmin 专属。
 */

/** 普通管理员仍可用的管理端路径前缀（其余管理端一律 superadmin）。 */
export const PLAIN_ADMIN_ALLOWED_PREFIXES: readonly string[] = [
  "/api/admin/users",
  "/api/admin/apikey-billing",
  "/api/apikeys",
  "/api/oauth",
];

/** `/api/admin` 下的用户自助端点：任何登录用户都可用，管理员范围收窄不影响它们。 */
export const ADMIN_USER_SELF_SERVICE_PREFIXES: readonly string[] = [
  "/api/admin/user/profile",
  "/api/admin/user/avatar",
  "/api/admin/user/fingerprint",
];

function matchesAnyPrefix(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/** 去掉 query、折叠重复斜杠，得到用于前缀判定的规范路径。 */
export function normalizeAdminScopePath(value: string): string {
  const withoutQuery = (value || "").split("?")[0] || "";
  const collapsed = withoutQuery.replace(/\/{2,}/g, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/$/, "") : collapsed;
}

export function isPlainAdminAllowedPath(fullPath: string): boolean {
  return matchesAnyPrefix(normalizeAdminScopePath(fullPath), PLAIN_ADMIN_ALLOWED_PREFIXES);
}

export function isAdminUserSelfServicePath(fullPath: string): boolean {
  return matchesAnyPrefix(normalizeAdminScopePath(fullPath), ADMIN_USER_SELF_SERVICE_PREFIXES);
}

/**
 * 管理员范围守卫。挂在**认证之后**（req.user 已就绪）的位置，并且自身 fail-closed：
 *  - 匿名 / 非管理员 → 403 `ADMIN_REQUIRED`（挂错位置只会更严，不会漏人）；
 *  - superadmin → 放行；
 *  - 普通管理员 → 只有用户管理 / API Key / API Key 计费 / OAuth 管理前缀放行，其余 403 `ADMIN_SCOPE_FORBIDDEN`。
 */
export function requireAdminScope(req: Request, res: Response, next: NextFunction): void {
  const user = (req as Request & { user?: { id?: string; role?: string } }).user;
  const fullPath = `${req.baseUrl || ""}${req.path || ""}`;

  // 用户自助端点（普通登录用户的接口，只是住在 /api/admin 前缀下）：由挂载级 authMiddleware 先认证。
  if (isAdminUserSelfServicePath(fullPath)) {
    next();
    return;
  }

  if (!user || !isAdminRole(user.role)) {
    logger.warn("[AdminScope] 未通过管理员认证就到达范围守卫（应为挂载次序错误）", {
      method: req.method,
      path: fullPath,
    });
    res.status(403).json({ error: "需要管理员权限", code: "ADMIN_REQUIRED" });
    return;
  }

  if (user.role === "superadmin") {
    next();
    return;
  }

  if (isPlainAdminAllowedPath(fullPath)) {
    next();
    return;
  }

  logger.warn("[AdminScope] 普通管理员访问超出授权范围的管理端接口", {
    userId: user.id,
    method: req.method,
    path: fullPath,
  });
  res.status(403).json({
    error: "该功能仅超级管理员可用，普通管理员仅可访问用户管理、API Key 与 OAuth 管理",
    code: "ADMIN_SCOPE_FORBIDDEN",
  });
}
