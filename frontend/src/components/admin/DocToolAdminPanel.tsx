import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  FaBroom,
  FaCheckCircle,
  FaCogs,
  FaExclamationTriangle,
  FaFileAlt,
  FaFolderOpen,
  FaListUl,
  FaSync,
} from 'react-icons/fa';
import {
  docToolAdminApi,
  type DocToolAdminJobRow,
  type DocToolAdminOverview,
  type DocToolStorageRow,
} from '@/api/docToolAdmin';
import {
  InfoBadge,
  InfoMetricCard,
  InfoPanel,
  InfoQueryHero,
  InfoQueryShell,
  studioDangerButtonClassName,
  studioPrimaryButtonClassName,
  studioSecondaryButtonClassName,
} from '@/components/studioTheme';
import { StudioEmptyState, StudioErrorState, StudioLoadingState } from '@/components/studioFeedback';
import { useNotification } from '@/components/Notification';
import EstablishSecuritySession from '@/components/EstablishSecuritySession';
import { cn } from '@/lib/utils';
import { getBackendErrorMessage } from '@/utils/backendError';
import { formatCount, formatRelativeTime, formatTime } from './ip-risk-log/format';
import { FilterSelect, Pager, RefreshButton, TableState, TableWrap, Td, Th } from './account-risk/ui';
import { Collapsible } from './account-risk/ui';
import { formatBytes } from './rate-limits/format';

/**
 * 文档转换运维（`/admin/doc-tool`）。
 *
 * doc-tool 是「用户上传 Markdown → 服务端 pandoc 串行转换 → 产物落本地盘」，
 * 但用户页只看得到自己的任务。运维要回答的是：引擎可用吗、队列积压多少、
 * 磁盘被谁占了、清理能回收多少。本页只回元数据，**没有任何下载用户文件的入口**。
 *
 * 权限：`admin` + 页面授权 `doc-tool`（默认只有超管）；真实清理额外要求安全会话
 * （未建立会话时只展示 EstablishSecuritySession，不发请求）。
 */

type TabKey = 'overview' | 'jobs' | 'files' | 'limits' | 'cleanup';

const TABS: ReadonlyArray<{ key: TabKey; label: string; icon: React.ReactNode; hint: string }> = [
  { key: 'overview', label: '概览', icon: <FaCheckCircle />, hint: '引擎 / 队列 / 保留期' },
  { key: 'jobs', label: '任务', icon: <FaListUl />, hint: '跨用户任务列表与逐文件结果' },
  { key: 'files', label: '目录占用', icon: <FaFolderOpen />, hint: '按用户统计 inbox / out 占用' },
  { key: 'limits', label: '限额', icon: <FaCogs />, hint: 'env 名与生效值' },
  { key: 'cleanup', label: '清理', icon: <FaBroom />, hint: '先预演，再执行（需要安全会话）' },
];

const STATUS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '全部状态' },
  { value: 'queued', label: '排队中' },
  { value: 'running', label: '运行中' },
  { value: 'succeeded', label: '成功' },
  { value: 'partial', label: '部分成功' },
  { value: 'failed', label: '失败' },
  { value: 'cancelled', label: '已取消' },
];

const PAGE_SIZES = [20, 50, 100, 200];

const DocToolAdminPanel: React.FC = () => {
  const { setNotification } = useNotification();
  const [tab, setTab] = useState<TabKey>('overview');
  const [overview, setOverview] = useState<DocToolAdminOverview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const requestRef = useRef(0);

  const loadOverview = useCallback(async () => {
    const requestId = ++requestRef.current;
    setOverviewLoading(true);
    try {
      const res = await docToolAdminApi.overview();
      if (requestId !== requestRef.current) return;
      setOverview(res);
      setOverviewError(null);
      setLastUpdatedAt(Date.now());
    } catch (error) {
      if (requestId !== requestRef.current) return;
      const message = getBackendErrorMessage(error, '读取文档转换概览失败');
      setOverviewError(message);
      setNotification({ message, type: 'error' });
    } finally {
      if (requestId === requestRef.current) setOverviewLoading(false);
    }
  }, [setNotification]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview, refreshNonce]);

  return (
    <InfoQueryShell maxWidthClassName="max-w-7xl">
      <InfoQueryHero
        eyebrow="媒体与文档"
        title="文档转换运维"
        description={[
          '把 doc-tool 这一层摊开：pandoc 引擎是否可用、串行队列积压多少、失败集中在哪些任务、',
          '各用户工作目录占了多少磁盘，以及按保留期清理能回收多少。',
          '本页只回元数据，不提供跨用户文件下载；真实清理需要二次验证并留审计。',
        ].join('')}
        icon={FaFileAlt}
        tone="sky"
        meta={
          <>
            <InfoBadge tone="slate">只读优先 · 清理需安全会话</InfoBadge>
            <InfoBadge>{lastUpdatedAt ? `概览更新于 ${formatRelativeTime(lastUpdatedAt)}` : '概览尚未加载'}</InfoBadge>
            {overview ? (
              <InfoBadge tone={overview.pandoc.available ? 'emerald' : 'rose'}>
                {overview.pandoc.available ? `pandoc ${overview.pandoc.version ?? '可用'}` : 'pandoc 不可用'}
              </InfoBadge>
            ) : null}
            {overviewError ? (
              <InfoBadge tone="rose">
                <FaExclamationTriangle className="mr-1 inline" />
                概览读取失败
              </InfoBadge>
            ) : null}
          </>
        }
        actions={
          <button
            type="button"
            onClick={() => setRefreshNonce((current) => current + 1)}
            disabled={overviewLoading}
            className={cn(studioPrimaryButtonClassName, 'min-h-11 px-4 py-2 sm:min-h-0')}
          >
            <FaSync className={cn(overviewLoading && 'animate-spin')} /> 刷新全部
          </button>
        }
      />

      {overviewError && !overview ? (
        <StudioErrorState className="mt-6" message="概览读取失败，下方各分页仍可单独使用。" onRetry={() => void loadOverview()} />
      ) : overviewLoading && !overview ? (
        <StudioLoadingState className="mt-6" minHeightClassName="min-h-[220px]" text="正在读取文档转换概览…" />
      ) : null}

      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <InfoMetricCard
          label="排队 / 运行中"
          value={overview ? `${formatCount(overview.counts.queued)} / ${formatCount(overview.counts.running)}` : '—'}
          detail={overview ? `历史任务共 ${formatCount(overview.counts.total)} 个` : '等待概览'}
          icon={FaListUl}
          tone={overview && overview.counts.running > 0 ? 'sky' : 'slate'}
        />
        <InfoMetricCard
          label="24 小时失败"
          value={overview ? formatCount(overview.counts.failed24h) : '—'}
          detail={overview ? `同期成功 ${formatCount(overview.counts.succeeded24h)} 个` : '等待概览'}
          icon={FaExclamationTriangle}
          tone={overview && overview.counts.failed24h > 0 ? 'rose' : 'slate'}
        />
        <InfoMetricCard
          label="工作根目录"
          value={overview ? (overview.workRoot.writable ? '可写' : '不可写') : '—'}
          detail="不可写时每个上传都会失败，属于部署问题"
          icon={FaFolderOpen}
          tone={overview?.workRoot.writable ? 'emerald' : 'rose'}
        />
        <InfoMetricCard
          label="保留期"
          value={overview ? `${overview.limits.retentionDays} 天` : '—'}
          detail="任务记录与产物一起过期（Mongo TTL + 目录清扫）"
          icon={FaCogs}
          tone="slate"
        />
      </div>

      <InfoPanel className="mt-6" compact>
        <Collapsible title="口径说明" subtitle="串行队列 · 保留期 · 清理边界" defaultOpen>
          <div className="space-y-2 text-xs leading-5 text-slate-600">
            <p>
              <span className="font-semibold text-slate-700">串行队列</span>：同一进程只有一个转换队列，
              `maxActiveJobs` 是**单个用户**允许的排队+运行任务数；全局同时只跑一个任务。
            </p>
            <p>
              <span className="font-semibold text-slate-700">保留期</span>：任务记录走 Mongo TTL，
              产物文件由清理任务删除。TTL 是索引创建时的选项，改 env 需要重建索引才对存量生效。
            </p>
            <p>
              <span className="font-semibold text-slate-700">清理边界</span>：只删过期任务**真的写出**的产物，
              不删用户上传的原稿（`keepInputs`）；目录清扫只覆盖 `out/`，`alongside` 模式产物交给任务删除。
            </p>
          </div>
        </Collapsible>
      </InfoPanel>

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
        {tab === 'overview' ? <OverviewTab overview={overview} onRefresh={() => void loadOverview()} /> : null}
        {tab === 'jobs' ? <JobsTab refreshNonce={refreshNonce} /> : null}
        {tab === 'files' ? <FilesTab refreshNonce={refreshNonce} /> : null}
        {tab === 'limits' ? <LimitsTab overview={overview} /> : null}
        {tab === 'cleanup' ? <CleanupTab onDone={() => setRefreshNonce((current) => current + 1)} /> : null}
      </div>
    </InfoQueryShell>
  );
};

const OverviewTab: React.FC<{ overview: DocToolAdminOverview | null; onRefresh: () => void }> = ({ overview, onRefresh }) => {
  if (!overview) return <StudioEmptyState message="概览还没有数据。" action={<button type="button" onClick={onRefresh} className="text-sm font-semibold text-slate-700 underline">重新读取</button>} />;
  return (
    <div className="space-y-4">
      <InfoPanel compact>
        <h3 className="text-sm font-semibold text-slate-900">引擎状态</h3>
        <dl className="mt-2 grid gap-2 text-xs text-slate-600 sm:grid-cols-2 lg:grid-cols-4">
          <div><dt className="text-slate-500">可用</dt><dd>{overview.pandoc.available ? '是' : '否'}</dd></div>
          <div><dt className="text-slate-500">版本</dt><dd>{overview.pandoc.version ?? '-'}</dd></div>
          <div><dt className="text-slate-500">可执行文件</dt><dd className="break-all font-mono text-[11px]">{overview.pandoc.bin}</dd></div>
          <div><dt className="text-slate-500">工作根可写</dt><dd>{overview.workRoot.writable ? '是' : '否'}</dd></div>
        </dl>
        {overview.pandoc.error ? <p className="mt-2 text-xs text-amber-700">{overview.pandoc.error}</p> : null}
      </InfoPanel>

      <InfoPanel compact>
        <h3 className="text-sm font-semibold text-slate-900">队列</h3>
        <dl className="mt-2 grid gap-2 text-xs text-slate-600 sm:grid-cols-2 lg:grid-cols-5">
          <div><dt className="text-slate-500">排队中</dt><dd className="tabular-nums">{formatCount(overview.counts.queued)}</dd></div>
          <div><dt className="text-slate-500">运行中</dt><dd className="tabular-nums">{formatCount(overview.counts.running)}</dd></div>
          <div><dt className="text-slate-500">24h 失败</dt><dd className="tabular-nums">{formatCount(overview.counts.failed24h)}</dd></div>
          <div><dt className="text-slate-500">24h 成功</dt><dd className="tabular-nums">{formatCount(overview.counts.succeeded24h)}</dd></div>
          <div><dt className="text-slate-500">历史总数</dt><dd className="tabular-nums">{formatCount(overview.counts.total)}</dd></div>
        </dl>
      </InfoPanel>
    </div>
  );
};

const JobsTab: React.FC<{ refreshNonce: number }> = ({ refreshNonce }) => {
  const [status, setStatus] = useState('');
  const [userId, setUserId] = useState('');
  const [limit, setLimit] = useState(20);
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<DocToolAdminJobRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await docToolAdminApi.jobs({ status, userId, limit, offset });
      setRows(res.jobs);
      setTotal(res.total);
      setError(null);
    } catch (err) {
      setError(getBackendErrorMessage(err, '读取任务列表失败'));
    } finally {
      setLoading(false);
    }
  }, [limit, offset, status, userId]);

  useEffect(() => {
    void load();
  }, [load, refreshNonce]);

  const openDetail = useCallback(async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      setDetail(null);
      return;
    }
    setExpandedId(id);
    setDetail(null);
    try {
      const res = await docToolAdminApi.job(id);
      setDetail(
        [
          ...res.job.items.map((item) => `${item.status}\t${item.sourceRel}${item.destRel ? ` → ${item.destRel}` : ''}${item.error ? `\t${item.error}` : ''}`),
          ...res.job.logs.map((log) => `[${log.level}] ${log.message}`),
        ].join('\n') || '（该任务没有逐文件结果与日志）',
      );
    } catch (err) {
      setDetail(getBackendErrorMessage(err, '读取任务详情失败'));
    }
  }, [expandedId]);

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
            placeholder="按用户 ID 过滤"
            aria-label="按用户 ID 过滤"
            className="min-h-11 min-w-[220px] flex-1 rounded-2xl border border-slate-200 bg-white/80 px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none sm:min-h-0"
          />
          <FilterSelect value={status} onChange={(value) => { setStatus(value); setOffset(0); }} options={STATUS_OPTIONS} title="任务状态" />
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

      {error ? <StudioErrorState message={error} onRetry={() => void load()} /> : null}

      <InfoPanel compact>
        <TableWrap minWidth="min-w-[1040px]">
          <thead>
            <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
              <Th>状态</Th>
              <Th>用户</Th>
              <Th>文件进度</Th>
              <Th>创建 / 结束</Th>
              <Th>操作</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            <TableState
              loading={loading && rows.length === 0}
              error={error}
              empty={!loading && rows.length === 0}
              emptyText="没有符合筛选的任务。任务记录按保留期自动过期；可清除筛选或放宽用户条件。"
              colSpan={5}
              onRetry={() => void load()}
            />
            {rows.map((row) => (
              <React.Fragment key={row.id}>
                <tr className="align-top transition hover:bg-slate-50/80">
                  <Td>
                    <div className="flex flex-col gap-1">
                      <InfoBadge tone={row.status === 'failed' ? 'rose' : row.status === 'partial' ? 'amber' : row.status === 'running' ? 'sky' : 'slate'}>
                        {row.status}
                      </InfoBadge>
                      {row.stage ? <span className="text-[10px] text-slate-400">{row.stage}</span> : null}
                    </div>
                  </Td>
                  <Td>
                    <div className="flex flex-col gap-0.5 text-[11px]">
                      <span className="font-mono text-slate-600">{row.userId}</span>
                      {row.createdBy ? <span className="text-slate-400">{row.createdBy}</span> : null}
                    </div>
                  </Td>
                  <Td>
                    <div className="flex flex-col gap-0.5 text-[11px] text-slate-600">
                      <span>
                        {formatCount(row.ok)} 成功 · {formatCount(row.skipped)} 跳过 · {formatCount(row.failed)} 失败
                      </span>
                      <span className="text-slate-400">进度 {row.progress}% · 共 {formatCount(row.total)}</span>
                      {row.error ? <span className="max-w-[280px] truncate text-rose-700" title={row.error}>{row.error}</span> : null}
                    </div>
                  </Td>
                  <Td>
                    <div className="flex flex-col gap-0.5 text-[11px] text-slate-500">
                      <span>{formatTime(row.createdAt)}</span>
                      <span>{row.finishedAt ? formatTime(row.finishedAt) : '未结束'}</span>
                    </div>
                  </Td>
                  <Td>
                    <button
                      type="button"
                      onClick={() => void openDetail(row.id)}
                      aria-expanded={expandedId === row.id}
                      className="whitespace-nowrap rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                    >
                      {expandedId === row.id ? '收起' : '逐文件'}
                    </button>
                  </Td>
                </tr>
                {expandedId === row.id ? (
                  <tr>
                    <td colSpan={5} className="bg-slate-50/70 px-3 py-2">
                      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-2xl border border-slate-200 bg-white/80 px-3 py-2 font-mono text-[11px] leading-5 text-slate-700">
                        {detail ?? '正在读取…'}
                      </pre>
                    </td>
                  </tr>
                ) : null}
              </React.Fragment>
            ))}
          </tbody>
        </TableWrap>
        <Pager total={total} limit={limit} offset={offset} loading={loading} onChange={setOffset} />
      </InfoPanel>
    </div>
  );
};

const FilesTab: React.FC<{ refreshNonce: number }> = ({ refreshNonce }) => {
  const [rows, setRows] = useState<DocToolStorageRow[]>([]);
  const [totalBytes, setTotalBytes] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await docToolAdminApi.files();
      setRows(res.storage);
      setTotalBytes(res.totalBytes);
      setTruncated(res.truncated);
      setError(null);
    } catch (err) {
      setError(getBackendErrorMessage(err, '统计目录占用失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshNonce]);

  if (error && rows.length === 0) return <StudioErrorState message={error} onRetry={() => void load()} />;

  return (
    <div className="space-y-4">
      <InfoPanel compact>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
          <div className="flex flex-wrap items-center gap-2">
            <InfoBadge tone="sky">{formatCount(rows.length)} 个用户目录</InfoBadge>
            <InfoBadge tone="slate">合计 {formatBytes(totalBytes)}</InfoBadge>
            {truncated ? <InfoBadge tone="amber">目录数超过扫描上限，仅展示前 300 个</InfoBadge> : null}
          </div>
          <RefreshButton onClick={() => void load()} loading={loading} />
        </div>
      </InfoPanel>

      <InfoPanel compact>
        {loading && rows.length === 0 ? (
          <StudioLoadingState minHeightClassName="min-h-[180px]" text="正在扫描目录…" />
        ) : rows.length === 0 ? (
          <StudioEmptyState message="工作根下还没有用户目录。用户第一次上传 .md 时才会创建。" />
        ) : (
          <TableWrap minWidth="min-w-[820px]">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
                <Th>用户</Th>
                <Th>inbox 文件</Th>
                <Th>out 文件</Th>
                <Th>占用</Th>
                <Th>最近活动</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => (
                <tr key={row.userId} className="transition hover:bg-slate-50/80">
                  <Td>
                    <div className="flex flex-col gap-0.5">
                      <span className="font-semibold text-slate-800">{row.username ?? row.userId}</span>
                      <span className="font-mono text-[11px] text-slate-400">{row.userId}</span>
                    </div>
                  </Td>
                  <Td><span className="tabular-nums text-slate-700">{formatCount(row.inboxFiles)}</span></Td>
                  <Td><span className="tabular-nums text-slate-700">{formatCount(row.outFiles)}</span></Td>
                  <Td>
                    <span className="tabular-nums font-semibold text-slate-800">{formatBytes(row.totalBytes)}</span>
                    {row.truncated ? <InfoBadge tone="amber" className="ml-1">部分统计</InfoBadge> : null}
                  </Td>
                  <Td><span className="text-[11px] text-slate-500">{row.lastModifiedAt ? formatRelativeTime(row.lastModifiedAt) : '-'}</span></Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </InfoPanel>
    </div>
  );
};

const LimitsTab: React.FC<{ overview: DocToolAdminOverview | null }> = ({ overview }) => {
  if (!overview) return <StudioEmptyState message="限额随概览一起返回，请先重新读取概览。" />;
  const rows: Array<{ label: string; env: string; value: string }> = [
    { label: '单次上传总量', env: 'DOC_TOOL_MAX_UPLOAD_BYTES', value: formatBytes(overview.limits.maxUploadBytes) },
    { label: '单个 .md 大小', env: 'DOC_TOOL_MAX_FILE_BYTES', value: formatBytes(overview.limits.maxFileBytes) },
    { label: '单任务文件数', env: 'DOC_TOOL_MAX_FILES_PER_JOB', value: `${overview.limits.maxFilesPerJob} 个` },
    { label: '单用户活动任务', env: 'DOC_TOOL_MAX_ACTIVE_JOBS', value: `${overview.limits.maxActiveJobs} 个` },
    { label: '产物保留期', env: 'DOC_TOOL_RETENTION_DAYS', value: `${overview.limits.retentionDays} 天` },
  ];
  return (
    <InfoPanel compact>
      <TableWrap minWidth="min-w-[640px]">
        <thead>
          <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
            <Th>项</Th>
            <Th>env</Th>
            <Th>生效值</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row) => (
            <tr key={row.env}>
              <Td><span className="text-slate-700">{row.label}</span></Td>
              <Td><span className="font-mono text-[11px] text-slate-500">{row.env}</span></Td>
              <Td><span className="tabular-nums font-semibold text-slate-800">{row.value}</span></Td>
            </tr>
          ))}
        </tbody>
      </TableWrap>
      <p className="mt-2 text-[11px] text-slate-500">改这些值需要改部署 env 并重启；保留期还要求重建 Mongo TTL 索引才对存量生效。</p>
    </InfoPanel>
  );
};

const CleanupTab: React.FC<{ onDone: () => void }> = ({ onDone }) => {
  const { setNotification } = useNotification();
  const [preview, setPreview] = useState<{ expiredJobs: number; purgedFiles: number; keepDays: number; note: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionMissing, setSessionMissing] = useState(false);

  const runPreview = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await docToolAdminApi.cleanupPreview();
      setPreview({ expiredJobs: res.expiredJobs, purgedFiles: res.purgedFiles, keepDays: res.keepDays, note: res.note });
    } catch (err) {
      setError(getBackendErrorMessage(err, '清理预演失败'));
    } finally {
      setBusy(false);
    }
  }, []);

  const runCleanup = useCallback(async () => {
    setBusy(true);
    setError(null);
    setSessionMissing(false);
    try {
      const res = await docToolAdminApi.cleanupRun();
      setNotification({
        message: `清理完成：删除 ${res.expiredJobs} 个过期任务、回收 ${res.purgedFiles + res.sweptFiles} 个文件`,
        type: 'success',
      });
      setPreview(null);
      onDone();
    } catch (err) {
      const code = (err as { response?: { data?: { code?: string } } })?.response?.data?.code;
      if (code === 'SECURITY_SESSION_REQUIRED') {
        setSessionMissing(true);
      }
      setError(getBackendErrorMessage(err, '清理未完成'));
    } finally {
      setBusy(false);
    }
  }, [onDone, setNotification]);

  return (
    <div className="space-y-4">
      <InfoPanel compact>
        <h3 className="text-sm font-semibold text-slate-900">清理（先预演，再执行）</h3>
        <p className="mt-1 text-xs leading-5 text-slate-500">
          清理会删除保留期之外的任务记录与它们产出的文件，不删用户上传的原稿。
          预演只统计数量、不改磁盘；真实执行需要建立安全会话并写审计。
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" onClick={() => void runPreview()} disabled={busy} className={cn(studioSecondaryButtonClassName, 'min-h-11 sm:min-h-0')}>
            预演
          </button>
          <button type="button" onClick={() => void runCleanup()} disabled={busy} className={cn(studioDangerButtonClassName, 'min-h-11 sm:min-h-0')}>
            <FaBroom className="mr-1 inline" />执行清理
          </button>
        </div>
        {preview ? (
          <dl className="mt-3 grid gap-2 text-xs text-slate-600 sm:grid-cols-3">
            <div><dt className="text-slate-500">将清理任务</dt><dd className="tabular-nums">{formatCount(preview.expiredJobs)}</dd></div>
            <div><dt className="text-slate-500">将删产物文件</dt><dd className="tabular-nums">{formatCount(preview.purgedFiles)}</dd></div>
            <div><dt className="text-slate-500">保留期</dt><dd>{preview.keepDays} 天</dd></div>
            <div className="sm:col-span-3 text-slate-500">{preview.note}</div>
          </dl>
        ) : null}
        {sessionMissing ? (
          <div className="mt-3">
            <p className="mb-2 text-xs text-amber-700">执行清理需要安全会话（二次验证）。</p>
            <EstablishSecuritySession />
          </div>
        ) : null}
        {error && !sessionMissing ? <p className="mt-2 text-xs text-rose-700">{error}</p> : null}
      </InfoPanel>
    </div>
  );
};

export default DocToolAdminPanel;
