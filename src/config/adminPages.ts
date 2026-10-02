/**
 * 管理面板「页面 → 可访问 API 前缀」登记表。
 *
 * 为什么需要它：普通管理员的权限判据必须能落到「这个请求属于哪个页面」上，
 * 而请求侧只有 URL。所以每个可授权的管理页面在这里登记一次它需要的 API 前缀；
 * 具体**谁**能拿到哪些页面由运行时配置决定（`services/adminScopeConfigService.ts`）。
 *
 * 约定：
 *  - `key` 与前端 `/admin/<key>` 的路径段对齐（`/admin/store/cdks` → `store/cdks`，
 *    总览 `/admin` → `dashboard`），前端不必再维护第二份清单。
 *  - **没登记 `apiPrefixes` 的页面 = 只能授权给超管**（fail-closed）：把它授给普通管理员
 *    只会放出导航入口，页面里的请求仍会被守卫拒掉。这样「漏登记」是可见的功能缺失，
 *    而不是权限被放宽。
 *  - 新增管理页面时加一条即可；前缀以页面自己发的请求为准（mount path 见
 *    `src/routes/routeModules/*.ts`，子路由见 `src/routes/admin/*.ts`）。
 */

export interface AdminPageDefinition {
  /** 与 /admin/<key> 对齐的稳定标识。 */
  key: string;
  /** 超管配置界面里的可读名。 */
  label: string;
  /** 该页面需要的管理端 API 前缀（前缀匹配：相等或以 `<prefix>/` 开头）。 */
  apiPrefixes: readonly string[];
}

export const ADMIN_PAGES: readonly AdminPageDefinition[] = [
  // 总览：任何人都能看到自己的入口列表，本身不需要额外 API。
  { key: "dashboard", label: "管理总览", apiPrefixes: [] },
  { key: "users", label: "用户管理", apiPrefixes: ["/api/admin/users"] },
  { key: "apikeys", label: "API Key 管理", apiPrefixes: ["/api/apikeys"] },
  {
    key: "apikey-billing",
    label: "API Key 计费",
    apiPrefixes: ["/api/admin/apikey-billing", "/api/apikeys/billing"],
  },
  { key: "oauth", label: "OAuth 接入", apiPrefixes: ["/api/oauth"] },
  {
    key: "registration-invites",
    label: "注册邀请码",
    apiPrefixes: ["/api/admin/registration-invites"],
  },
  { key: "audit-log", label: "操作审计", apiPrefixes: ["/api/admin/audit-logs"] },
  { key: "translation-audit", label: "翻译审计", apiPrefixes: ["/api/admin/translation-logs"] },
  { key: "tts-history", label: "TTS 生成记录", apiPrefixes: ["/api/tts/admin"] },
  { key: "media-tool", label: "媒体工具", apiPrefixes: ["/api/admin/media-tool"] },
  { key: "crash-reports", label: "崩溃报告", apiPrefixes: ["/api/admin/crash-reports"] },
  { key: "ip-risk-logs", label: "IP 风险日志", apiPrefixes: ["/api/admin/proxycheck"] },
  {
    key: "mobile-token-lineage",
    label: "登录令牌血缘",
    apiPrefixes: ["/api/admin/mobile-token"],
  },
  { key: "policy-consents", label: "政策同意记录", apiPrefixes: ["/api/admin/policy-consents"] },
  { key: "qq-guard", label: "QQ 群守卫", apiPrefixes: ["/api/admin/qq-guard"] },
  { key: "shortlink", label: "短链管理", apiPrefixes: ["/api/admin/shortlinks", "/api/shorturl"] },
  { key: "broadcast", label: "广播推送", apiPrefixes: ["/api/admin/broadcast"] },
  { key: "webhookevents", label: "Webhook 事件", apiPrefixes: ["/api/webhooks"] },
  {
    key: "integrations",
    label: "集成健康中心",
    apiPrefixes: ["/api/admin/integrations"],
  },
  { key: "data-collection", label: "数据采集", apiPrefixes: ["/api/data-collection/admin"] },
  { key: "github-billing-cache", label: "GitHub 计费缓存", apiPrefixes: ["/api/github-billing"] },
  { key: "fbiwanted", label: "FBI 通缉数据", apiPrefixes: ["/api/fbi-wanted"] },
  { key: "store/cdks", label: "CDK 管理", apiPrefixes: ["/api/cdks"] },
  { key: "store/resources", label: "资源管理", apiPrefixes: ["/api/resources", "/api/categories"] },
  { key: "ecoenchants", label: "EcoEnchants 授权", apiPrefixes: ["/api/ecoenchants"] },
  { key: "ecoenchants-ops", label: "EcoEnchants 远程运维", apiPrefixes: ["/api/ecoenchants"] },
  { key: "markdown-articles", label: "Markdown 文章", apiPrefixes: ["/api/articles"] },
  { key: "coin-flip", label: "抛硬币", apiPrefixes: ["/api/coin-flip"] },
  { key: "lottery", label: "抽奖管理", apiPrefixes: ["/api/lottery"] },
  { key: "command", label: "命令管理", apiPrefixes: ["/api/command"] },
  { key: "outemail", label: "邮件发送", apiPrefixes: ["/api/outemail", "/api/email"] },
  { key: "captcha-providers", label: "验证码渠道", apiPrefixes: ["/api/turnstile"] },
  { key: "humancheck", label: "人机验证", apiPrefixes: ["/api/human-check"] },
  { key: "tamper", label: "篡改检测", apiPrefixes: ["/api/tamper"] },
  { key: "ipfs", label: "IPFS 上传", apiPrefixes: ["/api/ipfs"] },

  // 以下页面尚未登记 API 范围：授给普通管理员只会放出导航入口，页面内请求仍 403。
  // 需要放开时按上面同样的格式补 `apiPrefixes`（前缀取自该页面实际请求）。
  { key: "announcement", label: "公告管理", apiPrefixes: [] },
  { key: "librechat", label: "LibreChat 管理", apiPrefixes: [] },
  { key: "bilibili-sync", label: "PiliPlus 设置同步", apiPrefixes: [] },
  { key: "bilibili-data", label: "B 站凭据与设备", apiPrefixes: [] },
  { key: "store", label: "资源商店", apiPrefixes: [] },
  { key: "logshare", label: "日志分享", apiPrefixes: [] },
  { key: "env", label: "运行时配置", apiPrefixes: [] },
  { key: "system", label: "系统管理", apiPrefixes: [] },
  { key: "fingerprint", label: "指纹管理", apiPrefixes: [] },
  { key: "ip-ban", label: "IP 封禁", apiPrefixes: [] },
  { key: "mail-system", label: "邮件系统", apiPrefixes: [] },
  { key: "shorturlmigration", label: "短链迁移", apiPrefixes: [] },
  { key: "nexai-security", label: "NexAI 安全", apiPrefixes: [] },
  { key: "tamper-detection-demo", label: "篡改检测演示", apiPrefixes: [] },
  { key: "email-sender", label: "邮件发送（总览）", apiPrefixes: [] },
  { key: "tickets", label: "工单管理", apiPrefixes: [] },
];

const ADMIN_PAGE_BY_KEY = new Map(ADMIN_PAGES.map((page) => [page.key, page]));

/** 未配置运行时授权时，普通管理员的默认页面（与历史行为一致）。 */
export const DEFAULT_PLAIN_ADMIN_PAGES: readonly string[] = ["users", "apikeys", "apikey-billing", "oauth"];

/** 总览页对任何管理员可见：它是入口列表本身，不是特权功能。 */
export const ALWAYS_VISIBLE_ADMIN_PAGES: readonly string[] = ["dashboard"];

export function isKnownAdminPage(key: string): boolean {
  return ADMIN_PAGE_BY_KEY.has(key);
}

export function getAdminPage(key: string): AdminPageDefinition | undefined {
  return ADMIN_PAGE_BY_KEY.get(key);
}

export function listAdminPageKeys(): string[] {
  return ADMIN_PAGES.map((page) => page.key);
}

/** 去掉 query、折叠重复斜杠、去尾斜杠后的规范路径（守卫与登记表共用同一套归一）。 */
export function normalizeAdminScopePath(value: string): string {
  const withoutQuery = (value || "").split("?")[0] || "";
  const collapsed = withoutQuery.replace(/\/{2,}/g, "/");
  return collapsed.length > 1 ? collapsed.replace(/\/$/, "") : collapsed;
}

function matchesAnyPrefix(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/** 该路径是否落在某个页面的 API 范围内。 */
export function isAdminPageApiPath(pageKey: string, fullPath: string): boolean {
  const page = ADMIN_PAGE_BY_KEY.get(pageKey);
  if (!page) return false;
  return matchesAnyPrefix(normalizeAdminScopePath(fullPath), page.apiPrefixes);
}

/** 哪些页面覆盖该请求路径（用于日志与 403 里提示「需要哪个页面」）。 */
export function resolveAdminPagesForPath(fullPath: string): string[] {
  const normalized = normalizeAdminScopePath(fullPath);
  return ADMIN_PAGES.filter((page) =>
    matchesAnyPrefix(normalized, page.apiPrefixes),
  ).map((page) => page.key);
}

/** 给定授权页面集合，判断该路径是否被其中任一页覆盖。 */
export function isAdminPathAllowedForPages(fullPath: string, grantedPageKeys: readonly string[]): boolean {
  const normalized = normalizeAdminScopePath(fullPath);
  return grantedPageKeys.some((key) => {
    const page = ADMIN_PAGE_BY_KEY.get(key);
    return Boolean(page) && matchesAnyPrefix(normalized, page.apiPrefixes);
  });
}

/**
 * 把运行时配置里的页面清单规整成可用集合：
 *  - 去重、去空、只保留字符串；
 *  - 总览始终可见（否则普通管理员进 `/admin` 会被自己的配置锁死）；
 *  - **不做「未知页面」过滤**：新功能可能先于登记表出现，留着它只会放出入口、
 *    不会放宽 API（未知页面没有 apiPrefixes），由配置界面提示即可。
 */
export function normalizeGrantedPages(pages: readonly unknown[]): string[] {
  const result = new Set<string>(ALWAYS_VISIBLE_ADMIN_PAGES);
  for (const page of pages) {
    if (typeof page === "string" && page.trim()) {
      result.add(page.trim());
    }
  }
  return [...result];
}

/** 给定页面集合，汇总它们的 API 前缀（供默认集合与调试使用）。 */
export function getApiPrefixesForPages(pages: readonly string[]): string[] {
  const result = new Set<string>();
  for (const key of pages) {
    const page = ADMIN_PAGE_BY_KEY.get(key);
    if (!page) continue;
    for (const prefix of page.apiPrefixes) result.add(prefix);
  }
  return [...result];
}

/** 只保留登记表里有 API 范围的页面（配置界面用它提示「哪些授权暂时没有实际效果」）。 */
export function pagesWithoutApiScope(pages: readonly string[]): string[] {
  return pages.filter((key) => {
    const page = ADMIN_PAGE_BY_KEY.get(key);
    return !page || page.apiPrefixes.length === 0;
  });
}
