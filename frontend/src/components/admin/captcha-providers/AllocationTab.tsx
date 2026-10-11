import { useCallback, useMemo, useState } from 'react';
import { FaFlask, FaMagic, FaUndo } from 'react-icons/fa';
import {
  studioFieldClassName,
  studioPanelClassName,
  studioPrimaryButtonClassName,
  studioSecondaryButtonClassName,
} from '@/components/studioTheme';
import {
  DEFAULT_SIMULATE_DRAWS,
  SIMULATE_MAX_DRAWS,
  STRATEGY_VALUES,
  toSimulationPolicy,
  type SelectionQuery,
  type SimulatePayload,
} from './api';
import {
  LIMITS,
  STRATEGY_TEXT,
  clampNumber,
  type AllocationPolicy,
  type ApiResult,
  type Option,
  type ProviderDraft,
  type ProviderId,
  type ProviderRow,
  type Scenario,
  type SelectionPreview,
  type SimulationResult,
  type Strategy,
  type TabActions,
} from './types';

export interface AllocationTabProps extends TabActions {
  policy: AllocationPolicy;
  savedPolicy: AllocationPolicy;
  scenarios: Option[];
  strategies: Option[];
  rows: ProviderRow[];
  drafts: Record<ProviderId, ProviderDraft>;
  dirty: boolean;
  onChange: (patch: Partial<AllocationPolicy>) => void;
  onScenarioStrategyChange: (scenario: Scenario, strategy: Strategy | '') => void;
  /** RC-24：场景供应商白名单（硬约束）。空数组 = 不受白名单约束。 */
  onScenarioAllowlistChange: (scenario: Scenario, providers: ProviderId[]) => void;
  onReset: () => void;
  onSimulate: (payload: SimulatePayload) => Promise<ApiResult<SimulationResult>>;
  onPreview: (query: SelectionQuery) => Promise<ApiResult<SelectionPreview>>;
}

function DistributionBars({
  distribution,
}: {
  distribution: Array<{ provider: ProviderId; count: number; percentage: number }>;
}) {
  return (
    <ul className="space-y-2">
      {distribution.map((entry) => (
        <li key={entry.provider}>
          <div className="flex items-center justify-between text-xs text-slate-600">
            <span className="font-medium text-slate-800">{entry.provider}</span>
            <span>
              {entry.count} 次 · {entry.percentage}%
            </span>
          </div>
          <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-slate-100">
            <div className="h-full rounded-full bg-slate-700" style={{ width: `${Math.min(100, entry.percentage)}%` }} />
          </div>
        </li>
      ))}
      {distribution.length === 0 && <li className="text-xs text-slate-500">没有可下发的候选（全部下线或凭据不全）。</li>}
    </ul>
  );
}

export default function AllocationTab(props: AllocationTabProps) {
  const {
    canWrite,
    notify,
    policy,
    scenarios,
    rows,
    drafts,
    dirty,
    onChange,
    onScenarioStrategyChange,
    onScenarioAllowlistChange,
    onReset,
    onSimulate,
    onPreview,
  } = props;

  const [simulateScenario, setSimulateScenario] = useState<Scenario>('default');
  const [simulateDraws, setSimulateDraws] = useState(DEFAULT_SIMULATE_DRAWS);
  const [simulateFingerprint, setSimulateFingerprint] = useState('');
  const [simulateResult, setSimulateResult] = useState<SimulationResult | null>(null);
  const [simulating, setSimulating] = useState(false);

  const [previewScenario, setPreviewScenario] = useState<Scenario>('default');
  const [previewFingerprint, setPreviewFingerprint] = useState('admin-preview');
  const [previewForce, setPreviewForce] = useState<ProviderId | ''>('');
  const [preview, setPreview] = useState<SelectionPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);

  const providerOptions = useMemo<Option[]>(
    () => rows.map((row) => ({ value: row.provider, label: row.label })),
    [rows],
  );

  const runSimulation = useCallback(
    async (useDraft: boolean) => {
      setSimulating(true);
      try {
        const payload: SimulatePayload = {
          draws: simulateDraws,
          scenario: simulateScenario,
          ...(simulateFingerprint ? { fingerprint: simulateFingerprint } : {}),
          ...(useDraft
            ? {
                policy: toSimulationPolicy(policy),
                providers: Object.values(drafts),
              }
            : {}),
        };
        const result = await onSimulate(payload);
        if (!result.ok || !result.data) {
          notify(result.error || '模拟失败', 'error');
          return;
        }
        setSimulateResult(result.data);
        notify(useDraft ? '按当前草稿模拟完成（未写库）' : '按已保存配置模拟完成', 'success');
      } finally {
        setSimulating(false);
      }
    },
    [drafts, notify, onSimulate, policy, simulateDraws, simulateFingerprint, simulateScenario],
  );

  const runPreview = useCallback(async () => {
    setPreviewing(true);
    try {
      const result = await onPreview({
        scenario: previewScenario,
        fingerprint: previewFingerprint || undefined,
        force: previewForce || undefined,
      });
      if (!result.ok || !result.data) {
        notify(result.error || '诊断失败', 'error');
        return;
      }
      setPreview(result.data);
    } finally {
      setPreviewing(false);
    }
  }, [notify, onPreview, previewFingerprint, previewForce, previewScenario]);

  return (
    <div className="space-y-6">
      <section className={`${studioPanelClassName} p-5`}>
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-slate-800">分配策略</h3>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              策略决定「把这一次验证交给谁」。除加权随机外都是确定性算法（只看指纹与时间），
              因此多实例部署下同一用户在窗口内必然落到同一家，不需要共享状态。
            </p>
          </div>
          <button type="button" onClick={onReset} disabled={!canWrite || !dirty} className={studioSecondaryButtonClassName}>
            <FaUndo className="mr-2 inline h-3 w-3" /> 撤销策略改动
          </button>
        </header>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <label className="text-xs font-medium text-slate-600">
            默认策略
            <select
              value={policy.strategy}
              disabled={!canWrite}
              onChange={(event) => onChange({ strategy: event.target.value as Strategy })}
              className={`${studioFieldClassName} mt-1`}
            >
              {STRATEGY_VALUES.map((strategy) => (
                <option key={strategy} value={strategy}>
                  {STRATEGY_TEXT[strategy]}
                </option>
              ))}
            </select>
          </label>

          <label className="text-xs font-medium text-slate-600">
            轮换周期（秒，仅「按时间轮换」生效）
            <input
              type="number"
              min={LIMITS.rotationSeconds.min}
              max={LIMITS.rotationSeconds.max}
              value={policy.rotationSeconds}
              disabled={!canWrite}
              onChange={(event) =>
                onChange({
                  rotationSeconds: clampNumber(Number(event.target.value), LIMITS.rotationSeconds.min, LIMITS.rotationSeconds.max),
                })
              }
              className={`${studioFieldClassName} mt-1`}
            />
          </label>

          <div className="rounded-2xl border border-slate-200 p-3">
            <label className="flex items-center gap-2 text-xs font-medium text-slate-700">
              <input
                type="checkbox"
                checked={policy.stickyEnabled}
                disabled={!canWrite}
                onChange={(event) => onChange({ stickyEnabled: event.target.checked })}
              />
              粘性分配（同一指纹在窗口内固定同一家）
            </label>
            <label className="mt-2 block text-xs text-slate-600">
              粘性窗口（分钟）
              <input
                type="number"
                min={LIMITS.stickyTtlMinutes.min}
                max={LIMITS.stickyTtlMinutes.max}
                value={policy.stickyTtlMinutes}
                disabled={!canWrite || !policy.stickyEnabled}
                onChange={(event) =>
                  onChange({
                    stickyTtlMinutes: clampNumber(
                      Number(event.target.value),
                      LIMITS.stickyTtlMinutes.min,
                      LIMITS.stickyTtlMinutes.max,
                    ),
                  })
                }
                className={`${studioFieldClassName} mt-1`}
              />
            </label>
          </div>

          <div className="rounded-2xl border border-slate-200 p-3">
            <label className="block text-xs font-medium text-slate-700">
              灰度比例（%）
              <input
                type="range"
                min={LIMITS.rolloutPercent.min}
                max={LIMITS.rolloutPercent.max}
                value={policy.rolloutPercent}
                disabled={!canWrite}
                onChange={(event) => onChange({ rolloutPercent: Number(event.target.value) })}
                className="mt-2 w-full"
                aria-label="灰度比例"
              />
            </label>
            <div className="mt-2 flex items-center gap-2">
              <input
                type="number"
                min={LIMITS.rolloutPercent.min}
                max={LIMITS.rolloutPercent.max}
                value={policy.rolloutPercent}
                disabled={!canWrite}
                onChange={(event) =>
                  onChange({ rolloutPercent: clampNumber(Number(event.target.value), LIMITS.rolloutPercent.min, LIMITS.rolloutPercent.max) })
                }
                className={`${studioFieldClassName} w-20`}
                aria-label="灰度比例数值"
              />
              <span className="text-xs text-slate-600">其余流量固定给</span>
              <select
                value={policy.rolloutControlProvider}
                disabled={!canWrite}
                onChange={(event) => onChange({ rolloutControlProvider: event.target.value as ProviderId })}
                className={`${studioFieldClassName} w-40`}
                aria-label="灰度对照组供应商"
              >
                {providerOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <p className="mt-2 text-[11px] text-slate-500">0 = 关闭灰度（全量走策略）；100 等价于全量走策略。对照组不可用时自动忽略灰度。</p>
          </div>

          <label className="text-xs font-medium text-slate-600">
            故障转移次数上限（含首次）
            <input
              type="number"
              min={LIMITS.failoverMaxAttempts.min}
              max={LIMITS.failoverMaxAttempts.max}
              value={policy.failoverMaxAttempts}
              disabled={!canWrite}
              onChange={(event) =>
                onChange({
                  failoverMaxAttempts: clampNumber(
                    Number(event.target.value),
                    LIMITS.failoverMaxAttempts.min,
                    LIMITS.failoverMaxAttempts.max,
                  ),
                })
              }
              className={`${studioFieldClassName} mt-1`}
            />
            <span className="mt-1 block text-[11px] text-slate-500">前端控件加载失败时，最多自动换几家（会同步下发到浏览器）。</span>
          </label>

          <div className="md:col-span-2">
            <p className="text-xs font-medium text-slate-600">按场景覆盖策略</p>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              {scenarios.map((scenario) => {
                const value = policy.scenarioStrategies[scenario.value as Scenario] ?? '';
                return (
                  <label key={scenario.value} className="text-[11px] text-slate-500">
                    {scenario.label}
                    <select
                      value={value}
                      disabled={!canWrite}
                      onChange={(event) => onScenarioStrategyChange(scenario.value as Scenario, event.target.value as Strategy | '')}
                      className={`${studioFieldClassName} mt-1`}
                    >
                      <option value="">沿用默认策略</option>
                      {STRATEGY_VALUES.map((strategy) => (
                        <option key={strategy} value={strategy}>
                          {STRATEGY_TEXT[strategy]}
                        </option>
                      ))}
                    </select>
                  </label>
                );
              })}
            </div>

            {/* RC-24：场景白名单是**硬约束**，不是权重。
                只要某场景设了白名单，候选集就恒等于它的交集（权重 0 在 weighted 下会退化为等概率、
                在 failover/round_robin 下根本不生效，所以排除供应商必须用白名单表达）。 */}
            <div className="mt-4">
              <p className="text-xs font-medium text-slate-600">场景供应商白名单（硬性排除）</p>
              <p className="mt-1 text-[11px] text-slate-500">
                全部不勾 = 该场景不受白名单约束；只要勾了至少一家，该场景的候选集就只会在勾选范围内。
                被标记账户的逐步验证默认只走自托管 Cap（trycap）与 Turnstile。
              </p>
              <div className="mt-2 space-y-2">
                {scenarios.map((scenario) => {
                  const key = scenario.value as Scenario;
                  const list = policy.scenarioProviderAllowlist?.[key] ?? [];
                  const unrestricted = list.length === 0;
                  return (
                    <div key={scenario.value} className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-white/70 px-3 py-2">
                      <span className="min-w-[9rem] text-[11px] font-medium text-slate-600">{scenario.label}</span>
                      {providerOptions.map((option) => {
                        const checked = list.includes(option.value as ProviderId);
                        return (
                          <label key={option.value} className="inline-flex items-center gap-1.5 text-[11px] text-slate-600">
                            <input
                              type="checkbox"
                              className="h-3.5 w-3.5"
                              checked={checked}
                              disabled={!canWrite}
                              onChange={(event) => {
                                const next = new Set(list);
                                if (event.target.checked) next.add(option.value as ProviderId);
                                else next.delete(option.value as ProviderId);
                                onScenarioAllowlistChange(key, [...next] as ProviderId[]);
                              }}
                            />
                            {option.label}
                          </label>
                        );
                      })}
                      <span className={`text-[11px] ${unrestricted ? 'text-slate-400' : 'text-amber-600'}`}>
                        {unrestricted ? '不限制' : '仅勾选范围'}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className={`${studioPanelClassName} p-5`}>
        <header className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="flex items-center gap-2 text-base font-semibold text-slate-800">
            <FaMagic className="h-4 w-4 text-slate-500" /> 分配模拟
          </h3>
          <p className="text-xs text-slate-500">用与线上同一套引擎抽样，不写库、不影响线上。</p>
        </header>

        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="text-xs text-slate-600">
            场景
            <select
              value={simulateScenario}
              onChange={(event) => setSimulateScenario(event.target.value as Scenario)}
              className={`${studioFieldClassName} mt-1`}
            >
              {scenarios.map((scenario) => (
                <option key={scenario.value} value={scenario.value}>
                  {scenario.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-slate-600">
            抽样次数
            <input
              type="number"
              min={10}
              max={SIMULATE_MAX_DRAWS}
              value={simulateDraws}
              onChange={(event) =>
                setSimulateDraws(clampNumber(Number(event.target.value), 10, SIMULATE_MAX_DRAWS))
              }
              className={`${studioFieldClassName} mt-1 w-28`}
            />
          </label>
          <label className="text-xs text-slate-600">
            指定指纹（可选，用于看粘性/灰度）
            <input
              value={simulateFingerprint}
              onChange={(event) => setSimulateFingerprint(event.target.value)}
              placeholder="留空则合成 1000 个指纹"
              className={`${studioFieldClassName} mt-1 w-56`}
            />
          </label>
          <button
            type="button"
            onClick={() => void runSimulation(true)}
            disabled={simulating}
            className={studioPrimaryButtonClassName}
          >
            {simulating ? '模拟中...' : '按当前草稿模拟'}
          </button>
          <button
            type="button"
            onClick={() => void runSimulation(false)}
            disabled={simulating}
            className={studioSecondaryButtonClassName}
          >
            按已保存配置模拟
          </button>
        </div>

        {simulateResult && (
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div>
              <DistributionBars distribution={simulateResult.distribution} />
            </div>
            <div className="text-xs text-slate-600">
              <p>
                场景 <b>{simulateResult.scenario}</b> · 策略 <b>{simulateResult.strategy}</b> · 抽样{' '}
                <b>{simulateResult.draws}</b> 次
              </p>
              <ul className="mt-2 list-disc space-y-1 pl-4 text-[11px] text-slate-500">
                {simulateResult.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
              <table className="mt-3 w-full text-left text-[11px]">
                <thead className="text-slate-500">
                  <tr className="border-b border-slate-200">
                    <th className="py-1 pr-2 font-medium">候选</th>
                    <th className="py-1 pr-2 font-medium">权重</th>
                    <th className="py-1 pr-2 font-medium">概率</th>
                    <th className="py-1 font-medium">优先级</th>
                  </tr>
                </thead>
                <tbody>
                  {simulateResult.candidates.map((candidate) => (
                    <tr key={candidate.provider} className="border-b border-slate-100 last:border-0">
                      <td className="py-1 pr-2 text-slate-800">{candidate.label}</td>
                      <td className="py-1 pr-2">{candidate.weight}</td>
                      <td className="py-1 pr-2">{candidate.percentage}%</td>
                      <td className="py-1">{candidate.priority}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      <section className={`${studioPanelClassName} p-5`}>
        <header className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="flex items-center gap-2 text-base font-semibold text-slate-800">
            <FaFlask className="h-4 w-4 text-slate-500" /> 现在会选谁（真实引擎诊断）
          </h3>
          <p className="text-xs text-slate-500">同一次请求只消耗零额度：只跑分配，不调用任何供应商接口。</p>
        </header>

        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="text-xs text-slate-600">
            场景
            <select
              value={previewScenario}
              onChange={(event) => setPreviewScenario(event.target.value as Scenario)}
              className={`${studioFieldClassName} mt-1`}
            >
              {scenarios.map((scenario) => (
                <option key={scenario.value} value={scenario.value}>
                  {scenario.label}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs text-slate-600">
            指纹
            <input
              value={previewFingerprint}
              onChange={(event) => setPreviewFingerprint(event.target.value)}
              className={`${studioFieldClassName} mt-1 w-56`}
            />
          </label>
          <label className="text-xs text-slate-600">
            强制预览供应商（用于实机预览）
            <select
              value={previewForce}
              onChange={(event) => setPreviewForce(event.target.value as ProviderId | '')}
              className={`${studioFieldClassName} mt-1 w-48`}
            >
              <option value="">不强制</option>
              {providerOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => void runPreview()} disabled={previewing} className={studioPrimaryButtonClassName}>
            {previewing ? '诊断中...' : '跑一次'}
          </button>
        </div>

        {preview && (
          <div className="mt-4 grid gap-4 text-xs md:grid-cols-2">
            <div>
              <p className="text-slate-600">
                选中：<b className="text-slate-900">{preview.selection.label}</b>（{preview.selection.reason}）·
                策略 <b>{preview.strategy}</b>
                {preview.stickyEnabled ? ` · 粘性 ${preview.stickyTtlMinutes} 分钟` : ''}
                {preview.rolloutPercent > 0 ? ` · 灰度 ${preview.rolloutPercent}%` : ''}
              </p>
              <ul className="mt-2 space-y-1">
                {preview.candidates.map((candidate) => (
                  <li key={candidate.provider} className="flex justify-between gap-2 text-slate-600">
                    <span>
                      {candidate.label}（权重 {candidate.weight} · 优先级 {candidate.priority}）
                    </span>
                    <span>{candidate.percentage}%</span>
                  </li>
                ))}
                {preview.candidates.length === 0 && <li className="text-rose-600">当前没有任何候选会下发。</li>}
              </ul>
            </div>
            <div className="rounded-2xl border border-slate-200 p-3">
              <p className="font-medium text-slate-700">解析后的控件外观</p>
              <p className="mt-1 text-slate-600">
                theme={preview.widget.theme} · size={preview.widget.size} · language={preview.widget.language} ·
                署名 {preview.widget.showProviderLabel ? '展示' : '隐藏'}
              </p>
              {preview.forced && (
                <p className="mt-2 text-slate-600">
                  强制预览 {preview.forced.label}：{preview.forced.usable ? '可用' : `不可用（${preview.forced.reason}）`} ·
                  siteKey {preview.forced.siteKey ? '已下发' : '缺失'}
                </p>
              )}
              <p className="mt-2 text-[11px] text-slate-500">
                到「组件外观」页签可看到按这份配置渲染的真实控件。
              </p>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
