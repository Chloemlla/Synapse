import { api } from "./api";

// Pixel 管理端客户端（页面 /admin/pixel）。
// 视图形状与后端 src/pixel/types.ts 一致；这里不出现上游 CDK 明文、完整卡密或结果链接。
export type PixelCdkMappingView = {
  mappingId: string;
  distributionCdkMasked: string;
  upstreamCdkMasked: string;
  note: string;
  enabled: boolean;
  createdByUsername: string;
  createdAt: string;
  updatedAt: string;
};

export type PixelCdkMappingCreated = {
  mapping: PixelCdkMappingView;
  /** 分发卡密明文：只在创建响应里出现这一次。 */
  distributionCdk: string;
};

export type PixelUsageLogView = {
  logId: string;
  requestId: string;
  userId: string;
  mappingId: string | null;
  requestedCdkMasked: string;
  matchedMapping: boolean;
  method: string;
  path: string;
  serviceType: string | null;
  accountCount: number | null;
  requestBytes: number;
  responseBytes: number | null;
  upstreamStatus: number | null;
  outcome: string;
  durationMs: number;
  createdAt: string;
};

export type PixelIntegrationConfigView = {
  configured: boolean;
  enabled: boolean;
  upstreamBaseUrl: string;
  allowedHosts: string[];
  requestTimeoutMs: number;
  updatedAt: string | null;
  updatedByUsername: string;
};

export type PixelAdminDashboardView = {
  config: { configured: boolean; enabled: boolean; host: string };
  mappings: { total: number; enabled: number };
  usage: { total: number; last24h: number; last7d: number; lastAt: string | null; retentionDays: number };
  tasks: { total: number; bySubmitState: Record<string, number> };
};

type Envelope<T> = { success: boolean; data: T };

function data<T>(response: { data: Envelope<T> }): T {
  return response.data.data;
}

export async function getPixelCdks(): Promise<PixelCdkMappingView[]> {
  return data(await api.get<Envelope<{ items: PixelCdkMappingView[] }>>("/api/admin/pixel/cdks")).items;
}

export async function createPixelCdk(input: { distributionCdk?: string; upstreamCdk: string; note?: string }): Promise<PixelCdkMappingCreated> {
  return data(await api.post<Envelope<PixelCdkMappingCreated>>("/api/admin/pixel/cdks", input));
}

export async function deletePixelCdk(mappingId: string): Promise<void> {
  await api.delete(`/api/admin/pixel/cdks/${encodeURIComponent(mappingId)}`);
}

export async function getPixelCdkUsage(params: { mappingId?: string; cdkMask?: string; limit?: number; cursor?: string }): Promise<{ items: PixelUsageLogView[]; nextCursor: string | null }> {
  // 只接受 mappingId 与**遮罩值** cdkMask：管理端查询串会被全局审计无条件写进 detail.query，
  // 完整卡密一旦进 URL 就等于默认落库一份。
  return data(await api.get<Envelope<{ items: PixelUsageLogView[]; nextCursor: string | null }>>("/api/admin/pixel/cdk-usage", { params }));
}

export async function getPixelCdkUsageDetail(logId: string): Promise<PixelUsageLogView> {
  return data(await api.get<Envelope<{ item: PixelUsageLogView }>>(`/api/admin/pixel/cdk-usage/${encodeURIComponent(logId)}`)).item;
}

export async function getPixelIntegrationConfig(): Promise<PixelIntegrationConfigView> {
  return data(await api.get<Envelope<PixelIntegrationConfigView>>("/api/admin/pixel/configs"));
}

export async function savePixelIntegrationConfig(input: {
  upstreamBaseUrl: string;
  allowedHosts: string[];
  enabled: boolean;
  requestTimeoutMs: number;
}): Promise<PixelIntegrationConfigView> {
  return data(await api.put<Envelope<PixelIntegrationConfigView>>("/api/admin/pixel/configs", input));
}

export async function getPixelAdminDashboard(): Promise<PixelAdminDashboardView> {
  return data(await api.get<Envelope<PixelAdminDashboardView>>("/api/admin/pixel/dashboard"));
}
