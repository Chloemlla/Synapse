import { describe, expect, it } from 'vitest';
import { ADMIN_MODULE_LOADERS } from '../components/admin/adminModules';
import { getAdminNavGroups } from '../navigation/navConfig';
import { adminPageKeyForModule } from '../utils/rbac';

/**
 * 十月十七日批次补齐的四个管理页：入册、可授权、且默认不授予普通管理员。
 *
 * 为什么钉这几条：新增页面最容易出的两类事故是
 *   1. 只在 `adminModules` 里登记、忘了在 `adminPages` 里写 API 前缀 ——
 *      授给普通管理员时只放出导航入口，页面里每个请求都 403；
 *   2. 忘写 `requiredPage` —— 侧栏对普通管理员也显示入口，点进去全 403。
 * 这两类都不会让 CI 变红，只会让运维在线上困惑。
 */
const NEW_PAGES = [
  { key: 'account-risk', url: '/admin/account-risk' },
  { key: 'rate-limits', url: '/admin/rate-limits' },
  { key: 'tickets', url: '/admin/tickets' },
  { key: 'doc-tool', url: '/admin/doc-tool' },
] as const;

describe('十月十七日批次新增的管理页', () => {
  it('每个页面都在模块注册表里有装载器', () => {
    for (const page of NEW_PAGES) {
      expect(Object.prototype.hasOwnProperty.call(ADMIN_MODULE_LOADERS, page.key)).toBe(true);
    }
  });

  it('模块 key 能映射到授权页面 key（与后端 adminPages 的 key 对齐）', () => {
    for (const page of NEW_PAGES) {
      // 页面授权的判据是「/admin/<module> → 页面 key」；映射错位会让授权永远不生效。
      expect(adminPageKeyForModule(page.key)).toBe(page.key);
    }
  });

  it('默认不授予普通管理员（fail-closed）：未授权时侧栏不出现入口', () => {
    const groups = getAdminNavGroups({
      isAdmin: true,
      isSuperAdmin: false,
      canUseTranslation: true,
      // 服务端返回的授权集合：只给默认页面，不含新页面。
      grantedAdminPages: ['dashboard', 'users', 'apikeys', 'apikey-billing', 'oauth'],
    });
    const urls = groups.flatMap((group) => group.items.map((item) => ('url' in item ? item.url : '')));
    for (const page of NEW_PAGES) {
      expect(urls).not.toContain(page.url);
    }
  });

  it('超管能看到全部新入口', () => {
    const groups = getAdminNavGroups({
      isAdmin: true,
      isSuperAdmin: true,
      canUseTranslation: true,
      grantedAdminPages: undefined,
    });
    const urls = groups.flatMap((group) => group.items.map((item) => ('url' in item ? item.url : '')));
    for (const page of NEW_PAGES) {
      expect(urls).toContain(page.url);
    }
  });

  it('被授予对应页面后普通管理员才看得到该入口', () => {
    const groups = getAdminNavGroups({
      isAdmin: true,
      isSuperAdmin: false,
      canUseTranslation: true,
      grantedAdminPages: ['dashboard', 'account-risk', 'rate-limits', 'tickets', 'doc-tool'],
    });
    const urls = groups.flatMap((group) => group.items.map((item) => ('url' in item ? item.url : '')));
    for (const page of NEW_PAGES) {
      expect(urls).toContain(page.url);
    }
  });
});
