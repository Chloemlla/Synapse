/**
 * RBAC helpers for the frontend UI tiering.
 *
 * `superadmin` is a superset of `admin`: everything admin can see,
 * superadmin can see too. The backend is the source of truth for
 * authorization; these helpers only drive UI visibility.
 *
 * 普通管理员（role = "admin"）能看到哪些管理页面，由**服务端**决定：
 *   `GET /api/admin/admin-scope/me` → `pages`（页面 key 数组，见 src/config/adminPages.ts）。
 * 本文件里那份写死的清单只剩两个用途：
 *   1. 服务端授权拿不到时的**回退值**（fail-closed：回退到历史最小集合，不放大权限）；
 *   2. 超管（服务端直接返回全部页面，不会走到回退）。
 * 之所以保留回退而不是「拿不到就全挡」：授权请求失败时把普通管理员彻底挡在管理端之外，
 * 属于把可用性事故当成安全策略；而回退集合恰是历史行为，不会比改动前更宽。
 */

export function isAdminRole(role?: string | null): boolean {
  return role === 'admin' || role === 'superadmin';
}

export function isSuperAdmin(role?: string | null): boolean {
  return role === 'superadmin';
}

/**
 * 回退页面集合 —— 与后端 `src/config/adminPages.ts` 的 `DEFAULT_PLAIN_ADMIN_PAGES` 同口径。
 * 只在 `/api/admin/admin-scope/me` 请求失败时生效；正常情况下以服务端返回的 `pages` 为准。
 */
export const PLAIN_ADMIN_FALLBACK_PAGES: readonly string[] = [
  'users',
  'apikeys',
  'apikey-billing',
  'oauth',
];

/**
 * 入口（模块 key / URL）→ 授权页面 key 的别名。
 *
 * 只在「多个入口共用同一份 API 面」时使用：一条 `/api/...` 前缀只登记在一个页面 key 上，
 * 否则两个 key 会让人觉得「可以只授其一」，实际授任何一个都同时放开同一批接口。
 */
const ADMIN_MODULE_PAGE_ALIASES: Readonly<Record<string, string>> = {
  // 邮件溯源与邮件外发是同一套 /api/outemail 的两个视图，授权 key 统一为 `outemail`
  // （登记表里的 label 已改成「邮件外发与溯源」）。
  'email-traceability': 'outemail',
};

/** 归一化服务端返回的授权集合；空/缺失时回退。 */
export function normalizeGrantedPages(pages?: readonly string[] | null): readonly string[] {
  if (!pages || pages.length === 0) return PLAIN_ADMIN_FALLBACK_PAGES;
  return pages;
}

/** 模块 key（`/admin/<module>` 的路径段，如 `store/cdks`）→ 授权页面 key。 */
export function adminPageKeyForModule(module: string): string {
  const clean = module.replace(/^\/+|\/+$/g, '');
  return ADMIN_MODULE_PAGE_ALIASES[clean] ?? clean;
}

/** `/admin/store/cdks?x=1` → `store/cdks`；非 `/admin/<module>` 返回 null。 */
export function adminModuleFromUrl(url?: string | null): string | null {
  if (!url) return null;
  const path = url.split('?')[0].split('#')[0].replace(/\/+$/, '');
  const match = /^\/admin\/(.+)$/.exec(path);
  if (!match) return null;
  return match[1];
}

/** 普通管理员是否被授予该模块（模块 key 或 `/admin/<module>` URL 都可传）。 */
export function isAdminModuleGranted(
  moduleOrUrl: string,
  grantedPages?: readonly string[] | null,
): boolean {
  const module = moduleOrUrl.startsWith('/admin/')
    ? adminModuleFromUrl(moduleOrUrl)
    : moduleOrUrl;
  if (!module) return false;
  const pageKey = adminPageKeyForModule(module);
  return normalizeGrantedPages(grantedPages).includes(pageKey);
}

/**
 * 某个用户是否被允许访问该管理端页面/模块。
 *
 * @param grantedPages 服务端返回的页面 key 集合；`undefined` 表示尚未拿到（按回退集合判定）。
 */
export function canAccessAdminModule(
  role: string | null | undefined,
  moduleOrUrl: string,
  grantedPages?: readonly string[] | null,
): boolean {
  if (!isAdminRole(role)) return false;
  if (isSuperAdmin(role)) return true;
  return isAdminModuleGranted(moduleOrUrl, grantedPages);
}

/** 兼容旧调用点：普通管理员是否可访问该模块（未传授权集合时按回退集合判定）。 */
export function isPlainAdminAllowedAdminModule(
  module?: string | null,
  grantedPages?: readonly string[] | null,
): boolean {
  if (!module) return false;
  return isAdminModuleGranted(module, grantedPages);
}

/** 兼容旧调用点：普通管理员是否可访问该 `/admin/**` 路径。 */
export function isPlainAdminAllowedAdminPath(
  url?: string | null,
  grantedPages?: readonly string[] | null,
): boolean {
  if (!url) return false;
  return isAdminModuleGranted(url, grantedPages);
}

/**
 * 旧名的聚合入口，保留给导航/总览做「非 /admin/** 场景」的兜底判定
 * （例如 `/email-sender`、`/nexai-security`、`/tamper-detection-demo` 这类独立路由）。
 */
export function canAccessAdminSurface(
  role: string | null | undefined,
  target: string,
  grantedPages?: readonly string[] | null,
): boolean {
  if (!isAdminRole(role)) return false;
  if (isSuperAdmin(role)) return true;
  const module = adminModuleFromUrl(target);
  if (module) return isAdminModuleGranted(module, grantedPages);
  // 非 /admin/** 的独立管理路由：登记表里按同名页面 key 授权（如 tamper-detection-demo）
  return isAdminModuleGranted(target.replace(/^\//, ''), grantedPages);
}

/** 供测试与调用方使用的别名表快照。 */
export function adminModulePageAliases(): Readonly<Record<string, string>> {
  return ADMIN_MODULE_PAGE_ALIASES;
}
