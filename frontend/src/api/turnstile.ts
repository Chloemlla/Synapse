import { getApiBaseUrl } from './api';
import { fetchWithTimeout } from '../utils/fetchWithTimeout';


// IP 封禁相关接口
export interface IPBanStats {
  totalBanned: number;
  activeBans: number;
  expiredBans: number;
  recentBans: number;
}

export interface IPBan {
  ipAddress: string;
  reason: string;
  violationCount: number;
  bannedAt: string | null;
  expiresAt: string | null;
  fingerprint?: string;
  userAgent?: string;
  /** manual = 管理员手工封；auto = 违规计数到阈值自动封。存量记录缺省当 auto。 */
  source?: 'manual' | 'auto';
  /** 服务端算好的「是否仍生效」，避免前端时钟偏差造成口径不一。 */
  active?: boolean;
}

export interface IPBanListSummary {
  total: number;
  active: number;
  expired: number;
  manual: number;
  automatic: number;
}

export interface IPBanListResponse {
  bans: IPBan[];
  total: number;
  page: number;
  pageSize: number;
  summary?: IPBanListSummary;
}

export interface IPBanListQuery {
  page?: number;
  pageSize?: number;
  keyword?: string;
  status?: 'all' | 'active' | 'expired';
  sort?: 'bannedAt' | 'expiresAt' | 'violationCount' | 'ipAddress';
  order?: 'asc' | 'desc';
}

// 指纹统计接口
export interface FingerprintStats {
  total: number;
  verified: number;
  unverified: number;
  expired: number;
}

export interface SystemCapability {
  key: string;
  label: string;
  description: string;
  scope: string;
  enabled: boolean;
  requiresAdmin: boolean;
  rateLimited: boolean;
  audited: boolean;
  destructive: boolean;
  intervalMs?: number;
}

export interface CleanupDetails {
  fingerprintCount: number;
  accessTokenCount: number;
  ipBanCount: number;
  ipDataCount: number;
  totalCount: number;
}

export interface SyncDirectionResult {
  synced: number;
  merged?: number;
  updated?: number;
  skipped: number;
  errors: number;
}

export interface SyncDetails {
  mongoToRedis: SyncDirectionResult;
  redisToMongo: SyncDirectionResult;
}

export interface IpBanSyncRuntimeStatus {
  isRunning: boolean;
  isSyncing: boolean;
  syncInterval: number;
  redisAvailable: boolean;
}

// 调度器状态接口
export interface SchedulerStatus {
  isRunning: boolean;
  isSyncEnabled: boolean;
  startedAt?: string | null;
  stoppedAt?: string | null;
  lastCleanup?: string | null;
  nextCleanup?: string | null;
  cleanupIntervalMs: number;
  totalCleanups: number;
  totalCleanupErrors: number;
  errors: number;
  lastCleanupResult?: CleanupDetails;
  lastCleanupError?: string;
  lastCleanupDurationMs?: number;
  lastSync?: string | null;
  nextSync?: string | null;
  syncIntervalMs: number;
  totalSyncs: number;
  totalSyncErrors: number;
  lastSyncResult?: SyncDetails;
  lastSyncError?: string;
  lastSyncDurationMs?: number;
  ipBanSyncStatus?: IpBanSyncRuntimeStatus;
  capabilities: SystemCapability[];
}

// 同步状态接口
export interface SyncStatus {
  lastSync?: string | null;
  nextSync?: string | null;
  mongoToRedisCount: number;
  redisToMongoCount: number;
  errors: string[];
  isRunning: boolean;
  isSyncEnabled: boolean;
  isSyncing: boolean;
  redisAvailable: boolean;
  syncIntervalMs: number;
  totalSyncs: number;
  totalErrors: number;
  lastSyncResult?: SyncDetails;
  lastSyncError?: string;
  lastSyncDurationMs?: number;
  capabilities: SystemCapability[];
}

// IP封禁列表响应接口（G9-33：此前文件内重复定义同名 IPBanListResponse，已删除后一处）
const toFiniteNumber = (value: unknown, fallback = 0): number => {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
};

const toOptionalFiniteNumber = (value: unknown): number | undefined => {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

const asDateString = (value: unknown): string | null => {
  return typeof value === 'string' && value.length > 0 ? value : null;
};

const asCapabilities = (value: unknown): SystemCapability[] => {
  return Array.isArray(value) ? value as SystemCapability[] : [];
};

const normalizeSchedulerStatus = (status: any): SchedulerStatus => {
  return {
    isRunning: Boolean(status?.isRunning),
    isSyncEnabled: Boolean(status?.isSyncEnabled),
    startedAt: asDateString(status?.startedAt),
    stoppedAt: asDateString(status?.stoppedAt),
    lastCleanup: asDateString(status?.lastCleanup),
    nextCleanup: asDateString(status?.nextCleanup),
    cleanupIntervalMs: toFiniteNumber(status?.cleanupIntervalMs),
    totalCleanups: toFiniteNumber(status?.totalCleanups),
    totalCleanupErrors: toFiniteNumber(status?.totalCleanupErrors ?? status?.errors),
    errors: toFiniteNumber(status?.errors ?? status?.totalCleanupErrors),
    lastCleanupResult: status?.lastCleanupResult,
    lastCleanupError: status?.lastCleanupError,
    lastCleanupDurationMs: toOptionalFiniteNumber(status?.lastCleanupDurationMs),
    lastSync: asDateString(status?.lastSync),
    nextSync: asDateString(status?.nextSync),
    syncIntervalMs: toFiniteNumber(status?.syncIntervalMs),
    totalSyncs: toFiniteNumber(status?.totalSyncs),
    totalSyncErrors: toFiniteNumber(status?.totalSyncErrors),
    lastSyncResult: status?.lastSyncResult,
    lastSyncError: status?.lastSyncError,
    lastSyncDurationMs: toOptionalFiniteNumber(status?.lastSyncDurationMs),
    ipBanSyncStatus: status?.ipBanSyncStatus,
    capabilities: asCapabilities(status?.capabilities)
  };
};

const countMongoToRedis = (value: unknown): number => {
  if (typeof value === 'number') return value;
  const result = value as Partial<SyncDirectionResult> | undefined;
  return toFiniteNumber(result?.synced) + toFiniteNumber(result?.merged);
};

const countRedisToMongo = (value: unknown): number => {
  if (typeof value === 'number') return value;
  const result = value as Partial<SyncDirectionResult> | undefined;
  return toFiniteNumber(result?.synced) + toFiniteNumber(result?.updated);
};

const normalizeSyncStatus = (status: any): SyncStatus => {
  return {
    lastSync: asDateString(status?.lastSync),
    nextSync: asDateString(status?.nextSync),
    mongoToRedisCount: toFiniteNumber(status?.mongoToRedisCount),
    redisToMongoCount: toFiniteNumber(status?.redisToMongoCount),
    errors: Array.isArray(status?.errors) ? status.errors : [],
    isRunning: Boolean(status?.isRunning),
    isSyncEnabled: Boolean(status?.isSyncEnabled),
    isSyncing: Boolean(status?.isSyncing),
    redisAvailable: Boolean(status?.redisAvailable),
    syncIntervalMs: toFiniteNumber(status?.syncIntervalMs),
    totalSyncs: toFiniteNumber(status?.totalSyncs),
    totalErrors: toFiniteNumber(status?.totalErrors),
    lastSyncResult: status?.lastSyncResult,
    lastSyncError: status?.lastSyncError,
    lastSyncDurationMs: toOptionalFiniteNumber(status?.lastSyncDurationMs),
    capabilities: asCapabilities(status?.capabilities)
  };
};

const readJsonResponse = async <T>(response: Response, fallbackMessage: string): Promise<T> => {
  let result: any = null;
  try {
    result = await response.json();
  } catch (_error) {
    result = null;
  }

  if (!response.ok) {
    throw new Error(result?.error || result?.message || fallbackMessage);
  }

  return result as T;
};

// API 客户端
class TurnstileAPI {
  private getAuthHeaders() {
    return {
      'Content-Type': 'application/json'
    };
  }

  // IP 封禁管理
  async getIPBanStats(): Promise<IPBanStats> {
    const response = await fetchWithTimeout(`${getApiBaseUrl()}/api/turnstile/ip-ban-stats`, {
      headers: this.getAuthHeaders(),
      credentials: 'include'
    });
    if (!response.ok) throw new Error('获取IP封禁统计失败');
    const result = await response.json();
    return result.stats; // Extract stats from wrapper object
  }

  async banIP(ipAddress: string, reason: string, durationMinutes?: number): Promise<{ success: boolean; message: string }> {
    const response = await fetchWithTimeout(`${getApiBaseUrl()}/api/turnstile/ban-ip`, {
      method: 'POST',
      headers: this.getAuthHeaders(),
      credentials: 'include',
      body: JSON.stringify({ ipAddress, reason, durationMinutes })
    });
    if (!response.ok) throw new Error('封禁IP失败');
    return response.json();
  }

  async unbanIP(ipAddress: string): Promise<{ success: boolean; message: string }> {
    const response = await fetchWithTimeout(`${getApiBaseUrl()}/api/turnstile/unban-ip`, {
      method: 'POST',
      headers: this.getAuthHeaders(),
      credentials: 'include',
      body: JSON.stringify({ ipAddress })
    });
    if (!response.ok) throw new Error('解封IP失败');
    return response.json();
  }

  async banIPs(ipAddresses: string[], reason: string, durationMinutes?: number): Promise<{ success: boolean; message: string; bannedCount: number }> {
    const response = await fetchWithTimeout(`${getApiBaseUrl()}/api/turnstile/ban-ips`, {
      method: 'POST',
      headers: this.getAuthHeaders(),
      credentials: 'include',
      body: JSON.stringify({ ipAddresses, reason, durationMinutes })
    });
    if (!response.ok) throw new Error('批量封禁IP失败');
    return response.json();
  }

  async unbanIPs(ipAddresses: string[]): Promise<{ success: boolean; message: string; unbannedCount: number }> {
    const response = await fetchWithTimeout(`${getApiBaseUrl()}/api/turnstile/unban-ips`, {
      method: 'POST',
      headers: this.getAuthHeaders(),
      credentials: 'include',
      body: JSON.stringify({ ipAddresses })
    });
    if (!response.ok) throw new Error('批量解封IP失败');
    return response.json();
  }

  /**
   * 封禁名单（分页 + 关键词 + 状态 + 排序）。
   * 后端返回 `{ success, data: { bans, total, page, pageSize }, summary }`：
   * `data` 保持历史结构（兼容早期调用方），汇总单独挂在 `summary`。
   */
  async listIPBans(query: IPBanListQuery = {}): Promise<IPBanListResponse> {
    const params = new URLSearchParams();
    params.set('page', String(query.page ?? 1));
    params.set('pageSize', String(query.pageSize ?? 20));
    if (query.keyword?.trim()) params.set('keyword', query.keyword.trim());
    if (query.status && query.status !== 'all') params.set('status', query.status);
    if (query.sort) params.set('sort', query.sort);
    if (query.order) params.set('order', query.order);

    const response = await fetchWithTimeout(`${getApiBaseUrl()}/api/turnstile/ip-ban-list?${params.toString()}`, {
      headers: this.getAuthHeaders(),
      credentials: 'include'
    });
    if (!response.ok) throw new Error('获取IP封禁列表失败');
    const result = await response.json();
    const data = result?.data;
    return {
      bans: Array.isArray(data?.bans) ? data.bans : [],
      total: typeof data?.total === 'number' ? data.total : 0,
      page: typeof data?.page === 'number' ? data.page : (query.page ?? 1),
      pageSize: typeof data?.pageSize === 'number' ? data.pageSize : (query.pageSize ?? 20),
      summary: result?.summary,
    };
  }

  /** 兼容入口：旧签名（page, pageSize）仍可用。 */
  async getIPBanList(page: number = 1, pageSize: number = 20): Promise<IPBanListResponse> {
    return this.listIPBans({ page, pageSize });
  }

  // 指纹管理
  async getFingerprintStats(): Promise<FingerprintStats> {
    const response = await fetchWithTimeout(`${getApiBaseUrl()}/api/turnstile/fingerprint-stats`, {
      headers: this.getAuthHeaders(),
      credentials: 'include'
    });
    if (!response.ok) throw new Error('获取指纹统计失败');
    const result = await response.json();
    return result.stats; // Extract stats from wrapper object
  }

  async cleanupExpiredFingerprints(): Promise<{ success: boolean; message: string; cleanedCount: number }> {
    const response = await fetchWithTimeout(`${getApiBaseUrl()}/api/turnstile/cleanup-expired-fingerprints`, {
      method: 'POST',
      headers: this.getAuthHeaders(),
      credentials: 'include'
    });
    if (!response.ok) throw new Error('清理过期指纹失败');
    return response.json();
  }

  // 调度器管理
  async getSchedulerStatus(): Promise<SchedulerStatus> {
    const response = await fetchWithTimeout(`${getApiBaseUrl()}/api/turnstile/scheduler-status`, {
      headers: this.getAuthHeaders(),
      credentials: 'include'
    });
    const result = await readJsonResponse<{ status?: SchedulerStatus; data?: SchedulerStatus }>(
      response,
      '获取调度器状态失败'
    );
    return normalizeSchedulerStatus(result.status || result.data || result as SchedulerStatus);
  }

  async startScheduler(): Promise<{ success: boolean; message: string }> {
    const response = await fetchWithTimeout(`${getApiBaseUrl()}/api/turnstile/scheduler/start`, {
      method: 'POST',
      headers: this.getAuthHeaders(),
      credentials: 'include'
    });
    return readJsonResponse<{ success: boolean; message: string }>(response, '启动调度器失败');
  }

  async stopScheduler(): Promise<{ success: boolean; message: string }> {
    const response = await fetchWithTimeout(`${getApiBaseUrl()}/api/turnstile/scheduler/stop`, {
      method: 'POST',
      headers: this.getAuthHeaders(),
      credentials: 'include'
    });
    return readJsonResponse<{ success: boolean; message: string }>(response, '停止调度器失败');
  }

  async manualCleanup(): Promise<{ success: boolean; message: string; cleanedCount: number; details?: CleanupDetails }> {
    const response = await fetchWithTimeout(`${getApiBaseUrl()}/api/turnstile/manual-cleanup`, {
      method: 'POST',
      headers: this.getAuthHeaders(),
      credentials: 'include'
    });
    const result = await readJsonResponse<{
      success: boolean;
      message: string;
      cleanedCount?: number;
      deletedCount?: number;
      details?: CleanupDetails;
    }>(response, '手动清理失败');
    return {
      success: result.success,
      message: result.message,
      cleanedCount: toFiniteNumber(result.cleanedCount ?? result.deletedCount),
      details: result.details
    };
  }

  // 同步管理
  async syncIPBans(): Promise<{
    success: boolean;
    message: string;
    mongoToRedis: number;
    redisToMongo: number;
    data?: { mongoToRedis?: SyncDirectionResult; redisToMongo?: SyncDirectionResult };
  }> {
    const response = await fetchWithTimeout(`${getApiBaseUrl()}/api/turnstile/sync-ipbans`, {
      method: 'POST',
      headers: this.getAuthHeaders(),
      credentials: 'include'
    });
    const result = await readJsonResponse<any>(response, '同步IP封禁失败');
    return {
      success: Boolean(result.success),
      message: result.message || 'IP 封禁同步完成',
      mongoToRedis: toFiniteNumber(result.mongoToRedis ?? result.data?.mongoToRedisCount, countMongoToRedis(result.data?.mongoToRedis)),
      redisToMongo: toFiniteNumber(result.redisToMongo ?? result.data?.redisToMongoCount, countRedisToMongo(result.data?.redisToMongo)),
      data: result.data
    };
  }

  async getSyncStatus(): Promise<SyncStatus> {
    const response = await fetchWithTimeout(`${getApiBaseUrl()}/api/turnstile/sync-status`, {
      headers: this.getAuthHeaders(),
      credentials: 'include'
    });
    const result = await readJsonResponse<{ data?: SyncStatus; status?: SyncStatus }>(
      response,
      '获取同步状态失败'
    );
    return normalizeSyncStatus(result.data || result.status || result as SyncStatus);
  }
}

export const turnstileApi = new TurnstileAPI();
