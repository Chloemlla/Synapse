import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FaLayerGroup } from 'react-icons/fa';
import { rateLimitsApi, type LadderRow } from '@/api/rateLimits';
import { InfoBadge, InfoPanel } from '@/components/studioTheme';
import { useNotification } from '@/components/Notification';
import { getBackendErrorMessage } from '@/utils/backendError';
import { formatCount, formatRelativeTime, formatTime } from '../ip-risk-log/format';
import { LADDER_STATE_OPTIONS } from './format';
import {
  DataPanel,
  FieldGrid,
  FieldRow,
  FilterSelect,
  InlineError,
  Pager,
  RefreshButton,
  TableState,
  TableWrap,
  Td,
  Th,
  useUrlFilters,
} from './ui';

// 显式标成 string：`as const` 会把初值推成字面量类型，导致 setter 只接受 `""`。
const FILTER_DEFAULTS: Record<'state' | 'q', string> = {
  state: '',
  q: '',
};

const PAGE_SIZES = [20, 50, 100, 200];

/**
 * 配额阶梯与封禁（RC-29 / RC-37）。
 *
 * 阶梯引擎 `quotaLadderService` 是泛化的「日额度 → 警告 N 次 → 按累计违规次数递增封禁时长」，
 * LibreChat 是第一个消费者。页面只读落库字段；解封仍走 LibreChat 配额管理入口。
 *
 * 两个容易读错的字段：
 *   - `violationCount`（警告数）按**上海自然日**归零，所以它永远很小；
 *   - `banCount`（累计封禁次数）**跨自然日不清零**，升档依据是它，不是警告数。
 */
const RateLimitsLaddersTab: React.FC<{ refreshNonce: number }> = ({ refreshNonce }) => {
  const { setNotification } = useNotification();
  const [filters, patchFilters] = useUrlFilters(FILTER_DEFAULTS);
  const [queryInput, setQueryInput] = useState(filters.q);
  const [limit, setLimit] = useState(20);
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<LadderRow[]>([]);
  const [total, setTotal] = useState(0);
  const [config, setConfig] = useState<{ defaults: Record<string, number>; env: Record<string, string>; note: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const lastNoticeRef = useRef<string | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    try {
      const res = await rateLimitsApi.ladders({ state: filters.state, q: filters.q, limit, offset });
      if (requestId !== requestRef.current) return;
      setRows(res.ladders);
      setTotal(res.total);
      setConfig(res.config);
      setError(null);
      lastNoticeRef.current = null;
    } catch (err) {
      if (requestId !== requestRef.current) return;
      const message = getBackendErrorMessage(err, '读取配额阶梯失败');
      setError(message);
      if (lastNoticeRef.current !== message) {
        lastNoticeRef.current = message;
        setNotification({ message, type: 'error' });
      }
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [filters.q, filters.state, limit, offset, setNotification]);

  useEffect(() => {
    void load();
  }, [load, refreshNonce]);

  useEffect(() => {
    const timer: number = window.setTimeout(() => {
      if (queryInput.trim() !== filters.q) {
        patchFilters({ q: queryInput.trim() });
        setOffset(0);
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [filters.q, patchFilters, queryInput]);

  const apply = useCallback(
    (patch: Partial<Record<keyof typeof FILTER_DEFAULTS, string>>) => {
      patchFilters(patch);
      setOffset(0);
    },
    [patchFilters],
  );

  return (
    <div className="space-y-4">
      <InfoPanel compact>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={queryInput}
            onChange={(event) => setQueryInput(event.target.value)}
            placeholder="按用户名 / 邮箱 / 用户 ID 搜索"
            aria-label="搜索账户"
            className="min-h-11 min-w-[240px] flex-1 rounded-2xl border border-slate-200 bg-white/80 px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none sm:min-h-0"
          />
          <FilterSelect value={filters.state} onChange={(value) => apply({ state: value })} options={LADDER_STATE_OPTIONS} title="封禁状态" />
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
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <span>共 {formatCount(total)} 个账户</span>
          {config ? (
            <InfoBadge tone="slate">
              默认：日额度 {config.defaults.dailyLimit} / 警告 {config.defaults.maxWarnings} / 首次封禁 {config.defaults.banHours}h
            </InfoBadge>
          ) : null}
        </div>
      </InfoPanel>

      {error && rows.length > 0 ? <InlineError message={error} onRetry={() => void load()} /> : null}

      <InfoPanel compact>
        <TableWrap minWidth="min-w-[1040px]">
          <thead>
            <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
              <Th>账户</Th>
              <Th>今日用量</Th>
              <Th>警告（日清零）</Th>
              <Th>累计封禁次数</Th>
              <Th>封禁状态</Th>
              <Th>解封时间</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            <TableState
              loading={loading && rows.length === 0}
              error={error}
              empty={!loading && rows.length === 0}
              emptyText="没有匹配的账户。阶梯字段只在用户使用 LibreChat 或触发违规后才会写入；可清除筛选看全部。"
              colSpan={6}
              onRetry={() => void load()}
            />
            {rows.map((row) => (
              <tr key={row.userId} className="align-top transition hover:bg-slate-50/80">
                <Td>
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="truncate font-semibold text-slate-800">{row.username ?? '-'}</span>
                    <span className="truncate text-[11px] text-slate-400">{row.email ?? '-'}</span>
                    <span className="font-mono text-[11px] text-slate-400">{row.userId}</span>
                  </div>
                </Td>
                <Td>
                  <div className="flex flex-col gap-0.5 text-[11px]">
                    <span className="tabular-nums text-slate-700">{formatCount(row.dailyUsage)}</span>
                    <span className="text-slate-400">{row.usageDay ?? '未使用'}</span>
                  </div>
                </Td>
                <Td><span className="tabular-nums text-slate-700">{formatCount(row.violationCount)}</span></Td>
                <Td>
                  <InfoBadge tone={row.banCount > 0 ? 'amber' : 'slate'} className="tabular-nums">{row.banCount}</InfoBadge>
                </Td>
                <Td>
                  {row.banned ? <InfoBadge tone="rose">封禁中</InfoBadge> : <InfoBadge tone="emerald">未封禁</InfoBadge>}
                </Td>
                <Td>
                  {row.bannedUntil ? (
                    <div className="flex flex-col gap-0.5 text-[11px]">
                      <span className="text-slate-700">{formatTime(row.bannedUntil)}</span>
                      <span className="text-slate-400">{row.banned ? `剩余 ${formatRelativeTime(row.bannedUntil)}` : '已过期'}</span>
                    </div>
                  ) : (
                    <span className="text-slate-400">-</span>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
        <Pager total={total} limit={limit} offset={offset} loading={loading} onChange={setOffset} />
      </InfoPanel>

      {config ? (
        <DataPanel>
          <div className="flex items-start gap-2 text-xs leading-5 text-slate-600">
            <FaLayerGroup className="mt-0.5 shrink-0 text-slate-400" aria-hidden />
            <div className="min-w-0">
              <p className="font-semibold text-slate-700">阶梯口径</p>
              <p className="mt-1">{config.note}</p>
              <FieldGrid className="mt-2">
                {Object.entries(config.env).map(([key, envName]) => (
                  <FieldRow key={key} label={key} value={envName} mono />
                ))}
              </FieldGrid>
            </div>
          </div>
        </DataPanel>
      ) : null}
    </div>
  );
};

export default RateLimitsLaddersTab;
