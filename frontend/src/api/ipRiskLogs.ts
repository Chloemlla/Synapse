import { api, getApiBaseUrl } from './api';

/**
 * proxycheck.io IP 风险检测管理端只读日志 API。
 * 契约：`.audit-reports/synapse-proxycheck-log-panel-2026-09-25.md` §2。
 * 所有端点都要求 superadmin 会话，只读，密钥一律由服务端 mask 后才下发。
 */

export type IpRiskCaller = 'api' | 'first_visit_gate' | 'batch';

export type IpRiskDecisionAction = 'report' | 'block' | 'challenge' | 'allow' | 'fail_open' | 'fail_closed';

export type IpRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export type IpRiskDecisionSource = 'cache' | 'proxycheck' | 'unavailable';

/** 一次「给前端的决策」的完整快照。落库在 lookup log 上；风险缓存页是按当前配置重算的。 */
export interface IpRiskDecision {
  caller: IpRiskCaller;
  action: IpRiskDecisionAction;
  shouldChallenge: boolean;
  /** 风险分达到 blockRiskScore 且 caller 是首访闸门：闸门应直接把该 IP 写进封禁表。 */
  shouldBlock: boolean;
  reason: string;
  risk: number;
  level: IpRiskLevel;
  flags: string[];
  source: IpRiskDecisionSource;
  threshold: number;
  /** 当时生效的 blockRiskScore（与 threshold 一样是快照，不是当前配置）。 */
  blockThreshold: number;
  failOpen: boolean;
  closedOnFailure: boolean;
}

export interface ProxycheckSettingConfig {
  enabled: boolean;
  apiKey: string;
  hasApiKey: boolean;
  publicApiKey: string;
  hasPublicApiKey: boolean;
  payloadVerificationKey: string;
  hasPayloadVerificationKey: boolean;
  hmacSecret: string;
  hasHmacSecret: boolean;
  cacheTtlHours: number;
  timeoutMs: number;
  dailyQuotaPerKey: number;
  challengeRiskScore: number;
  blockRiskScore: number;
  failOpen: boolean;
  usePublicKeyForClient: boolean;
  /** 验签未通过时是否仍采信上游结论（PROXYCHECK.trustUnverifiedUpstream）。旧后端响应没有该字段。 */
  trustUnverifiedUpstream?: boolean;
}

export interface ProxycheckOverviewCounts {
  lookupLogs: number;
  lookupLogs24h: number;
  /** 真的打到上游的行数（排除 status=cache）：与配额、外呼失败对应。 */
  upstreamCalls: number;
  upstreamCalls24h: number;
  /** 最近 24 小时真的打到上游且成功的次数（status=ok）。旧后端响应没有该字段。 */
  upstreamOk24h?: number;
  /** 最近 24 小时真的打到上游但失败的次数（status=failed）。>0 即「上游在失败」。 */
  failed24h?: number;
  /** 最近一次上游失败（status=failed 的最新一行）的 error 与时间；从无失败时为 null。 */
  lastError?: { message: string; at: string | null } | null;
  riskCache: number;
  riskCacheActive: number;
  probeReports: number;
  probeReports24h: number;
}

export interface ProxycheckQuotaSummary {
  dayKey: string;
  apiKeySlot: number;
  count: number;
  limit: number;
  exhausted: boolean;
  exhaustedAt: string | null;
  lastUsedAt: string | null;
}

export interface ProxycheckQuotaHistoryRow {
  dayKey: string;
  apiKeySlot?: number;
  count: number;
  exhausted: boolean;
  apiKeyHash: string;
  exhaustedAt: string | null;
  lastUsedAt: string | null;
}

export interface ProxycheckCollectionInfo {
  name: string;
  indexes: string[];
  exists: boolean;
}

export interface ProxycheckOverviewResponse {
  success: boolean;
  setting: { config: ProxycheckSettingConfig; updatedAt: string | null };
  counts: ProxycheckOverviewCounts;
  quota: ProxycheckQuotaSummary;
  quotaHistory: ProxycheckQuotaHistoryRow[];
  collections: ProxycheckCollectionInfo[];
}

export interface ProxycheckLookupLogRow {
  _id: string;
  ip: string;
  apiKeySlot: number;
  apiKeyHash: string;
  status: string;
  ok: boolean;
  risk: number | null;
  deduped: boolean;
  durationMs: number;
  error: string;
  createdAt: string;
  /** 旧行（本次改造之前写入的）没有这个字段。 */
  decision?: IpRiskDecision | null;
  /** 该行是否带上游交互排障快照（正文走 /upstream-diagnostics，列表只回布尔）。 */
  hasDiagnostics?: boolean;
  [key: string]: unknown;
}

// 'cache' = 命中 proxycheck_risk_cache 的决策行：零外呼、零配额，但当时确实交出了一个结论。
export type LookupStatusFilter =
  | ''
  | 'ok'
  | 'failed'
  | 'deduped'
  | 'quota_exhausted'
  | 'not_configured'
  | 'cache';

export type TriStateFilter = '' | 'true' | 'false';

export interface LookupsParams {
  limit?: number;
  offset?: number;
  ip?: string;
  status?: LookupStatusFilter;
  ok?: TriStateFilter;
  deduped?: TriStateFilter;
}

export interface LookupsFilters {
  ip: string | null;
  status: string | null;
  ok: boolean | null;
  deduped: boolean | null;
}

export interface LookupsResponse {
  success: boolean;
  logs: ProxycheckLookupLogRow[];
  total: number;
  limit: number;
  offset: number;
  filters: LookupsFilters;
}

/** `proxycheck_risk_cache` 文档原样字段（见 `src/models/proxycheckRiskCacheModel.ts`）。 */
export interface RiskCacheEntry {
  _id?: string;
  ip: string;
  risk: number;
  anonymous: boolean;
  proxy: boolean;
  vpn: boolean;
  tor: boolean;
  hosting: boolean;
  scraper: boolean;
  compromised: boolean;
  confidence: number;
  networkType: string;
  provider: string;
  asn: string;
  range: string;
  organisation: string;
  hostname: string;
  continent: string;
  country: string;
  isocode: string;
  region: string;
  city: string;
  latitude?: number | null;
  longitude?: number | null;
  timezone: string;
  detectionsRaw?: Record<string, unknown> | null;
  lastUpdated?: string | null;
  queriedAt: string;
  expiresAt: string;
  source: string;
  expired: boolean;
  /** 按「当前」challengeRiskScore / failOpen 重算，不是历史记录。 */
  derivedDecision: IpRiskDecision | null;
  [key: string]: unknown;
}

export type RiskCacheState = 'active' | 'expired' | 'all';

export interface RiskCacheParams {
  limit?: number;
  offset?: number;
  ip?: string;
  state?: RiskCacheState;
}

export interface RiskCacheResponse {
  success: boolean;
  entries: RiskCacheEntry[];
  total: number;
  limit: number;
  offset: number;
  state: string;
}

/** `proxycheck_probe_reports` 文档原样字段（见 `src/models/proxycheckProbeReportModel.ts`）。 */
export interface ProbeReportRow {
  _id?: string;
  ip: string;
  httpExitIp?: string;
  wsExitIp?: string;
  ipv6Exit?: string;
  webrtcLeak?: boolean;
  /** WebRTC host 候选暴露的地址（局域网/本机；mDNS 混淆下通常为空），客户端自报。 */
  webrtcHostIps?: string[];
  /** WebRTC srflx 候选（经 STUN 观测到的公网映射地址），客户端自报；服务端据此自判 webrtcVsExit。 */
  webrtcSrflxIps?: string[];
  timezone?: string;
  timezoneOffsetMin?: number;
  languages?: string[];
  userAgent?: string;
  uaPlatform?: string;
  hardwareConcurrency?: number;
  deviceMemory?: number;
  screenRes?: string;
  webdriver?: boolean;
  collectedAt?: string;
  flags: string[];
  mismatch: {
    ipv4vsWs: boolean;
    ipvEvsV6: boolean;
    timezoneVsGeo: boolean;
    /** 本轮新增：老文档没有这个字段，读出为 undefined。 */
    webrtcVsExit?: boolean;
  };
  /** 各轴是否具备判定条件；老文档（本判定改版前写入）没有这个字段，读出为 undefined。 */
  comparability?: {
    ipv4vsWs: boolean;
    ipvEvsV6: boolean;
    timezoneVsGeo: boolean;
    webrtcVsExit?: boolean;
  };
  createdAt: string;
  [key: string]: unknown;
}

export interface ProbeReportsParams {
  limit?: number;
  offset?: number;
  ip?: string;
  /** WebRTC 泄露筛选：leak=服务端判定的真实泄露，reported=客户端自报，any=任一。 */
  webrtc?: 'leak' | 'reported' | 'any';
}

export interface ProbeReportsResponse {
  success: boolean;
  reports: ProbeReportRow[];
  total: number;
  limit: number;
  offset: number;
}

export interface ProxycheckQuotaRow {
  dayKey: string;
  apiKeySlot: number;
  apiKeyHash: string;
  count: number;
  exhausted: boolean;
  exhaustedAt: string | null;
  lastUsedAt: string | null;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface QuotasResponse {
  success: boolean;
  quotas: ProxycheckQuotaRow[];
  limit: number;
}

/* ------------------------------------------------------------------ *
 * 上游交互排障快照（/api/admin/proxycheck/upstream-diagnostics）
 * 契约：docs/contracts/proxycheck-signature-diagnostics.md
 * 重申最要紧的一条：**密钥明文永远不会出现在这些响应里**，只有长度 + sha256 指纹。
 * ------------------------------------------------------------------ */

/** 一把密钥的形状：有没有配、多长、是哪一把。指纹不可反推明文。 */
export interface ProxycheckKeyShape {
  present: boolean;
  length: number;
  fingerprint: string;
}

export type ProxycheckSignatureVerdict =
  | 'verified'
  | 'header_missing'
  | 'header_malformed'
  | 'mismatch'
  | 'not_configured'
  | 'key_malformed'
  | 'no_response';

export interface ProxycheckExchangeDiagnostics {
  errorCode: string;
  /** 验签未过但按 trustUnverifiedUpstream 采信了上游结论。 */
  trustedWithoutSignature: boolean;
  method: string;
  /** 已脱敏：key 参数只剩长度与指纹。 */
  url: string;
  requestHeaders: Record<string, string>;
  requestBody?: string | null;
  status: number | null;
  responseHeaders: Record<string, string>;
  /** 上游响应体（按字节截断的展示副本）。 */
  body: string;
  bodyBytes: number;
  bodyTruncated: boolean;
  signature: {
    verdict: ProxycheckSignatureVerdict;
    headerName: string;
    headerValue: string;
    expectedSignature: string | null;
    key: ProxycheckKeyShape;
  };
  keys: {
    apiKey: ProxycheckKeyShape;
    publicApiKey: ProxycheckKeyShape;
    payloadVerificationKey: ProxycheckKeyShape;
    hmacSecret: ProxycheckKeyShape;
    payloadVerificationKeyMatchesHmacSecret: boolean;
  };
  durationMs: number;
  createdAt: string;
}

export interface UpstreamDiagnosticRow {
  _id: string;
  ip: string;
  status: string;
  error: string;
  durationMs: number;
  createdAt: string | null;
  diagnostics: ProxycheckExchangeDiagnostics | null;
}

export type SignatureVerdictFilter = '' | ProxycheckSignatureVerdict;

export interface UpstreamDiagnosticsParams {
  limit?: number;
  offset?: number;
  ip?: string;
  verdict?: SignatureVerdictFilter;
  /** '' = 不限；'true' = 只看「验签未过但已采信」；'false' = 只看真失败。 */
  trusted?: TriStateFilter;
}

export interface UpstreamDiagnosticsResponse {
  success: boolean;
  rows: UpstreamDiagnosticRow[];
  total: number;
  limit: number;
  offset: number;
  filters: { ip: string | null; verdict: string | null; trusted: boolean | null };
}

export interface SignatureVerifyResponse {
  success: boolean;
  /** 候选密钥对得上上游回签值。 */
  matches: boolean;
  verdict: ProxycheckSignatureVerdict;
  bodyTruncated: boolean;
  bodyBytes: number;
  upstreamSignature: string;
  expectedSignature: string;
  candidateLength: number;
  candidateFingerprint: string;
  configuredKeyLength: number;
  configuredKeyFingerprint: string;
  /** 候选密钥就是服务端当前配置的那把。 */
  candidateMatchesConfiguredKey: boolean;
}

const BASE = () => `${getApiBaseUrl()}/api/admin/proxycheck`;

const toQuery = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
};

export const ipRiskLogsApi = {
  overview: async (): Promise<ProxycheckOverviewResponse> => {
    const res = await api.get(`${BASE()}/overview`);
    return res.data;
  },

  lookups: async (params: LookupsParams = {}): Promise<LookupsResponse> => {
    const res = await api.get(`${BASE()}/lookups${toQuery({ ...params })}`);
    return res.data;
  },

  riskCache: async (params: RiskCacheParams = {}): Promise<RiskCacheResponse> => {
    const res = await api.get(`${BASE()}/risk-cache${toQuery({ ...params })}`);
    return res.data;
  },

  quotas: async (days = 30): Promise<QuotasResponse> => {
    const res = await api.get(`${BASE()}/quotas${toQuery({ days })}`);
    return res.data;
  },

  probeReports: async (params: ProbeReportsParams = {}): Promise<ProbeReportsResponse> => {
    const res = await api.get(`${BASE()}/probe-reports${toQuery({ ...params })}`);
    return res.data;
  },

  upstreamDiagnostics: async (
    params: UpstreamDiagnosticsParams = {},
  ): Promise<UpstreamDiagnosticsResponse> => {
    const res = await api.get(`${BASE()}/upstream-diagnostics${toQuery({ ...params })}`);
    return res.data;
  },

  /**
   * 用候选密钥在**已存响应体**上重算一次验签。
   * 用 POST 是因为候选密钥不能进 URL / 访问日志；该端点不改任何数据，候选密钥也不落库。
   */
  verifyDiagnosticSignature: async (id: string, key: string): Promise<SignatureVerifyResponse> => {
    const res = await api.post(`${BASE()}/upstream-diagnostics/${encodeURIComponent(id)}/verify-signature`, {
      key,
    });
    return res.data;
  },
};
