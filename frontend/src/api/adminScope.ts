import { api } from './api';

/**
 * 普通管理员页面授权（后端 `src/routes/admin/adminScope.ts`，挂在 `/api/admin/admin-scope`）。
 *
 * - `getMyAdminScope()`        任何管理员：自己可见的页面 key（前端据此过滤导航/总览/深链）
 * - `getAdminScopeSetting()`   超管：全部可授权页面 + 当前默认授权 + 按用户覆盖
 * - `updateAdminScopeSetting()` 超管：覆盖式写入（未传字段保持原值）
 * - `resetAdminScopeSetting()` 超管：恢复默认
 *
 * 注意：后端这四个接口直接返回视图对象（不是 `{success, data}` 信封），出错时是 `{error, code}`，
 * 由调用方用 `getBackendErrorMessage` 兜住 axios 的 4xx 异常。
 */

export interface AdminScopePageOption {
  key: string;
  label: string;
  /** 该页面覆盖的 API 前缀数量；0 表示「只有入口、没有自己的接口」（授了也不会放开任何接口）。 */
  apiScopeCount: number;
}

export interface AdminScopeMe {
  role: string;
  isSuperAdmin: boolean;
  /** 调用方可见的页面 key 集合（超管为全部已登记页面）。 */
  pages: string[];
  availablePages: Array<Pick<AdminScopePageOption, 'key' | 'label' | 'apiScopeCount'>>;
}

export interface AdminScopeSetting {
  defaultPages: string[];
  perUser: Record<string, string[]>;
  updatedAt: string | null;
  updatedBy: string;
  /** true = 还没写入过配置，当前用的是后端默认值。 */
  isDefault: boolean;
  availablePages: AdminScopePageOption[];
}

export interface AdminScopeUpdatePayload {
  defaultPages?: string[];
  perUser?: Record<string, string[]>;
}

/** 后端出错时会带回 `{error}`；这里统一抛成 Error 便于 UI 直接展示。 */
function ensureNoError<T extends object>(payload: unknown, fallback: string): T {
  if (!payload || typeof payload !== 'object') {
    throw new Error(fallback);
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.error === 'string' && record.error) {
    throw new Error(record.error);
  }
  return payload as T;
}

/** 调用方自己的可见页面集合。 */
export async function getMyAdminScope(): Promise<AdminScopeMe> {
  const res = await api.get('/api/admin/admin-scope/me');
  return ensureNoError<AdminScopeMe>(res.data, '获取管理员授权失败');
}

export async function getAdminScopeSetting(): Promise<AdminScopeSetting> {
  const res = await api.get('/api/admin/admin-scope/setting');
  return ensureNoError<AdminScopeSetting>(res.data, '获取页面授权配置失败');
}

export async function updateAdminScopeSetting(
  payload: AdminScopeUpdatePayload,
): Promise<AdminScopeSetting> {
  const res = await api.put('/api/admin/admin-scope/setting', payload);
  return ensureNoError<AdminScopeSetting>(res.data, '保存页面授权失败');
}

export async function resetAdminScopeSetting(): Promise<AdminScopeSetting> {
  const res = await api.delete('/api/admin/admin-scope/setting');
  return ensureNoError<AdminScopeSetting>(res.data, '恢复默认授权失败');
}
