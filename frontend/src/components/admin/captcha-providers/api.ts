import getApiBaseUrl from '@/api';
import { authFetch } from '@/components/env-manager/api';
import type {
  AllocationPolicy,
  ApiResult,
  CapConfigKey,
  CapConfigState,
  ProviderDraft,
  ProviderId,
  ProviderOverview,
  ProviderStatsResponse,
  QuotaHistoryResponse,
  Scenario,
  SelectionPreview,
  SimulationResult,
  Strategy,
  WidgetSettings,
} from './types';

const API = `${getApiBaseUrl()}/api/turnstile`;

async function request<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const response = await authFetch(`${API}${path}`, {
      credentials: 'include',
      headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
      ...init,
    });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

    if (!response.ok || payload?.success === false) {
      const message =
        (typeof payload?.error === 'string' && payload.error) ||
        (typeof payload?.message === 'string' && payload.message) ||
        `HTTP ${response.status}`;
      return { ok: false, error: message };
    }

    return { ok: true, data: payload as T };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '网络请求失败' };
  }
}

export function fetchProviderOverview(): Promise<ApiResult<ProviderOverview>> {
  return request<ProviderOverview>('/providers');
}

export function fetchQuotaHistory(months = 6): Promise<ApiResult<QuotaHistoryResponse>> {
  return request<QuotaHistoryResponse>(`/providers/quotas?months=${encodeURIComponent(String(months))}`);
}

export function fetchProviderStats(hours = 24): Promise<ApiResult<ProviderStatsResponse>> {
  return request<ProviderStatsResponse>(`/providers/stats?hours=${encodeURIComponent(String(hours))}`);
}

export function fetchCapConfig(): Promise<ApiResult<CapConfigState>> {
  return request<CapConfigState>('/cap-config');
}

export function saveProviderDrafts(drafts: ProviderDraft[]): Promise<ApiResult<ProviderOverview>> {
  return request<ProviderOverview>('/providers', {
    method: 'PUT',
    body: JSON.stringify({
      providers: drafts.map((draft) => {
        const scenarioWeights: Partial<Record<Scenario, number>> = {};
        (Object.keys(draft.scenarioWeights) as Scenario[]).forEach((scenario) => {
          const value = draft.scenarioWeights[scenario];
          if (value !== '' && Number.isFinite(Number(value))) scenarioWeights[scenario] = Number(value);
        });
        return {
          provider: draft.provider,
          enabled: draft.enabled,
          weight: draft.weight,
          priority: draft.priority,
          monthlyQuota: draft.monthlyQuota,
          // 整表覆盖：未填写的场景会被服务端清掉覆盖、回落基础权重。
          scenarioWeights,
        };
      }),
    }),
  });
}

export function savePolicy(policy: AllocationPolicy): Promise<ApiResult<{ policy: AllocationPolicy }>> {
  return request<{ policy: AllocationPolicy }>('/providers/policy', {
    method: 'PUT',
    body: JSON.stringify({
      strategy: policy.strategy,
      rotationSeconds: policy.rotationSeconds,
      stickyEnabled: policy.stickyEnabled,
      stickyTtlMinutes: policy.stickyTtlMinutes,
      rolloutPercent: policy.rolloutPercent,
      rolloutControlProvider: policy.rolloutControlProvider,
      failoverMaxAttempts: policy.failoverMaxAttempts,
      scenarioStrategies: policy.scenarioStrategies,
    }),
  });
}

export function saveWidgetSettings(widgets: WidgetSettings): Promise<ApiResult<{ widgets: WidgetSettings }>> {
  return request<{ widgets: WidgetSettings }>('/providers/widgets', {
    method: 'PUT',
    body: JSON.stringify({
      theme: widgets.theme,
      size: widgets.size,
      language: widgets.language,
      showProviderLabel: widgets.showProviderLabel,
      perProvider: widgets.perProvider,
    }),
  });
}

export interface SimulatePayload {
  draws: number;
  scenario: Scenario;
  fingerprint?: string;
  exclude?: ProviderId[];
  policy?: Partial<AllocationPolicy>;
  providers?: ProviderDraft[];
}

export function simulateAllocation(payload: SimulatePayload): Promise<ApiResult<SimulationResult>> {
  return request<SimulationResult>('/providers/simulate', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export interface SelectionQuery {
  scenario: Scenario;
  fingerprint?: string;
  force?: ProviderId;
  exclude?: ProviderId[];
}

export function fetchSelectionPreview(query: SelectionQuery): Promise<ApiResult<SelectionPreview>> {
  const params = new URLSearchParams({ scenario: query.scenario });
  if (query.fingerprint) params.set('fingerprint', query.fingerprint);
  if (query.force) params.set('force', query.force);
  if (query.exclude && query.exclude.length > 0) params.set('exclude', query.exclude.join(','));
  return request<SelectionPreview>(`/providers/selection?${params.toString()}`);
}

export function testProvider(provider: ProviderId): Promise<ApiResult<{ result: { ok: boolean; error?: string; latencyMs?: number } }>> {
  return request<{ result: { ok: boolean; error?: string; latencyMs?: number } }>(`/providers/${provider}/test`, {
    method: 'POST',
  });
}

export function saveCapConfigKey(key: CapConfigKey, value: string): Promise<ApiResult<unknown>> {
  return request('/cap-config', { method: 'POST', body: JSON.stringify({ key, value }) });
}

export function deleteCapConfigKey(key: CapConfigKey): Promise<ApiResult<unknown>> {
  return request(`/cap-config/${key}`, { method: 'DELETE' });
}

/** 策略草稿 → 模拟器入参（保证前端预览用的就是草稿）。 */
export function toSimulationPolicy(policy: AllocationPolicy): Partial<AllocationPolicy> {
  return {
    strategy: policy.strategy,
    rotationSeconds: policy.rotationSeconds,
    stickyEnabled: policy.stickyEnabled,
    stickyTtlMinutes: policy.stickyTtlMinutes,
    rolloutPercent: policy.rolloutPercent,
    rolloutControlProvider: policy.rolloutControlProvider,
    failoverMaxAttempts: policy.failoverMaxAttempts,
    scenarioStrategies: policy.scenarioStrategies,
  };
}

export const DEFAULT_SIMULATE_DRAWS = 1000;
export const SIMULATE_MAX_DRAWS = 20_000;
export const STRATEGY_VALUES: readonly Strategy[] = ['weighted', 'round_robin', 'failover'];
