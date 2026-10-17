import { api } from './api';

/**
 * 法律保留与取证管理端 API（RC-22 / RC-35 / RC-58）。
 *
 * 后端挂载点：`/api/admin/legal-holds/*`（见 src/routes/admin/legalHolds.ts）。
 * 读接口要求 admin + 页面授权；写/导出接口要求 superadmin + 安全会话，
 * 且拒绝 API Key 触发（D10）。安全会话令牌走 `x-verification-token` 请求头。
 */

export type LegalHoldScope = 'user' | 'ip' | 'fingerprint';

export interface LegalHoldRow {
  id: string;
  scope: LegalHoldScope;
  value: string;
  /** 普通管理员看到的是掩码值；超级管理员为 false/缺省。 */
  valueMasked?: boolean;
  caseRef: string;
  reason: string;
  issuedBy: string;
  issuedAt: string;
  expiresAt: string | null;
  releasedBy: string | null;
  releasedAt: string | null;
  releaseReason: string;
}

export interface LegalHoldListResponse {
  success: boolean;
  holds: LegalHoldRow[];
  limit: number;
  nextCursor: string | null;
  auditWarning?: string;
}

export interface LegalHoldListParams {
  includeReleased?: boolean;
  scope?: LegalHoldScope;
  caseRef?: string;
  limit?: number;
  cursor?: string;
}

export interface CreateLegalHoldInput {
  scope: LegalHoldScope;
  value: string;
  caseRef: string;
  reason: string;
  expiresAt?: string;
}

export interface ReleaseLegalHoldInput {
  caseRef: string;
  releaseReason: string;
}

export type ForensicExportStatus = 'pending' | 'approved' | 'downloaded' | 'expired';

export interface ForensicExportRequestRow {
  requestId: string;
  caseRef: string;
  reason: string;
  scope: LegalHoldScope;
  subjectValue: string;
  from: string | null;
  to: string | null;
  status: ForensicExportStatus;
  requestedByUserId: string;
  requestedByUsername: string;
  approvedByUserId: string;
  approvedByUsername: string;
  expiresAt: string;
  approvedAt: string | null;
  downloadedAt: string | null;
  rowCount: number;
  checksum: string;
  createdAt: string;
}

export interface ForensicAuditEvent {
  eventId: string;
  action: string;
  actorId: string;
  actorUsername: string;
  actorRole: string;
  caseRef: string;
  scope: string;
  subjectValue: string;
  reason: string;
  exportRequestId?: string;
  detail?: Record<string, unknown>;
  ip: string;
  path?: string;
  method?: string;
  createdAt: string;
}

export interface ForensicAuditListResponse {
  success: boolean;
  events: ForensicAuditEvent[];
  limit: number;
  nextCursor: string | null;
}

export interface ForensicAuditListParams {
  action?: string;
  caseRef?: string;
  subjectValue?: string;
  limit?: number;
  cursor?: string;
}

export interface CreateForensicExportInput {
  scope: LegalHoldScope;
  value: string;
  caseRef: string;
  reason: string;
  from?: string;
  to?: string;
}

export interface CleanupReport {
  ok: boolean;
  dbAvailable: boolean;
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  totalDeleted: number;
  totalSkippedHeld: number;
  targets: Array<{
    collection: string;
    scanned: number;
    deleted: number;
    skippedHeld: number;
    error?: string;
  }>;
}

const sessionHeader = (verificationToken: string): Record<string, string> =>
  verificationToken ? { 'x-verification-token': verificationToken } : {};

export const legalHoldApi = {
  list(params: LegalHoldListParams = {}): Promise<LegalHoldListResponse> {
    return api.get<LegalHoldListResponse>('/api/admin/legal-holds', { params }).then((res) => res.data);
  },

  create(input: CreateLegalHoldInput, verificationToken: string): Promise<{ success: boolean; hold: LegalHoldRow }> {
    return api
      .post('/api/admin/legal-holds', input, { headers: sessionHeader(verificationToken) })
      .then((res) => res.data);
  },

  release(holdId: string, input: ReleaseLegalHoldInput, verificationToken: string): Promise<{ success: boolean; hold: LegalHoldRow }> {
    return api
      .post(`/api/admin/legal-holds/${encodeURIComponent(holdId)}/release`, input, {
        headers: sessionHeader(verificationToken),
      })
      .then((res) => res.data);
  },

  runCleanup(dryRun: boolean, verificationToken: string): Promise<{ success: boolean; report: CleanupReport }> {
    return api
      .post('/api/admin/legal-holds/cleanup/run', { dryRun }, { headers: sessionHeader(verificationToken) })
      .then((res) => res.data);
  },

  listForensicAudit(
    params: ForensicAuditListParams,
    verificationToken: string,
  ): Promise<ForensicAuditListResponse> {
    return api
      .get<ForensicAuditListResponse>('/api/admin/legal-holds/forensic-audit', {
        params,
        headers: sessionHeader(verificationToken),
      })
      .then((res) => res.data);
  },

  createExport(
    input: CreateForensicExportInput,
    verificationToken: string,
  ): Promise<{ success: boolean; request: ForensicExportRequestRow; potentialRows: number }> {
    return api
      .post('/api/admin/legal-holds/forensic-exports', input, { headers: sessionHeader(verificationToken) })
      .then((res) => res.data);
  },

  approveExport(
    requestId: string,
    verificationToken: string,
  ): Promise<{ success: boolean; request: ForensicExportRequestRow }> {
    return api
      .post(
        `/api/admin/legal-holds/forensic-exports/${encodeURIComponent(requestId)}/approve`,
        {},
        { headers: sessionHeader(verificationToken) },
      )
      .then((res) => res.data);
  },

  /**
   * 下载 NDJSON 归档并解析最后一行 manifest（含 SHA-256）。
   * 响应体有 20,000 行硬顶（后端按行计），因此在前端整包读取是可接受的有界操作。
   */
  async downloadExport(
    requestId: string,
    verificationToken: string,
  ): Promise<{
    blob: Blob;
    checksum: string;
    rowCount: number;
    caseRef: string;
    filename: string;
  }> {
    const response = await api.get<Blob>(
      `/api/admin/legal-holds/forensic-exports/${encodeURIComponent(requestId)}/download`,
      {
        responseType: 'blob',
        headers: sessionHeader(verificationToken),
      },
    );
    const blob = response.data;
    const text = await blob.text();
    const lines = text.split('\n').filter((line) => line.trim().length > 0);
    const last = lines[lines.length - 1] || '{}';
    let manifest: Record<string, unknown> = {};
    try {
      manifest = JSON.parse(last) as Record<string, unknown>;
    } catch {
      manifest = {};
    }
    const headers = response.headers as unknown as Record<string, string>;
    const disposition = headers['content-disposition'] || headers['Content-Disposition'] || '';
    const filenameMatch = /filename="?([^";]+)"?/i.exec(disposition);
    return {
      blob,
      checksum: typeof manifest.sha256 === 'string' ? manifest.sha256 : '',
      rowCount: typeof manifest.rowCount === 'number' ? manifest.rowCount : 0,
      caseRef: typeof manifest.caseRef === 'string' ? manifest.caseRef : '',
      filename: filenameMatch?.[1] || `forensic-${requestId}.ndjson`,
    };
  },
};

/** 从导出错误里取稳定 code（超限时是 EXPORT_LIMIT_EXCEEDED）。 */
export function extractLegalHoldErrorCode(error: unknown): string | null {
  const data = (error as { response?: { data?: { code?: unknown } } })?.response?.data;
  return typeof data?.code === 'string' ? data.code : null;
}

/**
 * 下载端点的错误体是 `responseType: blob`，`error.response.data` 是 Blob 而不是对象。
 * 这里异步读回 JSON，保证 `EXPORT_LIMIT_EXCEEDED` 这类稳定 code 在下载失败时也能被识别。
 */
export async function extractLegalHoldDownloadError(
  error: unknown,
  fallback: string,
): Promise<{ code: string | null; message: string }> {
  const response = (error as { response?: { data?: unknown } })?.response;
  const data = response?.data;
  if (data && typeof (data as Blob).text === 'function') {
    try {
      const parsed = JSON.parse(await (data as Blob).text()) as Record<string, unknown>;
      return {
        code: typeof parsed.code === 'string' ? parsed.code : null,
        message:
          (typeof parsed.error === 'string' && parsed.error) ||
          (typeof parsed.message === 'string' && parsed.message) ||
          fallback,
      };
    } catch {
      // 落到下面的通用兜底。
    }
  }
  const code = extractLegalHoldErrorCode(error);
  const direct = (error as { response?: { data?: { error?: unknown; message?: unknown } } })?.response?.data;
  const message =
    (typeof direct?.error === 'string' && direct.error) ||
    (typeof direct?.message === 'string' && direct.message) ||
    (error instanceof Error && error.message) ||
    fallback;
  return { code, message };
}
