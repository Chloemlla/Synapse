import { api } from './api';
import { getBackendErrorMessage } from '../utils/backendError';

/**
 * 管理端 MongoDB 在库数据浏览 API（`/api/admin/system/mongo/*`）。
 *
 * 与 Redis 浏览器一致：**超管 + 安全会话**，令牌走 `x-verification-token` 请求头；
 * 后端只读，没有写入/删除入口。
 *
 * 脱敏：默认原样返回（安全会话已建立）；传 `redact: true` 时服务端把凭据类字段
 * 替换为 `[redacted]`，供截图/共享场景使用。
 */

export interface MongoAdminOverview {
  connected: boolean;
  database: string | null;
  collections: number;
  estimatedDocuments: number | null;
  dataSizeBytes: number | null;
  indexSizeBytes: number | null;
  serverVersion: string | null;
  maxPageSize: number;
  maxPage: number;
  maxExportDocs: number;
}

export interface MongoAdminCollectionSummary {
  name: string;
  type: string;
  estimatedCount: number | null;
  capped?: boolean;
  hasValidator?: boolean;
}

export interface MongoAdminDocumentPage {
  collection: string;
  page: number;
  pageSize: number;
  /** 精确匹配数（查询超时为 null）。 */
  total: number | null;
  estimatedTotal: number | null;
  documents: unknown[];
  hasMore: boolean;
  sort: { field: string; order: 'asc' | 'desc' };
  /** 本次响应是否做了凭据脱敏。 */
  redacted: boolean;
}

export interface MongoAdminIndexInfo {
  name?: string;
  key?: Record<string, unknown>;
  unique?: boolean;
  sparse?: boolean;
  expireAfterSeconds?: number;
  [key: string]: unknown;
}

export interface MongoAdminCollectionDetail {
  collection: string;
  indexes: MongoAdminIndexInfo[];
  options: { capped: boolean; size?: number; max?: number; hasValidator: boolean };
  capped: boolean;
  estimatedCount: number | null;
}

export interface MongoAdminDocumentsQuery {
  page?: number;
  pageSize?: number;
  /** 受限 JSON 查询对象（字符串形态）。 */
  filter?: string;
  sortField?: string;
  sortOrder?: 'asc' | 'desc';
  /** true = 服务端脱敏；缺省 = 原样（仍要求超管 + 安全会话）。 */
  redact?: boolean;
}

export interface MongoAdminExportOptions {
  collection: string;
  filter?: string;
  sortField?: string;
  sortOrder?: 'asc' | 'desc';
  maxDocs?: number;
  /** true = 服务端脱敏；缺省 = 原样。 */
  redact?: boolean;
}

const sessionHeader = (verificationToken: string): Record<string, string> =>
  verificationToken ? { 'x-verification-token': verificationToken } : {};

export const adminMongoApi = {
  async getOverview(verificationToken: string): Promise<MongoAdminOverview> {
    const { data } = await api.get<{ success: boolean; overview: MongoAdminOverview }>(
      '/api/admin/system/mongo/overview',
      { headers: sessionHeader(verificationToken) },
    );
    return data.overview;
  },

  async listCollections(verificationToken: string): Promise<MongoAdminCollectionSummary[]> {
    const { data } = await api.get<{ success: boolean; collections: MongoAdminCollectionSummary[] }>(
      '/api/admin/system/mongo/collections',
      { headers: sessionHeader(verificationToken) },
    );
    return Array.isArray(data.collections) ? data.collections : [];
  },

  async listDocuments(
    collection: string,
    query: MongoAdminDocumentsQuery,
    verificationToken: string,
  ): Promise<MongoAdminDocumentPage> {
    const { data } = await api.get<{ success: boolean } & MongoAdminDocumentPage>(
      `/api/admin/system/mongo/collections/${encodeURIComponent(collection)}/documents`,
      {
        params: {
          page: query.page,
          pageSize: query.pageSize,
          filter: query.filter || undefined,
          sortField: query.sortField || undefined,
          sortOrder: query.sortOrder || undefined,
          redact: query.redact ? '1' : undefined,
        },
        headers: sessionHeader(verificationToken),
      },
    );
    return data;
  },

  async getCollectionDetail(collection: string, verificationToken: string): Promise<MongoAdminCollectionDetail> {
    const { data } = await api.get<{ success: boolean } & MongoAdminCollectionDetail>(
      `/api/admin/system/mongo/collections/${encodeURIComponent(collection)}/detail`,
      { headers: sessionHeader(verificationToken) },
    );
    return data;
  },

  /**
   * 流式导出集合（NDJSON，服务端脱敏）。`timeout: 0` 关掉 15s 兜底 —— 大集合本来就可能跑很久。
   */
  async exportCollection(
    options: MongoAdminExportOptions,
    verificationToken: string,
    onProgress?: (loadedBytes: number) => void,
  ): Promise<{ blob: Blob; filename: string | null }> {
    const response = await api.get<Blob>('/api/admin/system/mongo/export', {
      params: { ...options, redact: options.redact ? '1' : undefined },
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

/** `responseType: 'blob'` 时错误体也是 Blob，先读文本再解析，避免把后端文案吞掉。 */
export async function extractAdminMongoErrorMessage(error: unknown, fallback: string): Promise<string> {
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
