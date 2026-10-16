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

// —— 法律保全与内容级取证（合规操作；全部仅超级管理员可写，读取逐次进审计） ——

export type PixelEvidenceHoldView = {
  holdId: string;
  userId: string;
  caseRef: string;
  legalBasis: string;
  reason: string;
  issuedByUsername: string;
  issuedAt: string;
  taskAccessCount: number;
  usageLogCount: number;
  truncated: boolean;
  releasedAt: string | null;
  releasedByUsername: string;
  releaseReason: string;
  purgeAfter: string | null;
};

export type PixelEvidenceApprovalView = {
  approvalId: string;
  userId: string;
  caseRef: string;
  legalBasis: string;
  reason: string;
  approvedByUsername: string;
  approvedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedByUsername: string;
  revokeReason: string;
};

export type PixelEvidenceView = {
  evidenceId: string;
  userId: string;
  caseRef: string;
  legalBasis: string;
  approvedByUsername: string;
  capturedAt: string;
  expiresAt: string;
  accountCount: number;
  byteSize: number;
  accessCount: number;
  lastAccessedAt: string | null;
  truncatedFromBytes: number | null;
};

export async function getPixelLegalHolds(includeReleased = false): Promise<PixelEvidenceHoldView[]> {
  return data(await api.get<Envelope<{ items: PixelEvidenceHoldView[] }>>("/api/admin/pixel/legal-holds", { params: includeReleased ? { includeReleased: "1" } : {} })).items;
}

export async function createPixelLegalHold(input: { userId: string; caseRef: string; legalBasis: string; reason?: string }): Promise<PixelEvidenceHoldView> {
  return data(await api.post<Envelope<PixelEvidenceHoldView>>("/api/admin/pixel/legal-holds", input));
}

export async function releasePixelLegalHold(holdId: string, input: { releaseReason?: string; purgeDelayDays?: number }): Promise<PixelEvidenceHoldView> {
  return data(await api.post<Envelope<PixelEvidenceHoldView>>(`/api/admin/pixel/legal-holds/${encodeURIComponent(holdId)}/release`, input));
}

export async function getPixelEvidenceApprovals(includeRevoked = false): Promise<PixelEvidenceApprovalView[]> {
  return data(await api.get<Envelope<{ items: PixelEvidenceApprovalView[] }>>("/api/admin/pixel/evidence-approvals", { params: includeRevoked ? { includeRevoked: "1" } : {} })).items;
}

export async function createPixelEvidenceApproval(input: { userId: string; caseRef: string; legalBasis: string; reason?: string; validDays?: number }): Promise<PixelEvidenceApprovalView> {
  return data(await api.post<Envelope<PixelEvidenceApprovalView>>("/api/admin/pixel/evidence-approvals", input));
}

export async function revokePixelEvidenceApproval(approvalId: string, reason?: string): Promise<PixelEvidenceApprovalView> {
  return data(await api.post<Envelope<PixelEvidenceApprovalView>>(`/api/admin/pixel/evidence-approvals/${encodeURIComponent(approvalId)}/revoke`, { reason }));
}

export async function getPixelEvidenceRecords(params: { caseRef?: string; userId?: string; limit?: number } = {}): Promise<PixelEvidenceView[]> {
  return data(await api.get<Envelope<{ items: PixelEvidenceView[] }>>("/api/admin/pixel/evidence", { params })).items;
}

/** 读取取证内容：必须带上与记录一致的条件编号；服务端会为每一次读取写审计。 */
export async function readPixelEvidenceRecord(evidenceId: string, caseRef: string): Promise<{ meta: PixelEvidenceView; accountsText: string }> {
  return data(await api.post<Envelope<{ meta: PixelEvidenceView; accountsText: string }>>(`/api/admin/pixel/evidence/${encodeURIComponent(evidenceId)}/read`, { caseRef }));
}

// —— 主密钥轮换：体检 + 存量密文重加密（仅超级管理员 + 安全会话） ——

export type PixelKeyRotationStatus = {
  master: { origin: string; fingerprint: string; previousConfigured: boolean; previousFingerprint: string | null };
  mappings: { total: number; encryptedWithCurrentKey: number; needsReencrypt: number; undecryptable: number };
  evidence: { total: number; encryptedWithCurrentKey: number; needsReencrypt: number; undecryptable: number };
  retirePreviousKey: { canRetire: boolean; reason: string };
};

export type PixelReencryptResult = {
  apply: boolean;
  scanned: number;
  reencrypted: number;
  pending: number;
  undecryptable: number;
  remaining: number;
};

export async function getPixelKeyRotationStatus(): Promise<PixelKeyRotationStatus> {
  return data(await api.get<Envelope<PixelKeyRotationStatus>>("/api/admin/pixel/key-rotation"));
}

export async function reencryptPixelSecrets(input: { apply: boolean; limit?: number }): Promise<PixelReencryptResult> {
  return data(await api.post<Envelope<PixelReencryptResult>>("/api/admin/pixel/key-rotation/reencrypt", input));
}
