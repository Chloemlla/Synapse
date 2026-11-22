import { api } from "../api";

// GeoGebra 管理诊断的只读客户端（页面 /admin/geogebra）。
// 写操作（维护清理）只对超管开放，服务端是唯一判据，前端仅按角色决定是否显示入口。
export type GeoGebraAdminOverview = {
  generatedAt: string;
  service: { uptimeSeconds: number; pid: number; nodeVersion: string };
  mongo: { readyState: number; state: string; database: string | null };
  ai: { configured: boolean; source: "env" | "custom" | "librechat"; vision: boolean; reason: string | null };
  counts: { projects: number; versions: number; comments: number; shares: number; activeShares: number; assets: number };
  worker: {
    scheduler: "in-process";
    running: boolean;
    pid: number;
    tickMs: number;
    leaseMs: number;
    note: string;
  };
  queue: {
    queued: number;
    running: number;
    totalActive: number;
    maxActiveJobsPerUser: number;
    leaseMs: number;
    note: string;
  };
  staticAssets: {
    shareCovers: { active: number; storage: "local-disk" };
    aiReferenceAssets: { count: number; bytes: number };
    exportBundles: { count: number; bytes: number };
  };
  jobsByStatus: Record<string, number>;
  recentJobs: Array<{
    jobId: string;
    kind: string;
    status: string;
    progress: number;
    owner: string;
    attempts: number;
    errorCode: string | null;
    hasResult: boolean;
    createdAt: string;
    updatedAt: string;
  }>;
  recentShares: Array<{
    shareId: string;
    slug: string;
    title: string;
    owner: string;
    commandCount: number;
    allowFork: boolean;
    revoked: boolean;
    createdAt: string;
  }>;
  recentAssets: Array<{
    assetId: string;
    purpose: string;
    mimeType: string;
    byteSize: number;
    owner: string;
    createdAt: string;
    expiresAt: string;
  }>;
  metrics: {
    endpointLatency: null;
    modelLatency: null;
    uploadSizeDistribution: null;
    unavailableReason: string;
  };
};

export async function getGeoGebraAdminOverview(): Promise<GeoGebraAdminOverview> {
  const response = await api.get<{ success: boolean; data: GeoGebraAdminOverview }>("/api/admin/geogebra/overview");
  return response.data.data;
}

export async function runGeoGebraMaintenance(): Promise<{ removedAssets: number; expiredJobs: number }> {
  const response = await api.post<{ success: boolean; data: { removedAssets: number; expiredJobs: number } }>("/api/admin/geogebra/maintenance");
  return response.data.data;
}

// ── 分页列表（任务 / 分享 / 资源）与保留口径 ──────────────────────────────
// 与概览同一档权限（admin + 页面授权 geogebra）；全部只读。

export interface GeoGebraAdminPageMeta {
  total: number;
  limit: number;
  offset: number;
}

export interface GeoGebraAdminJobRow {
  jobId: string;
  kind: string;
  owner: string;
  status: string;
  progress: number;
  attempts: number;
  errorCode: string | null;
  hasResult: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface GeoGebraAdminShareRow {
  shareId: string;
  slug: string;
  owner: string;
  title: string;
  canvasMode: string;
  commandCount: number;
  allowFork: boolean;
  coverStored: boolean;
  revoked: boolean;
  revokedAt: string | null;
  createdAt: string | null;
  embedPath: string | null;
}

export interface GeoGebraAdminAssetRow {
  assetId: string;
  owner: string;
  purpose: string;
  mimeType: string;
  byteSize: number;
  createdAt: string | null;
  expiresAt: string | null;
  expired: boolean;
}

export interface GeoGebraAdminSettings {
  success: boolean;
  versionRetentionLimit: number;
  versionRetentionEnv: string;
  versionRetentionNote: string;
  embedFrameAncestors: string;
  embedFrameAncestorsEnv: string;
  embedFrameAncestorsNote: string;
}

export interface GeoGebraAiAdminSetting {
  success: boolean;
  config: {
    mode: 'env' | 'custom' | 'librechat';
    baseUrl: string;
    model: string;
    vision: boolean;
    librechatProviderId: string;
    hasApiKey: boolean;
    apiKeyMasked: string;
    updatedAt: string | null;
    updatedBy: string;
  };
  providers: Array<{ id: string; baseUrl: string; model: string; wire: string; group: string; enabled: boolean; compatible: boolean }>;
  status: { configured: boolean; source: 'env' | 'custom' | 'librechat'; reason: string | null };
}

const toQuery = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
};

export async function listGeoGebraAdminJobs(
  params: { status?: string; kind?: string; userId?: string; limit?: number; offset?: number } = {},
): Promise<GeoGebraAdminPageMeta & { jobs: GeoGebraAdminJobRow[]; runner: unknown }> {
  const response = await api.get(`/api/admin/geogebra/jobs${toQuery(params)}`);
  return response.data;
}

export async function listGeoGebraAdminShares(
  params: { state?: string; userId?: string; limit?: number; offset?: number } = {},
): Promise<GeoGebraAdminPageMeta & { shares: GeoGebraAdminShareRow[] }> {
  const response = await api.get(`/api/admin/geogebra/shares${toQuery(params)}`);
  return response.data;
}

export async function listGeoGebraAdminAssets(
  params: { purpose?: string; limit?: number; offset?: number } = {},
): Promise<GeoGebraAdminPageMeta & { assets: GeoGebraAdminAssetRow[] }> {
  const response = await api.get(`/api/admin/geogebra/assets${toQuery(params)}`);
  return response.data;
}

export async function getGeoGebraAdminSettings(): Promise<GeoGebraAdminSettings> {
  const response = await api.get('/api/admin/geogebra/settings');
  return response.data;
}

export async function getGeoGebraAiSetting(): Promise<GeoGebraAiAdminSetting> {
  const response = await api.get('/api/admin/geogebra/ai/setting');
  return response.data;
}

export async function saveGeoGebraAiSetting(input: {
  mode: 'env' | 'custom' | 'librechat';
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  vision?: boolean;
  librechatProviderId?: string;
}): Promise<GeoGebraAiAdminSetting> {
  const response = await api.put('/api/admin/geogebra/ai/setting', input);
  return response.data;
}
