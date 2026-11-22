import React from 'react';
import {
  FaBolt,
  FaChartPie,
  FaExclamationTriangle,
  FaFingerprint,
  FaGlobe,
  FaNetworkWired,
  FaShieldAlt,
  FaUserShield,
} from 'react-icons/fa';
import type { AccountRiskOverviewResponse } from '@/api/accountRisk';
import { InfoBadge, InfoMetricCard, InfoPanel } from '@/components/studioTheme';
import { StudioEmptyState, StudioErrorState, StudioLoadingState } from '@/components/studioFeedback';
import { cn } from '@/lib/utils';
import { formatCount, formatRelativeTime } from '../ip-risk-log/format';
import { TIER_CONFIG, TIER_ORDER, eventTypeLabel, riskFlagLabel } from './format';
import type { AccountRiskQuickFilter } from './format';
import { DataPanel, JsonBlock } from './ui';

/**
 * 概览页签：先给结论，再给入口。
 *
 * 每张卡片都可点击并带着筛选跳到对应列表 —— 管理员看到「受限 3 个」时，
 * 下一步一定是「哪 3 个」，不该让他自己回列表页再筛一遍。
 */
const AccountRiskOverviewTab: React.FC<{
  overview: AccountRiskOverviewResponse | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onQuickFilter: (filter: AccountRiskQuickFilter) => void;
}> = ({ overview, loading, error, onRefresh, onQuickFilter }) => {
  if (error && !overview) {
    return <StudioErrorState message={error} onRetry={onRefresh} />;
  }
  if (loading && !overview) {
    return <StudioLoadingState minHeightClassName="min-h-[280px]" text="正在读取账户风险概览…" />;
  }
  if (!overview) {
    return <StudioEmptyState message="概览还没有数据。" action={<button type="button" onClick={onRefresh} className="text-sm font-semibold text-slate-700 underline">重新读取</button>} />;
  }

  const { accounts, events24h, ipFacts } = overview;
  const restrictedPlus = accounts.tiers.restricted + accounts.tiers.danger;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <button type="button" onClick={() => onQuickFilter({ tab: 'accounts', tier: 'watch' })} className="text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300">
          <InfoMetricCard
            label="观察档"
            value={formatCount(accounts.tiers.watch)}
            detail="有信号未处置；点卡片查看账户清单"
            icon={FaShieldAlt}
            tone="sky"
          />
        </button>
        <button type="button" onClick={() => onQuickFilter({ tab: 'accounts', tier: 'restricted' })} className="text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300">
          <InfoMetricCard
            label="受限档"
            value={formatCount(accounts.tiers.restricted)}
            detail="算力/转写/兑换/上传/LibreChat 冻结，工单仍开放"
            icon={FaExclamationTriangle}
            tone={accounts.tiers.restricted > 0 ? 'amber' : 'slate'}
          />
        </button>
        <button type="button" onClick={() => onQuickFilter({ tab: 'accounts', tier: 'danger' })} className="text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300">
          <InfoMetricCard
            label="危险档"
            value={formatCount(accounts.tiers.danger)}
            detail="连工单一起冻结；只能人工降档"
            icon={FaUserShield}
            tone={accounts.tiers.danger > 0 ? 'rose' : 'slate'}
          />
        </button>
        <button type="button" onClick={() => onQuickFilter({ tab: 'accounts', status: 'suspended' })} className="text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300">
          <InfoMetricCard
            label="已封停账户"
            value={formatCount(accounts.statuses.suspended)}
            detail={`账户总数 ${formatCount(accounts.total)} · 待逐步验证 ${formatCount(accounts.stepUpPending)}`}
            icon={FaBolt}
            tone={accounts.statuses.suspended > 0 ? 'rose' : 'slate'}
          />
        </button>
        <button type="button" onClick={() => onQuickFilter({ tab: 'signals' })} className="text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300">
          <InfoMetricCard
            label="24 小时信号"
            value={formatCount(events24h.total)}
            detail={`IDC ${formatCount(events24h.idcEgress)} · 属地跳变 ${formatCount(events24h.geoJump)} · 验证失败 ${formatCount(events24h.captchaFailed)}`}
            icon={FaNetworkWired}
            tone={events24h.total > 0 ? 'sky' : 'slate'}
          />
        </button>
        <button type="button" onClick={() => onQuickFilter({ tab: 'ip-facts', datacenter: 'true' })} className="text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300">
          <InfoMetricCard
            label="机房出口事实"
            value={formatCount(ipFacts.datacenter)}
            detail={`账户 × IP 事实共 ${formatCount(ipFacts.total)} 条；点卡片只看 IDC`}
            icon={FaGlobe}
            tone={ipFacts.datacenter > 0 ? 'amber' : 'slate'}
          />
        </button>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <InfoPanel>
          <div className="flex items-center gap-2">
            <FaChartPie className="text-slate-400" aria-hidden />
            <h3 className="text-sm font-semibold text-slate-900">风险档分布</h3>
            <span className="text-xs text-slate-400">合计 {formatCount(accounts.total)} 个账户</span>
          </div>
          <ul className="mt-3 space-y-2">
            {TIER_ORDER.map((tier) => {
              const count = accounts.tiers[tier] ?? 0;
              const ratio = accounts.total > 0 ? Math.round((count / accounts.total) * 100) : 0;
              const config = TIER_CONFIG[tier];
              return (
                <li key={tier}>
                  <button
                    type="button"
                    onClick={() => onQuickFilter({ tab: 'accounts', tier })}
                    className="flex w-full items-center gap-3 rounded-2xl px-2 py-1.5 text-left transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
                    title={config.hint}
                  >
                    <span className="w-20 shrink-0 text-xs font-semibold text-slate-700">{config.label}</span>
                    <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-100">
                      <span
                        className={cn('block h-full rounded-full', count > 0 ? config.dotClass : 'bg-slate-200')}
                        style={{ width: `${Math.max(ratio, count > 0 ? 2 : 0)}%` }}
                      />
                    </span>
                    <span className="w-16 shrink-0 text-right text-xs tabular-nums text-slate-600">
                      {formatCount(count)}
                      <span className="text-slate-400"> · {ratio}%</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {restrictedPlus === 0 && accounts.total > 0 ? (
            <p className="mt-2 text-xs text-slate-400">当前没有受限或危险档账户；冻结通道对所有人开放。</p>
          ) : null}
        </InfoPanel>

        <InfoPanel>
          <div className="flex items-center gap-2">
            <FaFingerprint className="text-slate-400" aria-hidden />
            <h3 className="text-sm font-semibold text-slate-900">Top 风险旗标</h3>
            <span className="text-xs text-slate-400">按命中账户数排序</span>
          </div>
          {overview.topFlags.length === 0 ? (
            <StudioEmptyState
              className="mt-3 py-8"
              message="还没有账户带风险旗标。旗标由 accountRisk 聚合任务写入（默认在登录成功路径上顺带聚合）。"
            />
          ) : (
            <ul className="mt-3 space-y-1.5">
              {overview.topFlags.map((row) => (
                <li key={row.flag}>
                  <button
                    type="button"
                    onClick={() => onQuickFilter({ tab: 'accounts', flag: row.flag })}
                    className="flex w-full items-center justify-between gap-3 rounded-2xl px-2 py-1.5 text-left transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
                    title={row.flag}
                  >
                    <span className="min-w-0 truncate text-xs text-slate-700">{riskFlagLabel(row.flag)}</span>
                    <span className="shrink-0 text-xs font-semibold tabular-nums text-slate-900">{formatCount(row.count)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </InfoPanel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <InfoPanel>
          <h3 className="text-sm font-semibold text-slate-900">24 小时信号构成</h3>
          <p className="mt-1 text-xs text-slate-500">
            信号来自 <code className="rounded bg-slate-100 px-1">security_events</code>；匿名来源（登录前人机验证失败）
            按半权重、总额封顶 {formatCount(10)} 分计入评分，单靠它到不了观察档。
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            {overview.signalsByType.length === 0 ? (
              <span className="text-xs text-slate-400">最近 24 小时没有新信号。</span>
            ) : (
              overview.signalsByType.map((row) => (
                <InfoBadge key={row.eventType} tone="sky">
                  {eventTypeLabel(row.eventType)}：{formatCount(row.count)}
                </InfoBadge>
              ))
            )}
          </div>
        </InfoPanel>

        <InfoPanel>
          <h3 className="text-sm font-semibold text-slate-900">索引自检</h3>
          <p className="mt-1 text-xs text-slate-500">账户风险列表按档位/分数排序；缺索引会让排序落到内存。</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {overview.indexes.missing.length === 0 ? (
              <InfoBadge tone="emerald">四个读路径索引齐全</InfoBadge>
            ) : (
              overview.indexes.missing.map((name) => (
                <InfoBadge key={name} tone="amber">
                  缺索引 {name}
                </InfoBadge>
              ))
            )}
          </div>
        </InfoPanel>
      </div>

      <DataPanel>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-900">最近处置</h3>
          <button
            type="button"
            onClick={() => onQuickFilter({ tab: 'actions' })}
            className="text-xs font-semibold text-slate-600 hover:text-slate-900"
          >
            查看全部处置记录 →
          </button>
        </div>
        {overview.recentActions.length === 0 ? (
          <StudioEmptyState
            className="mt-3 py-8"
            message="还没有风险处置记录。管理员在用户管理页执行封停 / 标记观察 / 设受限时会写入这里。"
          />
        ) : (
          <ul className="mt-3 space-y-2">
            {overview.recentActions.map((row) => (
              <li key={row.id} className="rounded-2xl border border-slate-200 bg-white/80 px-3 py-2">
                <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                  <InfoBadge tone="slate">{eventTypeLabel(row.eventType)}</InfoBadge>
                  <span className="font-semibold text-slate-800">{row.userId ?? '-'}</span>
                  <span className="text-slate-400">{formatRelativeTime(row.createdAt)}</span>
                </div>
                <div className="mt-1.5">
                  <JsonBlock className="max-h-32" value={row.eventData} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </DataPanel>
    </div>
  );
};

export default AccountRiskOverviewTab;
