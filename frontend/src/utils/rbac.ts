/**
 * RBAC helpers for the frontend UI tiering.
 *
 * `superadmin` is a superset of `admin`: everything admin can see,
 * superadmin can see too. The backend is the source of truth for
 * authorization; these helpers only drive UI visibility.
 */

export function isAdminRole(role?: string | null): boolean {
  return role === 'admin' || role === 'superadmin';
}

export function isSuperAdmin(role?: string | null): boolean {
  return role === 'superadmin';
}

/**
 * 普通管理员（role = "admin"）仍然可用的管理端能力：只有这三块业务 + API Key 计费视图。
 * 其余管理端页面与接口一律 superadmin —— 与后端 `middleware/adminScope.ts` 的
 * `PLAIN_ADMIN_ALLOWED_PREFIXES` 同口径，两边必须一起改。
 */
export const PLAIN_ADMIN_ADMIN_MODULES: readonly string[] = ['users', 'oauth', 'apikeys', 'apikey-billing'];

/** 对应的页面路径（导航项 / 路由判定用）。 */
export const PLAIN_ADMIN_ADMIN_PATHS: readonly string[] = [
  '/admin/users',
  '/admin/oauth',
  '/admin/apikeys',
  '/admin/apikey-billing',
];

export function isPlainAdminAllowedAdminModule(module?: string | null): boolean {
  if (!module) return false;
  return PLAIN_ADMIN_ADMIN_MODULES.includes(module);
}

/** 非管理员返回 true（调用方自己判断 isAdminRole）；普通管理员只允许白名单页面。 */
export function isPlainAdminAllowedAdminPath(url?: string | null): boolean {
  if (!url) return false;
  return PLAIN_ADMIN_ADMIN_PATHS.some((path) => url === path || url.startsWith(`${path}/`));
}

/** 某个用户是否被允许访问该管理端页面/模块。 */
export function canAccessAdminSurface(role: string | null | undefined, target: string): boolean {
  if (!isAdminRole(role)) return false;
  if (isSuperAdmin(role)) return true;
  return isPlainAdminAllowedAdminPath(target) || isPlainAdminAllowedAdminModule(target);
}
