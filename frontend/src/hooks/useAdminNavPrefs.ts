import { useMemo, useSyncExternalStore } from 'react';

/**
 * 管理员导航偏好（置顶模块 + 最近访问），localStorage 持久化。
 *
 * 为什么放在模块级单例而不是 React context：命令面板挂在 shell 顶栏、置顶组挂在
 * 侧边栏、模块页工具条又要读同一个「是否已置顶」，三处距离很远；用 context 得把
 * Provider 提到 shell 顶（并且要处理移动端），用 `useSyncExternalStore` 则各处
 * 直接订阅同一份快照，顺带天然支持多标签页同步。
 */

export type AdminNavEntry = {
  url: string;
  title: string;
  /** 最近一次访问/置顶时间戳，用于排序与去重 */
  at: number;
};

export type AdminNavPrefs = {
  pinned: AdminNavEntry[];
  recent: AdminNavEntry[];
};

export const ADMIN_NAV_PREFS_STORAGE_KEY = 'synapse.admin.nav.prefs.v1';
export const MAX_PINNED_ADMIN_MODULES = 12;
export const MAX_RECENT_ADMIN_MODULES = 8;

const EMPTY_PREFS: AdminNavPrefs = { pinned: [], recent: [] };

function isAdminUrl(value: unknown): value is string {
  // '/admin'（总览）本身也允许置顶：侧边栏与命令面板里它都是可点条目。
  return typeof value === 'string' && (value === '/admin' || value.startsWith('/admin/'));
}

function sanitizeEntry(value: unknown): AdminNavEntry | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<AdminNavEntry>;
  if (!isAdminUrl(candidate.url)) return null;
  if (typeof candidate.title !== 'string' || !candidate.title.trim()) return null;
  const at = typeof candidate.at === 'number' && Number.isFinite(candidate.at) ? candidate.at : Date.now();
  return { url: candidate.url, title: candidate.title, at };
}

function sanitizeList(value: unknown, limit: number): AdminNavEntry[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: AdminNavEntry[] = [];
  for (const raw of value) {
    const entry = sanitizeEntry(raw);
    if (!entry || seen.has(entry.url)) continue;
    seen.add(entry.url);
    result.push(entry);
    if (result.length >= limit) break;
  }
  return result;
}

function loadPrefs(): AdminNavPrefs {
  if (typeof window === 'undefined') return EMPTY_PREFS;
  try {
    const raw = window.localStorage.getItem(ADMIN_NAV_PREFS_STORAGE_KEY);
    if (!raw) return EMPTY_PREFS;
    const parsed = JSON.parse(raw) as Partial<AdminNavPrefs> | null;
    return {
      pinned: sanitizeList(parsed?.pinned, MAX_PINNED_ADMIN_MODULES),
      recent: sanitizeList(parsed?.recent, MAX_RECENT_ADMIN_MODULES),
    };
  } catch {
    // 隐私模式/配额满/历史脏数据：一律退回空偏好，不影响后台可用性
    return EMPTY_PREFS;
  }
}

function persistPrefs(prefs: AdminNavPrefs): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ADMIN_NAV_PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* 落盘失败只影响"下次还记得"，本次会话内存里仍然生效 */
  }
}

let snapshot: AdminNavPrefs = loadPrefs();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

function commit(next: AdminNavPrefs): void {
  snapshot = next;
  persistPrefs(next);
  notify();
}

function upsertFront(list: AdminNavEntry[], entry: AdminNavEntry, limit: number): AdminNavEntry[] {
  return [entry, ...list.filter((item) => item.url !== entry.url)].slice(0, limit);
}

export const adminNavPrefsStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot(): AdminNavPrefs {
    return snapshot;
  },
  /** SSR / 首帧：稳定空快照，避免 hydration 抖动 */
  getServerSnapshot(): AdminNavPrefs {
    return EMPTY_PREFS;
  },
  isPinned(url: string): boolean {
    return snapshot.pinned.some((entry) => entry.url === url);
  },
  togglePin(input: { url: string; title: string }): boolean {
    const entry = sanitizeEntry({ ...input, at: Date.now() });
    if (!entry) return false;
    const alreadyPinned = snapshot.pinned.some((item) => item.url === entry.url);
    commit({
      ...snapshot,
      pinned: alreadyPinned
        ? snapshot.pinned.filter((item) => item.url !== entry.url)
        : upsertFront(snapshot.pinned, entry, MAX_PINNED_ADMIN_MODULES),
    });
    return !alreadyPinned;
  },
  /** 记录一次模块访问；重复访问只更新时间并前置 */
  recordVisit(input: { url: string; title: string }): void {
    const entry = sanitizeEntry({ ...input, at: Date.now() });
    if (!entry) return;
    if (snapshot.recent[0]?.url === entry.url && snapshot.recent[0]?.title === entry.title) {
      return; // 同页重复渲染不写盘
    }
    commit({
      ...snapshot,
      recent: upsertFront(snapshot.recent, entry, MAX_RECENT_ADMIN_MODULES),
    });
  },
  clearRecent(): void {
    if (snapshot.recent.length === 0) return;
    commit({ ...snapshot, recent: [] });
  },
  /** 退出登录/换账号时清空，避免下一位使用者看到上一位的访问轨迹 */
  reset(): void {
    if (snapshot.pinned.length === 0 && snapshot.recent.length === 0) return;
    commit(EMPTY_PREFS);
  },
};

if (typeof window !== 'undefined') {
  // 多标签页：另一处改了偏好，这里同步刷新
  window.addEventListener('storage', (event) => {
    if (event.key !== ADMIN_NAV_PREFS_STORAGE_KEY) return;
    snapshot = loadPrefs();
    notify();
  });
}

export type UseAdminNavPrefsResult = AdminNavPrefs & {
  isPinned: (url: string) => boolean;
  togglePin: (input: { url: string; title: string }) => boolean;
  recordVisit: (input: { url: string; title: string }) => void;
  clearRecent: () => void;
};

export function useAdminNavPrefs(): UseAdminNavPrefsResult {
  const prefs = useSyncExternalStore(
    adminNavPrefsStore.subscribe,
    adminNavPrefsStore.getSnapshot,
    adminNavPrefsStore.getServerSnapshot,
  );

  return useMemo(
    () => ({
      pinned: prefs.pinned,
      recent: prefs.recent,
      isPinned: adminNavPrefsStore.isPinned,
      togglePin: adminNavPrefsStore.togglePin,
      recordVisit: adminNavPrefsStore.recordVisit,
      clearRecent: adminNavPrefsStore.clearRecent,
    }),
    [prefs],
  );
}
