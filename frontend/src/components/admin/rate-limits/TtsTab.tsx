import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FaTachometerAlt } from 'react-icons/fa';
import { rateLimitsApi, type TtsOccupancy } from '@/api/rateLimits';
import { InfoBadge, InfoMetricCard, InfoPanel } from '@/components/studioTheme';
import { StudioEmptyState, StudioErrorState, StudioLoadingState } from '@/components/studioFeedback';
import { getBackendErrorMessage } from '@/utils/backendError';
import { formatCount, formatRelativeTime } from '../ip-risk-log/format';
import { DataPanel, TableWrap, Td, Th, UtilizationBar, FilterSelect, RefreshButton } from './ui';

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
