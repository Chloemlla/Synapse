import api, { getApiBaseUrl } from './api';
import type { AiErrorDetails } from '../types/aiDiagnostics';

export interface AdminUserSummary {
    userId: string;
    /** user：普通用户会话；system：系统内部服务会话（言论审查 / 工单 AI 等）。 */
    kind?: 'user' | 'system';
    /** 系统内部服务会话名（组件名开头，如 `moderation:check:1a2b3c`）；用户会话为 null。 */
    name?: string | null;
    /** 系统内部服务组件名（如 `moderation`）。 */
    component?: string | null;
    /** 组件中文名，由后端给（如 `工单言论审查`）。 */
    componentLabel?: string | null;
    total: number;
    updatedAt?: string;
    firstTs?: string | null;
    lastTs?: string | null;
}

export interface AdminUsersResponse {
    users: AdminUserSummary[];
    total: number;
}

export interface AdminUserHistoryItem {
    id: string;
    message: string;
    role?: 'user' | 'assistant';
    timestamp: string;
    aiErrorDetails?: AiErrorDetails;
}

export interface AdminUserHistoryResponse {
    messages: AdminUserHistoryItem[];
    total: number;
}

// 统一的 LibreChat 接口前缀，API base URL 只从 api.ts 读取
const BASE = `${getApiBaseUrl()}/api/librechat`;

export type AdminConversationScope = 'all' | 'user' | 'system';

export async function listUsers(params: { kw?: string; page?: number; limit?: number; includeDeleted?: boolean; scope?: AdminConversationScope }): Promise<AdminUsersResponse> {
    const { kw = '', page = 1, limit = 20, includeDeleted = false, scope = 'all' } = params || {};
    const res = await api.get(`${BASE}/admin/users`, { params: { kw, page, limit, includeDeleted, scope } });
    return res.data as AdminUsersResponse;
}

export async function getUserHistory(userId: string, params: { page?: number; limit?: number }): Promise<AdminUserHistoryResponse> {
    const { page = 1, limit = 20 } = params || {};
    const res = await api.get(`${BASE}/admin/users/${encodeURIComponent(userId)}/history`, { params: { page, limit } });
    return res.data as AdminUserHistoryResponse;
}

export async function deleteUser(userId: string): Promise<{ deleted: number; message: string }> {
    const res = await api.delete(`${BASE}/admin/users/${encodeURIComponent(userId)}`);
    return res.data as { deleted: number; message: string };
}

export async function batchDeleteUsers(userIds: string[]): Promise<{ deleted: number; details: { userId: string; deleted: number }[]; message: string }> {
    const res = await api.delete(`${BASE}/admin/users`, { data: { userIds } });
    return res.data as { deleted: number; details: { userId: string; deleted: number }[]; message: string };
}

export async function deleteAllUsers(): Promise<{ deleted: number; message: string }> {
    const res = await api.delete(`${BASE}/admin/users/all`, { data: { confirm: true } });
    return res.data as { deleted: number; message: string };
}

export async function deleteGuestHistories(): Promise<{ deleted: number; message: string }> {
    // 服务端要求显式 confirm（该端点不接收其它参数，与 deleteAllUsers 同口径）。
    const res = await api.delete(`${BASE}/admin/users/guests`, { data: { confirm: true } });
    return res.data as { deleted: number; message: string };
}
