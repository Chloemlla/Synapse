import { api, getApiBaseUrl } from './api';

/**
 * 隐私政策同意记录管理端只读 API。
 * 数据源：policy_consents 集合，由 policyConsentService.writePolicyConsent 单点写入
 * （登录 / 注册 / TTS 门禁）。所有端点都要求 superadmin 会话，只读；checksum 只回前 12 位预览。
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
  isValid: boolean;
  expired: boolean;
  /** checksum 的前 12 位预览，仅用于辨识，非完整签名。 */
  checksumPreview: string;
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
  validityDays: number;
  /** 当前版本要求逐项勾选的文件键名（POLICY_AGREEMENT_KEYS）。 */
  agreementKeys: string[];
  counts: { total: number; valid: number; expired: number };
  versions: PolicyConsentGroupRow[];
  sources: PolicyConsentGroupRow[];
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
}

export interface PolicyConsentListFilters {
  fingerprint: string | null;
  ip: string | null;
  version: string | null;
  source: string | null;
  state: PolicyConsentState;
}

export interface PolicyConsentListResponse {
  success: boolean;
  consents: PolicyConsentRow[];
  total: number;
  limit: number;
  offset: number;
  filters: PolicyConsentListFilters;
}

const BASE = () => `${getApiBaseUrl()}/api/admin/policy-consents`;

const toQuery = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
};

export const policyConsentApi = {
  overview: async (): Promise<PolicyConsentOverviewResponse> => {
    const res = await api.get(`${BASE()}/overview`);
    return res.data;
  },

  list: async (params: PolicyConsentListParams = {}): Promise<PolicyConsentListResponse> => {
    const res = await api.get(`${BASE()}${toQuery({ ...params })}`);
    return res.data;
  },
};
