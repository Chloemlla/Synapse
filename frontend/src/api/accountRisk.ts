import { api, getApiBaseUrl } from './api';

/**
 * 账户风险与自动化信号管理端只读 API（页面 `/admin/account-risk`）。
 *
 * 权限：`admin` + 页面授权 `account-risk`（默认只有超管）。
 * 所有端点只读；处置仍走用户管理页的批量动作，由服务端 `applyAccountRiskAction` 单一出口写库。
 *
 * 口径提醒：`riskScore` **越高越危险**（0-100），与账户安全摘要里「越高越安全」的方向相反。
 * 本客户端拿到的 IP / 指纹 / 事件载荷都已由服务端打码或脱敏，前端不做二次还原。
 */

export type AccountRiskTier = 'normal' | 'watch' | 'restricted' | 'danger';

export type AccountRiskChannel =
  | 'tts_generate'
  | 'transcribe'
  | 'cdk_redeem'
  | 'file_upload'
  | 'librechat'
  | 'ticket';

export interface AccountRiskChannelDecision {
  locked: boolean;
  code: 'ACCOUNT_RESTRICTED' | null;
  reason: string;
  supportEmail: string;
  appealChannel: 'ticket' | 'support_email' | 'none';
}

export interface AccountRiskOverviewResponse {
  success: boolean;
  generatedAt: string;
  accounts: {
    total: number;
    tiers: Record<AccountRiskTier, number>;
    statuses: { active: number; suspended: number };
    stepUpPending: number;
  };
  events24h: {
    total: number;
    idcEgress: number;
    geoJump: number;
    captchaFailed: number;
    automationTrace: number;
    riskActions: number;
  };
  signalsByType: Array<{ eventType: string; count: number }>;
  topFlags: Array<{ flag: string; count: number }>;
  recentActions: Array<{
    id: string;
    eventType: string;
    userId: string | null;
    createdAt: string | null;
    eventData: unknown;
  }>;
  ipFacts: { total: number; datacenter: number };
  indexes: { names: string[]; missing: string[] };
}

export interface AccountRiskAccountRow {
  id: string;
  username: string | null;
  email: string | null;
  role: string;
  riskTier: AccountRiskTier;
  riskScore: number;
  riskFlags: string[];
  riskUpdatedAt: string | null;
  flaggedBy: string | null;
  flagReason: string | null;
  accountStatus: 'active' | 'suspended';
  stepUpUntil: string | null;
  stepUpMode: string | null;
  lastLoginIp: string | null;
  lastLoginAt: string | null;
  createdAt: string | null;
}

export interface AccountRiskSignalRow {
  id: string;
  eventType: string;
  userId: string | null;
  ip: string | null;
  deviceFingerprint: string | null;
  riskScore: number | null;
  anonymous: boolean;
  createdAt: string | null;
  eventData: unknown;
}

export interface AccountRiskIpFactRow {
  id: string;
  userId: string | null;
  ip: string | null;
  ipLocation: string | null;
  loginCount: number;
  riskScore: number | null;
  riskLevel: string | null;
  flags: string[];
  networkType: string | null;
  asn: string | null;
  organisation: string | null;
  isDatacenter: boolean;
  source: string;
  riskCheckedAt: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
}

export interface AccountRiskActionRow {
  id: string;
  eventType: string;
  userId: string | null;
  createdAt: string | null;
  action: string | null;
  fromTier: string | null;
  toTier: string | null;
  operatorId: string | null;
  reason: string | null;
  automatic: boolean;
  eventData: unknown;
}

export interface AccountRiskConfigResponse {
  success: boolean;
  config: Record<string, unknown>;
  weights: {
    anonymousAbuseMaxScore: number;
    probeExitMismatchScore: number;
    automationHintScore: number;
    geoJumpScore: number;
    note: string;
  };
  channelMatrix: Array<{
    channel: AccountRiskChannel;
    byTier: Array<{ tier: AccountRiskTier } & AccountRiskChannelDecision>;
  }>;
  restrictedCode: string;
  supportEmail: string;
  eventPrefix: string;
  automationEvent: string;
}

export interface AccountRiskAccountDetailResponse {
  success: boolean;
  account: AccountRiskAccountRow;
  channels: Array<{ channel: AccountRiskChannel } & AccountRiskChannelDecision>;
  signals: AccountRiskSignalRow[];
  ipFacts: AccountRiskIpFactRow[];
  actions: Array<
    Pick<AccountRiskActionRow, 'id' | 'eventType' | 'createdAt' | 'action' | 'fromTier' | 'toTier' | 'operatorId' | 'reason'>
  >;
}

export interface AccountRiskPageMeta {
  total: number;
  limit: number;
  offset: number;
}

export interface AccountsParams {
  q?: string;
  tier?: string;
  status?: string;
  flag?: string;
  sort?: 'risk_desc' | 'recent' | 'created';
  limit?: number;
  offset?: number;
}

export interface SignalsParams {
  userId?: string;
  eventType?: string;
  ip?: string;
  anonymous?: boolean;
  since?: string;
  until?: string;
  sort?: 'recent' | 'oldest';
  limit?: number;
  offset?: number;
}

export interface IpFactsParams {
  userId?: string;
  ip?: string;
  datacenter?: 'true' | 'false' | '';
  level?: string;
  since?: string;
  limit?: number;
  offset?: number;
}

export interface ActionsParams {
  userId?: string;
  action?: string;
  operatorId?: string;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

const BASE = () => `${getApiBaseUrl()}/api/admin/account-risk`;

const toQuery = (params: Record<string, string | number | boolean | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
};

export const accountRiskApi = {
  overview: async (): Promise<AccountRiskOverviewResponse> => {
    const res = await api.get(`${BASE()}/overview`);
    return res.data;
  },

  accounts: async (params: AccountsParams = {}): Promise<AccountRiskPageMeta & { accounts: AccountRiskAccountRow[] }> => {
    const res = await api.get(`${BASE()}/accounts${toQuery({ ...params })}`);
    return res.data;
  },

  accountDetail: async (userId: string): Promise<AccountRiskAccountDetailResponse> => {
    const res = await api.get(`${BASE()}/accounts/${encodeURIComponent(userId)}`);
    return res.data;
  },

  signals: async (params: SignalsParams = {}): Promise<AccountRiskPageMeta & { signals: AccountRiskSignalRow[] }> => {
    const res = await api.get(`${BASE()}/signals${toQuery({ ...params })}`);
    return res.data;
  },

  ipFacts: async (params: IpFactsParams = {}): Promise<AccountRiskPageMeta & { ipFacts: AccountRiskIpFactRow[] }> => {
    const res = await api.get(`${BASE()}/ip-facts${toQuery({ ...params })}`);
    return res.data;
  },

  actions: async (params: ActionsParams = {}): Promise<AccountRiskPageMeta & { actions: AccountRiskActionRow[] }> => {
    const res = await api.get(`${BASE()}/actions${toQuery({ ...params })}`);
    return res.data;
  },

  config: async (): Promise<AccountRiskConfigResponse> => {
    const res = await api.get(`${BASE()}/config`);
    return res.data;
  },
};
