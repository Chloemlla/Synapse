import { api } from './api';
import { getBackendErrorMessage } from '../utils/backendError';

/**
 * 管理端 Redis 在库数据浏览 API（`/api/admin/system/redis/*`）。
 *
 * 三个端点都要求 **超管 + 安全会话**：令牌走 `x-verification-token` 请求头
 * （GET 没有 body，后端 `requestVerificationToken` 优先读 body、其次读该头，
 * 与 passkey 凭证管理、备份码查看用的是同一枚 token）。
 * 后端只读：没有删除/写入/flush 入口。
 */

export interface RedisAdminScope {
  restricted: boolean;
  prefixes: string[];
  source: 'env' | 'all';
}

export interface RedisAdminStatus {
  configured: boolean;
  enabled: boolean;
  ready: boolean;
  available: boolean;
}

export interface RedisAdminOverview {
  status: RedisAdminStatus;
  dbsize: number | null;
  usedMemoryBytes: number | null;
  scope: RedisAdminScope;
  maxPageLimit: number;
  defaultPageLimit: number;
}

export interface RedisAdminKeySummary {
  key: string;
  /** 元信息读取失败或键刚好过期时为 'unknown'。 */
  type: string;
  /** PTTL：-1 永不过期，-2 不存在。 */
  ttlMs: number;
}

export interface RedisAdminKeysPage {
  cursor: string;
  done: boolean;
  keys: RedisAdminKeySummary[];
  scanned: number;
  outOfScope: number;
  match: string;
  hasFilter: boolean;
  namespace: string | null;
  scope: RedisAdminScope;
}

export interface RedisKeyEntry {
  /** hash 字段；list/set/zset 为空（位置由数组下标表达）。 */
  field?: string;
  value: string;
  /** zset 分数。 */
  score?: string;
}

export interface RedisKeyContent {
  type: string;
  ttlMs: number;
  encoding: string | null;
  sizeBytes: number | null;
  stringLength: number | null;
  value: string | null;
  entries: RedisKeyEntry[] | null;
  totalEntries: number | null;
  truncated: boolean;
}

export interface RedisAdminKeyDetail {
  key: string;
  scope: RedisAdminScope;
  content: RedisKeyContent;
}

export interface RedisAdminKeysQuery {
  cursor?: string;
  namespace?: string;
  filter?: string;
  limit?: number;
}

export interface RedisAdminExportOptions {
  namespace?: string;
  filter?: string;
  maxKeys?: number;
}

const sessionHeader = (verificationToken: string): Record<string, string> =>
  verificationToken ? { 'x-verification-token': verificationToken } : {};

export const adminRedisApi = {
  async getOverview(verificationToken: string): Promise<RedisAdminOverview> {
    const { data } = await api.get<{ success: boolean; overview: RedisAdminOverview }>(
      '/api/admin/system/redis/overview',
      { headers: sessionHeader(verificationToken) },
    );
    return data.overview;
  },

  async listKeys(query: RedisAdminKeysQuery, verificationToken: string): Promise<RedisAdminKeysPage> {
    const { data } = await api.get<{ success: boolean } & RedisAdminKeysPage>('/api/admin/system/redis/keys', {
      params: query,
      headers: sessionHeader(verificationToken),
    });
    return data;
  },

  async getKey(
    key: string,
    verificationToken: string,
    limits?: { maxValueChars?: number; maxEntries?: number },
  ): Promise<RedisAdminKeyDetail> {
    const { data } = await api.post<{ success: boolean } & RedisAdminKeyDetail>(
      '/api/admin/system/redis/value',
      { key, ...(limits ?? {}) },
      { headers: sessionHeader(verificationToken) },
    );
    return data;
  },

  /**
   * 流式导出在库快照（NDJSON，逐键 DUMP + PTTL）。返回原始 Blob 由调用方落盘；
   * `timeout: 0` 关掉 axios 的 15s 兜底 —— 导出本来就可能跑很久。
   */
  async exportSnapshot(
    options: RedisAdminExportOptions,
    verificationToken: string,
    onProgress?: (loadedBytes: number) => void,
  ): Promise<{ blob: Blob; filename: string | null }> {
    const response = await api.get<Blob>('/api/admin/system/redis/export', {
      params: { format: 'ndjson', ...options },
      headers: sessionHeader(verificationToken),
      responseType: 'blob',
      timeout: 0,
      onDownloadProgress: (event) => onProgress?.(event.loaded),
    });
    const disposition = String(response.headers?.['content-disposition'] ?? '');
    const match = /filename="?([^";]+)"?/.exec(disposition);
    return { blob: response.data, filename: match ? match[1] : null };
  },
};

/**
 * `responseType: 'blob'` 时错误响应体也是 Blob，通用 `getBackendErrorMessage` 读不出后端文案；
 * 这里先把 Blob 读成文本再解析，避免把「RDB 不可用」这类关键说明吞成一句泛化错误。
 */
export async function extractAdminRedisErrorMessage(error: unknown, fallback: string): Promise<string> {
  const data = (error as { response?: { data?: unknown } } | undefined)?.response?.data;
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    try {
      const parsed = JSON.parse(await data.text()) as { error?: unknown };
      if (typeof parsed?.error === 'string' && parsed.error) return parsed.error;
    } catch {
      // 落到通用错误提取
    }
  }
  return getBackendErrorMessage(error, fallback);
}
