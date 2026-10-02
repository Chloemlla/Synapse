import { api, getApiBaseUrl } from './api';

/**
 * 集成健康中心 API 客户端。
 * 对应后端 `src/routes/admin/integrations.ts`（挂载在 /api/admin，继承管理端鉴权与 adminLimiter）。
 * 读接口对普通管理员开放（页面授权范围内）；写接口（清缓存、名单增删、事件清理）要求超管。
 */

const BASE = () => `${getApiBaseUrl()}/api/admin/integrations`;

const toQuery = (params: Record<string, string | number | boolean | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
};

export interface CacheStats {
  tier: 'redis' | 'memory';
  hits: number;
  misses: number;
  sets: number;
  deletes: number;
  errors: number;
  hitRate: number;
  memoryEntries: number;
  inflight: number;
}

export interface RedisStatus {
  configured: boolean;
  enabled: boolean;
  ready: boolean;
  available: boolean;
}

export interface RedisServerStats {
  dbsize: number | null;
  usedMemoryBytes: number | null;
}

export type SuppressionReason = 'bounce' | 'complaint' | 'unsubscribe' | 'manual';

export interface SuppressionRow {
  email: string;
  reason: SuppressionReason;
  source: string;
  detail: string;
  expiresAt: string | null;
  permanent: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface SuppressionStats {
  total: number;
  active: number;
  permanent: number;
  byReason: Array<{ reason: string; total: number }>;
  last24h: number;
  last7d: number;
}

export interface SuppressionListResponse {
  success: boolean;
  items: SuppressionRow[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  stats: SuppressionStats;
}

export interface WebhookRouteHealth {
  routeKey: string | null;
  total7d: number;
  total24h: number;
  failed7d: number;
  failureRate: number;
  lastReceivedAt: string | null;
  secretConfigured: boolean;
}

export interface WebhookSecretRow {
  key: string;
  secretPreview: string;
  updatedAt: string | null;
}

export interface WebhookHealthResponse {
  success: boolean;
  since: string;
  routes: WebhookRouteHealth[];
  secretKeys: string[];
  secrets: WebhookSecretRow[];
}

export interface RecommendationAnalytics {
  totalUsers: number;
  totalGenerations: number;
  feedback: { like: number; dislike: number; notInterested: number; total: number };
  topStyles: Array<{ styleId: string; total: number }>;
  topLanguages: Array<{ language: string; total: number }>;
}

export interface RegistrationInviteStats {
  total: number;
  active: number;
  expired: number;
  exhausted: number;
  totalUses: number;
  remainingUses: number;
  topInviters: Array<{ username: string; created: number; uses: number }>;
  topCodes: Array<{ code: string; usedCount: number; maxUses: number; active: boolean }>;
  recentUses: Array<{ code: string; username: string; email: string; usedAt: string }>;
  trend: Array<{ date: string; uses: number }>;
}

export interface ProviderSnapshot {
  openai: {
    apiKeyConfigured: boolean;
    apiKeyPreview: string | null;
    baseUrlConfigured: boolean;
    model: string | null;
  };
  resend: { apiKeyConfigured: boolean; domain: string | null; outemailEnabled: boolean };
  svix: { envSecretConfigured: boolean };
}

export interface IntegrationsOverview {
  success: boolean;
  mongoReady: boolean;
  providers: ProviderSnapshot;
  cache: { stats: CacheStats; redis: RedisStatus; server: RedisServerStats } | null;
  emailSuppressions: SuppressionStats | null;
  webhooks: { routes: WebhookRouteHealth[]; total7d: number; last24h: number; failed: number } | null;
  recommendations: RecommendationAnalytics | null;
  registrationInvites: RegistrationInviteStats | null;
  generatedAt: string;
}

export interface CacheResponse {
  success: boolean;
  stats: CacheStats;
  redis: RedisStatus;
  server: RedisServerStats;
  webhookSecretKeys: WebhookSecretRow[];
}

export interface PruneResult {
  success: boolean;
  matched: number;
  deleted: number;
  dryRun: boolean;
  cutoff: string;
}

export const integrationsApi = {
  overview: async (): Promise<IntegrationsOverview> => {
    const res = await api.get(`${BASE()}/overview`);
    return res.data;
  },

  cache: async (): Promise<CacheResponse> => {
    const res = await api.get(`${BASE()}/cache`);
    return res.data;
  },

  invalidateCache: async (prefix: string): Promise<{ success: boolean; deleted: number; prefix: string }> => {
    const res = await api.post(`${BASE()}/cache/invalidate`, { prefix });
    return res.data;
  },

  flushMemoryCache: async (): Promise<{ success: boolean; cleared: number }> => {
    const res = await api.post(`${BASE()}/cache/flush-memory`, {});
    return res.data;
  },

  listSuppressions: async (params: {
    page?: number;
    pageSize?: number;
    q?: string;
    reason?: string;
    activeOnly?: boolean;
  } = {}): Promise<SuppressionListResponse> => {
    const res = await api.get(`${BASE()}/email-suppressions${toQuery(params)}`);
    return res.data;
  },

  addSuppression: async (payload: {
    email: string;
    reason?: SuppressionReason;
    detail?: string;
  }): Promise<{ success: boolean; item: SuppressionRow }> => {
    const res = await api.post(`${BASE()}/email-suppressions`, payload);
    return res.data;
  },

  removeSuppression: async (email: string): Promise<{ success: boolean }> => {
    const res = await api.delete(`${BASE()}/email-suppressions${toQuery({ email })}`);
    return res.data;
  },

  checkSuppression: async (email: string): Promise<{ success: boolean; email: string; suppressed: boolean }> => {
    const res = await api.get(`${BASE()}/email-suppressions/check${toQuery({ email })}`);
    return res.data;
  },

  webhooks: async (): Promise<WebhookHealthResponse> => {
    const res = await api.get(`${BASE()}/webhooks`);
    return res.data;
  },

  pruneWebhooks: async (payload: {
    days?: number;
    dryRun?: boolean;
    provider?: string;
    routeKey?: string;
  }): Promise<PruneResult> => {
    const res = await api.post(`${BASE()}/webhooks/prune`, payload);
    return res.data;
  },

  recommendations: async (): Promise<{ success: boolean; analytics: RecommendationAnalytics }> => {
    const res = await api.get(`${BASE()}/recommendations`);
    return res.data;
  },

  invites: async (): Promise<{ success: boolean; stats: RegistrationInviteStats }> => {
    const res = await api.get(`${BASE()}/invites`);
    return res.data;
  },
};
