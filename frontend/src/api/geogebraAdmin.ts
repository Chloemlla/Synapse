import { api } from "../api";

// GeoGebra 管理诊断的只读客户端（页面 /admin/geogebra）。
// 写操作（维护清理）只对超管开放，服务端是唯一判据，前端仅按角色决定是否显示入口。
export type GeoGebraAdminOverview = {
  generatedAt: string;
  service: { uptimeSeconds: number; pid: number; nodeVersion: string };
  mongo: { readyState: number; state: string; database: string | null };
  ai: { configured: boolean; vision: boolean; reason: string | null };
  counts: { projects: number; versions: number; comments: number; shares: number; activeShares: number; assets: number };
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
