import { useCallback, useEffect, useState } from 'react';
import { getMyAdminScope, type AdminScopeMe } from '../api/adminScope';
import { useAuth } from './useAuth';
import { isAdminRole, isSuperAdmin } from '../utils/rbac';

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

let cached: AdminScopeMe | null = null;
let inflight: Promise<AdminScopeMe | null> | null = null;

/** 授权变更（如超管改完配置）后强制下次重新拉取。 */
export function invalidateAdminScopeCache(): void {
  cached = null;
  inflight = null;
}

function loadAdminScope(): Promise<AdminScopeMe | null> {
  if (cached) return Promise.resolve(cached);
  if (!inflight) {
    inflight = getMyAdminScope()
      .then((data) => {
        cached = data;
        return data;
      })
      .catch(() => null)
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
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

  const [data, setData] = useState<AdminScopeMe | null>(cached);
  const [loading, setLoading] = useState<boolean>(adminUser && !cached);
  const [degraded, setDegraded] = useState(false);

  useEffect(() => {
    if (!adminUser) {
      setData(null);
      setLoading(false);
      setDegraded(false);
      return undefined;
    }

    let cancelled = false;
    if (!cached) setLoading(true);

    void loadAdminScope().then((value) => {
      if (cancelled) return;
      setData(value);
      setDegraded(value === null);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [adminUser, role]);

  const refresh = useCallback(async () => {
    invalidateAdminScopeCache();
    if (!adminUser) return;
    setLoading(true);
    const value = await loadAdminScope();
    setData(value);
    setDegraded(value === null);
    setLoading(false);
  }, [adminUser]);

  return {
    loading,
    degraded,
    // 超管不参与页面授权（后端对超管直接返回全部页面），但仍把集合传下去，
    // 这样导航过滤逻辑只有一条路径。
    grantedPages: data?.pages,
    availablePages: data?.availablePages ?? [],
    isSuperAdmin: superAdmin,
    refresh,
  };
}
