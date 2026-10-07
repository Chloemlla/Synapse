import { useCallback, useEffect, useState } from 'react';
import { getMyAdminScope, type AdminScopeMe } from '../api/adminScope';
import { useAuth } from './useAuth';
import { isAdminRole, isSuperAdmin } from '../utils/rbac';
import { getAuthRequestGeneration } from '../utils/authRequestGeneration';
import { useAuthStore } from '../stores/authStore';

/**
 * 读一次「我能看哪些管理页面」（`GET /api/admin/admin-scope/me`），并在整个 SPA 会话内复用。
 *
 * 为什么做成模块级缓存：导航（侧栏 + 移动端 + 总览 + 深链守卫）都依赖这份授权，
 * 每处各发一次请求既浪费也会让侧栏在计数上闪烁。缓存 + in-flight 去重后，一次会话只打一次。
 *
 * 失败策略（重要）：请求失败时 `grantedPages` 返回 `undefined`，调用方按 `utils/rbac` 的
 * **回退集合**（= 历史默认的四个页面）判定 —— 既不让授权服务抖动把普通管理员整个挡在门外，
 * 也不会因为“拿不到就全放开”而放大权限。
 */

type ScopedResult = { key: string; value: AdminScopeMe | null };
let cached: ScopedResult | null = null;
let inflight: { key: string; promise: Promise<AdminScopeMe | null> } | null = null;
let revision = 0;
const listeners = new Set<() => void>();

const scopeKey = (userId?: string): string => `${userId ?? ''}:${getAuthRequestGeneration()}`;

/** 授权变更（如超管改完配置）后强制下次重新拉取。 */
export function invalidateAdminScopeCache(): void {
  cached = null;
  inflight = null;
  revision += 1;
  listeners.forEach(listener => listener());
}

function loadAdminScope(key: string): Promise<AdminScopeMe | null> {
  if (cached?.key === key) return Promise.resolve(cached.value);
  if (inflight?.key !== key) {
    const startedRevision = revision;
    const request = getMyAdminScope()
      .then((data) => {
        if (startedRevision === revision && key === scopeKey(useAuthStore.getState().user?.id)) {
          cached = { key, value: data };
        }
        return data;
      })
      .catch(() => null)
      .finally(() => {
        if (inflight?.promise === request) inflight = null;
      });
    inflight = { key, promise: request };
  }
  return inflight.promise;
}

export interface UseAdminScopeResult {
  /** 仍在拉取（且尚无缓存）时 true。 */
  loading: boolean;
  /** 服务端授权不可用（回退到本地最小集合）时 true —— 仅用于给出提示，不用于放权。 */
  degraded: boolean;
  /** 服务端返回的页面 key 集合；未拿到时为 undefined（调用方按回退集合判定）。 */
  grantedPages: readonly string[] | undefined;
  /** 供 UI 展示的页面清单（超管为全部已登记页面）。 */
  availablePages: AdminScopeMe['availablePages'];
  isSuperAdmin: boolean;
  /** 重新拉取（先失效缓存）。 */
  refresh: () => Promise<void>;
}

export function useAdminScope(): UseAdminScopeResult {
  const { user } = useAuth();
  const role = user?.role;
  const adminUser = isAdminRole(role);
  const superAdmin = isSuperAdmin(role);
  const key = scopeKey(user?.id);
  const [cacheRevision, setCacheRevision] = useState(revision);

  const [data, setData] = useState<ScopedResult | null>(cached?.key === key ? cached : null);
  const [loading, setLoading] = useState<boolean>(adminUser && cached?.key !== key);
  const [degraded, setDegraded] = useState(false);

  useEffect(() => {
    const update = () => setCacheRevision(revision);
    listeners.add(update);
    return () => { listeners.delete(update); };
  }, []);

  useEffect(() => {
    if (!adminUser) {
      setData(null);
      setLoading(false);
      setDegraded(false);
      return undefined;
    }

    let cancelled = false;
    const startedRevision = revision;
    if (cached?.key !== key) setLoading(true);

    void loadAdminScope(key).then((value) => {
      if (cancelled || startedRevision !== revision || key !== scopeKey(useAuthStore.getState().user?.id)) return;
      setData({ key, value });
      setDegraded(value === null);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [adminUser, role, key, cacheRevision]);

  const refresh = useCallback(async () => {
    invalidateAdminScopeCache();
    const startedRevision = revision;
    if (!adminUser) return;
    setLoading(true);
    const value = await loadAdminScope(key);
    if (startedRevision !== revision || key !== scopeKey(useAuthStore.getState().user?.id)) return;
    setData({ key, value });
    setDegraded(value === null);
    setLoading(false);
  }, [adminUser, key]);

  const visible = data?.key === key ? data.value : null;

  return {
    loading,
    degraded,
    // 超管不参与页面授权（后端对超管直接返回全部页面），但仍把集合传下去，
    // 这样导航过滤逻辑只有一条路径。
    grantedPages: visible?.pages,
    availablePages: visible?.availablePages ?? [],
    isSuperAdmin: superAdmin,
    refresh,
  };
}
