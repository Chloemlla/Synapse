import { api, getApiBaseUrl } from './api';

/**
 * 限流、配额与资源闸门管理端只读 API（页面 `/admin/rate-limits`）。
 *
 * 权限：`admin` + 页面授权 `rate-limits`（默认只有超管）。
 * 数据源：进程内并发快照、`quota_events`、`user_datas` 的 LibreChat 阶梯字段、
 * TTS 队列占用、`LIMITER_DEFINITIONS` 快照与各闸门的 env 解析值。
 *
 * 页面不提供写接口：阈值改动必须走 `/admin/env`（超管 + 安全会话 + 审计）。
 */

export interface BurstGuardRow {
  name: string;
  active: number;
  keys: number;
  maxConcurrent: number;
  utilization: number;
  overCap?: boolean;
}

export interface QuotaEventRow {
  id: string;
  scope: 'key' | 'account' | 'upstream';
  keyId: string | null;
  userId: string | null;
  resource: string;
  threshold: number | null;
  periodKey: string;
  cycle: number;
  code: string;
  detail: unknown;
  createdAt: string | null;
}

export interface TtsOccupancy {
  available: boolean;
  reason: string | null;
  global: { concurrency: number; perUserMaxActive: number; processing: boolean } | null;
  perUserMaxActive: number | null;
  topOwners: Array<{ userId: string; active: number }>;
}

export interface LadderRow {
  userId: string;
  username: string | null;
  email: string | null;
  role: string;
  dailyUsage: number;
  usageDay: string | null;
  violationCount: number;
  banCount: number;
  bannedUntil: string | null;
  banned: boolean;
}

export interface LimiterRow {
  name: string;
  profile: string;
  category: string;
  windowMs: number;
  max: number;
  keyMode: 'user-ip' | 'ip';
  storage: 'memory' | 'shared';
  effectiveStorage: 'memory' | 'redis' | 'memory(fallback)';
  skipLocal: boolean;
  message: string;
}

export interface RateLimitsOverviewResponse {
  success: boolean;
  generatedAt: string;
  burst: { totalActive: number; guards: BurstGuardRow[] };
  quota:
    | {
        total24h: number;
        warning24h: number;
        exhausted24h: number;
        upstream24h: number;
        byResource: Array<{ resource: string; count: number }>;
      }
    | { unavailableReason: string };
  tts: TtsOccupancy;
  storage: { redisConfigured: boolean; backend: 'redis' | 'memory' };
  limits: {
    docTool: Record<string, number>;
    mediaSandbox: { maxFileBytes: number; maxFilesPerJob: number; maxUserDirBytes: number; maxUserDirFiles: number };
    watchdogMode: string;
  };
}

export interface QuotaEventsPage {
  success: boolean;
  total: number;
  limit: number;
  offset: number;
  events: QuotaEventRow[];
}

export interface LaddersPage {
  success: boolean;
  total: number;
  limit: number;
  offset: number;
  config: {
    defaults: { dailyLimit: number; maxWarnings: number; banHours: number };
    env: Record<string, string>;
    note: string;
  };
  ladders: LadderRow[];
}

export interface ResourcesResponse {
  success: boolean;
  generatedAt: string;
  mediaSandbox: {
    effective: Record<string, number>;
    defaults: Record<string, number>;
    env: Record<string, string>;
    note: string;
  };
  docTool: { effective: Record<string, number>; env: Record<string, string>; note: string };
  processWatchdog: { mode: string; env: Record<string, string>; note: string };
}

export interface LimitersResponse {
  success: boolean;
  storage: { redisConfigured: boolean; backend: 'redis' | 'memory' };
  total: number;
  limiters: LimiterRow[];
}

const BASE = () => `${getApiBaseUrl()}/api/admin/rate-limits`;

const toQuery = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
};

export const rateLimitsApi = {
  overview: async (): Promise<RateLimitsOverviewResponse> => {
    const res = await api.get(`${BASE()}/overview`);
    return res.data;
  },
  burst: async (): Promise<{ success: boolean; generatedAt: string; totalActive: number; guards: BurstGuardRow[] }> => {
    const res = await api.get(`${BASE()}/burst`);
    return res.data;
  },
  quotaEvents: async (params: {
    scope?: string;
    resource?: string;
    threshold?: string;
    userId?: string;
    since?: string;
    limit?: number;
    offset?: number;
  } = {}): Promise<QuotaEventsPage> => {
    const res = await api.get(`${BASE()}/quota-events${toQuery(params)}`);
    return res.data;
  },
  ladders: async (params: { state?: string; q?: string; limit?: number; offset?: number } = {}): Promise<LaddersPage> => {
    const res = await api.get(`${BASE()}/ladders${toQuery(params)}`);
    return res.data;
  },
  ttsOccupancy: async (top = 20): Promise<{ success: boolean; generatedAt: string } & TtsOccupancy> => {
    const res = await api.get(`${BASE()}/tts-occupancy${toQuery({ top })}`);
    return res.data;
  },
  resources: async (): Promise<ResourcesResponse> => {
    const res = await api.get(`${BASE()}/resources`);
    return res.data;
  },
  limiters: async (): Promise<LimitersResponse> => {
    const res = await api.get(`${BASE()}/limiters`);
    return res.data;
  },
};
