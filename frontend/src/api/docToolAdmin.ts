import { api, getApiBaseUrl } from './api';

/**
 * doc-tool 运维面板（`/admin/doc-tool`）的只读客户端 + 两个清理动作。
 *
 * 权限：`admin` + 页面授权 `doc-tool`（默认只有超管）；真实清理额外要求安全会话。
 * 边界：本客户端只回元数据，**没有任何下载用户文件的入口**。
 */

export interface DocToolAdminOverview {
  success: boolean;
  generatedAt: string;
  pandoc: { available: boolean; version: string | null; bin: string; error: string | null };
  workRoot: { writable: boolean };
  limits: {
    maxUploadBytes: number;
    maxFileBytes: number;
    maxFilesPerJob: number;
    maxActiveJobs: number;
    retentionDays: number;
  };
  counts: { queued: number; running: number; failed24h: number; succeeded24h: number; total: number };
}

export interface DocToolAdminJobRow {
  id: string;
  userId: string;
  createdBy: string | null;
  status: string;
  stage: string | null;
  progress: number;
  total: number;
  ok: number;
  skipped: number;
  failed: number;
  error: string | null;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface DocToolAdminJobDetail {
  id: string;
  userId: string;
  status: string;
  stage: string | null;
  error: string | null;
  createdAt: string | null;
  finishedAt: string | null;
  items: Array<{ sourceRel: string; destRel: string | null; status: string; error: string | null }>;
  logs: Array<{ at: string | null; level: string; message: string }>;
}

export interface DocToolStorageRow {
  userId: string;
  username: string | null;
  inboxFiles: number;
  outFiles: number;
  totalBytes: number;
  lastModifiedAt: string | null;
  truncated: boolean;
}

export interface DocToolCleanupResult {
  success: boolean;
  dryRun: boolean;
  keepDays: number;
  expiredJobs: number;
  purgedFiles: number;
  sweptFiles: number;
  affectedUsers: string[];
  note: string;
}

const BASE = () => `${getApiBaseUrl()}/api/admin/doc-tool`;

const toQuery = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
};

export const docToolAdminApi = {
  overview: async (): Promise<DocToolAdminOverview> => {
    const res = await api.get(`${BASE()}/overview`);
    return res.data;
  },
  jobs: async (params: { status?: string; userId?: string; limit?: number; offset?: number } = {}): Promise<{
    success: boolean;
    total: number;
    limit: number;
    offset: number;
    jobs: DocToolAdminJobRow[];
  }> => {
    const res = await api.get(`${BASE()}/jobs${toQuery(params)}`);
    return res.data;
  },
  job: async (id: string): Promise<{ success: boolean; job: DocToolAdminJobDetail }> => {
    const res = await api.get(`${BASE()}/jobs/${encodeURIComponent(id)}`);
    return res.data;
  },
  files: async (): Promise<{
    success: boolean;
    total: number;
    truncated: boolean;
    totalBytes: number;
    storage: DocToolStorageRow[];
  }> => {
    const res = await api.get(`${BASE()}/files`);
    return res.data;
  },
  cleanupPreview: async (): Promise<DocToolCleanupResult> => {
    const res = await api.post(`${BASE()}/cleanup/preview`, {});
    return res.data;
  },
  cleanupRun: async (): Promise<DocToolCleanupResult> => {
    const res = await api.post(`${BASE()}/cleanup/run`, {});
    return res.data;
  },
};
