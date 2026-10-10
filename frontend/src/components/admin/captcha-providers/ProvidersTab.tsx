import {
  FaCheckCircle,
  FaExclamationTriangle,
  FaPlug,
  FaTrash,
  FaUndo,
} from 'react-icons/fa';
import {
  studioDangerButtonClassName,
  studioFieldClassName,
  studioPanelClassName,
  studioPrimaryButtonClassName,
  studioSecondaryButtonClassName,
} from '@/components/studioTheme';
import {
  LIMITS,
  PROVIDER_ORDER,
  REASON_TEXT,
  clampNumber,
  formatQuota,
  type CapConfigKey,
  type CapConfigState,
  type Option,
  type ProviderDraft,
  type ProviderId,
  type ProviderRow,
  type Scenario,
  type TabActions,
} from './types';

export interface ProvidersTabProps extends TabActions {
  rows: ProviderRow[];
  drafts: Record<ProviderId, ProviderDraft>;
  scenarios: Option[];
  testing: ProviderId | null;
  dirty: boolean;
  onChange: (provider: ProviderId, patch: Partial<ProviderDraft>) => void;
  onScenarioWeightChange: (provider: ProviderId, scenario: Scenario, value: number | '') => void;
  onTest: (provider: ProviderId) => void;
  onApplyPreset: (preset: 'even' | 'off' | 'only' | 'reset', provider?: ProviderId) => void;
  capConfig: CapConfigState | null;
  capInput: { siteKey: string; secretKey: string; apiEndpoint: string };
  onCapInputChange: (patch: Partial<{ siteKey: string; secretKey: string; apiEndpoint: string }>) => void;
  onSaveCapKey: (key: CapConfigKey) => void;
  onDeleteCapKey: (key: CapConfigKey) => void;
  savingCap: boolean;
}

const PROVIDER_HINT: Record<ProviderId, string> = {
  turnstile: 'Cloudflare 托管，脚本与校验都走 challenges.cloudflare.com；支持 theme/size/language。',
  hcaptcha: '第三方托管，返回 score 时低于 0.5 会被拒绝；免费额度按调用次数计，用尽后本月不再外呼。',
  trycap: '自托管 Cap（PoW/hashwx）：无第三方、无追踪。站点密钥需保持 instrumentation 关闭——该功能要求 CSP 放行 unsafe-eval，本仓生产 CSP 刻意不放行。',
};

/** 这两家不限额：trycap 自托管、Turnstile 当前免费额度不按调用计。仅 hCaptcha 按月计额度。 */
const UNLIMITED_PROVIDERS: ProviderId[] = ['turnstile', 'trycap'];

function statusPill(row: ProviderRow, draft: ProviderDraft) {
  if (!draft.enabled) {
    return { className: 'border-slate-200 bg-slate-100 text-slate-600', label: '已下线', Icon: FaExclamationTriangle };
  }
  if (row.quota?.exhausted) {
    return { className: 'border-rose-200 bg-rose-50 text-rose-700', label: '额度用尽', Icon: FaExclamationTriangle };
  }
  if (!row.credentialsConfigured) {
    return { className: 'border-amber-200 bg-amber-50 text-amber-700', label: '缺凭据', Icon: FaExclamationTriangle };
  }
  return { className: 'border-emerald-200 bg-emerald-50 text-emerald-700', label: '生效中', Icon: FaCheckCircle };
}

export default function ProvidersTab(props: ProvidersTabProps) {
  const {
    canWrite,
    rows,
    drafts,
    scenarios,
    testing,
    onChange,
    onScenarioWeightChange,
    onTest,
    onApplyPreset,
    capConfig,
    capInput,
    onCapInputChange,
    onSaveCapKey,
    onDeleteCapKey,
    savingCap,
  } = props;

  const ordered = PROVIDER_ORDER.map((provider) => rows.find((row) => row.provider === provider)).filter(
    (row): row is ProviderRow => Boolean(row),
  );

  return (
    <div className="space-y-6">
      <div className={`${studioPanelClassName} flex flex-wrap items-center justify-between gap-3 p-4`}>
        <p className="text-xs leading-5 text-slate-600">
          权重是<b>相对值</b>（自动归一化）；<b>场景权重</b>留空表示沿用基础权重；
          <b>优先级</b>只在「优先级故障转移」策略下起作用（数值小者优先）。
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" disabled={!canWrite} onClick={() => onApplyPreset('even')} className={studioSecondaryButtonClassName}>
            平均分配
          </button>
          <button type="button" disabled={!canWrite} onClick={() => onApplyPreset('off')} className={studioSecondaryButtonClassName}>
            全部下线
          </button>
          <button type="button" disabled={!canWrite} onClick={() => onApplyPreset('reset')} className={studioSecondaryButtonClassName}>
            <FaUndo className="mr-2 inline h-3 w-3" /> 撤销改动
          </button>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-3 lg:grid-cols-2">
        {ordered.map((row) => {
          const draft =
            drafts[row.provider] ??
            ({
              provider: row.provider,
              enabled: row.enabled,
              weight: row.weight,
              priority: row.priority,
              monthlyQuota: row.quota?.limit ?? 0,
              scenarioWeights: { default: '', first_visit: '', standalone: '', step_up: '' },
            } satisfies ProviderDraft);
          const status = statusPill(row, draft);
          const StatusIcon = status.Icon;
          const preview = row.effective && draft.enabled ? row.percentage : null;
          const unlimited = UNLIMITED_PROVIDERS.includes(row.provider);

          return (
            <section key={row.provider} className={`${studioPanelClassName} flex flex-col gap-4 p-5`}>
              <header className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-base font-semibold text-slate-800">{row.label}</h3>
                  <p className="mt-1 text-xs leading-5 text-slate-500">{PROVIDER_HINT[row.provider]}</p>
                </div>
                <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs text-slate-600">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    disabled={!canWrite}
                    onChange={(event) => onChange(row.provider, { enabled: event.target.checked })}
                    aria-label={`${row.label} 上线`}
                  />
                  {draft.enabled ? '已上线' : '已下线'}
                </label>
              </header>

              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 ${status.className}`}>
                  <StatusIcon className="h-3 w-3" /> {status.label}
                </span>
                <span className="text-slate-500">
                  {REASON_TEXT[
                    row.quota?.exhausted && draft.enabled
                      ? 'quota_exhausted'
                      : draft.enabled
                        ? row.credentialsConfigured
                          ? 'ok'
                          : 'credentials_missing'
                        : 'scheduling_disabled'
                  ]}
                </span>
              </div>

              <div>
                <div className="flex items-center justify-between text-xs text-slate-600">
                  <span>基础权重</span>
                  <span className="font-medium text-slate-800">
                    {draft.weight}
                    {preview !== null ? ` · 当前约 ${preview}%` : ''}
                  </span>
                </div>
                <input
                  type="range"
                  min={LIMITS.weight.min}
                  max={LIMITS.weight.max}
                  step={1}
                  value={Math.min(draft.weight, LIMITS.weight.max)}
                  disabled={!canWrite || !draft.enabled}
                  onChange={(event) => onChange(row.provider, { weight: Number(event.target.value) })}
                  className="mt-2 w-full"
                  aria-label={`${row.label} 权重滑块`}
                />
                <div className="mt-2 flex items-center gap-3">
                  <input
                    type="number"
                    min={LIMITS.weight.min}
                    max={LIMITS.weight.max}
                    value={draft.weight}
                    disabled={!canWrite || !draft.enabled}
                    onChange={(event) =>
                      onChange(row.provider, { weight: clampNumber(Number(event.target.value), LIMITS.weight.min, LIMITS.weight.max) })
                    }
                    className={`${studioFieldClassName} w-24`}
                    aria-label={`${row.label} 权重数值`}
                  />
                  <label className="flex items-center gap-2 text-xs text-slate-600">
                    <span>优先级</span>
                    <input
                      type="number"
                      min={LIMITS.priority.min}
                      max={LIMITS.priority.max}
                      value={draft.priority}
                      disabled={!canWrite}
                      onChange={(event) =>
                        onChange(row.provider, {
                          priority: clampNumber(Number(event.target.value), LIMITS.priority.min, LIMITS.priority.max),
                        })
                      }
                      className={`${studioFieldClassName} w-20`}
                      aria-label={`${row.label} 故障转移优先级`}
                    />
                  </label>
                </div>
              </div>

              <div className="rounded-2xl border border-slate-200 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-slate-700">按场景权重</span>
                  <button
                    type="button"
                    disabled={!canWrite}
                    onClick={() => scenarios.forEach((scenario) => onScenarioWeightChange(row.provider, scenario.value as Scenario, ''))}
                    className="text-[11px] text-slate-500 underline decoration-dotted hover:text-slate-700"
                  >
                    全部沿用基础权重
                  </button>
                </div>
                <div className="mt-2 grid gap-2 sm:grid-cols-3">
                  {scenarios.map((scenario) => {
                    const value = draft.scenarioWeights[scenario.value as Scenario];
                    return (
                      <label key={scenario.value} className="text-[11px] text-slate-500">
                        {scenario.label}
                        <input
                          type="number"
                          min={LIMITS.weight.min}
                          max={LIMITS.weight.max}
                          value={value === '' ? '' : value}
                          placeholder={String(draft.weight)}
                          disabled={!canWrite || !draft.enabled}
                          onChange={(event) => {
                            const raw = event.target.value;
                            onScenarioWeightChange(
                              row.provider,
                              scenario.value as Scenario,
                              raw === '' ? '' : clampNumber(Number(raw), LIMITS.weight.min, LIMITS.weight.max),
                            );
                          }}
                          className={`${studioFieldClassName} mt-1 w-full`}
                          aria-label={`${row.label} ${scenario.label}权重`}
                        />
                      </label>
                    );
                  })}
                </div>
                <p className="mt-2 text-[11px] text-slate-500">
                  当前生效：{scenarios.map((scenario) => `${scenario.label} ${row.effectiveScenarioWeights[scenario.value as Scenario]}`).join(' · ')}
                </p>
              </div>

              <div className="rounded-2xl border border-slate-200 p-3">
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
                  {unlimited
                    ? '不限额：只计数不拦截'
                    : `额度用尽后本月不再外呼，${row.quota ? new Date(row.quota.resetsAt).toLocaleDateString() : '下月'}自动恢复`}
                </p>
                {!unlimited && (
                  <div className="mt-2 flex items-center gap-2">
                    <label className="text-xs text-slate-600" htmlFor={`quota-${row.provider}`}>
                      每月上限
                    </label>
                    <input
                      id={`quota-${row.provider}`}
                      type="number"
                      min={LIMITS.quota.min}
                      max={LIMITS.quota.max}
                      value={draft.monthlyQuota}
                      disabled={!canWrite}
                      onChange={(event) =>
                        onChange(row.provider, {
                          monthlyQuota: clampNumber(Number(event.target.value), LIMITS.quota.min, LIMITS.quota.max),
                        })
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
                <div className="flex justify-between gap-2">
                  <dt>最近更新</dt>
                  <dd className="text-slate-800">{row.updatedAt ? new Date(row.updatedAt).toLocaleString() : '—'}</dd>
                </div>
              </dl>

              <div className="mt-auto flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={!canWrite || testing === row.provider}
                  onClick={() => onTest(row.provider)}
                  className={studioSecondaryButtonClassName}
                >
                  <FaPlug className="mr-2 inline h-3 w-3" /> {testing === row.provider ? '自检中...' : '自检'}
                </button>
                <button
                  type="button"
                  disabled={!canWrite}
                  onClick={() => onApplyPreset('only', row.provider)}
                  className={studioSecondaryButtonClassName}
                >
                  仅用此家
                </button>
              </div>
            </section>
          );
        })}
      </div>

      <section className={`${studioPanelClassName} p-5`}>
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-slate-800">trycap（Cap）凭据</h3>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              指向你自己的 Cap 实例。Site Key 是公开值（下发到浏览器），Secret Key 只留在服务端，用于 <code>/siteverify</code>。
              留空表示不修改当前值。
            </p>
          </div>
          <span className="text-xs text-slate-500">
            当前：{capConfig?.enabled ? '已配置可用' : '未配置或仅缺 Secret'}
          </span>
        </header>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div>
            <label className="block text-xs font-medium text-slate-600" htmlFor="cap-site-key">
              Site Key（当前：{capConfig?.siteKey || '未设置'}）
            </label>
            <div className="mt-1 flex gap-2">
              <input
                id="cap-site-key"
                value={capInput.siteKey}
                disabled={!canWrite}
                onChange={(event) => onCapInputChange({ siteKey: event.target.value })}
                className={studioFieldClassName}
                placeholder="10 位十六进制，例如 a1b2c3d4e5"
              />
              <button
                type="button"
                disabled={!canWrite || savingCap}
                onClick={() => onSaveCapKey('CAP_SITE_KEY')}
                className={studioPrimaryButtonClassName}
              >
                保存
              </button>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-600" htmlFor="cap-secret-key">
              Secret Key（当前：{capConfig?.secretKey || '未设置'}）
            </label>
            <div className="mt-1 flex gap-2">
              <input
                id="cap-secret-key"
                value={capInput.secretKey}
                disabled={!canWrite}
                onChange={(event) => onCapInputChange({ secretKey: event.target.value })}
                className={studioFieldClassName}
                placeholder="sk- 开头，创建时只显示一次"
                type="password"
              />
              <button
                type="button"
                disabled={!canWrite || savingCap}
                onClick={() => onSaveCapKey('CAP_SECRET_KEY')}
                className={studioPrimaryButtonClassName}
              >
                保存
              </button>
            </div>
          </div>

          <div className="md:col-span-2">
            <label className="block text-xs font-medium text-slate-600" htmlFor="cap-endpoint">
              实例地址
            </label>
            <div className="mt-1 flex gap-2">
              <input
                id="cap-endpoint"
                value={capInput.apiEndpoint}
                disabled={!canWrite}
                onChange={(event) => onCapInputChange({ apiEndpoint: event.target.value })}
                className={studioFieldClassName}
                placeholder="https://cap.example.com"
              />
              <button
                type="button"
                disabled={!canWrite || savingCap}
                onClick={() => onSaveCapKey('CAP_API_ENDPOINT')}
                className={studioPrimaryButtonClassName}
              >
                保存
              </button>
              <button
                type="button"
                disabled={!canWrite || savingCap}
                onClick={() => onDeleteCapKey('CAP_API_ENDPOINT')}
                className={studioDangerButtonClassName}
                aria-label="删除实例地址"
              >
                <FaTrash className="inline h-3 w-3" />
              </button>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              改地址后请同步更新 CSP 里的 connect-src / script-src，否则浏览器会拦下 Cap 的请求。
            </p>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={!canWrite || savingCap}
            onClick={() => onDeleteCapKey('CAP_SITE_KEY')}
            className={studioDangerButtonClassName}
          >
            删除 Site Key
          </button>
          <button
            type="button"
            disabled={!canWrite || savingCap}
            onClick={() => onDeleteCapKey('CAP_SECRET_KEY')}
            className={studioDangerButtonClassName}
          >
            删除 Secret Key
          </button>
        </div>
      </section>
    </div>
  );
}
