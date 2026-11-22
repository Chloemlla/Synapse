import React from 'react';
import {
  FaBolt,
  FaDatabase,
  FaExclamationTriangle,
  FaTachometerAlt,
  FaServer,
  FaUserClock,
} from 'react-icons/fa';
import type { RateLimitsOverviewResponse } from '@/api/rateLimits';
import { InfoBadge, InfoMetricCard, InfoPanel } from '@/components/studioTheme';
import { StudioEmptyState, StudioErrorState, StudioLoadingState } from '@/components/studioFeedback';
import { formatCount, formatRelativeTime } from '../ip-risk-log/format';
import { formatBytes, quotaResourceLabel } from './format';
import { DataPanel, FieldGrid, FieldRow, UtilizationBar } from './ui';

/**
 * 概览页签：一句话回答「现在系统被什么顶着」。
 *
 * 四类数据并排：在途并发（进程内）、配额事件（24h，Mongo）、TTS 队列占用、闸门生效值。
 * 缺数据的部分显式给原因（例如 Redis 未配置、Mongo 未连接、队列未注册），不渲染成 0。
 */
const RateLimitsOverviewTab: React.FC<{
  overview: RateLimitsOverviewResponse | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  onOpenTab: (tab: string) => void;
}> = ({ overview, loading, error, onRefresh, onOpenTab }) => {
  if (error && !overview) return <StudioErrorState message={error} onRetry={onRefresh} />;
  if (loading && !overview) {
    return <StudioLoadingState minHeightClassName="min-h-[280px]" text="正在读取限流与配额概览…" />;
  }
  if (!overview) return <StudioEmptyState message="概览还没有数据。" action={<button type="button" onClick={onRefresh} className="text-sm font-semibold text-slate-700 underline">重新读取</button>} />;

  // 用 `in` 直接收窄：抽成布尔变量后 TS 不再跟着收窄（两个成员没有共同属性）。
  const quota = 'unavailableReason' in overview.quota ? null : overview.quota;
  const topGuards = [...overview.burst.guards].sort((a, b) => b.active - a.active).slice(0, 5);
  const overCapGuards = overview.burst.guards.filter((guard) => guard.active > guard.maxConcurrent);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <InfoMetricCard
          label="在途并发"
          value={formatCount(overview.burst.totalActive)}
          detail={`${overview.burst.guards.length} 个并发守卫；超顶 ${overCapGuards.length} 个`}
          icon={FaBolt}
          tone={overCapGuards.length > 0 ? 'rose' : 'sky'}
        />
        <InfoMetricCard
          label="配额事件（24h）"
          value={quota ? formatCount(quota.total24h) : '—'}
          detail={quota ? `预警 ${formatCount(quota.warning24h)} · 用尽 ${formatCount(quota.exhausted24h)} · 上游 ${formatCount(quota.upstream24h)}` : (overview.quota as { unavailableReason: string }).unavailableReason}
          icon={FaTachometerAlt}
          tone={quota && quota.total24h > 0 ? 'amber' : 'slate'}
        />
        <InfoMetricCard
          label="TTS 队列占用"
          value={overview.tts.available && overview.tts.global ? `${overview.tts.global.concurrency} 并发` : '—'}
          detail={
            overview.tts.available && overview.tts.global
              ? `每用户上限 ${formatCount(overview.tts.global.perUserMaxActive)} · ${overview.tts.global.processing ? '正在处理' : '空闲'}`
              : (overview.tts.reason ?? '队列不可用')
          }
          icon={FaTachometerAlt}
          tone={overview.tts.topOwners.length > 0 ? 'sky' : 'slate'}
        />
        <InfoMetricCard
          label="限流存储"
          value={overview.storage.backend === 'redis' ? 'Redis 共享档' : '进程内存档'}
          detail={overview.storage.redisConfigured ? 'REDIS_URL 已配置；多实例一致' : '未配置 REDIS_URL；实例之间额度独立'}
          icon={FaDatabase}
          tone={overview.storage.backend === 'redis' ? 'emerald' : 'amber'}
        />
      </div>

      {overCapGuards.length > 0 ? (
        <InfoPanel compact className="border-rose-200 bg-rose-50/60">
          <div className="flex items-start gap-2 text-xs leading-5 text-rose-700">
            <FaExclamationTriangle className="mt-0.5 shrink-0" aria-hidden />
            <span>
              有 {overCapGuards.length} 个并发守卫超过上限：{overCapGuards.map((guard) => guard.name).join('、')}。
              超顶请求会被立即 429（不排队）——如果持续超顶，说明有客户端在并发刷，或上限配得过低。
            </span>
          </div>
        </InfoPanel>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <InfoPanel compact>
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-900">在途并发 Top</h3>
            <button type="button" onClick={() => onOpenTab('burst')} className="text-xs font-semibold text-slate-600 hover:text-slate-900">
              查看全部 →
            </button>
          </div>
          {topGuards.length === 0 ? (
            <StudioEmptyState className="mt-3 py-8" message="当前没有任何在途请求。并发守卫只在有请求时才有计数。" />
          ) : (
            <ul className="mt-3 space-y-2">
              {topGuards.map((guard) => (
                <li key={guard.name} className="rounded-2xl border border-slate-200 bg-white/80 px-3 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <span className="min-w-0 truncate font-mono text-slate-700">{guard.name}</span>
                    <span className="text-slate-400">{guard.keys} 个键</span>
                  </div>
                  <UtilizationBar className="mt-1.5" active={guard.active} max={guard.maxConcurrent} />
                </li>
              ))}
            </ul>
          )}
        </InfoPanel>

        <InfoPanel compact>
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-900">配额事件按资源（24h）</h3>
            <button type="button" onClick={() => onOpenTab('quota-events')} className="text-xs font-semibold text-slate-600 hover:text-slate-900">
              明细 →
            </button>
          </div>
          {!quota ? (
            <StudioEmptyState className="mt-3 py-8" message={(overview.quota as { unavailableReason: string }).unavailableReason} />
          ) : quota.byResource.length === 0 ? (
            <StudioEmptyState
              className="mt-3 py-8"
              message="最近 24 小时没有配额事件。账户预算默认处于观察期（API_KEY_ACCOUNT_BUDGET_MODE=off），不会产生事件。"
            />
          ) : (
            <ul className="mt-3 space-y-1.5">
              {quota.byResource.map((row) => (
                <li key={row.resource} className="flex items-center justify-between gap-2 rounded-2xl px-2 py-1.5 text-xs">
                  <span className="min-w-0 truncate text-slate-700">{quotaResourceLabel(row.resource)}</span>
                  <span className="shrink-0 font-semibold tabular-nums text-slate-900">{formatCount(row.count)}</span>
                </li>
              ))}
            </ul>
          )}
        </InfoPanel>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <DataPanel>
          <h3 className="text-sm font-semibold text-slate-900">资源闸门生效值</h3>
          <FieldGrid className="mt-2">
            <FieldRow label="单文件上限" value={formatBytes(overview.limits.mediaSandbox.maxFileBytes)} />
            <FieldRow label="单任务文件数" value={formatCount(overview.limits.mediaSandbox.maxFilesPerJob)} />
            <FieldRow label="用户目录总量" value={formatBytes(overview.limits.mediaSandbox.maxUserDirBytes)} />
            <FieldRow label="用户目录文件数" value={formatCount(overview.limits.mediaSandbox.maxUserDirFiles)} />
            <FieldRow label="doc-tool 上传上限" value={formatBytes(Number(overview.limits.docTool.maxUploadBytes ?? 0))} />
            <FieldRow label="doc-tool 活动任务" value={formatCount(Number(overview.limits.docTool.maxActiveJobs ?? 0))} />
            <FieldRow label="看门狗模式" value={overview.limits.watchdogMode} hint="observe 只告警；enforce 会杀超限的子进程树" />
            <FieldRow label="生成时间" value={formatRelativeTime(overview.generatedAt)} />
          </FieldGrid>
          <button type="button" onClick={() => onOpenTab('resources')} className="mt-2 text-xs font-semibold text-slate-600 hover:text-slate-900">
            查看 env 名与默认值 →
          </button>
        </DataPanel>

        <InfoPanel compact>
          <div className="flex items-center gap-2">
            <FaUserClock className="text-slate-400" aria-hidden />
            <h3 className="text-sm font-semibold text-slate-900">TTS 占用 Top</h3>
          </div>
          {overview.tts.topOwners.length === 0 ? (
            <StudioEmptyState className="mt-3 py-8" message={overview.tts.available ? '当前没有排队或运行中的 TTS 任务。' : (overview.tts.reason ?? '队列不可用')} />
          ) : (
            <ul className="mt-3 space-y-1.5">
              {overview.tts.topOwners.map((owner) => (
                <li key={owner.userId} className="flex items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-white/80 px-2.5 py-1.5 text-[11px]">
                  <span className="min-w-0 truncate font-mono text-slate-600">{owner.userId}</span>
                  <InfoBadge tone={overview.tts.perUserMaxActive && owner.active >= overview.tts.perUserMaxActive ? 'rose' : 'slate'}>
                    {owner.active} 个活跃
                  </InfoBadge>
                </li>
              ))}
            </ul>
          )}
        </InfoPanel>
      </div>

      <InfoPanel compact>
        <div className="flex items-start gap-2 text-xs leading-5 text-slate-500">
          <FaServer className="mt-0.5 shrink-0 text-slate-400" aria-hidden />
          <span>
            阈值不在本页修改：并发上限（<code className="rounded bg-slate-100 px-1">BURST_*</code>）、
            每用户活跃任务（<code className="rounded bg-slate-100 px-1">TTS_PER_USER_MAX_ACTIVE</code>）、
            账户预算（<code className="rounded bg-slate-100 px-1">API_KEY_ACCOUNT_BUDGET_*</code>）、
            沙箱与看门狗（<code className="rounded bg-slate-100 px-1">MEDIA_TOOL_*</code> / <code className="rounded bg-slate-100 px-1">PROCESS_WATCHDOG_*</code>）
            都在「运行时配置」页，写入需要超管 + 安全会话并留审计。
          </span>
        </div>
      </InfoPanel>
    </div>
  );
};

export default RateLimitsOverviewTab;
