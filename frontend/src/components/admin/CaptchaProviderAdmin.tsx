import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FaCheckCircle, FaCloudUploadAlt, FaExclamationTriangle, FaLock, FaSync } from 'react-icons/fa';
import { SimpleLoadingSpinner } from '@/components/LoadingSpinner';
import { useNotification } from '@/components/Notification';
import { useConfirm } from '@/components/confirm/ConfirmDialogProvider';
import {
  studioPanelClassName,
  studioPrimaryButtonClassName,
  studioSecondaryButtonClassName,
} from '@/components/studioTheme';
import { useAuth } from '@/hooks/useAuth';
import { isSuperAdmin } from '@/utils/rbac';
import AllocationTab from './captcha-providers/AllocationTab';
import OverviewTab from './captcha-providers/OverviewTab';
import ProvidersTab from './captcha-providers/ProvidersTab';
import QuotaTab from './captcha-providers/QuotaTab';
import WidgetsTab from './captcha-providers/WidgetsTab';
import * as api from './captcha-providers/api';
import {
  PROVIDER_ORDER,
  clampNumber,
  type AllocationPolicy,
  type ApiResult,
  type CapConfigKey,
  type CapConfigState,
  type ProviderDraft,
  type ProviderId,
  type ProviderOverview,
  type ProviderRow,
  type ProviderStatsResponse,
  type QuotaHistoryEntry,
  type Scenario,
  type Strategy,
  type WidgetProviderOverride,
  type WidgetSettings,
} from './captcha-providers/types';

/**
 * 人机验证控制台（/admin/captcha-providers）。
 *
 * 四件事被收在这一个页面里（读 admin、写 superadmin）：
 * 1. 供应商调度：上线、权重、优先级、按场景权重、月度额度、自检；
 * 2. 分配体系：策略（加权随机 / 时间轮换 / 优先级故障转移）、粘性窗口、灰度、故障转移次数、按场景策略；
 * 3. 统一外观：三家前端控件共用的 theme/size/language/署名开关 + 逐家覆盖 + 样式预览；
 * 4. 观测：生效矩阵、分配模拟、当下选谁诊断、逐月额度与近期成功率。
 *
 * 工程约束：所有写操作走同一个「草稿 → 保存全部」闸门（Ctrl/Cmd+S），离开前有未保存提醒。
 */

type TabKey = 'overview' | 'providers' | 'allocation' | 'widgets' | 'quota';

const TABS: Array<{ key: TabKey; label: string; hint: string }> = [
  { key: 'overview', label: '总览', hint: 'KPI、生效矩阵与近 24h 成功率' },
  { key: 'providers', label: '供应商', hint: '上线/下线、权重、优先级、额度与自检' },
  { key: 'allocation', label: '分配策略', hint: '策略、粘性、灰度、模拟与诊断' },
  { key: 'widgets', label: '组件外观', hint: '三家控件的统一外观与逐家覆盖' },
  { key: 'quota', label: '额度与用量', hint: '本月额度与逐月历史' },
];

function buildProviderDrafts(rows: ProviderRow[]): Record<ProviderId, ProviderDraft> {
  const drafts = {} as Record<ProviderId, ProviderDraft>;
  for (const provider of PROVIDER_ORDER) {
    drafts[provider] = {
      provider,
      enabled: false,
      weight: 0,
      priority: 50,
      monthlyQuota: 0,
      scenarioWeights: { default: '', first_visit: '', standalone: '' },
    };
  }
  for (const row of rows) {
    drafts[row.provider] = {
      provider: row.provider,
      enabled: row.enabled,
      weight: row.weight,
      priority: row.priority,
      monthlyQuota: row.quota?.limit ?? 0,
      scenarioWeights: {
        default: row.scenarioWeights.default ?? '',
        first_visit: row.scenarioWeights.first_visit ?? '',
        standalone: row.scenarioWeights.standalone ?? '',
      },
    };
  }
  return drafts;
}

function canonicalProvider(draft: ProviderDraft): string {
  return JSON.stringify([
    draft.enabled,
    draft.weight,
    draft.priority,
    draft.monthlyQuota,
    draft.scenarioWeights.default,
    draft.scenarioWeights.first_visit,
    draft.scenarioWeights.standalone,
  ]);
}

function canonicalPolicy(policy: AllocationPolicy): string {
  return JSON.stringify([
    policy.strategy,
    policy.rotationSeconds,
    policy.stickyEnabled,
    policy.stickyTtlMinutes,
    policy.rolloutPercent,
    policy.rolloutControlProvider,
    policy.failoverMaxAttempts,
    (['default', 'first_visit', 'standalone'] as Scenario[]).map((scenario) => [
      scenario,
      policy.scenarioStrategies[scenario] ?? null,
    ]),
  ]);
}

function canonicalWidgets(widgets: WidgetSettings): string {
  return JSON.stringify([
    widgets.theme,
    widgets.size,
    widgets.language,
    widgets.showProviderLabel,
    PROVIDER_ORDER.map((provider) => {
      const override = widgets.perProvider[provider];
      return [provider, override?.theme ?? null, override?.size ?? null, override?.language ?? null];
    }),
  ]);
}

export default function CaptchaProviderAdmin() {
  const { user } = useAuth();
  const canWrite = isSuperAdmin(user?.role);
  const { setNotification } = useNotification();
  const confirm = useConfirm();

  const notify = useCallback(
    (message: string, type: 'success' | 'error' | 'warning' | 'info') => setNotification({ message, type }),
    [setNotification],
  );

  const [tab, setTab] = useState<TabKey>('overview');
  const [overview, setOverview] = useState<ProviderOverview | null>(null);
  const [drafts, setDrafts] = useState<Record<ProviderId, ProviderDraft> | null>(null);
  const [policy, setPolicy] = useState<AllocationPolicy | null>(null);
  const [widgets, setWidgets] = useState<WidgetSettings | null>(null);
  const [capConfig, setCapConfig] = useState<CapConfigState | null>(null);
  const [capInput, setCapInput] = useState({ siteKey: '', secretKey: '', apiEndpoint: '' });
  const [stats, setStats] = useState<ProviderStatsResponse | null>(null);
  const [statsHours, setStatsHours] = useState(24);
  const [quotaMonths, setQuotaMonths] = useState(6);
  const [quotaHistory, setQuotaHistory] = useState<QuotaHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // 首次加载失败时不能与 loading 共用同一个转圈分支，否则页面永久停在加载中。
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savingCap, setSavingCap] = useState(false);
  const [testing, setTesting] = useState<ProviderId | null>(null);
  const [loadingQuota, setLoadingQuota] = useState(false);
  const [loadingStats, setLoadingStats] = useState(false);

  const dirtyRef = useRef(false);

  const applyOverview = useCallback((data: ProviderOverview) => {
    setOverview(data);
    setDrafts(buildProviderDrafts(data.providers));
    setPolicy(data.policy);
    setWidgets(data.widgets);
  }, []);

  const loadStats = useCallback(
    async (hours: number) => {
      setLoadingStats(true);
      try {
        const result = await api.fetchProviderStats(hours);
        if (result.ok && result.data) setStats(result.data);
        else setStats(null);
      } finally {
        setLoadingStats(false);
      }
    },
    [],
  );

  const loadQuota = useCallback(
    async (months: number) => {
      setLoadingQuota(true);
      try {
        const result = await api.fetchQuotaHistory(months);
        if (!result.ok || !result.data) {
          notify(result.error || '读取额度历史失败', 'error');
          setQuotaHistory([]);
          return;
        }
        setQuotaHistory(result.data.history);
      } finally {
        setLoadingQuota(false);
      }
    },
    [notify],
  );

  const loadAll = useCallback(
    async (options: { silent?: boolean; hours?: number; months?: number } = {}) => {
      if (options.silent) setRefreshing(true);
      else setLoading(true);
      try {
        const [overviewResult, capResult] = await Promise.all([api.fetchProviderOverview(), api.fetchCapConfig()]);

        if (!overviewResult.ok || !overviewResult.data) {
          const message = overviewResult.error || '获取供应商配置失败';
          setLoadError(message);
          notify(message, 'error');
          return false;
        }
        setLoadError(null);
        applyOverview(overviewResult.data);
        if (capResult.ok && capResult.data) {
          setCapConfig(capResult.data);
          setCapInput((prev) => ({ ...prev, apiEndpoint: capResult.data?.apiEndpoint ?? prev.apiEndpoint }));
        }
        void loadStats(options.hours ?? statsHours);
        return true;
      } finally {
        setRefreshing(false);
        setLoading(false);
      }
    },
    [applyOverview, loadStats, notify, statsHours],
  );

  useEffect(() => {
    void loadAll();
    // 只在挂载时拉一次；后续刷新走显式按钮/保存回读。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ===== 草稿改动统计 =====
  const providersDirty = useMemo(() => {
    if (!overview || !drafts) return false;
    const base = buildProviderDrafts(overview.providers);
    return PROVIDER_ORDER.some((provider) => canonicalProvider(base[provider]) !== canonicalProvider(drafts[provider]));
  }, [drafts, overview]);

  const policyDirty = useMemo(() => {
    if (!overview || !policy) return false;
    return canonicalPolicy(overview.policy) !== canonicalPolicy(policy);
  }, [overview, policy]);

  const widgetsDirty = useMemo(() => {
    if (!overview || !widgets) return false;
    return canonicalWidgets(overview.widgets) !== canonicalWidgets(widgets);
  }, [overview, widgets]);

  const dirtyCount = (providersDirty ? 1 : 0) + (policyDirty ? 1 : 0) + (widgetsDirty ? 1 : 0);
  const dirty = dirtyCount > 0;
  dirtyRef.current = dirty;

  const saveAll = useCallback(async () => {
    if (!canWrite || saving || !drafts || !policy || !widgets) return;
    if (!dirty) {
      notify('没有需要保存的改动', 'info');
      return;
    }
    setSaving(true);
    try {
      const jobs: Array<Promise<ApiResult<unknown>>> = [];
      if (providersDirty) jobs.push(api.saveProviderDrafts(PROVIDER_ORDER.map((provider) => drafts[provider])));
      if (policyDirty) jobs.push(api.savePolicy(policy));
      if (widgetsDirty) jobs.push(api.saveWidgetSettings(widgets));

      const results = await Promise.all(jobs);
      const failed = results.filter((result) => !result.ok);
      if (failed.length > 0) {
        notify(`保存失败：${failed.map((result) => result.error).join('；')}`, 'error');
        return;
      }
      notify(`已保存 ${results.length} 组配置，立即生效`, 'success');
      await loadAll({ silent: true });
    } finally {
      setSaving(false);
    }
  }, [canWrite, dirty, drafts, loadAll, notify, policy, policyDirty, providersDirty, saving, widgets, widgetsDirty]);

  // 未保存提醒 + Ctrl/Cmd+S
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void saveAll();
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [saveAll]);

  useEffect(() => {
    if (tab === 'quota') void loadQuota(quotaMonths);
  }, [loadQuota, quotaMonths, tab]);

  // ===== 草稿编辑 =====
  const updateProvider = useCallback((provider: ProviderId, patch: Partial<ProviderDraft>) => {
    setDrafts((prev) => (prev ? { ...prev, [provider]: { ...prev[provider], ...patch } } : prev));
  }, []);

  const updateScenarioWeight = useCallback(
    (provider: ProviderId, scenario: Scenario, value: number | '') => {
      setDrafts((prev) => {
        if (!prev) return prev;
        const current = prev[provider];
        return {
          ...prev,
          [provider]: { ...current, scenarioWeights: { ...current.scenarioWeights, [scenario]: value } },
        };
      });
    },
    [],
  );

  const applyPreset = useCallback(
    (preset: 'even' | 'off' | 'only' | 'reset', provider?: ProviderId) => {
      if (!overview) return;
      if (preset === 'reset') {
        setDrafts(buildProviderDrafts(overview.providers));
        return;
      }
      setDrafts((prev) => {
        if (!prev) return prev;
        const next = { ...prev };
        for (const id of PROVIDER_ORDER) {
          const current = prev[id];
          if (preset === 'even') next[id] = { ...current, enabled: true, weight: 50 };
          else if (preset === 'off') next[id] = { ...current, enabled: false };
          else next[id] = { ...current, enabled: id === provider, weight: id === provider ? 100 : 0 };
        }
        return next;
      });
    },
    [overview],
  );

  const updatePolicy = useCallback((patch: Partial<AllocationPolicy>) => {
    setPolicy((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const updateScenarioStrategy = useCallback((scenario: Scenario, strategy: Strategy | '') => {
    setPolicy((prev) => {
      if (!prev) return prev;
      const scenarioStrategies = { ...prev.scenarioStrategies };
      if (strategy === '') delete scenarioStrategies[scenario];
      else scenarioStrategies[scenario] = strategy;
      return { ...prev, scenarioStrategies };
    });
  }, []);

  const updateWidgets = useCallback((patch: Partial<WidgetSettings>) => {
    setWidgets((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const updateProviderOverride = useCallback((provider: ProviderId, patch: WidgetProviderOverride) => {
    setWidgets((prev) => {
      if (!prev) return prev;
      const cleaned: WidgetProviderOverride = {};
      if (patch.theme !== undefined) cleaned.theme = patch.theme;
      if (patch.size !== undefined) cleaned.size = patch.size;
      if (patch.language !== undefined) cleaned.language = patch.language;
      const perProvider = { ...prev.perProvider };
      if (Object.keys(cleaned).length === 0) delete perProvider[provider];
      else perProvider[provider] = cleaned;
      return { ...prev, perProvider };
    });
  }, []);

  const clearProviderOverride = useCallback((provider: ProviderId) => {
    setWidgets((prev) => {
      if (!prev) return prev;
      const perProvider = { ...prev.perProvider };
      delete perProvider[provider];
      return { ...prev, perProvider };
    });
  }, []);

  // ===== 凭据与自检 =====
  const saveCapKey = useCallback(
    async (key: CapConfigKey) => {
      if (!canWrite || savingCap) return;
      const value = key === 'CAP_SITE_KEY' ? capInput.siteKey.trim() : key === 'CAP_SECRET_KEY' ? capInput.secretKey.trim() : capInput.apiEndpoint.trim();
      if (!value) {
        notify('请先填写要保存的值', 'error');
        return;
      }
      setSavingCap(true);
      try {
        const result = await api.saveCapConfigKey(key, value);
        if (!result.ok) {
          notify(result.error || '保存失败', 'error');
          return;
        }
        notify('trycap 配置已保存', 'success');
        setCapInput({ siteKey: '', secretKey: '', apiEndpoint: key === 'CAP_API_ENDPOINT' ? value : capInput.apiEndpoint });
        const latest = await api.fetchCapConfig();
        if (latest.ok && latest.data) setCapConfig(latest.data);
      } finally {
        setSavingCap(false);
      }
    },
    [canWrite, capInput, notify, savingCap],
  );

  const deleteCapKey = useCallback(
    async (key: CapConfigKey) => {
      if (!canWrite) return;
      const ok = await confirm({
        title: '确认执行该操作？',
        description: `确定删除 ${key} ？该供应商可能因此立即停止下发。`,
        tone: 'danger',
        confirmLabel: '删除',
      });
      if (!ok) return;
      setSavingCap(true);
      try {
        const result = await api.deleteCapConfigKey(key);
        if (!result.ok) {
          notify(result.error || '删除失败', 'error');
          return;
        }
        notify('已删除', 'success');
        const latest = await api.fetchCapConfig();
        if (latest.ok && latest.data) setCapConfig(latest.data);
      } finally {
        setSavingCap(false);
      }
    },
    [canWrite, notify],
  );

  const runTest = useCallback(
    async (provider: ProviderId) => {
      if (!canWrite) return;
      setTesting(provider);
      try {
        const result = await api.testProvider(provider);
        const payload = result.data?.result;
        const ok = Boolean(payload?.ok);
        const detail = payload?.error || (ok ? `连通正常（${payload?.latencyMs ?? 0}ms）` : '检查未通过');
        notify(`${provider} 自检：${detail}`, ok ? 'success' : 'error');
      } finally {
        setTesting(null);
      }
    },
    [canWrite, notify],
  );

  // ===== 模拟与诊断（直接透传给页签，壳不持有瞬时结果） =====
  const runSimulate = useCallback(
    (payload: api.SimulatePayload) => api.simulateAllocation(payload),
    [],
  );
  const runPreview = useCallback((query: api.SelectionQuery) => api.fetchSelectionPreview(query), []);

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <SimpleLoadingSpinner size={0.75} />
      </div>
    );
  }

  if (!overview || !drafts || !policy || !widgets) {
    return (
      <div className={`${studioPanelClassName} p-6`}>
        <div className="flex flex-col gap-3 rounded-2xl border border-rose-200 bg-rose-50 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-2 text-sm text-rose-700">
            <FaExclamationTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>{loadError || '获取人机验证配置失败，请稍后重试'}</span>
          </div>
          <button
            type="button"
            onClick={() => void loadAll()}
            disabled={loading || refreshing}
            className={studioSecondaryButtonClassName}
          >
            <FaSync className="mr-2 inline h-3.5 w-3.5" />
            重试
          </button>
        </div>
      </div>
    );
  }

  const tabDirty: Record<TabKey, boolean> = {
    overview: dirty,
    providers: providersDirty,
    allocation: policyDirty,
    widgets: widgetsDirty,
    quota: false,
  };

  return (
    <div className="space-y-5 pb-24">
      <header className={`${studioPanelClassName} p-5`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-800">人机验证控制台</h2>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              三家供应商共用同一套下发链路：<b>上线/下线</b>决定是否参与，<b>权重</b>是相对值（自动归一化），
              <b>分配策略</b>决定怎么选，<b>组件外观</b>统一调控前端三家控件。保存后立即生效，无需重启。
            </p>
            {!canWrite && (
              <p className="mt-2 inline-flex items-center gap-2 rounded-full bg-amber-50 px-3 py-1 text-xs text-amber-700">
                <FaLock className="h-3 w-3" /> 当前账号是只读管理员：可以查看全部状态与诊断，保存类操作需超级管理员
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void loadAll({ silent: true })} disabled={refreshing} className={studioSecondaryButtonClassName}>
              <FaSync className="mr-2 inline h-3.5 w-3.5" /> {refreshing ? '刷新中...' : '刷新'}
            </button>
            <button
              type="button"
              onClick={() => void saveAll()}
              disabled={!canWrite || saving || !dirty}
              className={studioPrimaryButtonClassName}
            >
              <FaCloudUploadAlt className="mr-2 inline h-4 w-4" />
              {saving ? '保存中...' : dirty ? `保存全部（${dirtyCount} 组）` : '已同步'}
            </button>
          </div>
        </div>

        <nav className="mt-4 flex flex-wrap gap-2" aria-label="人机验证控制台页签">
          {TABS.map((entry) => (
            <button
              key={entry.key}
              type="button"
              onClick={() => setTab(entry.key)}
              aria-current={tab === entry.key}
              className={`rounded-full border px-4 py-2 text-xs font-medium transition ${
                tab === entry.key ? 'border-slate-800 bg-slate-800 text-white' : 'border-slate-200 text-slate-600 hover:border-slate-400'
              }`}
            >
              {entry.label}
              {tabDirty[entry.key] ? <span className="ml-2 inline-block h-1.5 w-1.5 rounded-full bg-amber-400 align-middle" /> : null}
            </button>
          ))}
        </nav>
        <p className="mt-2 text-[11px] text-slate-500">{TABS.find((entry) => entry.key === tab)?.hint}</p>
      </header>

      {tab === 'overview' && (
        <OverviewTab
          canWrite={canWrite}
          notify={notify}
          rows={overview.providers}
          policy={policy}
          widgets={widgets}
          candidateCount={overview.selection.candidateCount}
          dirty={dirty}
          stats={stats}
          statsHours={statsHours}
          loadingStats={loadingStats}
          onStatsHoursChange={(hours) => {
            setStatsHours(hours);
            void loadStats(hours);
          }}
          onApplyPreset={(preset) => applyPreset(preset)}
          onRefresh={() => void loadAll({ silent: true })}
          refreshing={refreshing}
        />
      )}

      {tab === 'providers' && (
        <ProvidersTab
          canWrite={canWrite}
          notify={notify}
          rows={overview.providers}
          drafts={drafts}
          scenarios={overview.scenarios}
          testing={testing}
          dirty={providersDirty}
          onChange={updateProvider}
          onScenarioWeightChange={updateScenarioWeight}
          onTest={(provider) => void runTest(provider)}
          onApplyPreset={applyPreset}
          capConfig={capConfig}
          capInput={capInput}
          onCapInputChange={(patch) => setCapInput((prev) => ({ ...prev, ...patch }))}
          onSaveCapKey={(key) => void saveCapKey(key)}
          onDeleteCapKey={(key) => void deleteCapKey(key)}
          savingCap={savingCap}
        />
      )}

      {tab === 'allocation' && (
        <AllocationTab
          canWrite={canWrite}
          notify={notify}
          policy={policy}
          savedPolicy={overview.policy}
          scenarios={overview.scenarios}
          strategies={overview.strategies}
          rows={overview.providers}
          drafts={drafts}
          dirty={policyDirty}
          onChange={updatePolicy}
          onScenarioStrategyChange={updateScenarioStrategy}
          onReset={() => setPolicy(overview.policy)}
          onSimulate={runSimulate}
          onPreview={runPreview}
        />
      )}

      {tab === 'widgets' && (
        <WidgetsTab
          canWrite={canWrite}
          notify={notify}
          widgets={widgets}
          defaults={overview.defaults.widgets}
          rows={overview.providers}
          scenarios={overview.scenarios}
          dirty={widgetsDirty}
          onChange={updateWidgets}
          onProviderOverrideChange={updateProviderOverride}
          onClearOverride={clearProviderOverride}
          onReset={() => setWidgets(overview.widgets)}
          onPreview={runPreview}
        />
      )}

      {tab === 'quota' && (
        <QuotaTab
          canWrite={canWrite}
          notify={notify}
          rows={overview.providers}
          quotas={overview.providers.map((row) => row.quota)}
          history={quotaHistory}
          months={quotaMonths}
          onMonthsChange={(months) => setQuotaMonths(clampNumber(months, 1, 24))}
          loading={loadingQuota}
          onRefresh={() => void loadQuota(quotaMonths)}
        />
      )}

      {dirty && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3">
            <p className="flex items-center gap-2 text-xs text-amber-700">
              <FaExclamationTriangle className="h-3.5 w-3.5" />
              有未保存改动：{providersDirty ? '供应商 ' : ''}
              {policyDirty ? '分配策略 ' : ''}
              {widgetsDirty ? '组件外观' : ''}·离开页面会提示
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setDrafts(buildProviderDrafts(overview.providers));
                  setPolicy(overview.policy);
                  setWidgets(overview.widgets);
                }}
                disabled={!canWrite}
                className={studioSecondaryButtonClassName}
              >
                全部撤销
              </button>
              <button type="button" onClick={() => void saveAll()} disabled={!canWrite || saving} className={studioPrimaryButtonClassName}>
                <FaCheckCircle className="mr-2 inline h-3.5 w-3.5" /> {saving ? '保存中...' : '保存全部（Ctrl/Cmd+S）'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
