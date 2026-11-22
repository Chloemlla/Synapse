import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FaBolt, FaSync } from 'react-icons/fa';
import { rateLimitsApi, type BurstGuardRow } from '@/api/rateLimits';
import { InfoBadge, InfoPanel, studioSecondaryButtonClassName } from '@/components/studioTheme';
import { StudioEmptyState, StudioErrorState, StudioLoadingState } from '@/components/studioFeedback';
import { cn } from '@/lib/utils';
import { getBackendErrorMessage } from '@/utils/backendError';
import { formatRelativeTime } from '../ip-risk-log/format';
import { DataPanel, TableWrap, Td, Th, UtilizationBar } from './ui';

/** 短周期刷新：并发是瞬时状态，看 1 分钟前的数字没有意义。 */
const REFRESH_OPTIONS = [
  { value: 0, label: '手动刷新' },
  { value: 5000, label: '5 秒' },
  { value: 15000, label: '15 秒' },
  { value: 30000, label: '30 秒' },
];

/**
 * 在途并发（RC-27）。
 *
 * 与「固定窗口限流」是两条正交的约束：窗口管「一分钟内允许几次」，
 * 这里管「同一时刻允许几个在途请求」。超顶的请求被**立即拒绝**而不是排队 ——
 * 排队本身就是新的内存压力，这是 RC-43 的教训。
 */
const RateLimitsBurstTab: React.FC<{ refreshNonce: number }> = ({ refreshNonce }) => {
  const [guards, setGuards] = useState<BurstGuardRow[]>([]);
  const [totalActive, setTotalActive] = useState(0);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshMs, setRefreshMs] = useState(0);
  const [tick, setTick] = useState(0);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    try {
      const res = await rateLimitsApi.burst();
      if (requestId !== requestRef.current) return;
      setGuards(res.guards);
      setTotalActive(res.totalActive);
      setGeneratedAt(res.generatedAt);
      setError(null);
    } catch (err) {
      if (requestId !== requestRef.current) return;
      setError(getBackendErrorMessage(err, '读取在途并发快照失败'));
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshNonce, tick]);

  useEffect(() => {
    if (refreshMs <= 0) return;
    const timer: number = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      setTick((current) => current + 1);
    }, refreshMs);
    return () => window.clearInterval(timer);
  }, [refreshMs]);

  const overCap = guards.filter((guard) => guard.active > guard.maxConcurrent);

  return (
    <div className="space-y-4">
      <InfoPanel compact>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
            <InfoBadge tone={overCap.length > 0 ? 'rose' : 'sky'}>在途合计 {totalActive}</InfoBadge>
            <InfoBadge tone="slate">{guards.length} 个守卫</InfoBadge>
            {generatedAt ? <span className="text-slate-400">更新于 {formatRelativeTime(generatedAt)}</span> : null}
          </div>
          <div className="flex items-center gap-2">
            <select
              value={refreshMs}
              onChange={(event) => setRefreshMs(Number(event.target.value))}
              aria-label="自动刷新间隔"
              className="min-h-11 rounded-2xl border border-slate-200 bg-white/80 px-3 py-1.5 text-xs font-semibold text-slate-700 sm:min-h-0"
            >
              {REFRESH_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label === '手动刷新' ? option.label : `自动刷新：${option.label}`}</option>
              ))}
            </select>
            <button type="button" onClick={() => void load()} disabled={loading} className={cn(studioSecondaryButtonClassName, 'min-h-11 sm:min-h-0')}>
              <FaSync className={cn('mr-1 inline', loading && 'animate-spin')} />刷新
            </button>
          </div>
        </div>
      </InfoPanel>

      {error ? <StudioErrorState message={error} onRetry={() => void load()} /> : null}

      <InfoPanel compact>
        {loading && guards.length === 0 ? (
          <StudioLoadingState minHeightClassName="min-h-[200px]" text="正在读取并发快照…" />
        ) : guards.length === 0 ? (
          <StudioEmptyState message="当前没有在途请求。并发守卫只在请求进出时计数；空闲时列表为空是正常状态。" />
        ) : (
          <TableWrap minWidth="min-w-[860px]">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
                <Th>守卫</Th>
                <Th>在途 / 上限</Th>
                <Th>占用键数</Th>
                <Th>状态</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {guards.map((guard) => (
                <tr key={guard.name} className={cn('align-middle', guard.active > guard.maxConcurrent && 'bg-rose-50/50')}>
                  <Td><span className="font-mono text-[11px] text-slate-700">{guard.name}</span></Td>
                  <Td><UtilizationBar active={guard.active} max={guard.maxConcurrent} /></Td>
                  <Td><span className="tabular-nums text-slate-600">{guard.keys}</span></Td>
                  <Td>
                    {guard.active > guard.maxConcurrent ? (
                      <InfoBadge tone="rose">超顶（新请求 429）</InfoBadge>
                    ) : guard.active === guard.maxConcurrent ? (
                      <InfoBadge tone="amber">已满</InfoBadge>
                    ) : (
                      <InfoBadge tone="emerald">有余量</InfoBadge>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </InfoPanel>

      <DataPanel>
        <div className="flex items-start gap-2 text-xs leading-5 text-slate-600">
          <FaBolt className="mt-0.5 shrink-0 text-slate-400" aria-hidden />
          <div className="min-w-0">
            <p className="font-semibold text-slate-700">口径</p>
            <p className="mt-1">
              这里只统计在途请求，不统计后台任务 —— TTS 的排队任务数由队列自己的每用户上限负责
              （见「TTS 占用」页签），两者是不同层面，不能互相替代。匿名请求按「IP + 设备指纹」双桶计数，
              登录用户按「用户 + IP」双键计数。
            </p>
          </div>
        </div>
      </DataPanel>
    </div>
  );
};

export default RateLimitsBurstTab;
