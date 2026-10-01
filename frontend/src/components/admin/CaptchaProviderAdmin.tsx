import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FaCheckCircle, FaExclamationTriangle, FaPlug, FaSave, FaSync, FaTrash } from 'react-icons/fa';
import getApiBaseUrl from '@/api';
import { SimpleLoadingSpinner } from '@/components/LoadingSpinner';
import { useNotification } from '@/components/Notification';
import {
  studioDangerButtonClassName,
  studioFieldClassName,
  studioPanelClassName,
  studioPrimaryButtonClassName,
  studioSecondaryButtonClassName,
} from '@/components/studioTheme';
import { useAuth } from '@/hooks/useAuth';
import { authFetch } from '@/components/env-manager/api';
import { isSuperAdmin } from '@/utils/rbac';

const API = `${getApiBaseUrl()}/api/turnstile`;

type ProviderId = 'turnstile' | 'hcaptcha' | 'trycap';
type SkipReason = 'ok' | 'scheduling_disabled' | 'credentials_missing' | 'quota_exhausted';

interface QuotaSnapshot {
  monthKey: string;
  limit: number;
  used: number;
  /** -1 表示不限额 */
  remaining: number;
  percentage: number;
  exhausted: boolean;
  resetsAt: string;
  exhaustedAt?: string;
  lastUsedAt?: string;
}

interface ProviderRow {
  provider: ProviderId;
  label: string;
  enabled: boolean;
  weight: number;
  percentage: number;
  siteKey: string | null;
  secretKey: string | null;
  secretConfigured: boolean;
  credentialsConfigured: boolean;
  effective: boolean;
  reason: SkipReason;
  quota: QuotaSnapshot;
  updatedAt?: string;
}

interface CapConfigState {
  siteKey: string | null;
  secretKey: string | null;
  apiEndpoint: string;
  enabled: boolean;
}

type DraftRow = Pick<ProviderRow, 'provider' | 'enabled' | 'weight'> & { monthlyQuota: number };

const WEIGHT_SLIDER_MAX = 100;

/** 这两家不限额：trycap 自托管、Turnstile 当前免费额度不按调用计。仅 hCaptcha 按月计额度。 */
const UNLIMITED_PROVIDERS: ProviderId[] = ['turnstile', 'trycap'];

const REASON_TEXT: Record<SkipReason, string> = {
  ok: '正常参与下发',
  scheduling_disabled: '已下线：不参与下发',
  credentials_missing: '已上线但凭据不全：需补齐 Site Key 与 Secret Key',
  quota_exhausted: '本月额度已用尽：已自动停止下发，下月自动恢复',
};

const PROVIDER_HINT: Record<ProviderId, string> = {
  turnstile: 'Cloudflare 托管，脚本与校验都走 challenges.cloudflare.com。',
  hcaptcha: '第三方托管，返回 score 时低于 0.5 会被拒绝；免费额度按调用次数计，用尽后本月不再外呼。',
  trycap: '自托管 Cap（PoW + 浏览器 instrumentation），无第三方、无追踪，加速本地实例。',
};

function formatQuota(quota: QuotaSnapshot): string {
  if (quota.limit <= 0) return `本月已用 ${quota.used}（不限额度）`;
  return `本月已用 ${quota.used} / ${quota.limit}（剩余 ${Math.max(0, quota.remaining)}）`;
}

/** 与服务端 providers.ts 的归一化规则保持一致，保证面板预览值就是实际概率。 */
function normalizePercentages(rows: DraftRow[]): Record<string, number> {
  const active = rows.filter((row) => row.enabled);
  const positives = active.map((row) => (row.weight > 0 ? row.weight : 0));
  const total = positives.reduce((sum, weight) => sum + weight, 0);
  const map: Record<string, number> = {};
  if (active.length === 0) return map;
  if (total <= 0) {
    const even = Math.round((100 / active.length) * 10) / 10;
    for (const row of active) map[row.provider] = even;
    return map;
  }
  active.forEach((row, index) => {
    map[row.provider] = Math.round((positives[index] / total) * 1000) / 10;
  });
  return map;
}

export default function CaptchaProviderAdmin() {
  const { user } = useAuth();
  const canWrite = isSuperAdmin(user?.role);
  const { setNotification } = useNotification();

  const [rows, setRows] = useState<ProviderRow[]>([]);
  const [draft, setDraft] = useState<Record<string, DraftRow>>({});
  const [capConfig, setCapConfig] = useState<CapConfigState | null>(null);
  const [capInput, setCapInput] = useState({ siteKey: '', secretKey: '', apiEndpoint: '' });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<ProviderId | null>(null);
  const [savingCap, setSavingCap] = useState(false);
  const dirtyRef = useRef(false);

  const draftRows = useMemo<DraftRow[]>(() => Object.values(draft), [draft]);
  const percentages = useMemo(() => normalizePercentages(draftRows), [draftRows]);
  const dirty = useMemo(
    () =>
      rows.some((row) => {
        const current = draft[row.provider];
        if (!current) return false;
        return (
          current.enabled !== row.enabled ||
          current.weight !== row.weight ||
          current.monthlyQuota !== (row.quota?.limit ?? 0)
        );
      }),
    [draft, rows],
  );

  dirtyRef.current = dirty;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [providersRes, capRes] = await Promise.all([
        authFetch(`${API}/providers`, { credentials: 'include' }),
        authFetch(`${API}/cap-config`, { credentials: 'include' }),
      ]);

      if (!providersRes.ok) {
        const data = await providersRes.json().catch(() => ({}));
        setNotification({ message: data.error || `获取供应商配置失败（HTTP ${providersRes.status}）`, type: 'error' });
        return;
      }

      const data = await providersRes.json();
      const nextRows: ProviderRow[] = Array.isArray(data.providers) ? data.providers : [];
      setRows(nextRows);
      setDraft(
        Object.fromEntries(
          nextRows.map((row) => [
            row.provider,
            {
              provider: row.provider,
              enabled: row.enabled,
              weight: row.weight,
              monthlyQuota: row.quota?.limit ?? 0,
            },
          ]),
        ),
      );

      if (capRes.ok) {
        const capData = await capRes.json();
        setCapConfig({
          siteKey: capData.siteKey ?? null,
          secretKey: capData.secretKey ?? null,
          apiEndpoint: capData.apiEndpoint ?? '',
          enabled: Boolean(capData.enabled),
        });
        setCapInput((prev) => ({ ...prev, apiEndpoint: capData.apiEndpoint ?? '' }));
      }
    } catch (error) {
      setNotification({ message: `获取失败：${error instanceof Error ? error.message : '未知错误'}`, type: 'error' });
    } finally {
      setLoading(false);
    }
  }, [setNotification]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, []);

  const updateDraft = useCallback((provider: ProviderId, patch: Partial<DraftRow>) => {
    setDraft((prev) => ({ ...prev, [provider]: { ...prev[provider], ...patch } }));
  }, []);

  const resetDraftFromRows = useCallback(() => {
    setDraft(
      Object.fromEntries(
        rows.map((row) => [
          row.provider,
          {
            provider: row.provider,
            enabled: row.enabled,
            weight: row.weight,
            monthlyQuota: row.quota?.limit ?? 0,
          },
        ]),
      ),
    );
  }, [rows]);

  const applyPreset = useCallback(
    (preset: 'even' | 'off' | 'reset' | ProviderId) => {
      setDraft((prev) => {
        const next: Record<string, DraftRow> = { ...prev };
        const providers = Object.keys(prev) as ProviderId[];
        if (preset === 'reset') {
          for (const row of rows)
            next[row.provider] = {
              provider: row.provider,
              enabled: row.enabled,
              weight: row.weight,
              monthlyQuota: row.quota?.limit ?? 0,
            };
          return next;
        }
        for (const provider of providers) {
          if (preset === 'even') next[provider] = { ...prev[provider], enabled: true, weight: 50 };
          else if (preset === 'off') next[provider] = { ...prev[provider], enabled: false };
          else next[provider] = { ...prev[provider], enabled: provider === preset, weight: provider === preset ? 100 : 0 };
        }
        return next;
      });
    },
    [rows],
  );

  const save = useCallback(async () => {
    if (!canWrite || saving || !dirty) return;
    setSaving(true);
    try {
      const res = await authFetch(`${API}/providers`, {
        method: 'PUT',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          providers: draftRows.map((row) => ({
            provider: row.provider,
            enabled: row.enabled,
            weight: Number(row.weight),
            ...(UNLIMITED_PROVIDERS.includes(row.provider) ? {} : { monthlyQuota: Number(row.monthlyQuota) }),
          })),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        setNotification({ message: data.error || '保存失败', type: 'error' });
        return;
      }
      setNotification({ message: '已保存，立即生效（无需重启）', type: 'success' });
      await load();
    } catch (error) {
      setNotification({ message: `保存失败：${error instanceof Error ? error.message : '未知错误'}`, type: 'error' });
    } finally {
      setSaving(false);
    }
  }, [canWrite, dirty, draftRows, load, saving, setNotification]);

  const runTest = useCallback(
    async (provider: ProviderId) => {
      if (!canWrite) return;
      setTesting(provider);
      try {
        const res = await authFetch(`${API}/providers/${provider}/test`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
        });
        const data = await res.json().catch(() => ({}));
        const ok = Boolean(data?.result?.ok);
        const detail = data?.result?.error || (ok ? `连通正常（${data?.result?.latencyMs ?? 0}ms）` : '检查未通过');
        setNotification({ message: `${provider} 自检：${detail}`, type: ok ? 'success' : 'error' });
      } catch (error) {
        setNotification({ message: `自检失败：${error instanceof Error ? error.message : '未知错误'}`, type: 'error' });
      } finally {
        setTesting(null);
      }
    },
    [canWrite, setNotification],
  );

  const saveCapKey = useCallback(
    async (key: 'CAP_SITE_KEY' | 'CAP_SECRET_KEY' | 'CAP_API_ENDPOINT') => {
      if (!canWrite || savingCap) return;
      const value =
        key === 'CAP_SITE_KEY' ? capInput.siteKey.trim() : key === 'CAP_SECRET_KEY' ? capInput.secretKey.trim() : capInput.apiEndpoint.trim();
      if (!value) {
        setNotification({ message: '请先填写要保存的值', type: 'error' });
        return;
      }
      setSavingCap(true);
      try {
        const res = await authFetch(`${API}/cap-config`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, value }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
          setNotification({ message: data.error || '保存失败', type: 'error' });
          return;
        }
        setNotification({ message: 'trycap 配置已保存', type: 'success' });
        setCapInput({ siteKey: '', secretKey: '', apiEndpoint: value });
        await load();
      } catch (error) {
        setNotification({ message: `保存失败：${error instanceof Error ? error.message : '未知错误'}`, type: 'error' });
      } finally {
        setSavingCap(false);
      }
    },
    [canWrite, capInput, load, savingCap, setNotification],
  );

  const deleteCapKey = useCallback(
    async (key: 'CAP_SITE_KEY' | 'CAP_SECRET_KEY' | 'CAP_API_ENDPOINT') => {
      if (!canWrite) return;
      if (!window.confirm(`确定删除 ${key} ？该供应商可能因此立即停止下发。`)) return;
      setSavingCap(true);
      try {
        const res = await authFetch(`${API}/cap-config/${key}`, { method: 'DELETE', credentials: 'include' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
          setNotification({ message: data.error || '删除失败', type: 'error' });
          return;
        }
        setNotification({ message: '已删除', type: 'success' });
        await load();
      } finally {
        setSavingCap(false);
      }
    },
    [canWrite, load, setNotification],
  );

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <SimpleLoadingSpinner size={0.75} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className={`${studioPanelClassName} p-5`}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-800">人机验证供应商</h2>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              三家供应商共用同一套下发链路：<b>上线/下线</b>决定是否参与，<b>权重</b>是相对值（自动归一化，见每行右侧概率）。
              保存后立即生效，无需重启。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void load()} className={studioSecondaryButtonClassName}>
              <FaSync className="mr-2 inline h-3.5 w-3.5" /> 刷新
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={!canWrite || saving || !dirty}
              className={studioPrimaryButtonClassName}
            >
              <FaSave className="mr-2 inline h-3.5 w-3.5" /> {saving ? '保存中...' : dirty ? '保存改动' : '已同步'}
            </button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-slate-500">快捷操作：</span>
          <button type="button" disabled={!canWrite} onClick={() => applyPreset('even')} className={studioSecondaryButtonClassName}>
            平均分配
          </button>
          <button type="button" disabled={!canWrite} onClick={() => applyPreset('off')} className={studioSecondaryButtonClassName}>
            全部下线
          </button>
          <button type="button" disabled={!canWrite || !dirty} onClick={() => applyPreset('reset')} className={studioSecondaryButtonClassName}>
            撤销改动
          </button>
          {dirty && <span className="text-amber-600">有未保存的改动（离开页面会提示）</span>}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {rows.map((row) => {
          const current = draft[row.provider] ?? { provider: row.provider, enabled: row.enabled, weight: row.weight };
          const preview = percentages[row.provider] ?? (current.enabled ? 0 : null);
          return (
            <div key={row.provider} className={`${studioPanelClassName} flex flex-col gap-3 p-5`}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="text-base font-semibold text-slate-800">{row.label}</h3>
                  <p className="mt-1 text-xs leading-5 text-slate-500">{PROVIDER_HINT[row.provider]}</p>
                </div>
                <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-600">
                  <input
                    type="checkbox"
                    checked={current.enabled}
                    disabled={!canWrite}
                    onChange={(event) => updateDraft(row.provider, { enabled: event.target.checked })}
                  />
                  {current.enabled ? '已上线' : '已下线'}
                </label>
              </div>

              <div className="flex items-center gap-2 text-xs">
                {current.enabled && row.credentialsConfigured ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-1 text-emerald-700">
                    <FaCheckCircle className="h-3 w-3" /> 生效中
                  </span>
                ) : current.enabled && row.quota?.exhausted ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-rose-50 px-2 py-1 text-rose-700">
                    <FaExclamationTriangle className="h-3 w-3" /> 额度用尽
                  </span>
                ) : !current.enabled ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-1 text-slate-600">
                    <FaExclamationTriangle className="h-3 w-3" /> 已下线
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-1 text-amber-700">
                    <FaExclamationTriangle className="h-3 w-3" /> 缺凭据
                  </span>
                )}
                <span className="text-slate-500">
                  {REASON_TEXT[
                    row.quota?.exhausted && current.enabled
                      ? 'quota_exhausted'
                      : current.enabled
                        ? row.credentialsConfigured
                          ? 'ok'
                          : 'credentials_missing'
                        : 'scheduling_disabled'
                  ]}
                </span>
              </div>

              <div>
                <div className="flex items-center justify-between text-xs text-slate-600">
                  <span>相对权重</span>
                  <span className="font-medium text-slate-800">
                    {current.weight}
                    {preview !== null && preview !== undefined ? ` · 约 ${preview}%` : ''}
                  </span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={WEIGHT_SLIDER_MAX}
                  step={1}
                  value={Math.min(current.weight, WEIGHT_SLIDER_MAX)}
                  disabled={!canWrite || !current.enabled}
                  onChange={(event) => updateDraft(row.provider, { weight: Number(event.target.value) })}
                  className="mt-2 w-full"
                  aria-label={`${row.label} 权重`}
                />
                <input
                  type="number"
                  min={0}
                  max={1000}
                  value={current.weight}
                  disabled={!canWrite || !current.enabled}
                  onChange={(event) => updateDraft(row.provider, { weight: Math.max(0, Math.min(1000, Number(event.target.value) || 0)) })}
                  className={`${studioFieldClassName} mt-2 w-28`}
                  aria-label={`${row.label} 权重数值`}
                />
              </div>

              <div className="rounded-2xl border border-slate-200 px-3 py-2">
                <div className="flex items-center justify-between text-xs text-slate-600">
                  <span>本月额度</span>
                  <span className={row.quota?.exhausted ? 'font-medium text-rose-600' : 'font-medium text-slate-800'}>
                    {row.quota ? formatQuota(row.quota) : '—'}
                  </span>
                </div>
                {row.quota && row.quota.limit > 0 && (
                  <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                    <div
                      className={`h-full rounded-full ${row.quota.exhausted ? 'bg-rose-500' : 'bg-emerald-500'}`}
                      style={{ width: `${Math.min(100, row.quota.percentage)}%` }}
                    />
                  </div>
                )}
                <p className="mt-1 text-[11px] text-slate-500">
                  {UNLIMITED_PROVIDERS.includes(row.provider)
                    ? '不限额：只计数不拦截'
                    : `额度用尽后本月不再外呼，${row.quota ? new Date(row.quota.resetsAt).toLocaleDateString() : '下月'}自动恢复`}
                </p>

                {!UNLIMITED_PROVIDERS.includes(row.provider) && (
                  <div className="mt-2 flex items-center gap-2">
                    <label className="text-xs text-slate-600" htmlFor={`quota-${row.provider}`}>
                      每月上限
                    </label>
                    <input
                      id={`quota-${row.provider}`}
                      type="number"
                      min={0}
                      max={10000000}
                      value={current.monthlyQuota}
                      disabled={!canWrite}
                      onChange={(event) =>
                        updateDraft(row.provider, { monthlyQuota: Math.max(0, Math.min(10000000, Number(event.target.value) || 0)) })
                      }
                      className={`${studioFieldClassName} w-28`}
                    />
                    <span className="text-[11px] text-slate-500">0 = 不限</span>
                  </div>
                )}
              </div>

              <dl className="space-y-1 text-xs text-slate-600">
                <div className="flex justify-between gap-2">
                  <dt>Site Key</dt>
                  <dd className="truncate font-mono text-slate-800">{row.siteKey || '未设置'}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt>Secret Key</dt>
                  <dd className="font-mono text-slate-800">{row.secretKey || '未设置'}</dd>
                </div>
                {row.updatedAt && (
                  <div className="flex justify-between gap-2">
                    <dt>最近更新</dt>
                    <dd className="text-slate-800">{new Date(row.updatedAt).toLocaleString()}</dd>
                  </div>
                )}
              </dl>

              <div className="mt-auto flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={!canWrite || testing === row.provider}
                  onClick={() => void runTest(row.provider)}
                  className={studioSecondaryButtonClassName}
                >
                  <FaPlug className="mr-2 inline h-3 w-3" /> {testing === row.provider ? '自检中...' : '自检'}
                </button>
                <button
                  type="button"
                  disabled={!canWrite}
                  onClick={() => applyPreset(row.provider)}
                  className={studioSecondaryButtonClassName}
                >
                  仅用此家
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div className={`${studioPanelClassName} p-5`}>
        <h3 className="text-base font-semibold text-slate-800">trycap（Cap）凭据</h3>
        <p className="mt-1 text-sm leading-6 text-slate-600">
          指向你自己的 Cap 实例。Site Key 是公开值（下发到浏览器），Secret Key 只留在服务端，用于 <code>/siteverify</code>。
          留空表示不修改当前值。
        </p>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div>
            <label className="block text-xs font-medium text-slate-600">Site Key（当前：{capConfig?.siteKey || '未设置'}）</label>
            <div className="mt-1 flex gap-2">
              <input
                value={capInput.siteKey}
                disabled={!canWrite}
                onChange={(event) => setCapInput((prev) => ({ ...prev, siteKey: event.target.value }))}
                className={studioFieldClassName}
                placeholder="10 位十六进制，例如 a1b2c3d4e5"
              />
              <button type="button" disabled={!canWrite || savingCap} onClick={() => void saveCapKey('CAP_SITE_KEY')} className={studioPrimaryButtonClassName}>
                保存
              </button>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600">Secret Key（当前：{capConfig?.secretKey || '未设置'}）</label>
            <div className="mt-1 flex gap-2">
              <input
                value={capInput.secretKey}
                disabled={!canWrite}
                onChange={(event) => setCapInput((prev) => ({ ...prev, secretKey: event.target.value }))}
                className={studioFieldClassName}
                placeholder="sk- 开头，创建时只显示一次"
                type="password"
              />
              <button type="button" disabled={!canWrite || savingCap} onClick={() => void saveCapKey('CAP_SECRET_KEY')} className={studioPrimaryButtonClassName}>
                保存
              </button>
            </div>
          </div>

          <div className="md:col-span-2">
            <label className="block text-xs font-medium text-slate-600">实例地址</label>
            <div className="mt-1 flex gap-2">
              <input
                value={capInput.apiEndpoint}
                disabled={!canWrite}
                onChange={(event) => setCapInput((prev) => ({ ...prev, apiEndpoint: event.target.value }))}
                className={studioFieldClassName}
                placeholder="https://cap.example.com"
              />
              <button type="button" disabled={!canWrite || savingCap} onClick={() => void saveCapKey('CAP_API_ENDPOINT')} className={studioPrimaryButtonClassName}>
                保存
              </button>
              <button type="button" disabled={!canWrite || savingCap} onClick={() => void deleteCapKey('CAP_API_ENDPOINT')} className={studioDangerButtonClassName}>
                <FaTrash className="inline h-3 w-3" />
              </button>
            </div>
            <p className="mt-1 text-xs text-slate-500">改地址后请同步更新 CSP 里的 connect-src / script-src，否则浏览器会拦下 Cap 的请求。</p>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" disabled={!canWrite || savingCap} onClick={() => void deleteCapKey('CAP_SITE_KEY')} className={studioDangerButtonClassName}>
            删除 Site Key
          </button>
          <button type="button" disabled={!canWrite || savingCap} onClick={() => void deleteCapKey('CAP_SECRET_KEY')} className={studioDangerButtonClassName}>
            删除 Secret Key
          </button>
        </div>
      </div>
    </div>
  );
}
