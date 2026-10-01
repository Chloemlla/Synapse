import { beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN_NAV_PREFS_STORAGE_KEY,
  MAX_PINNED_ADMIN_MODULES,
  adminNavPrefsStore,
} from './useAdminNavPrefs';

/** 直接读落盘内容，验证"刷新后还记得"这条承诺。 */
const persisted = () => JSON.parse(window.localStorage.getItem(ADMIN_NAV_PREFS_STORAGE_KEY) || '{}');

describe('useAdminNavPrefs store', () => {
  beforeEach(() => {
    window.localStorage.clear();
    adminNavPrefsStore.reset();
  });

  it('置顶/取消置顶并落盘', () => {
    expect(adminNavPrefsStore.togglePin({ url: '/admin/users', title: '用户管理' })).toBe(true);
    expect(adminNavPrefsStore.isPinned('/admin/users')).toBe(true);
    expect(persisted().pinned).toHaveLength(1);

    expect(adminNavPrefsStore.togglePin({ url: '/admin/users', title: '用户管理' })).toBe(false);
    expect(adminNavPrefsStore.isPinned('/admin/users')).toBe(false);
    expect(persisted().pinned).toHaveLength(0);
  });

  it('最近访问去重、最新在前，并限制条数', () => {
    for (let index = 0; index < 12; index += 1) {
      adminNavPrefsStore.recordVisit({ url: `/admin/m${index}`, title: `模块${index}` });
    }
    const recent = adminNavPrefsStore.getSnapshot().recent;
    expect(recent[0].url).toBe('/admin/m11');
    expect(new Set(recent.map((entry) => entry.url)).size).toBe(recent.length);
    expect(recent.length).toBeLessThanOrEqual(8);
  });

  it('同一模块重复记录不会重复写盘', () => {
    adminNavPrefsStore.recordVisit({ url: '/admin/users', title: '用户管理' });
    const first = window.localStorage.getItem(ADMIN_NAV_PREFS_STORAGE_KEY);
    adminNavPrefsStore.recordVisit({ url: '/admin/users', title: '用户管理' });
    expect(window.localStorage.getItem(ADMIN_NAV_PREFS_STORAGE_KEY)).toBe(first);
  });

  it('拒绝非 /admin 的地址与空标题（防止把外部链接塞进侧边栏）', () => {
    expect(adminNavPrefsStore.togglePin({ url: 'https://evil.example/steal', title: '坏链接' })).toBe(false);
    expect(adminNavPrefsStore.togglePin({ url: '/admin/users', title: '   ' })).toBe(false);
    expect(adminNavPrefsStore.getSnapshot().pinned).toHaveLength(0);
  });

  it('置顶数量有上限', () => {
    for (let index = 0; index < MAX_PINNED_ADMIN_MODULES + 5; index += 1) {
      adminNavPrefsStore.togglePin({ url: `/admin/p${index}`, title: `置顶${index}` });
    }
    expect(adminNavPrefsStore.getSnapshot().pinned).toHaveLength(MAX_PINNED_ADMIN_MODULES);
  });

  it('reset 清空置顶与最近（换账号时用）', () => {
    adminNavPrefsStore.togglePin({ url: '/admin/users', title: '用户管理' });
    adminNavPrefsStore.recordVisit({ url: '/admin/users', title: '用户管理' });
    adminNavPrefsStore.reset();
    expect(adminNavPrefsStore.getSnapshot()).toEqual({ pinned: [], recent: [] });
    expect(persisted().pinned).toEqual([]);
  });
});
