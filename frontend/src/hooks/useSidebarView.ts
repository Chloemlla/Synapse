import { useEffect, useMemo } from 'react';
import { useLocation } from 'react-router-dom';

import type { NavGroup, ResolvedSidebarView } from '@/layout/types';
import { useAuth } from '@/hooks/useAuth';
import { useAdminNavPrefs } from '@/hooks/useAdminNavPrefs';
import { isAdminRole, isSuperAdmin as isSuperAdminRole } from '@/utils/rbac';

import { buildAdminPrefGroups, resolveActiveAdminItem } from '@/navigation/adminNavIndex';
import { getRootNavGroups } from '@/navigation/navConfig';
import { resolveSidebarView } from '@/navigation/sidebarViews';

/** Sentinel key used for the root navigation in animation `key=` props. */
const ROOT_VIEW_KEY = '__root';

/**
 * Resolve the active sidebar view for the current location.
 *
 * - Returns the matching nested {@link SidebarView} (with its nav groups)
 *   when the URL belongs to a registered drill-in workspace.
 * - Otherwise returns the root navigation, narrowed by role.
 *
 * 管理后台视图额外做两件事：
 * 1. 把「已置顶 / 最近访问」两组插到最前（`useAdminNavPrefs`，localStorage 持久化）；
 * 2. 每次进入某个模块就记一笔访问，供命令面板与置顶区使用。
 *    （放在这里而不是各模块组件里：模块页面有 41 个，不可能逐个加埋点。）
 */
export function useSidebarView(): ResolvedSidebarView {
  const { pathname } = useLocation();
  const { user } = useAuth();
  const { pinned, recent, recordVisit } = useAdminNavPrefs();

  const isAdmin = isAdminRole(user?.role);
  const isSuperAdmin = isSuperAdminRole(user?.role);
  // 契约对齐：匿名用户（user 为 null）不得显示翻译入口；只有已登录且未被禁用翻译时才可用
  const canUseTranslation = Boolean(user) && user?.isTranslationEnabled !== false;

  const visibility = useMemo(
    () => ({ isAdmin, isSuperAdmin, canUseTranslation }),
    [canUseTranslation, isAdmin, isSuperAdmin],
  );

  const rootNavGroups = useMemo<NavGroup[]>(
    () => getRootNavGroups(visibility),
    [visibility],
  );

  const view = resolveSidebarView(pathname);
  // 嵌套视图仅管理员可用；非管理员落到主导航，且不计算管理分组。
  const activeAdminView = view && isAdmin ? view : null;

  const adminGroups = useMemo<NavGroup[] | null>(
    () => (activeAdminView ? activeAdminView.getNavGroups(visibility) : null),
    [activeAdminView, visibility],
  );

  const activeAdminItem = useMemo(
    () => (adminGroups ? resolveActiveAdminItem(pathname, adminGroups) : null),
    [adminGroups, pathname],
  );

  useEffect(() => {
    if (!activeAdminItem) return;
    recordVisit({ url: activeAdminItem.url, title: activeAdminItem.title });
  }, [activeAdminItem, recordVisit]);

  const navGroups = useMemo<NavGroup[]>(() => {
    if (!adminGroups) return rootNavGroups;
    return [...buildAdminPrefGroups(adminGroups, { pinned, recent }), ...adminGroups];
  }, [adminGroups, pinned, recent, rootNavGroups]);

  if (activeAdminView) {
    return {
      key: activeAdminView.id,
      view: activeAdminView,
      navGroups,
    };
  }

  return {
    key: ROOT_VIEW_KEY,
    view: null,
    navGroups: rootNavGroups,
  };
}
