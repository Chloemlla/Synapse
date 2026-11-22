import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  FiAlertCircle,
  FiCheckCircle,
  FiClock,
  FiExternalLink,
  FiInbox,
  FiStar,
  FiUsers,
} from 'react-icons/fi';
import { ticketApi, type ITicketSummary, type TicketStats } from '@/api/ticketApi';
import { ticketInsightsApi, type TicketInsightsResponse } from '@/api/ticketInsights';
import { InfoBadge, InfoMetricCard, InfoPanel, studioSecondaryButtonClassName } from '@/components/studioTheme';
import { StudioEmptyState, StudioErrorState, StudioLoadingState } from '@/components/studioFeedback';
import { useNotification } from '@/components/Notification';
import { useAuth } from '@/hooks/useAuth';
import { isSuperAdmin } from '@/utils/rbac';
import { cn } from '@/lib/utils';
import { getBackendErrorMessage } from '@/utils/backendError';
import { formatCount, formatRelativeTime } from './ip-risk-log/format';
import TicketStatsBar from '../ticket/TicketStatsBar';
import TicketFilters, {
  EMPTY_TICKET_FILTER,
  ticketQuickViewPatch,
  type TicketFilterValue,
} from '../ticket/TicketFilters';
import TicketListItem from '../ticket/TicketListItem';
import TicketBulkBar, { type TicketBulkPatch } from '../ticket/TicketBulkBar';
import {
  TICKET_PRIORITY_META,
  TICKET_STATUS_META,
  formatTicketAge,
  ticketServiceLabel,
} from '../ticket/ticketConstants';
import { DataPanel, FieldGrid, FieldRow, FilterSelect, Pager, RefreshButton, TableWrap, Td, Th } from './account-risk/ui';
import TicketAdminDetail from './ticket-admin/TicketDetail';

/**
 * 工单管理（`/admin/tickets`）——分诊工作台 + 质量与 SLA + 客服工作量。
 *
 * 为什么另开一页而不是把 `/support` 加个管理页签：`/support` 是属主视角的会话页，
 * 它的权限分支、滚动策略、消息编辑器都是为「用户看自己的工单」设计的。
 * 管理端真正需要的是「扫队列 → 批量分诊 → 回看 SLA 与满意度」，两者共用同一批
 * 展示组件（TicketFilters / TicketStatsBar / TicketListItem / TicketBulkBar），
 * 交互外壳不共用。
 *
 * 权限：读走 `admin` + 页面授权 `tickets`；批量写仍由服务端 `authenticateSuperAdmin` 收口，
 * 因此本页在普通管理员下会隐藏写按钮（点了必然是 403）。
 */
type TabKey = 'overview' | 'queue' | 'sla' | 'workload';

const TABS: ReadonlyArray<{ key: TabKey; label: string; hint: string }> = [
  { key: 'overview', label: '概览', hint: '分诊待办 / 今日吞吐 / 首响与满意度' },
  { key: 'queue', label: '工单队列', hint: '筛选 + 批量分诊 + 打开会话工作台' },
  { key: 'sla', label: '质量与 SLA', hint: '首响与解决分位、逾期 Top、低满意度 Top' },
  { key: 'workload', label: '客服工作量', hint: '按受理人聚合同步与满意度' },
];

const WINDOW_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 7, label: '最近 7 天' },
  { value: 30, label: '最近 30 天' },
  { value: 90, label: '最近 90 天' },
  { value: 180, label: '最近 180 天' },
];

const PAGE_SIZES: ReadonlyArray<{ value: number; label: string }> = [
  { value: 20, label: '每页 20' },
  { value: 50, label: '每页 50' },
  { value: 100, label: '每页 100' },
];

const hoursText = (value: number | null | undefined): string => {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value < 1) return `${Math.round(value * 60)} 分钟`;
  if (value < 48) return `${Math.round(value * 10) / 10} 小时`;
  return `${Math.round((value / 24) * 10) / 10} 天`;
};

const TicketAdminPanel: React.FC = () => {
  const { setNotification } = useNotification();
  // 写权限在页面内自行判定：路由表用 React.lazy 挂载组件、不传 props，
  // 所以「谁能写」必须从会话里读，而不是等父组件注入（否则超管也看不到批量按钮）。
  const { user } = useAuth();
  const canWrite = isSuperAdmin(user?.role);
  const [tab, setTab] = useState<TabKey>('overview');
  const [windowDays, setWindowDays] = useState(30);

  const [stats, setStats] = useState<TicketStats | null>(null);
  const [insights, setInsights] = useState<TicketInsightsResponse | null>(null);
  const [insightsLoading, setInsightsLoading] = useState(false);
  const [insightsError, setInsightsError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const insightsRequestRef = useRef(0);

  const loadStats = useCallback(async () => {
    try {
      setStats(await ticketApi.getStats());
      setLastUpdatedAt(Date.now());
    } catch (error) {
      setNotification({ message: getBackendErrorMessage(error, '读取工单统计失败'), type: 'error' });
    }
  }, [setNotification]);

  const loadInsights = useCallback(async () => {
    const requestId = ++insightsRequestRef.current;
    setInsightsLoading(true);
    try {
      const res = await ticketInsightsApi.insights(windowDays);
      if (requestId !== insightsRequestRef.current) return;
      setInsights(res);
      setInsightsError(null);
    } catch (error) {
      if (requestId !== insightsRequestRef.current) return;
      setInsightsError(getBackendErrorMessage(error, '读取工单质量聚合失败'));
    } finally {
      if (requestId === insightsRequestRef.current) setInsightsLoading(false);
    }
  }, [windowDays]);

  useEffect(() => {
    void loadStats();
    void loadInsights();
  }, [loadInsights, loadStats, refreshNonce]);

  const refreshAll = useCallback(() => setRefreshNonce((current) => current + 1), []);

  return (
    <section className="space-y-4">
      <InfoPanel compact>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <InfoBadge tone="sky">按上海时区切天</InfoBadge>
            <InfoBadge tone="slate">SLA {formatCount(stats?.slaHours ?? 24)} 小时</InfoBadge>
            {lastUpdatedAt ? <span>统计更新于 {formatRelativeTime(lastUpdatedAt)}</span> : null}
            {!canWrite ? <InfoBadge tone="amber">只读：批量分诊需要超管</InfoBadge> : null}
          </div>
          <div className="flex items-center gap-2">
            <FilterSelect
              value={String(windowDays)}
              onChange={(value) => setWindowDays(Number(value))}
              options={WINDOW_OPTIONS.map((item) => ({ value: String(item.value), label: item.label }))}
              title="聚合窗口"
            />
            <RefreshButton onClick={refreshAll} loading={insightsLoading} />
          </div>
        </div>
      </InfoPanel>

      <div className="flex flex-wrap gap-1.5 rounded-2xl border border-slate-200/80 bg-white/80 p-1.5">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            title={item.hint}
            onClick={() => setTab(item.key)}
            aria-pressed={tab === item.key}
            className={cn(
              'inline-flex min-h-11 items-center rounded-full px-3.5 py-2 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 sm:min-h-0',
              tab === item.key ? 'bg-slate-900 text-white shadow-sm' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700',
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'overview' ? <OverviewSection stats={stats} onJump={setTab} /> : null}
      {tab === 'queue' ? <QueueSection canWrite={canWrite} refreshNonce={refreshNonce} /> : null}
      {tab === 'sla' ? (
        <SlaSection insights={insights} loading={insightsLoading} error={insightsError} onRetry={() => void loadInsights()} />
      ) : null}
      {tab === 'workload' ? (
        <WorkloadSection insights={insights} loading={insightsLoading} error={insightsError} onRetry={() => void loadInsights()} />
      ) : null}
    </section>
  );
};

/** 概览：分诊结论 + 一键进入对应筛选。 */
const OverviewSection: React.FC<{ stats: TicketStats | null; onJump: (tab: TabKey) => void }> = ({ stats, onJump }) => {
  if (!stats) return <StudioLoadingState minHeightClassName="min-h-[220px]" text="正在读取工单统计…" />;
  const waiting = stats.awaitingReply ?? 0;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <InfoMetricCard
          label="待回复"
          value={formatCount(waiting)}
          detail={`其中逾期 ${formatCount(stats.slaBreached ?? 0)}；最久等待 ${hoursText(stats.oldestAwaitingHours)}`}
          icon={FiInbox}
          tone={stats.slaBreached > 0 ? 'rose' : 'sky'}
        />
        <InfoMetricCard
          label="我的待办"
          value={formatCount(stats.awaitingMine ?? 0)}
          detail={`我名下未结束 ${formatCount(stats.mineOpen ?? 0)} 张`}
          icon={FiUsers}
          tone="slate"
        />
        <InfoMetricCard
          label="今日吞吐"
          value={`${formatCount(stats.createdToday ?? 0)} / ${formatCount(stats.resolvedToday ?? 0)}`}
          detail="新建 / 解决；按上海时区零点切天"
          icon={FiCheckCircle}
          tone="emerald"
        />
        <InfoMetricCard
          label="满意度"
          value={stats.csatAverage !== null && stats.csatAverage !== undefined ? `${stats.csatAverage} 星` : '—'}
          detail={`共 ${formatCount(stats.csatCount ?? 0)} 条评价；低分见「质量与 SLA」`}
          icon={FiStar}
          tone={stats.csatAverage !== null && stats.csatAverage !== undefined && stats.csatAverage <= 3 ? 'amber' : 'slate'}
        />
      </div>

      <InfoPanel compact>
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-900">分诊快捷视图</h3>
          <button type="button" onClick={() => onJump('queue')} className="text-xs font-semibold text-slate-600 hover:text-slate-900">
            进入工单队列 →
          </button>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Link to="/support" className={cn(studioSecondaryButtonClassName, 'px-3 py-1.5 text-xs')}>
            <FiExternalLink className="mr-1 inline" />打开会话工作台
          </Link>
          <span className="text-xs text-slate-500">
            会话、内部备注、逐条事件与满意度详情在 `/support` 的管理视图中处理；本页负责队列筛选与批量分诊。
          </span>
        </div>
      </InfoPanel>

      <div className="grid gap-3 lg:grid-cols-2">
        <DataPanel>
          <h3 className="text-sm font-semibold text-slate-900">按状态</h3>
          <ul className="mt-2 space-y-1 text-xs">
            {Object.entries(stats.status ?? {}).map(([key, count]) => (
              <li key={key} className="flex items-center justify-between gap-2 rounded-2xl px-2 py-1">
                <span className="text-slate-600">{TICKET_STATUS_META[key]?.label ?? key}</span>
                <span className="tabular-nums font-semibold text-slate-900">{formatCount(count)}</span>
              </li>
            ))}
          </ul>
        </DataPanel>
        <DataPanel>
          <h3 className="text-sm font-semibold text-slate-900">按相关服务</h3>
          <ul className="mt-2 space-y-1 text-xs">
            {Object.entries(stats.service ?? {}).map(([key, count]) => (
              <li key={key} className="flex items-center justify-between gap-2 rounded-2xl px-2 py-1">
                <span className="text-slate-600">{ticketServiceLabel(key)}</span>
                <span className="tabular-nums font-semibold text-slate-900">{formatCount(count)}</span>
              </li>
            ))}
          </ul>
        </DataPanel>
      </div>
    </div>
  );
};

/** 队列：复用管理端筛选条 + 行组件 + 批量条，分页走服务端。 */
const QueueSection: React.FC<{ canWrite: boolean; refreshNonce: number }> = ({ canWrite, refreshNonce }) => {
  const { setNotification } = useNotification();
  const [filters, setFilters] = useState<TicketFilterValue>({ ...EMPTY_TICKET_FILTER });
  const [searchInput, setSearchInput] = useState('');
  const [activeView, setActiveView] = useState('all');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(50);
  const [rows, setRows] = useState<ITicketSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  /** 打开中的工单详情（内嵌视图，不跳页——跳转会丢掉队列筛选）。 */
  const [openTicketId, setOpenTicketId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [stats, setStats] = useState<TicketStats | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    try {
      const res = await ticketApi.getAllTickets({
        status: filters.status || undefined,
        priority: filters.priority || undefined,
        category: filters.category || undefined,
        type: filters.type || undefined,
        service: filters.service || undefined,
        assignee: filters.assignee || undefined,
        awaitingReply: filters.awaitingReply || undefined,
        unread: filters.unread || undefined,
        csat: filters.csat || undefined,
        q: filters.q || undefined,
        from: filters.from || undefined,
        to: filters.to || undefined,
        sort: filters.sort || undefined,
        page,
        limit,
      });
      if (requestId !== requestRef.current) return;
      setRows(res.tickets);
      setTotal(res.meta.total);
      setError(null);
    } catch (err) {
      if (requestId !== requestRef.current) return;
      setError(getBackendErrorMessage(err, '读取工单列表失败'));
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [filters, limit, page]);

  useEffect(() => {
    void load();
  }, [load, refreshNonce]);

  useEffect(() => {
    void ticketApi.getStats().then(setStats).catch(() => setStats(null));
  }, []);

  // 关键词搜索防抖：输入框与筛选值分离，避免每敲一个字查一次库。
  useEffect(() => {
    const timer: number = window.setTimeout(() => {
      setFilters((current) => (current.q === searchInput ? current : { ...current, q: searchInput }));
      setPage(1);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const applyQuickView = useCallback((view: string) => {
    setActiveView(view);
    setFilters((current) => ({ ...current, ...ticketQuickViewPatch(view) }));
    setPage(1);
  }, []);

  const handleBulk = useCallback(
    async (patch: TicketBulkPatch) => {
      if (!canWrite) {
        setNotification({ message: '批量分诊需要超级管理员权限。', type: 'error' });
        return;
      }
      if (checked.length === 0) return;
      setBulkBusy(true);
      try {
        const result = await ticketApi.bulkUpdate(checked, patch);
        setNotification({
          message: `已更新 ${result.updated} 张（命中 ${result.matched} 张）`,
          type: 'success',
        });
        setChecked([]);
        await load();
      } catch (err) {
        setNotification({ message: getBackendErrorMessage(err, '批量更新失败'), type: 'error' });
      } finally {
        setBulkBusy(false);
      }
    },
    [canWrite, checked, load, setNotification],
  );

  const exportCsv = useCallback(() => {
    // 导出走浏览器本地生成：数据已经在当前页内存里，不再向后端要一份（避免第二套导出契约）。
    const header = ['id', 'title', 'status', 'priority', 'category', 'assignee', 'csat', 'createdAt', 'updatedAt'];
    const escape = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const lines = rows.map((row) =>
      [row._id, row.title, row.status, row.priority, row.category, row.assigneeName ?? '', row.csatRating ?? '', row.createdAt, row.updatedAt]
        .map(escape)
        .join(','),
    );
    const blob = new Blob([`﻿${[header.join(','), ...lines].join('\n')}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `tickets-page-${page}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }, [page, rows]);

  const totalPages = Math.max(1, Math.ceil(total / Math.max(1, limit)));

  if (openTicketId) {
    return (
      <TicketAdminDetail
        ticketId={openTicketId}
        canWrite={canWrite}
        onBack={() => {
          setOpenTicketId(null);
          void load();
        }}
        onChanged={() => void load()}
      />
    );
  }

  return (
    <div className="space-y-4">
      <TicketStatsBar stats={stats} loading={loading && !stats} onQuickFilter={() => undefined} activeView={activeView} />

      <TicketFilters
        value={filters}
        searchInput={searchInput}
        onSearchChange={setSearchInput}
        onChange={(patch) => {
          setFilters((current) => ({ ...current, ...patch }));
          setPage(1);
        }}
        onReset={() => {
          setFilters({ ...EMPTY_TICKET_FILTER });
          setSearchInput('');
          setActiveView('all');
          setPage(1);
        }}
        onRefresh={() => void load()}
        onExport={exportCsv}
        loading={loading}
        total={total}
        shown={rows.length}
        activeView={activeView}
        onQuickView={applyQuickView}
      />

      {error ? <StudioErrorState message={error} onRetry={() => void load()} /> : null}

      {checked.length > 0 ? (
        <TicketBulkBar
          checkedCount={checked.length}
          totalShown={rows.length}
          busy={bulkBusy}
          onSelectAll={() => setChecked(rows.map((row) => row._id))}
          onClearSelection={() => setChecked([])}
          onExit={() => setChecked([])}
          onBulk={(patch) => void handleBulk(patch)}
        />
      ) : null}

      <InfoPanel compact>
        {rows.length === 0 && !loading ? (
          <StudioEmptyState
            message="没有符合当前筛选的工单。可清除筛选或切换快捷视图；新工单会在用户提交后出现在队列里。"
          />
        ) : (
          <ul className="space-y-2">
            {rows.map((ticket, index) => (
              <li key={ticket._id}>
                <TicketListItem
                  ticket={ticket}
                  selected={false}
                  isAdmin
                  bulkMode={canWrite}
                  checked={checked.includes(ticket._id)}
                  index={index}
                  onToggleCheck={(id) =>
                    setChecked((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]))
                  }
                  onOpen={() => setOpenTicketId(ticket._id)}
                />
              </li>
            ))}
          </ul>
        )}
        <Pager total={total} limit={limit} offset={(page - 1) * limit} loading={loading} onChange={(offset) => setPage(Math.floor(offset / limit) + 1)} />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
          <span>
            第 {page} / {totalPages} 页 · 共 {formatCount(total)} 张
          </span>
          <FilterSelect
            value={String(limit)}
            onChange={(value) => {
              setLimit(Number(value));
              setPage(1);
            }}
            options={PAGE_SIZES.map((item) => ({ value: String(item.value), label: item.label }))}
            title="每页条数"
          />
        </div>
      </InfoPanel>
    </div>
  );
};

const SlaSection: React.FC<{
  insights: TicketInsightsResponse | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}> = ({ insights, loading, error, onRetry }) => {
  if (error && !insights) return <StudioErrorState message={error} onRetry={onRetry} />;
  if (loading && !insights) return <StudioLoadingState minHeightClassName="min-h-[220px]" text="正在计算 SLA 与质量分位…" />;
  if (!insights) return null;

  const { sla, firstResponse, resolution, csat } = insights;
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <InfoMetricCard
          label="SLA 逾期"
          value={formatCount(sla.breached)}
          detail={`在评 ${formatCount(sla.evaluated)} 张 · 即将逾期 ${formatCount(sla.atRisk)}`}
          icon={FiAlertCircle}
          tone={sla.breached > 0 ? 'rose' : 'emerald'}
        />
        <InfoMetricCard
          label="首响 P50 / P95"
          value={`${hoursText(firstResponse.p50Hours)} / ${hoursText(firstResponse.p95Hours)}`}
          detail={`样本 ${formatCount(firstResponse.samples)} 张；分位取不到时显示 —`}
          icon={FiClock}
          tone="sky"
        />
        <InfoMetricCard
          label="解决 P50 / P95"
          value={`${hoursText(resolution.p50Hours)} / ${hoursText(resolution.p95Hours)}`}
          detail={`样本 ${formatCount(resolution.samples)} 张`}
          icon={FiCheckCircle}
          tone="emerald"
        />
        <InfoMetricCard
          label="满意度均分"
          value={csat.average !== null ? `${csat.average} 星` : '—'}
          detail={`${formatCount(csat.count)} 条评价 · 低分（≤2 星）${formatCount(csat.low)} 条`}
          icon={FiStar}
          tone={csat.average !== null && csat.average <= 3 ? 'amber' : 'slate'}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <DataPanel>
          <h3 className="text-sm font-semibold text-slate-900">满意度分布</h3>
          <ul className="mt-2 space-y-1.5">
            {['5', '4', '3', '2', '1'].map((star) => {
              const count = csat.distribution[star] ?? 0;
              const ratio = csat.count > 0 ? Math.round((count / csat.count) * 100) : 0;
              return (
                <li key={star} className="flex items-center gap-2 text-xs">
                  <span className="w-10 shrink-0 text-slate-600">{star} 星</span>
                  <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-slate-100">
                    <span
                      className={cn('block h-full rounded-full', Number(star) <= 2 ? 'bg-rose-500' : 'bg-emerald-500')}
                      style={{ width: `${Math.max(ratio, count > 0 ? 2 : 0)}%` }}
                    />
                  </span>
                  <span className="w-16 shrink-0 text-right tabular-nums text-slate-600">
                    {formatCount(count)} · {ratio}%
                  </span>
                </li>
              );
            })}
          </ul>
        </DataPanel>

        <DataPanel>
          <h3 className="text-sm font-semibold text-slate-900">按相关服务（窗口内）</h3>
          <ul className="mt-2 space-y-1 text-xs">
            {Object.entries(insights.volumeByService).map(([key, count]) => (
              <li key={key} className="flex items-center justify-between gap-2 rounded-2xl px-2 py-1">
                <span className="text-slate-600">{ticketServiceLabel(key)}</span>
                <span className="tabular-nums font-semibold text-slate-900">{formatCount(count)}</span>
              </li>
            ))}
          </ul>
        </DataPanel>
      </div>

      <DataPanel>
        <h3 className="text-sm font-semibold text-slate-900">逾期最久（Top 10）</h3>
        {insights.slaBreachTop.length === 0 ? (
          <StudioEmptyState className="mt-3 py-8" message="窗口内没有逾期工单。" />
        ) : (
          <TableWrap minWidth="min-w-[720px]">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
                <Th>工单</Th>
                <Th>状态 / 优先级</Th>
                <Th>受理人</Th>
                <Th>已等待</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {insights.slaBreachTop.map((row) => (
                <tr key={row.id}>
                  <Td><span className="block max-w-[320px] truncate text-slate-700" title={row.title}>{row.title || row.id}</span></Td>
                  <Td>
                    <span className="flex flex-wrap gap-1">
                      <InfoBadge tone="rose">{TICKET_STATUS_META[row.status]?.label ?? row.status}</InfoBadge>
                      <InfoBadge tone="slate">{TICKET_PRIORITY_META[row.priority]?.label ?? row.priority}</InfoBadge>
                    </span>
                  </Td>
                  <Td>{row.assigneeName ?? '未分配'}</Td>
                  <Td><span className="tabular-nums text-rose-700">{hoursText(row.waitingHours)}</span></Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </DataPanel>

      <DataPanel>
        <h3 className="text-sm font-semibold text-slate-900">低满意度（≤2 星，最近 10 条）</h3>
        {insights.lowCsatTop.length === 0 ? (
          <StudioEmptyState className="mt-3 py-8" message="还没有低分评价。" />
        ) : (
          <ul className="mt-3 space-y-2">
            {insights.lowCsatTop.map((row) => (
              <li key={row.id} className="rounded-2xl border border-slate-200 bg-white/80 px-3 py-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <InfoBadge tone="rose">{row.csatRating} 星</InfoBadge>
                  <span className="min-w-0 flex-1 truncate font-semibold text-slate-800" title={row.title}>{row.title || row.id}</span>
                  <span className="text-slate-400">{row.assigneeName ?? '未分配'}</span>
                  <span className="text-slate-400">{formatRelativeTime(row.resolvedAt)}</span>
                </div>
                {row.csatComment ? <p className="mt-1 text-slate-600">{row.csatComment}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </DataPanel>
    </div>
  );
};

const WorkloadSection: React.FC<{
  insights: TicketInsightsResponse | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}> = ({ insights, loading, error, onRetry }) => {
  if (error && !insights) return <StudioErrorState message={error} onRetry={onRetry} />;
  if (loading && !insights) return <StudioLoadingState minHeightClassName="min-h-[220px]" text="正在聚合成员工工作量…" />;
  if (!insights) return null;

  const rows = useMemo(
    () => [...insights.assignees].sort((a, b) => b.open - a.open || b.awaitingReply - a.awaitingReply),
    [insights.assignees],
  );

  return (
    <div className="space-y-4">
      <InfoPanel compact>
        <FieldGrid>
          <FieldRow label="统计窗口" value={`最近 ${insights.windowDays} 天`} />
          <FieldRow label="SLA 阈值" value={`${insights.sla.slaHours} 小时`} />
          <FieldRow label="受理人数" value={formatCount(rows.length)} hint="只统计名下至少有一张工单的账号" />
          <FieldRow label="口径" value="未结束 = 非 resolved/closed；待回复 = 未关闭且最后一条是用户发言" />
        </FieldGrid>
      </InfoPanel>

      <InfoPanel compact>
        {rows.length === 0 ? (
          <StudioEmptyState message="还没有工单被分配给任何人。在工单队列里批量「认领给我」后这里才会有数据。" />
        ) : (
          <TableWrap minWidth="min-w-[980px]">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
                <Th>受理人</Th>
                <Th>未结束</Th>
                <Th>待回复</Th>
                <Th>窗口内解决</Th>
                <Th>平均首响</Th>
                <Th>满意度</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => (
                <tr key={row.assigneeId} className="transition hover:bg-slate-50/80">
                  <Td>
                    <div className="flex flex-col gap-0.5">
                      <span className="font-semibold text-slate-800">{row.assigneeName ?? row.assigneeId}</span>
                      <span className="font-mono text-[11px] text-slate-400">{row.assigneeId}</span>
                    </div>
                  </Td>
                  <Td><span className="tabular-nums text-slate-700">{formatCount(row.open)}</span></Td>
                  <Td>
                    <InfoBadge tone={row.awaitingReply > 0 ? 'amber' : 'slate'} className="tabular-nums">
                      {formatCount(row.awaitingReply)}
                    </InfoBadge>
                  </Td>
                  <Td><span className="tabular-nums text-slate-700">{formatCount(row.resolvedInWindow)}</span></Td>
                  <Td><span className="tabular-nums text-slate-700">{hoursText(row.avgFirstResponseHours)}</span></Td>
                  <Td>
                    {row.csatAverage === null ? (
                      <span className="text-slate-400">无评价</span>
                    ) : (
                      <InfoBadge tone={row.csatAverage <= 3 ? 'amber' : 'emerald'}>
                        {row.csatAverage} 星 · {formatCount(row.csatCount)} 条
                      </InfoBadge>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </InfoPanel>

      <DataPanel>
        <p className="text-xs leading-5 text-slate-600">
          平均首响只算窗口内创建、且已有首响的工单；没有首响的工单不计入分母（否则「没人回」会被平均成「回得很快」）。
          满意度按窗口内创建且已评价的工单计算。
        </p>
      </DataPanel>
    </div>
  );
};

/** 供其它管理页复用的时间格式（避免各处再写一份 0 小时的兜底）。 */
export const formatTicketHours = hoursText;
export const ticketAgeLabel = formatTicketAge;

export default TicketAdminPanel;
