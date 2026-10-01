import { FaChartLine, FaExclamationTriangle, FaExternalLinkAlt, FaSync } from 'react-icons/fa';
import { studioPanelClassName, studioSecondaryButtonClassName } from '@/components/studioTheme';
import {
  CAPTCHA_COVERAGE,
  REASON_TEXT,
  STRATEGY_TEXT,
  type AllocationPolicy,
  type ProviderRow,
  type ProviderStatsResponse,
  type TabActions,
  type WidgetSettings,
} from './types';

export interface OverviewTabProps extends TabActions {
  rows: ProviderRow[];
  policy: AllocationPolicy;
  widgets: WidgetSettings;
  candidateCount: number;
  dirty: boolean;
  stats: ProviderStatsResponse | null;
  statsHours: number;
  loadingStats: boolean;
  onStatsHoursChange: (hours: number) => void;
  onApplyPreset: (preset: 'even' | 'off' | 'reset') => void;
  onRefresh: () => void;
  refreshing: boolean;
}

const HOUR_CHOICES = [1, 6, 24, 72, 168] as const;

function KpiCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className={`${studioPanelClassName} p-4`}>
      <p className="text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-slate-800">{value}</p>
      {hint && <p className="mt-1 text-xs leading-5 text-slate-500">{hint}</p>}
    </div>
  );
}

export default function OverviewTab(props: OverviewTabProps) {
  const {
    canWrite,
    rows,
    policy,
    widgets,
    candidateCount,
    dirty,
    stats,
    statsHours,
    loadingStats,
    onStatsHoursChange,
    onApplyPreset,
    onRefresh,
    refreshing,
  } = props;

  const monthlyUsed = rows.reduce((sum, row) => sum + (row.quota?.used ?? 0), 0);
  const limitedOverflow = rows.filter((row) => row.quota?.exhausted);
  const successRate = stats?.totals.successRate;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="可下发供应商"
          value={`${candidateCount} / ${rows.length}`}
          hint={candidateCount === 0 ? '当前没有任何供应商会下发，用户会直接放行 —— 请检查上线开关与凭据' : '凭据齐全、已上线且本月额度未用尽'}
        />
        <KpiCard label="本月外呼合计" value={String(monthlyUsed)} hint="三家供应商本月校验次数之和（不含未计数的失败）" />
        <KpiCard
          label={`近 ${statsHours} 小时成功率`}
          value={successRate === null || successRate === undefined ? '—' : `${successRate}%`}
          hint={stats ? `样本 ${stats.totals.total} 次（成功 ${stats.totals.success} / 失败 ${stats.totals.failure}）` : '统计不可用'}
        />
        <KpiCard
          label="未保存改动"
          value={dirty ? '有' : '无'}
          hint={dirty ? (canWrite ? '点右下角「保存全部」或按 Ctrl/Cmd+S 生效' : '只读账号无法保存，请联系超级管理员') : '与线上配置一致'}
        />
      </div>

      {limitedOverflow.length > 0 && (
        <div className="flex items-start gap-3 rounded-2xl border border-rose-200 bg-rose-50/80 p-4 text-sm text-rose-800">
          <FaExclamationTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            {limitedOverflow.map((row) => row.label).join('、')} 本月额度已用尽，已被自动摘出下发候选；
            下月 1 日 00:00（北京时间）自动恢复，也可在「供应商」页签里调高每月上限。
          </p>
        </div>
      )}

      <section className={`${studioPanelClassName} p-5`}>
        <header className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-base font-semibold text-slate-800">生效矩阵</h3>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" disabled={!canWrite} onClick={() => onApplyPreset('even')} className={studioSecondaryButtonClassName}>
              平均分配
            </button>
            <button type="button" disabled={!canWrite} onClick={() => onApplyPreset('off')} className={studioSecondaryButtonClassName}>
              全部下线
            </button>
            <button type="button" onClick={onRefresh} disabled={refreshing} className={studioSecondaryButtonClassName}>
              <FaSync className="mr-2 inline h-3 w-3" /> {refreshing ? '刷新中...' : '刷新'}
            </button>
          </div>
        </header>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-xs">
            <thead className="text-slate-500">
              <tr className="border-b border-slate-200">
                <th className="py-2 pr-3 font-medium">供应商</th>
                <th className="py-2 pr-3 font-medium">上线</th>
                <th className="py-2 pr-3 font-medium">凭据</th>
                <th className="py-2 pr-3 font-medium">额度</th>
                <th className="py-2 pr-3 font-medium">生效</th>
                <th className="py-2 pr-3 font-medium">权重 / 概率</th>
                <th className="py-2 pr-3 font-medium">优先级</th>
                <th className="py-2 font-medium">结论</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.provider} className="border-b border-slate-100 last:border-0">
                  <td className="py-2 pr-3 font-medium text-slate-800">{row.label}</td>
                  <td className="py-2 pr-3">{row.enabled ? '已上线' : '已下线'}</td>
                  <td className="py-2 pr-3">{row.credentialsConfigured ? '齐全' : '缺失'}</td>
                  <td className="py-2 pr-3">
                    {row.quota.limit <= 0 ? `已用 ${row.quota.used}（不限）` : `${row.quota.used}/${row.quota.limit}`}
                  </td>
                  <td className="py-2 pr-3">
                    <span className={row.effective ? 'text-emerald-600' : 'text-slate-400'}>
                      {row.effective ? '参与下发' : '不参与'}
                    </span>
                  </td>
                  <td className="py-2 pr-3">
                    {row.weight}
                    {row.effective ? ` · ${row.percentage}%` : ''}
                  </td>
                  <td className="py-2 pr-3">{row.priority}</td>
                  <td className="py-2 text-slate-600">{REASON_TEXT[row.reason]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="mt-3 text-xs leading-5 text-slate-500">
          场景权重（生效值）：{' '}
          {rows
            .map(
              (row) =>
                `${row.label} = 默认 ${row.effectiveScenarioWeights.default} / 首访 ${row.effectiveScenarioWeights.first_visit} / 独立页 ${row.effectiveScenarioWeights.standalone}`,
            )
            .join('；')}
        </p>
      </section>

      <section className={`${studioPanelClassName} p-5`}>
        <header className="flex flex-wrap items-baseline justify-between gap-3">
          <h3 className="text-base font-semibold text-slate-800">接管范围</h3>
          <p className="text-xs text-slate-500">
            以下页面共用同一套下发链路 —— 本面板的上线/权重/优先级/策略/外观一改，对这些页面同时生效。
          </p>
        </header>

        <div className="mt-4 grid gap-4 lg:grid-cols-3">
          {CAPTCHA_COVERAGE.map((group) => (
            <div key={group.scenario} className="rounded-2xl border border-slate-200 p-4">
              <p className="text-sm font-semibold text-slate-800">{group.label}</p>
              <p className="mt-1 text-xs leading-5 text-slate-500">{group.description}</p>
              <ul className="mt-3 space-y-1.5">
                {group.pages.map((page) => (
                  <li key={`${group.scenario}-${page.name}`} className="flex items-center justify-between gap-2 text-xs">
                    <span className="text-slate-700">{page.name}</span>
                    {page.path && (
                      <a
                        href={page.path}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-slate-500 hover:text-slate-800"
                      >
                        {page.path}
                        <FaExternalLinkAlt className="h-2.5 w-2.5" />
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <p className="mt-3 text-[11px] leading-5 text-slate-500">
          场景权重分别对应三个场景（默认 / 首访 / 独立页）；内容页与业务页共用「默认」那一列。
          三家供应商的校验都由后端统一入口分派，页面不再各自写死 Turnstile。
        </p>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className={`${studioPanelClassName} p-5`}>
          <h3 className="text-base font-semibold text-slate-800">当前分配策略</h3>
          <dl className="mt-3 space-y-2 text-sm text-slate-600">
            <div className="flex justify-between gap-3">
              <dt>默认策略</dt>
              <dd className="text-slate-800">{STRATEGY_TEXT[policy.strategy]}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>场景覆盖</dt>
              <dd className="text-slate-800">
                {Object.keys(policy.scenarioStrategies).length === 0
                  ? '无（三场景共用默认策略）'
                  : Object.entries(policy.scenarioStrategies)
                      .map(([scenario, strategy]) => `${scenario} → ${strategy}`)
                      .join('；')}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>轮换周期</dt>
              <dd className="text-slate-800">{policy.rotationSeconds}s</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>粘性窗口</dt>
              <dd className="text-slate-800">
                {policy.stickyEnabled ? `开启 · ${policy.stickyTtlMinutes} 分钟同一指纹固定同一家` : '关闭'}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>灰度</dt>
              <dd className="text-slate-800">
                {policy.rolloutPercent <= 0
                  ? '关闭（全量走策略）'
                  : `${policy.rolloutPercent}% 走策略，其余固定 ${policy.rolloutControlProvider}`}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>故障转移</dt>
              <dd className="text-slate-800">最多尝试 {policy.failoverMaxAttempts} 家</dd>
            </div>
          </dl>
        </section>

        <section className={`${studioPanelClassName} p-5`}>
          <h3 className="text-base font-semibold text-slate-800">统一控件外观</h3>
          <dl className="mt-3 space-y-2 text-sm text-slate-600">
            <div className="flex justify-between gap-3">
              <dt>主题</dt>
              <dd className="text-slate-800">{widgets.theme}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>尺寸</dt>
              <dd className="text-slate-800">{widgets.size}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>语言</dt>
              <dd className="text-slate-800">{widgets.language === 'auto' ? '跟随浏览器' : widgets.language}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>展示供应商署名</dt>
              <dd className="text-slate-800">{widgets.showProviderLabel ? '展示' : '隐藏'}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>逐家覆盖</dt>
              <dd className="text-slate-800">
                {Object.keys(widgets.perProvider).length === 0
                  ? '无（三家共用全局设置）'
                  : Object.entries(widgets.perProvider)
                      .map(([provider, override]) => `${provider}: ${Object.keys(override).length} 项`)
                      .join('；')}
              </dd>
            </div>
          </dl>
        </section>
      </div>

      <section className={`${studioPanelClassName} p-5`}>
        <header className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="flex items-center gap-2 text-base font-semibold text-slate-800">
            <FaChartLine className="h-4 w-4 text-slate-500" /> 近 {statsHours} 小时校验情况
          </h3>
          <div className="flex items-center gap-2">
            {HOUR_CHOICES.map((hours) => (
              <button
                key={hours}
                type="button"
                onClick={() => onStatsHoursChange(hours)}
                className={`rounded-full border px-3 py-1 text-xs ${
                  statsHours === hours ? 'border-slate-800 bg-slate-800 text-white' : 'border-slate-200 text-slate-600'
                }`}
              >
                {hours}h
              </button>
            ))}
          </div>
        </header>

        {loadingStats && <p className="mt-3 text-xs text-slate-500">统计加载中...</p>}

        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-xs">
            <thead className="text-slate-500">
              <tr className="border-b border-slate-200">
                <th className="py-2 pr-3 font-medium">供应商</th>
                <th className="py-2 pr-3 font-medium">成功</th>
                <th className="py-2 pr-3 font-medium">失败</th>
                <th className="py-2 pr-3 font-medium">合计</th>
                <th className="py-2 pr-3 font-medium">成功率</th>
                <th className="py-2 font-medium">最近一次</th>
              </tr>
            </thead>
            <tbody>
              {(stats?.providers ?? []).map((row) => (
                <tr key={row.provider} className="border-b border-slate-100 last:border-0">
                  <td className="py-2 pr-3 font-medium text-slate-800">{row.provider}</td>
                  <td className="py-2 pr-3 text-emerald-600">{row.success}</td>
                  <td className="py-2 pr-3 text-rose-600">{row.failure}</td>
                  <td className="py-2 pr-3">{row.total}</td>
                  <td className="py-2 pr-3">{row.successRate === null ? '—' : `${row.successRate}%`}</td>
                  <td className="py-2 text-slate-600">{row.lastSeenAt ? new Date(row.lastSeenAt).toLocaleString() : '—'}</td>
                </tr>
              ))}
              {rows.length > 0 && !stats && !loadingStats && (
                <tr>
                  <td colSpan={6} className="py-3 text-slate-500">
                    暂无统计（可能这段时间没有校验记录）。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-[11px] text-slate-500">
          统计口径：`shc_traces` 里按 `verificationMethod` 归集的校验结果，不含前端控件加载失败。
        </p>
      </section>
    </div>
  );
}
