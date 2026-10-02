import type { NextFunction, Request, Response } from "express";
import logger from "../utils/logger";
import { isAdminRole } from "./auth";
import {
  DEFAULT_PLAIN_ADMIN_PAGES,
  getApiPrefixesForPages,
  isAdminPathAllowedForPages,
  normalizeAdminScopePath,
  resolveAdminPagesForPath,
} from "../config/adminPages";
import { getPagesForUser } from "../services/adminScopeConfigService";

/**
 * 普通管理员（role = "admin"）的管理端范围守卫。
 *
 * 判据来源：
 *  - **谁**能访问哪些页面 → 运行时配置（`services/adminScopeConfigService.ts`，超管在线可改）。
 *  - **页面**对应哪些 API → 登记表（`config/adminPages.ts`，新增页面时登记一次）。
 *   这里没有任何写死的页面清单，加新功能只需要在登记表里加一条。
 *
 * 实现要点：
 *  - **fail-closed**：守卫只应挂在「已完成管理员认证」的位置（`authenticateAdmin` 之后，
 *    或 `/api/admin` 的挂载级认证之后）。它自己再校一次角色：匿名 / 非管理员一律 403，
 *    不依赖「目标路由应该记得自己加守卫」这个假设。挂错位置只会更严，不会漏人。
 *  - 判定用挂载后的完整路径（`req.baseUrl + req.path`），所以同一守卫在任意 router 里都能用。
 *  - 配置读不到时退回默认页面集合（= 历史行为），属于收窄而不是放宽。
 *  - 未登记 API 范围的页面不会带来任何放行 —— 「漏登记」是功能缺失，不是权限漏洞。
 */

/** `/api/admin` 下的用户自助端点：任何登录用户都可用，管理员范围收窄不影响它们。 */
export const ADMIN_USER_SELF_SERVICE_PREFIXES: readonly string[] = [
  "/api/admin/user/profile",
  "/api/admin/user/avatar",
  "/api/admin/user/fingerprint",
];

/**
 * 只要求「是管理员」，不要求具体页面权限的端点。
 *  - `/api/admin/verify-access`：AdminGuard 用它确认「当前会话确实是管理员」，
 *    只比对调用方自己的身份，不带出任何业务数据；此前它落进了页面权限判定，
 *    导致普通管理员一进 `/admin` 就被 403 + 告警日志。
 *  - `/api/admin/admin-scope/me`：回调用方自己的可见页面列表，是权限展示本身。
 */
export const ADMIN_ANY_ROLE_PREFIXES: readonly string[] = [
  "/api/admin/verify-access",
  "/api/admin/admin-scope/me",
];

/** 兼容旧引用：默认（未配置运行时授权时）普通管理员可用的 API 前缀（由页面登记表推导）。 */
export const PLAIN_ADMIN_ALLOWED_PREFIXES: readonly string[] = getApiPrefixesForPages(DEFAULT_PLAIN_ADMIN_PAGES);

function matchesAnyPrefix(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export { normalizeAdminScopePath };

export function isAdminUserSelfServicePath(fullPath: string): boolean {
  return matchesAnyPrefix(normalizeAdminScopePath(fullPath), ADMIN_USER_SELF_SERVICE_PREFIXES);
}

/** 只要求管理员身份、不参与页面授权的路径。 */
export function isAdminAnyRolePath(fullPath: string): boolean {
  return matchesAnyPrefix(normalizeAdminScopePath(fullPath), ADMIN_ANY_ROLE_PREFIXES);
}

/** 该路径是否落在「默认页面集合」的 API 范围内（未配置运行时授权时即为放行集合）。 */
export function isPlainAdminAllowedPath(fullPath: string): boolean {
  return isAdminPathAllowedForPages(fullPath, DEFAULT_PLAIN_ADMIN_PAGES);
}

/**
 * 管理员范围守卫。挂在**认证之后**（req.user 已就绪）的位置，并且自身 fail-closed：
 *  - 匿名 / 非管理员 → 403 `ADMIN_REQUIRED`（挂错位置只会更严，不会漏人）；
 *  - 只要求管理员身份的端点 → 放行；
 *  - superadmin → 放行；
 *  - 普通管理员 → 按运行时配置判页面，命中页面登记表的 API 前缀才放行，否则 403 `ADMIN_SCOPE_FORBIDDEN`。
 *
 * 返回 Promise，调用方应当 `await`（Express 5 会等待返回的 Promise）；
 * 函数内部已兜住异常，不会抛给上层。
 */
export async function requireAdminScope(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = (req as Request & { user?: { id?: string; role?: string } }).user;
  const fullPath = `${req.baseUrl || ""}${req.path || ""}`;

  try {
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

    // 只要求管理员身份的端点：不参与页面授权。
    if (isAdminAnyRolePath(fullPath)) {
      next();
      return;
    }

    if (user.role === "superadmin") {
      next();
      return;
    }

    const grantedPages = user.id ? await getPagesForUser(user.id) : [];

    if (isAdminPathAllowedForPages(fullPath, grantedPages)) {
      next();
      return;
    }

    logger.warn("[AdminScope] 普通管理员访问超出授权范围的管理端接口", {
      userId: user.id,
      method: req.method,
      path: fullPath,
      // 告警里带上「这个接口属于哪个页面」，便于一眼看出该给谁开哪个页面。
      requiredPages: resolveAdminPagesForPath(fullPath),
      grantedPages,
    });
    res.status(403).json({
      error: "该功能未对你的账号开放，请联系超级管理员分配对应页面权限",
      code: "ADMIN_SCOPE_FORBIDDEN",
      requiredPages: resolveAdminPagesForPath(fullPath),
    });
  } catch (error) {
    // 守卫自身出错时 fail-closed：宁可拒掉一个请求，也不放开管理端。
    logger.error("[AdminScope] 范围判定异常，已按拒绝处理", {
      path: fullPath,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(403).json({ error: "管理端权限校验失败", code: "ADMIN_SCOPE_FORBIDDEN" });
  }
}
