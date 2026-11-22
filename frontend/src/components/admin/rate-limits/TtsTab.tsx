import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FaTachometerAlt } from 'react-icons/fa';
import { rateLimitsApi, type TtsActiveJobRow, type TtsOccupancy } from '@/api/rateLimits';
import { InfoBadge, InfoMetricCard, InfoPanel } from '@/components/studioTheme';
import { StudioEmptyState, StudioErrorState, StudioLoadingState } from '@/components/studioFeedback';
import { getBackendErrorMessage } from '@/utils/backendError';
import { formatCount, formatRelativeTime, formatTime } from '../ip-risk-log/format';
import { DataPanel, FilterSelect, Pager, RefreshButton, TableState, TableWrap, Td, Th, UtilizationBar, InlineError } from './ui';

const TOP_OPTIONS = [
  { value: 10, label: 'Top 10' },
  { value: 20, label: 'Top 20' },
  { value: 50, label: 'Top 50' },
];

/**
 * TTS 队列占用（RC-30）。
 *
 * 两个层面必须分开看：
 *   - 全局并发 `concurrency`：整个进程同时跑几个生成任务（队列配置）；
 *   - 每用户上限 `perUserMaxActive`：单个登录用户允许同时排队+运行几个（默认 3，管理员与匿名豁免）。
 * 这张表回答「现在谁把队列占满了」，不展示任务正文（题词与语音参数都是用户内容）。
 */
const RateLimitsTtsTab: React.FC<{ refreshNonce: number }> = ({ refreshNonce }) => {
  const [data, setData] = useState<(TtsOccupancy & { generatedAt?: string }) | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [top, setTop] = useState(20);
  const requestRef = useRef(0);

  // 逐任务明细：默认跟随展开的用户过滤，也可以单独按 userId 查。
  const [jobUserId, setJobUserId] = useState('');
  const [jobUserIdInput, setJobUserIdInput] = useState('');
  const [jobs, setJobs] = useState<TtsActiveJobRow[]>([]);
  const [jobsTotal, setJobsTotal] = useState(0);
  const [jobsOffset, setJobsOffset] = useState(0);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [jobsError, setJobsError] = useState<string | null>(null);

  const loadJobs = useCallback(async () => {
    setJobsLoading(true);
    try {
      const res = await rateLimitsApi.ttsJobs({ userId: jobUserId, limit: 50, offset: jobsOffset });
      setJobs(res.jobs);
      setJobsTotal(res.total);
      setJobsError(null);
    } catch (err) {
      setJobsError(getBackendErrorMessage(err, '读取 TTS 任务明细失败'));
    } finally {
      setJobsLoading(false);
    }
  }, [jobUserId, jobsOffset]);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs, refreshNonce]);

  useEffect(() => {
    const timer: number = window.setTimeout(() => {
      if (jobUserIdInput.trim() !== jobUserId) {
        setJobUserId(jobUserIdInput.trim());
        setJobsOffset(0);
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [jobUserId, jobUserIdInput]);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    try {
      const res = await rateLimitsApi.ttsOccupancy(top);
      if (requestId !== requestRef.current) return;
      setData(res);
      setError(null);
    } catch (err) {
      if (requestId !== requestRef.current) return;
      setError(getBackendErrorMessage(err, '读取 TTS 队列占用失败'));
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [top]);

  useEffect(() => {
    void load();
  }, [load, refreshNonce]);

  if (error && !data) return <StudioErrorState message={error} onRetry={() => void load()} />;
  if (loading && !data) return <StudioLoadingState minHeightClassName="min-h-[240px]" text="正在读取 TTS 队列占用…" />;
  if (!data) return null;

  return (
    <div className="space-y-4">
      <InfoPanel compact>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
            <InfoBadge tone={data.available ? 'sky' : 'amber'}>{data.available ? '队列已注册' : '队列不可用'}</InfoBadge>
            {data.generatedAt ? <span>更新于 {formatRelativeTime(data.generatedAt)}</span> : null}
          </div>
          <div className="flex items-center gap-2">
            <FilterSelect value={String(top)} onChange={(value) => setTop(Number(value))} options={TOP_OPTIONS} title="Top 数量" />
            <RefreshButton onClick={() => void load()} loading={loading} />
          </div>
        </div>
        {!data.available ? <p className="mt-2 text-xs text-amber-700">{data.reason}</p> : null}
      </InfoPanel>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <InfoMetricCard
          label="全局并发"
          value={data.global ? formatCount(data.global.concurrency) : '—'}
          detail="整个进程同时处理的任务数（队列配置）"
          icon={FaTachometerAlt}
          tone="sky"
        />
        <InfoMetricCard
          label="每用户上限"
          value={data.perUserMaxActive !== null ? formatCount(data.perUserMaxActive) : '—'}
          detail="超出后新任务 429 TTS_USER_CONCURRENCY_LIMIT；0 = 关闭"
          icon={FaTachometerAlt}
          tone="slate"
        />
        <InfoMetricCard
          label="处理状态"
          value={data.global ? (data.global.processing ? '正在处理' : '空闲') : '—'}
          detail="空闲但仍有活跃任务 = 任务在排队等待下一轮 drain"
          icon={FaTachometerAlt}
          tone={data.global?.processing ? 'emerald' : 'slate'}
        />
      </div>

      <InfoPanel compact>
        <h3 className="text-sm font-semibold text-slate-900">占用 Top（按活跃任务数）</h3>
        {data.topOwners.length === 0 ? (
          <StudioEmptyState
            className="mt-3 py-10"
            message={data.available ? '当前没有排队或运行中的任务。' : (data.reason ?? '队列不可用')}
          />
        ) : (
          <TableWrap minWidth="min-w-[720px]">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
                <Th>用户</Th>
                <Th>活跃任务 / 每用户上限</Th>
                <Th>状态</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.topOwners.map((owner) => {
                const cap = data.perUserMaxActive && data.perUserMaxActive > 0 ? data.perUserMaxActive : owner.active;
                return (
                  <tr key={owner.userId}>
                    <Td><span className="font-mono text-[11px] text-slate-600">{owner.userId}</span></Td>
                    <Td><UtilizationBar active={owner.active} max={cap} /></Td>
                    <Td>
                      {data.perUserMaxActive && owner.active >= data.perUserMaxActive ? (
                        <InfoBadge tone="rose">已达上限（新任务会被拒）</InfoBadge>
                      ) : (
                        <InfoBadge tone="emerald">正常</InfoBadge>
                      )}
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </TableWrap>
        )}
      </InfoPanel>

      <InfoPanel compact>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold text-slate-900">逐任务明细（排队 + 运行中）</h3>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="search"
              value={jobUserIdInput}
              onChange={(event) => setJobUserIdInput(event.target.value)}
              placeholder="按用户 ID 过滤"
              aria-label="按用户 ID 过滤 TTS 任务"
              className="min-h-11 min-w-[200px] rounded-2xl border border-slate-200 bg-white/80 px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none sm:min-h-0"
            />
            <RefreshButton onClick={() => void loadJobs()} loading={jobsLoading} />
          </div>
        </div>
        <p className="mt-1 text-xs text-slate-500">
          共 {formatCount(jobsTotal)} 个活跃任务；只含执行元数据，题词与产物地址属用户内容，不在此视图内。
        </p>
        {jobsError && jobs.length > 0 ? <InlineError message={jobsError} onRetry={() => void loadJobs()} /> : null}
        <TableWrap minWidth="min-w-[980px]">
          <thead>
            <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
              <Th>任务</Th>
              <Th>用户</Th>
              <Th>状态</Th>
              <Th>提供者 / 模型</Th>
              <Th>时间</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            <TableState
              loading={jobsLoading && jobs.length === 0}
              error={jobsError}
              empty={!jobsLoading && jobs.length === 0}
              emptyText="当前没有排队或运行中的 TTS 任务。任务完成后会离开本视图（历史记录在 TTS 生成记录页）。"
              colSpan={5}
              onRetry={() => void loadJobs()}
            />
            {jobs.map((job) => (
              <tr key={job.taskId} className="align-top transition hover:bg-slate-50/80">
                <Td>
                  <div className="flex flex-col gap-0.5">
                    <span className="font-mono text-[11px] text-slate-700">{job.taskId}</span>
                    {job.attempts > 0 ? <span className="text-[10px] text-slate-400">已重试 {job.attempts} 次</span> : null}
                  </div>
                </Td>
                <Td>
                  <button
                    type="button"
                    onClick={() => {
                      setJobUserIdInput(job.userId);
                      setJobUserId(job.userId);
                      setJobsOffset(0);
                    }}
                    className="font-mono text-[11px] text-slate-600 underline-offset-2 hover:text-slate-900 hover:underline"
                    title="只看该用户的任务"
                  >
                    {job.userId || '-'}
                  </button>
                </Td>
                <Td>
                  <InfoBadge tone={job.status === 'processing' ? 'sky' : 'slate'}>{job.status}</InfoBadge>
                  {job.processingOwner ? (
                    <span className="mt-1 block font-mono text-[10px] text-slate-400">{job.processingOwner}</span>
                  ) : null}
                </Td>
                <Td>
                  <div className="flex flex-col gap-0.5 text-[11px] text-slate-600">
                    <span>{job.provider ?? '-'}</span>
                    <span className="text-slate-400">{job.providerModel ?? '-'}</span>
                  </div>
                </Td>
                <Td>
                  <div className="flex flex-col gap-0.5 text-[11px] text-slate-500">
                    <span>{formatTime(job.createdAt)}</span>
                    <span>{formatRelativeTime(job.updatedAt)}</span>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
        <Pager total={jobsTotal} limit={50} offset={jobsOffset} loading={jobsLoading} onChange={setJobsOffset} />
      </InfoPanel>

      <DataPanel>
        <p className="text-xs leading-5 text-slate-600">
          每用户上限来自 <code className="rounded bg-slate-100 px-1">TTS_PER_USER_MAX_ACTIVE</code>（默认 3，0 = 关闭，上限 50）。
          管理员与匿名任务豁免：匿名由配额与设备指纹闸门负责，管理员是运维批量验证。
        </p>
      </DataPanel>
    </div>
  );
};

export default RateLimitsTtsTab;
