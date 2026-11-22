import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  FaBroom,
  FaChartBar,
  FaComments,
  FaCogs,
  FaFileAlt,
  FaFolderOpen,
  FaShareAlt,
  FaSync,
} from 'react-icons/fa';
import {
  getGeoGebraAdminOverview,
  getGeoGebraAdminSettings,
  listGeoGebraAdminAssets,
  listGeoGebraAdminJobs,
  listGeoGebraAdminShares,
  runGeoGebraMaintenance,
  type GeoGebraAdminAssetRow,
  type GeoGebraAdminJobRow,
  type GeoGebraAdminOverview,
  type GeoGebraAdminSettings,
  type GeoGebraAdminShareRow,
} from '@/api/geogebraAdmin';
import {
  InfoBadge,
  InfoMetricCard,
  InfoPanel,
  InfoQueryHero,
  InfoQueryShell,
  studioDangerButtonClassName,
  studioSecondaryButtonClassName,
} from '@/components/studioTheme';
import { StudioEmptyState, StudioErrorNote, StudioErrorState, StudioLoadingState } from '@/components/studioFeedback';
import { useNotification } from '@/components/Notification';
import { useAuth } from '@/hooks/useAuth';
import { cn } from '@/lib/utils';
import { getBackendErrorMessage } from '@/utils/backendError';
import { formatCount, formatRelativeTime, formatTime } from './ip-risk-log/format';
import { DataPanel, FilterSelect, Pager, RefreshButton, TableState, TableWrap, Td, Th } from './account-risk/ui';
import { AUTO_REFRESH_OPTIONS } from './ip-risk-log/format';
import { formatBytes } from './rate-limits/format';
import GeoGebraAiConfigTab from './geogebra/AiConfigTab';

/**
 * GeoGebra 诊断与管理（`/admin/geogebra`）。
 *
 * 原来是一屏顺序渲染的概览；运维实际要按问题域分开看：任务队列卡在哪、分享被撤了没、
 * 资源什么时候过期、AI 配置到底从哪读的、版本保留上限是多少。所以拆成 7 个页签。
 *
 * 三条取舍：
 *   1. **只展示服务端真实能给出的数据**，延迟/体积分位没有数据源时按「无数据 + 原因」渲染，不编数字；
 *   2. 维护清理与 AI 配置写操作按角色隐藏（服务端仍要求超管 / 安全会话，前端只避免点了必然 403）；
 *   3. 新列表端点与概览同一档权限（admin + 页面授权 geogebra）。
 */

type TabKey = 'overview' | 'jobs' | 'shares' | 'assets' | 'ai' | 'retention' | 'maintenance';

const TABS: ReadonlyArray<{ key: TabKey; label: string; icon: React.ReactNode; hint: string }> = [
  { key: 'overview', label: '概览', icon: <FaChartBar />, hint: '项目 / 分享 / 资源 / 评论与服务状态' },
  { key: 'jobs', label: '任务队列', icon: <FaSync />, hint: 'GEO-22：worker 与队列，按状态/用户翻页' },
  { key: 'shares', label: '分享与嵌入', icon: <FaShareAlt />, hint: 'GEO-17：分享链接、撤销状态与 embed 地址' },
  { key: 'assets', label: '静态资源', icon: <FaFileAlt />, hint: 'AI 参考图与导出包的占用与到期' },
  { key: 'ai', label: 'AI 配置', icon: <FaCogs />, hint: 'env / 独立配置 / 复用 LibreChat 提供者' },
  { key: 'retention', label: '版本与保留', icon: <FaFolderOpen />, hint: 'GEO-11：版本保留上限与嵌入白名单口径' },
  { key: 'maintenance', label: '维护', icon: <FaBroom />, hint: '清理过期资源与任务（超管）' },
];

const AI_SOURCE_LABELS: Record<GeoGebraAdminOverview['ai']['source'], string> = {
  env: '环境变量',
  custom: '运行时独立配置',
  librechat: '复用 LibreChat 提供者',
};

const formatDuration = (seconds: number): string => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${seconds} 秒`;
};

const STATUS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '全部状态' },
  { value: 'queued', label: '排队中' },
  { value: 'running', label: '运行中' },
  { value: 'succeeded', label: '成功' },
  { value: 'failed', label: '失败' },
  { value: 'expired', label: '已过期' },
  { value: 'cancelled', label: '已取消' },
];

const SHARE_STATE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '全部分享' },
  { value: 'active', label: '生效中' },
  { value: 'revoked', label: '已撤销' },
];

const ASSET_PURPOSE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '全部用途' },
  { value: 'ai-reference', label: 'AI 参考图' },
  { value: 'export-bundle', label: '导出包' },
];

const PAGE_SIZES = [20, 50, 100, 200];

const GeoGebraAdminPanel: React.FC = () => {
  const { setNotification } = useNotification();
  const { user } = useAuth();
  const isSuperAdmin = String(user?.role ?? '') === 'superadmin';

  const [tab, setTab] = useState<TabKey>('overview');
  const [overview, setOverview] = useState<GeoGebraAdminOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshMs, setRefreshMs] = useState(0);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    setError('');
    try {
      const res = await getGeoGebraAdminOverview();
      if (requestId !== requestRef.current) return;
      setOverview(res);
    } catch (err) {
      if (requestId !== requestRef.current) return;
      setError(getBackendErrorMessage(err, '暂时无法读取 GeoGebra 运行概览。'));
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshNonce]);

  useEffect(() => {
    if (!refreshMs) return undefined;
    const timer: number = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      setRefreshNonce((current) => current + 1);
    }, refreshMs);
    return () => window.clearInterval(timer);
  }, [refreshMs]);

  return (
    <InfoQueryShell maxWidthClassName="max-w-7xl">
      <InfoQueryHero
        eyebrow="GeoGebra 工作台"
        title="GeoGebra 诊断与管理"
        description={[
          '工作台的项目、分享、资源与异步任务的运行概览，以及按问题域分开的运维视图：',
          '任务队列卡在哪、分享被撤了没、资源什么时候过期、AI 配置从哪读、版本保留上限是多少。',
          '只展示服务端真实能给出的数据；没有数据源的分位指标按「无数据 + 原因」渲染。',
        ].join('')}
        icon={FaChartBar}
        tone="sky"
        meta={
          <>
            {overview ? (
              <InfoBadge tone={overview.ai.configured ? 'emerald' : 'amber'}>
                {overview.ai.configured ? `AI 已配置 · ${AI_SOURCE_LABELS[overview.ai.source] ?? overview.ai.source}` : 'AI 未配置'}
              </InfoBadge>
            ) : null}
            {overview ? <InfoBadge tone="slate">队列 排队 {formatCount(overview.queue.queued)} / 运行 {formatCount(overview.queue.running)}</InfoBadge> : null}
            <InfoBadge tone="slate">读接口 admin + 页面授权</InfoBadge>
            {error ? <InfoBadge tone="rose">概览读取失败</InfoBadge> : null}
          </>
        }
        actions={
          <>
            <FilterSelect
              title="自动刷新间隔"
              value={refreshMs}
              options={AUTO_REFRESH_OPTIONS}
              onChange={(value) => setRefreshMs(Number(value))}
            />
            <button
              type="button"
              onClick={() => setRefreshNonce((current) => current + 1)}
              disabled={loading}
              className={cn(studioSecondaryButtonClassName, 'min-h-11 sm:min-h-0')}
            >
              <FaSync className={cn('mr-2 inline', loading && 'animate-spin')} />刷新
            </button>
          </>
        }
      />

      {error && !overview ? <StudioErrorState className="mt-6" message={error} onRetry={() => void load()} /> : null}
      {error && overview ? (
        <StudioErrorNote className="mt-6 flex flex-wrap items-center gap-3">
          <span className="min-w-0 flex-1">{error}</span>
          <button type="button" onClick={() => void load()} className={studioSecondaryButtonClassName}>
            重试
          </button>
        </StudioErrorNote>
      ) : null}
      {loading && !overview ? <StudioLoadingState className="mt-6" minHeightClassName="min-h-[220px]" text="正在读取运行概览…" /> : null}

      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <InfoMetricCard
          label="项目"
          value={overview ? formatCount(overview.counts.projects) : '—'}
          detail={overview ? `版本 ${formatCount(overview.counts.versions)}` : '等待概览'}
          icon={FaFolderOpen}
          tone="sky"
        />
        <InfoMetricCard
          label="分享"
          value={overview ? formatCount(overview.counts.shares) : '—'}
          detail={overview ? `生效中 ${formatCount(overview.counts.activeShares)}` : '等待概览'}
          icon={FaShareAlt}
          tone="slate"
        />
        <InfoMetricCard
          label="资源"
          value={overview ? formatCount(overview.counts.assets) : '—'}
          detail="到期由定时清理回收"
          icon={FaFileAlt}
          tone="slate"
        />
        <InfoMetricCard
          label="评论"
          value={overview ? formatCount(overview.counts.comments) : '—'}
          detail={overview ? `运行时长 ${formatDuration(overview.service.uptimeSeconds)}` : '等待概览'}
          icon={FaComments}
          tone="slate"
        />
      </div>

      <div className="mt-4 flex flex-wrap gap-1.5 rounded-2xl border border-slate-200/80 bg-white/80 p-1.5">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            title={item.hint}
            onClick={() => setTab(item.key)}
            aria-pressed={tab === item.key}
            className={cn(
              'inline-flex min-h-11 items-center gap-1.5 rounded-full px-3.5 py-2 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 sm:min-h-0',
              tab === item.key ? 'bg-slate-900 text-white shadow-sm' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700',
            )}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </div>

      <div className="mt-5">
        {tab === 'overview' ? <OverviewTab overview={overview} /> : null}
        {tab === 'jobs' ? <JobsTab refreshNonce={refreshNonce} /> : null}
        {tab === 'shares' ? <SharesTab refreshNonce={refreshNonce} /> : null}
        {tab === 'assets' ? <AssetsTab refreshNonce={refreshNonce} /> : null}
        {tab === 'ai' ? <GeoGebraAiConfigTab isSuperAdmin={isSuperAdmin} /> : null}
        {tab === 'retention' ? <RetentionTab refreshNonce={refreshNonce} /> : null}
        {tab === 'maintenance' ? (
          <MaintenanceTab
            isSuperAdmin={isSuperAdmin}
            onDone={() => {
              setRefreshNonce((current) => current + 1);
              setNotification({ message: '清理已完成。', type: 'success' });
            }}
          />
        ) : null}
      </div>
    </InfoQueryShell>
  );
};

const OverviewTab: React.FC<{ overview: GeoGebraAdminOverview | null }> = ({ overview }) => {
  if (!overview) return <StudioEmptyState message="概览还没有数据。" />;
  return (
    <div className="space-y-4">
      <InfoPanel compact>
        <h3 className="text-sm font-semibold text-slate-900">服务状态</h3>
        <dl className="mt-2 grid gap-2 text-[13px] text-slate-600 sm:grid-cols-2 lg:grid-cols-4">
          <div><dt className="text-xs text-slate-500">运行时长</dt><dd>{formatDuration(overview.service.uptimeSeconds)}</dd></div>
          <div><dt className="text-xs text-slate-500">Mongo</dt><dd>{overview.mongo.state}{overview.mongo.database ? ` · ${overview.mongo.database}` : ''}</dd></div>
          <div><dt className="text-xs text-slate-500">Node</dt><dd>{overview.service.nodeVersion}</dd></div>
          <div><dt className="text-xs text-slate-500">AI 配置来源</dt><dd>{AI_SOURCE_LABELS[overview.ai.source] ?? overview.ai.source}</dd></div>
          <div><dt className="text-xs text-slate-500">AI 图片能力</dt><dd>{overview.ai.configured ? (overview.ai.vision ? '已开启' : '未开启') : '未配置'}</dd></div>
        </dl>
        {!overview.ai.configured && overview.ai.reason ? <p className="mt-2 text-xs text-amber-700">{overview.ai.reason}</p> : null}
      </InfoPanel>

      {overview.worker && overview.queue ? (
        <InfoPanel compact>
          <h3 className="text-sm font-semibold text-slate-900">任务队列与处理进程</h3>
          <dl className="mt-2 grid gap-2 text-[13px] text-slate-600 sm:grid-cols-2 lg:grid-cols-4">
            <div><dt className="text-xs text-slate-500">调度方式</dt><dd>{overview.worker.scheduler}</dd></div>
            <div><dt className="text-xs text-slate-500">处理进程</dt><dd>{overview.worker.running ? '运行中' : '未启动'} · PID {overview.worker.pid}</dd></div>
            <div><dt className="text-xs text-slate-500">排队 / 运行中</dt><dd>{overview.queue.queued} / {overview.queue.running}</dd></div>
            <div><dt className="text-xs text-slate-500">单用户并发上限</dt><dd>{overview.queue.maxActiveJobsPerUser}</dd></div>
          </dl>
          <p className="mt-2 text-xs text-slate-500">{overview.queue.note}</p>
        </InfoPanel>
      ) : null}

      <InfoPanel compact>
        <h3 className="text-sm font-semibold text-slate-900">异步任务状态</h3>
        {Object.keys(overview.jobsByStatus).length === 0 ? (
          <StudioEmptyState className="mt-2 py-8" message="还没有任务记录。在工作台发起一次编辑导出后，任务状态会出现在这里。" />
        ) : (
          <div className="mt-2 flex flex-wrap gap-2">
            {Object.entries(overview.jobsByStatus).map(([status, count]) => (
              <InfoBadge key={status} tone="slate">{status}: {count}</InfoBadge>
            ))}
          </div>
        )}
      </InfoPanel>

      <InfoPanel compact>
        <h3 className="text-sm font-semibold text-slate-900">延迟与体积指标</h3>
        <StudioEmptyState className="mt-2 py-8" message={overview.metrics.unavailableReason} />
      </InfoPanel>
    </div>
  );
};

const JobsTab: React.FC<{ refreshNonce: number }> = ({ refreshNonce }) => {
  const [status, setStatus] = useState('');
  const [kind, setKind] = useState('');
  const [userId, setUserId] = useState('');
  const [limit, setLimit] = useState(20);
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<GeoGebraAdminJobRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listGeoGebraAdminJobs({ status, kind, userId, limit, offset });
      setRows(res.jobs);
      setTotal(res.total);
      setError(null);
    } catch (err) {
      setError(getBackendErrorMessage(err, '读取任务列表失败'));
    } finally {
      setLoading(false);
    }
  }, [kind, limit, offset, status, userId]);

  useEffect(() => {
    void load();
  }, [load, refreshNonce]);

  return (
    <div className="space-y-4">
      <InfoPanel compact>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={userId}
            onChange={(event) => {
              setUserId(event.target.value);
              setOffset(0);
            }}
            placeholder="按所有者用户 ID 过滤"
            aria-label="按所有者用户 ID 过滤"
            className="min-h-11 min-w-[220px] flex-1 rounded-2xl border border-slate-200 bg-white/80 px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none sm:min-h-0"
          />
          <FilterSelect value={status} onChange={(value) => { setStatus(value); setOffset(0); }} options={STATUS_OPTIONS} title="任务状态" />
          <input
            type="search"
            value={kind}
            onChange={(event) => {
              setKind(event.target.value);
              setOffset(0);
            }}
            placeholder="按 kind 过滤（如 export）"
            aria-label="按 kind 过滤"
            className="min-h-11 min-w-[180px] rounded-2xl border border-slate-200 bg-white/80 px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none sm:min-h-0"
          />
          <FilterSelect
            value={String(limit)}
            onChange={(value) => {
              setLimit(Number(value));
              setOffset(0);
            }}
            options={PAGE_SIZES.map((size) => ({ value: String(size), label: `每页 ${size}` }))}
            title="每页条数"
          />
          <RefreshButton onClick={() => void load()} loading={loading} />
        </div>
        <p className="mt-2 text-xs text-slate-500">共 {formatCount(total)} 个任务</p>
      </InfoPanel>

      <InfoPanel compact>
        <TableWrap minWidth="min-w-[900px]">
          <thead>
            <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
              <Th>任务</Th>
              <Th>所有者</Th>
              <Th>状态</Th>
              <Th>进度</Th>
              <Th>时间</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            <TableState
              loading={loading && rows.length === 0}
              error={error}
              empty={!loading && rows.length === 0}
              emptyText="没有符合筛选的任务。任务到期后会被标记过期并清理；可清除筛选或放宽用户条件。"
              colSpan={5}
              onRetry={() => void load()}
            />
            {rows.map((row) => (
              <tr key={row.jobId} className="align-top transition hover:bg-slate-50/80">
                <Td>
                  <div className="flex flex-col gap-0.5">
                    <span className="font-mono text-[11px] text-slate-700">{row.jobId}</span>
                    <span className="text-[10px] text-slate-400">{row.kind} · 尝试 {row.attempts} 次</span>
                  </div>
                </Td>
                <Td><span className="font-mono text-[11px] text-slate-600">{row.owner}</span></Td>
                <Td>
                  <InfoBadge tone={row.status === 'failed' ? 'rose' : row.status === 'running' ? 'sky' : 'slate'}>{row.status}</InfoBadge>
                  {row.errorCode ? <span className="mt-1 block text-[10px] text-rose-700">{row.errorCode}</span> : null}
                </Td>
                <Td><span className="tabular-nums text-slate-700">{row.progress}%</span></Td>
                <Td>
                  <div className="flex flex-col gap-0.5 text-[11px] text-slate-500">
                    <span>{formatTime(row.createdAt)}</span>
                    <span>{formatRelativeTime(row.updatedAt)}</span>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
        <Pager total={total} limit={limit} offset={offset} loading={loading} onChange={setOffset} />
      </InfoPanel>
    </div>
  );
};

const SharesTab: React.FC<{ refreshNonce: number }> = ({ refreshNonce }) => {
  const [state, setState] = useState('');
  const [userId, setUserId] = useState('');
  const [limit, setLimit] = useState(20);
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<GeoGebraAdminShareRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listGeoGebraAdminShares({ state, userId, limit, offset });
      setRows(res.shares);
      setTotal(res.total);
      setError(null);
    } catch (err) {
      setError(getBackendErrorMessage(err, '读取分享列表失败'));
    } finally {
      setLoading(false);
    }
  }, [limit, offset, state, userId]);

  useEffect(() => {
    void load();
  }, [load, refreshNonce]);

  return (
    <div className="space-y-4">
      <InfoPanel compact>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={userId}
            onChange={(event) => {
              setUserId(event.target.value);
              setOffset(0);
            }}
            placeholder="按所有者用户 ID 过滤"
            aria-label="按所有者用户 ID 过滤"
            className="min-h-11 min-w-[220px] flex-1 rounded-2xl border border-slate-200 bg-white/80 px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none sm:min-h-0"
          />
          <FilterSelect value={state} onChange={(value) => { setState(value); setOffset(0); }} options={SHARE_STATE_OPTIONS} title="分享状态" />
          <FilterSelect
            value={String(limit)}
            onChange={(value) => {
              setLimit(Number(value));
              setOffset(0);
            }}
            options={PAGE_SIZES.map((size) => ({ value: String(size), label: `每页 ${size}` }))}
            title="每页条数"
          />
          <RefreshButton onClick={() => void load()} loading={loading} />
        </div>
        <p className="mt-2 text-xs text-slate-500">共 {formatCount(total)} 条分享 · embed 路径只在生效分享上给出</p>
      </InfoPanel>

      <InfoPanel compact>
        <TableWrap minWidth="min-w-[980px]">
          <thead>
            <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
              <Th>标题 / slug</Th>
              <Th>所有者</Th>
              <Th>画布 / 指令数</Th>
              <Th>状态</Th>
              <Th>嵌入</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            <TableState
              loading={loading && rows.length === 0}
              error={error}
              empty={!loading && rows.length === 0}
              emptyText="没有符合筛选的分享。分享在工作台里发布后才会出现。"
              colSpan={5}
              onRetry={() => void load()}
            />
            {rows.map((row) => (
              <tr key={row.shareId} className="align-top transition hover:bg-slate-50/80">
                <Td>
                  <div className="flex flex-col gap-0.5">
                    <span className="max-w-[260px] truncate font-semibold text-slate-800" title={row.title}>{row.title || row.shareId}</span>
                    <span className="font-mono text-[11px] text-slate-400">{row.slug}</span>
                  </div>
                </Td>
                <Td><span className="font-mono text-[11px] text-slate-600">{row.owner}</span></Td>
                <Td>
                  <div className="flex flex-col gap-0.5 text-[11px] text-slate-600">
                    <span>{row.canvasMode}</span>
                    <span className="text-slate-400">{formatCount(row.commandCount)} 条指令 · {row.allowFork ? '允许 fork' : '禁止 fork'}</span>
                  </div>
                </Td>
                <Td>
                  <InfoBadge tone={row.revoked ? 'rose' : 'emerald'}>{row.revoked ? '已撤销' : '生效中'}</InfoBadge>
                  {row.revokedAt ? <span className="mt-1 block text-[10px] text-slate-400">{formatTime(row.revokedAt)}</span> : null}
                </Td>
                <Td>
                  {row.embedPath ? (
                    <span className="break-all font-mono text-[10px] text-slate-500">{row.embedPath}</span>
                  ) : (
                    <span className="text-slate-400">已撤销，无嵌入地址</span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
        <Pager total={total} limit={limit} offset={offset} loading={loading} onChange={setOffset} />
      </InfoPanel>
    </div>
  );
};

const AssetsTab: React.FC<{ refreshNonce: number }> = ({ refreshNonce }) => {
  const [purpose, setPurpose] = useState('');
  const [limit, setLimit] = useState(20);
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<GeoGebraAdminAssetRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listGeoGebraAdminAssets({ purpose, limit, offset });
      setRows(res.assets);
      setTotal(res.total);
      setError(null);
    } catch (err) {
      setError(getBackendErrorMessage(err, '读取资源列表失败'));
    } finally {
      setLoading(false);
    }
  }, [limit, offset, purpose]);

  useEffect(() => {
    void load();
  }, [load, refreshNonce]);

  const totalBytes = rows.reduce((sum, row) => sum + row.byteSize, 0);

  return (
    <div className="space-y-4">
      <InfoPanel compact>
        <div className="flex flex-wrap items-center gap-2">
          <FilterSelect value={purpose} onChange={(value) => { setPurpose(value); setOffset(0); }} options={ASSET_PURPOSE_OPTIONS} title="资源用途" />
          <FilterSelect
            value={String(limit)}
            onChange={(value) => {
              setLimit(Number(value));
              setOffset(0);
            }}
            options={PAGE_SIZES.map((size) => ({ value: String(size), label: `每页 ${size}` }))}
            title="每页条数"
          />
          <RefreshButton onClick={() => void load()} loading={loading} />
        </div>
        <p className="mt-2 text-xs text-slate-500">
          共 {formatCount(total)} 个资源；本页合计 {formatBytes(totalBytes)}（只统计当前页）
        </p>
      </InfoPanel>

      <InfoPanel compact>
        <TableWrap minWidth="min-w-[880px]">
          <thead>
            <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
              <Th>资源</Th>
              <Th>所有者</Th>
              <Th>类型</Th>
              <Th>大小</Th>
              <Th>到期</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            <TableState
              loading={loading && rows.length === 0}
              error={error}
              empty={!loading && rows.length === 0}
              emptyText="没有符合筛选的资源。AI 参考图与导出包只保留到各自有效期。"
              colSpan={5}
              onRetry={() => void load()}
            />
            {rows.map((row) => (
              <tr key={row.assetId} className="align-top transition hover:bg-slate-50/80">
                <Td><span className="font-mono text-[11px] text-slate-700">{row.assetId}</span></Td>
                <Td><span className="font-mono text-[11px] text-slate-600">{row.owner}</span></Td>
                <Td>
                  <InfoBadge tone={row.purpose === 'ai-reference' ? 'sky' : 'slate'}>{row.purpose}</InfoBadge>
                  <span className="mt-1 block text-[10px] text-slate-400">{row.mimeType}</span>
                </Td>
                <Td><span className="tabular-nums text-slate-700">{formatBytes(row.byteSize)}</span></Td>
                <Td>
                  {row.expired ? (
                    <InfoBadge tone="amber">已到期</InfoBadge>
                  ) : (
                    <span className="text-[11px] text-slate-600">{formatTime(row.expiresAt)}</span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
        <Pager total={total} limit={limit} offset={offset} loading={loading} onChange={setOffset} />
      </InfoPanel>
    </div>
  );
};

const RetentionTab: React.FC<{ refreshNonce: number }> = ({ refreshNonce }) => {
  const [settings, setSettings] = useState<GeoGebraAdminSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setSettings(await getGeoGebraAdminSettings());
      setError(null);
    } catch (err) {
      setError(getBackendErrorMessage(err, '读取运行口径失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshNonce]);

  if (error && !settings) return <StudioErrorState message={error} onRetry={() => void load()} />;
  if (loading && !settings) return <StudioLoadingState minHeightClassName="min-h-[180px]" text="正在读取运行口径…" />;
  if (!settings) return null;

  return (
    <div className="space-y-4">
      <DataPanel>
        <h3 className="text-sm font-semibold text-slate-900">云端版本保留（GEO-11）</h3>
        <dl className="mt-2 grid gap-2 text-[13px] text-slate-600 sm:grid-cols-2">
          <div><dt className="text-xs text-slate-500">每个项目保留版本数</dt><dd className="tabular-nums font-semibold text-slate-900">{settings.versionRetentionLimit}</dd></div>
          <div><dt className="text-xs text-slate-500">env</dt><dd className="font-mono text-[11px]">{settings.versionRetentionEnv}</dd></div>
        </dl>
        <p className="mt-2 text-xs leading-5 text-slate-500">{settings.versionRetentionNote}</p>
      </DataPanel>

      <DataPanel>
        <h3 className="text-sm font-semibold text-slate-900">嵌入来源白名单（GEO-17）</h3>
        <dl className="mt-2 grid gap-2 text-[13px] text-slate-600 sm:grid-cols-2">
          <div><dt className="text-xs text-slate-500">生效值</dt><dd className="break-all font-mono text-[11px]">{settings.embedFrameAncestors || '（空 = 关闭嵌入）'}</dd></div>
          <div><dt className="text-xs text-slate-500">env</dt><dd className="font-mono text-[11px]">{settings.embedFrameAncestorsEnv}</dd></div>
        </dl>
        <p className="mt-2 text-xs leading-5 text-slate-500">{settings.embedFrameAncestorsNote}</p>
      </DataPanel>
    </div>
  );
};

const MaintenanceTab: React.FC<{ isSuperAdmin: boolean; onDone: () => void }> = ({ isSuperAdmin, onDone }) => {
  const { setNotification } = useNotification();
  const [maintaining, setMaintaining] = useState(false);

  const handleMaintenance = async () => {
    setMaintaining(true);
    try {
      const result = await runGeoGebraMaintenance();
      setNotification({ type: 'success', message: `已清理 ${result.removedAssets} 个过期资源，标记 ${result.expiredJobs} 个过期任务。` });
      onDone();
    } catch (err) {
      setNotification({ type: 'error', message: getBackendErrorMessage(err, '清理未完成，请稍后重试。') });
    } finally {
      setMaintaining(false);
    }
  };

  return (
    <div className="space-y-4">
      <InfoPanel compact>
        <h3 className="text-sm font-semibold text-slate-900">清理过期资源与任务</h3>
        <p className="mt-1 text-xs leading-5 text-slate-500">
          定时清理轮（每 5 分钟）已覆盖同一套逻辑；这里的按钮用于「立刻回收一次」。
          服务端要求超级管理员，未授权时本页隐藏入口。
        </p>
        {isSuperAdmin ? (
          <button
            type="button"
            onClick={() => void handleMaintenance()}
            disabled={maintaining}
            className={cn(studioDangerButtonClassName, 'mt-3 min-h-11 sm:min-h-0')}
          >
            <FaBroom className="mr-2 inline" />{maintaining ? '清理中…' : '清理过期资源'}
          </button>
        ) : (
          <p className="mt-2 text-xs text-amber-700">当前账号不是超级管理员，清理入口已隐藏（服务端仍会拒绝）。</p>
        )}
      </InfoPanel>
    </div>
  );
};

export default GeoGebraAdminPanel;
