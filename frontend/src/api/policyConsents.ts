import { api, getApiBaseUrl } from './api';

/**
 * 隐私政策同意记录管理端只读 API。
 * 数据源：policy_consents 集合，由 policyConsentService.writePolicyConsent 单点写入
 * （登录 / 注册 / TTS 门禁）。所有端点都要求 superadmin 会话，只读（导出除外，只读 + 审计）；
 * checksum / documentHash 只回前 12 位预览。
 */

/** 同意记录的写入来源，与 policyConsentService.PolicyConsentSource 对齐。 */
export type PolicyConsentSource = 'login' | 'register' | 'feature';

/** 记录状态筛选：valid = 有效且未过期；expired = 已过期或已置无效；all = 全部。 */
export type PolicyConsentState = 'valid' | 'expired' | 'all';

/** 逐条同意记录（服务端 toConsentRow 的形状）。 */
export interface PolicyConsentRow {
  id: string;
  version: string;
  fingerprint: string;
  ipAddress: string;
  userAgent: string;
  source: string;
  agreements: string[];
  /** 是否勾满全部四份文件（老记录可能没有 agreements 字段）。 */
  agreementsComplete: boolean;
  /** 未勾选的文件键名；空数组表示四份齐全。 */
  missingAgreements: string[];
  isValid: boolean;
  expired: boolean;
  /** checksum 的前 12 位预览，仅用于辨识，非完整签名。 */
  checksumPreview: string;
  /** 同意时条文指纹的前 12 位预览 */
  documentHashPreview: string;
  /** 撤回时间 / 撤回 IP / 撤回原因（未撤回时为空） */
  revokedAt: string | null;
  revokedIP: string;
  revokedReason: string;
  recordedAt: string | null;
  expiresAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface PolicyConsentGroupRow {
  key: string;
  count: number;
}

export interface PolicyConsentTrendRow {
  date: string;
  count: number;
}

export interface PolicyConsentCollectionInfo {
  name: string;
  indexes: string[];
  exists: boolean;
}

export interface PolicyConsentOverviewResponse {
  success: boolean;
  currentVersion: string;
  /** 当前条文的指纹（sha256）：与每条记录的 documentHashPreview 对账的基准值 */
  documentHash: string;
  validityDays: number;
  /** 当前版本要求逐项勾选的文件键名（POLICY_AGREEMENT_KEYS）。 */
  agreementKeys: string[];
  counts: { total: number; valid: number; expired: number; revoked: number; incomplete: number };
  versions: PolicyConsentGroupRow[];
  sources: PolicyConsentGroupRow[];
  /** 趋势窗口（天） */
  trendDays: number;
  recentTrend: PolicyConsentTrendRow[];
  collection: PolicyConsentCollectionInfo;
}

export interface PolicyConsentListParams {
  limit?: number;
  offset?: number;
  fingerprint?: string;
  ip?: string;
  version?: string;
  source?: string;
  state?: PolicyConsentState;
  /** 记录时间下界（YYYY-MM-DD 或 ISO） */
  from?: string;
  /** 记录时间上界（YYYY-MM-DD 或 ISO） */
  to?: string;
  /** 只看勾选不完整的记录（缺字段或没覆盖全部四份文件） */
  agreementsIncomplete?: boolean;
}

export interface PolicyConsentListFilters {
  fingerprint: string | null;
  ip: string | null;
  version: string | null;
  source: string | null;
  state: PolicyConsentState;
  from: string | null;
  to: string | null;
  agreementsIncomplete: boolean;
}

export interface PolicyConsentListResponse {
  success: boolean;
  consents: PolicyConsentRow[];
  total: number;
  limit: number;
  offset: number;
  filters: PolicyConsentListFilters;
}

export interface PolicyConsentExportResult {
  csv: string;
  /** 服务端实际写入的行数（不含表头） */
  rowCount: number;
  /** 是否因为 5000 行上限被截断 */
  truncated: boolean;
}

const BASE = () => `${getApiBaseUrl()}/api/admin/policy-consents`;

const toQuery = (params: Record<string, string | number | boolean | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
};

const readHeader = (headers: unknown, name: string): string => {
  if (!headers || typeof headers !== 'object') return '';
  const value = (headers as Record<string, unknown>)[name];
  return value === undefined || value === null ? '' : String(value);
};

export const policyConsentApi = {
  /** 概览：计数 + 版本/来源分布 + 趋势（窗口由 days 控制，服务端收敛到 1–90）。 */
  overview: async (days?: number): Promise<PolicyConsentOverviewResponse> => {
    const res = await api.get(`${BASE()}/overview${toQuery({ days })}`);
    return res.data;
  },

  /** 逐条记录（分页 + 多条件筛选）。 */
  list: async (params: PolicyConsentListParams = {}): Promise<PolicyConsentListResponse> => {
    const res = await api.get(`${BASE()}${toQuery({ ...params })}`);
    return res.data;
  },

  /**
   * 按同一套筛选导出 CSV（服务端上限 5000 行）。
   * 导出含设备指纹与 IP，所以这里只把文本取回来，由调用方决定落盘方式；
   * 服务端已挂审计留痕，文件名带导出时刻。
   */
  exportCsv: async (params: PolicyConsentListParams = {}): Promise<PolicyConsentExportResult> => {
    const res = await api.get(`${BASE()}/export${toQuery({ ...params })}`, { responseType: 'text' });
    const csv = typeof res.data === 'string' ? res.data : String(res.data ?? '');
    return {
      csv,
      rowCount: Number(readHeader(res.headers, 'x-export-rows')) || 0,
      truncated: readHeader(res.headers, 'x-export-truncated') === 'true',
    };
  },
};
