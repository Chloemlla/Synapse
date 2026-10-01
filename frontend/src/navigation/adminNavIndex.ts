import type { NavGroup, NavLink } from '@/layout/types';
import { checkIsActive, isNavLink } from '@/layout/url-utils';

/**
 * Admin 导航索引（置顶/最近/上一下一模块都靠它）。
 *
 * `getAdminNavGroups()` 是按角色过滤后的**分组**结构，管理员侧边栏、命令面板、
 * 模块页工具条都需要「扁平的模块清单」与「当前模块是谁」，这里统一算一次，
 * 避免各处各写一遍 `group.items.map(...)` 后行为漂移。
 */

/** 把分组结构摊平成扁平的链接清单（保留顺序，即导航里的展示顺序）。 */
export function flattenAdminNavItems(groups: NavGroup[]): NavLink[] {
  const items: NavLink[] = [];
  for (const group of groups) {
    for (const item of group.items) {
      if (isNavLink(item)) {
        items.push(item);
        continue;
      }
      if (item.items?.length) {
        for (const sub of item.items) {
          if ('url' in sub && typeof sub.url === 'string') {
            items.push(sub as NavLink);
          }
        }
      }
    }
  }
  return items;
}

/** url → 导航项，便于按 url 回填标题/图标。 */
export function indexAdminNavByUrl(groups: NavGroup[]): Map<string, NavLink> {
  return new Map(flattenAdminNavItems(groups).map((item) => [item.url, item]));
}

/**
 * 当前路径命中的管理模块。
 *
 * 先取最长匹配（`/admin/store/resources` 不该退化成 `/admin/store`），
 * 管理员工作区里还有几个不在 `/admin/*` 下的页面（如 `/email-sender`），同样能命中。
 */
export function resolveActiveAdminItem(
  pathname: string,
  groups: NavGroup[],
): NavLink | null {
  let best: NavLink | null = null;
  for (const item of flattenAdminNavItems(groups)) {
    if (!checkIsActive(pathname, item)) continue;
    if (!best || item.url.length > best.url.length) best = item;
  }
  return best;
}

export type AdminModuleNeighbors = {
  /** 当前模块在扁平清单里的下标；未命中为 -1 */
  index: number;
  total: number;
  prev: NavLink | null;
  next: NavLink | null;
};

/**
 * 上/下一个管理模块（命令面板与模块页工具条的「切换模块」用它）。
 * 越界时循环到另一端，避免在首/末模块上按钮变灰没反馈。
 */
export function findAdminModuleNeighbors(
  pathname: string,
  groups: NavGroup[],
): AdminModuleNeighbors {
  const items = flattenAdminNavItems(groups);
  const current = resolveActiveAdminItem(pathname, groups);
  const index = current ? items.findIndex((item) => item.url === current.url) : -1;
  if (index === -1 || items.length < 2) {
    return { index, total: items.length, prev: null, next: null };
  }
  return {
    index,
    total: items.length,
    prev: items[(index - 1 + items.length) % items.length],
    next: items[(index + 1) % items.length],
  };
}

/**
 * 为侧边栏拼出「已置顶 / 最近访问」两组（置顶优先）。
 *
 * 只保留当前角色可见、且仍存在的模块：角色被降级或模块下线后，历史记录里
 * 的条目会被自动丢弃，不会留下点进去 403 的死链。
 */
export function buildAdminPrefGroups(
  groups: NavGroup[],
  prefs: { pinned: Array<{ url: string; title: string }>; recent: Array<{ url: string; title: string }> },
  options: { maxRecent?: number } = {},
): NavGroup[] {
  const byUrl = indexAdminNavByUrl(groups);
  const toItems = (entries: Array<{ url: string }>) =>
    entries
      .map((entry) => byUrl.get(entry.url))
      .filter((item): item is NavLink => Boolean(item));

  const pinnedItems = toItems(prefs.pinned);
  const pinnedUrls = new Set(pinnedItems.map((item) => item.url));
  const recentItems = toItems(prefs.recent)
    .filter((item) => !pinnedUrls.has(item.url))
    .slice(0, options.maxRecent ?? 8);

  const result: NavGroup[] = [];
  if (pinnedItems.length > 0) {
    result.push({ id: 'admin-pinned', title: '已置顶', items: pinnedItems });
  }
  if (recentItems.length > 0) {
    result.push({ id: 'admin-recent', title: '最近访问', items: recentItems });
  }
  return result;
}
