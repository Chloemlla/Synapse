import { api } from "../api";

// GeoGebra 管理诊断的只读客户端（页面 /admin/geogebra）。
// 写操作（维护清理）只对超管开放，服务端是唯一判据，前端仅按角色决定是否显示入口。
export type GeoGebraAdminOverview = {
  generatedAt: string;
  service: { uptimeSeconds: number; pid: number; nodeVersion: string };
  mongo: { readyState: number; state: string; database: string | null };
  ai: { configured: boolean; vision: boolean; reason: string | null };
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
