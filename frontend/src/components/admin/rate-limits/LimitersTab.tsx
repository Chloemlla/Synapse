import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FaFilter, FaListOl } from 'react-icons/fa';
import { rateLimitsApi, type LimitersResponse } from '@/api/rateLimits';
import { InfoBadge, InfoPanel } from '@/components/studioTheme';
import { StudioErrorState, StudioLoadingState } from '@/components/studioFeedback';
import { getBackendErrorMessage } from '@/utils/backendError';
import { formatCount } from '../ip-risk-log/format';
import { formatWindow } from './format';
import { DataPanel, RefreshButton, TableState, TableWrap, Td, Th } from './ui';

/**
 * 限流器清单（`LIMITER_DEFINITIONS` 的只读投影）。
 *
 * 为什么需要：排查 429 时最常见的问题是「这个端点到底用了哪一档、额度多少、走的 Redis 还是内存」。
 * 以前只能翻源码。这里展示的是定义表快照 —— 它**不参与任何限流判定**，
 * 改动仍是改代码或 env 后重启。
 */
const RateLimitsLimitersTab: React.FC<{ refreshNonce: number }> = ({ refreshNonce }) => {
  const [data, setData] = useState<LimitersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState('');
  const [category, setCategory] = useState('');
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    try {
      const res = await rateLimitsApi.limiters();
      if (requestId !== requestRef.current) return;
      setData(res);
      setError(null);
    } catch (err) {
      if (requestId !== requestRef.current) return;
      setError(getBackendErrorMessage(err, '读取限流器清单失败'));
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshNonce]);

  const categories = useMemo(() => {
    if (!data) return [] as string[];
    return Array.from(new Set(data.limiters.map((row) => row.category))).sort();
  }, [data]);

  const rows = useMemo(() => {
    if (!data) return [];
    const needle = keyword.trim().toLowerCase();
    return data.limiters.filter((row) => {
      if (category && row.category !== category) return false;
      if (!needle) return true;
      return (
        row.name.toLowerCase().includes(needle) ||
        row.profile.toLowerCase().includes(needle) ||
        row.message.includes(needle)
      );
    });
  }, [category, data, keyword]);

  if (error && !data) return <StudioErrorState message={error} onRetry={() => void load()} />;
  if (loading && !data) return <StudioLoadingState minHeightClassName="min-h-[240px]" text="正在读取限流器清单…" />;
  if (!data) return null;

  return (
    <div className="space-y-4">
      <InfoPanel compact>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex min-w-0 flex-1 items-center gap-2 rounded-2xl border border-slate-200 bg-white/80 px-3">
            <FaFilter className="shrink-0 text-slate-400" aria-hidden />
            <input
              type="search"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="按名称 / 档位 / 提示文案搜索"
              aria-label="搜索限流器"
              className="min-h-11 w-full min-w-0 bg-transparent py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none sm:min-h-0"
            />
          </label>
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            aria-label="按类别过滤"
            className="min-h-11 rounded-2xl border border-slate-200 bg-white/80 px-3 py-1.5 text-xs font-semibold text-slate-700 sm:min-h-0"
          >
            <option value="">全部类别</option>
            {categories.map((item) => (
              <option key={item} value={item}>{item}</option>
            ))}
          </select>
          <RefreshButton onClick={() => void load()} loading={loading} />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <span>共 {formatCount(data.limiters.length)} 个限流器，当前显示 {formatCount(rows.length)} 个</span>
          <InfoBadge tone={data.storage.redisConfigured ? 'emerald' : 'amber'}>
            {data.storage.redisConfigured ? '共享档已启用（Redis）' : '共享档会退化为进程内存档'}
          </InfoBadge>
        </div>
      </InfoPanel>

      {error && data ? <p className="text-xs text-rose-700">{error}</p> : null}

      <InfoPanel compact>
        <TableWrap minWidth="min-w-[1100px]">
          <thead>
            <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
              <Th>名称</Th>
              <Th>档位 / 类别</Th>
              <Th>窗口</Th>
              <Th>额度</Th>
              <Th>键口径</Th>
              <Th>存储</Th>
              <Th>本地豁免</Th>
              <Th>提示文案</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            <TableState
              loading={loading && rows.length === 0}
              error={null}
              empty={!loading && rows.length === 0}
              emptyText="没有匹配的限流器。清空关键词或切换类别再看。"
              colSpan={8}
            />
            {rows.map((row) => (
              <tr key={row.name} className="align-top transition hover:bg-slate-50/80">
                <Td><span className="font-mono text-[11px] text-slate-700">{row.name}</span></Td>
                <Td>
                  <div className="flex flex-col gap-0.5">
                    <span className="font-mono text-[11px] text-slate-600">{row.profile}</span>
                    <span className="text-[10px] text-slate-400">{row.category}</span>
                  </div>
                </Td>
                <Td><span className="tabular-nums text-slate-700">{formatWindow(row.windowMs)}</span></Td>
                <Td><span className="tabular-nums font-semibold text-slate-800">{formatCount(row.max)}</span></Td>
                <Td>
                  <InfoBadge tone={row.keyMode === 'user-ip' ? 'sky' : 'slate'}>
                    {row.keyMode === 'user-ip' ? '用户 + IP' : 'IP'}
                  </InfoBadge>
                </Td>
                <Td>
                  <InfoBadge tone={row.effectiveStorage === 'redis' ? 'emerald' : row.effectiveStorage === 'memory' ? 'slate' : 'amber'}>
                    {row.effectiveStorage}
                  </InfoBadge>
                </Td>
                <Td>{row.skipLocal ? <InfoBadge tone="slate">是</InfoBadge> : <InfoBadge tone="amber">否</InfoBadge>}</Td>
                <Td><span className="block max-w-[260px] truncate text-[11px] text-slate-600" title={row.message}>{row.message}</span></Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      </InfoPanel>

      <DataPanel>
        <div className="flex items-start gap-2 text-xs leading-5 text-slate-600">
          <FaListOl className="mt-0.5 shrink-0 text-slate-400" aria-hidden />
          <div className="min-w-0">
            <p className="font-semibold text-slate-700">口径</p>
            <p className="mt-1">
              额度按「窗口内次数」计，与「在途并发」是两条正交约束。「用户 + IP」双键的意思是
              <span className="mx-1 font-medium">两个维度各自计数、任一超限即拒绝</span>
              —— 只按 IP 会在 NAT 后误伤，只按账号则换 IP 即可并行刷。
              静态资源类的三道闸固定走进程内存档（防刷语义，不是配额）。
            </p>
            <p className="mt-1 text-slate-400">本清单是定义表快照，不参与运行判定；改额度需要改代码或 env 后重启。</p>
          </div>
        </div>
      </DataPanel>
    </div>
  );
};

export default RateLimitsLimitersTab;
