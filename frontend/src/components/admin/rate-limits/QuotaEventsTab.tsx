import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FaReceipt } from 'react-icons/fa';
import { rateLimitsApi, type QuotaEventRow } from '@/api/rateLimits';
import { InfoBadge, InfoPanel } from '@/components/studioTheme';
import { useNotification } from '@/components/Notification';
import { getBackendErrorMessage } from '@/utils/backendError';
import { formatCount, formatRelativeTime, formatTime } from '../ip-risk-log/format';
import {
  QUOTA_SCOPE_OPTIONS,
  QUOTA_THRESHOLD_OPTIONS,
  SINCE_OPTIONS,
  quotaResourceLabel,
  quotaScopeLabel,
  sinceToIso,
  thresholdStyle,
} from './format';
import {
  Badge,
  DataPanel,
  FilterSelect,
  InlineError,
  JsonBlock,
  Pager,
  RefreshButton,
  TableState,
  TableWrap,
  Td,
  Th,
  useUrlFilters,
} from './ui';

// 显式标成 string：`as const` 会把初值推成字面量类型，导致 setter 只接受 `""`。
const FILTER_DEFAULTS: Record<'scope' | 'threshold' | 'userId' | 'since', string> = {
  scope: '',
  threshold: '',
  userId: '',
  since: '',
};

const PAGE_SIZES = [20, 50, 100, 200];

/**
 * 配额事件（RC-28）。
 *
 * `quota_events` 的去重键是 `(scope, keyId, resource, threshold, periodKey, cycle)`：
 * 同一条事件在一个账期内只写一次；`cycle`（Key 的预算周期序号）保证「充值后再次花掉 80%」
 * 还能再报一次。这张表回答「谁在什么时候碰到了哪条线」，不是实时余额。
 */
const RateLimitsQuotaEventsTab: React.FC<{ refreshNonce: number }> = ({ refreshNonce }) => {
  const { setNotification } = useNotification();
  const [filters, patchFilters] = useUrlFilters(FILTER_DEFAULTS);
  const [userIdInput, setUserIdInput] = useState(filters.userId);
  const [limit, setLimit] = useState(20);
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<QuotaEventRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const lastNoticeRef = useRef<string | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    try {
      const res = await rateLimitsApi.quotaEvents({
        scope: filters.scope,
        threshold: filters.threshold,
        userId: filters.userId,
        since: sinceToIso(filters.since),
        limit,
        offset,
      });
      if (requestId !== requestRef.current) return;
      setRows(res.events);
      setTotal(res.total);
      setError(null);
      lastNoticeRef.current = null;
    } catch (err) {
      if (requestId !== requestRef.current) return;
      const message = getBackendErrorMessage(err, '读取配额事件失败');
      setError(message);
      if (lastNoticeRef.current !== message) {
        lastNoticeRef.current = message;
        setNotification({ message, type: 'error' });
      }
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [filters, limit, offset, setNotification]);

  useEffect(() => {
    void load();
  }, [load, refreshNonce]);

  useEffect(() => {
    const timer: number = window.setTimeout(() => {
      if (userIdInput.trim() !== filters.userId) {
        patchFilters({ userId: userIdInput.trim() });
        setOffset(0);
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [filters.userId, patchFilters, userIdInput]);

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
            value={userIdInput}
            onChange={(event) => setUserIdInput(event.target.value)}
            placeholder="按用户 ID 过滤"
            aria-label="按用户 ID 过滤"
            className="min-h-11 min-w-[220px] flex-1 rounded-2xl border border-slate-200 bg-white/80 px-3 py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none sm:min-h-0"
          />
          <FilterSelect value={filters.scope} onChange={(value) => apply({ scope: value })} options={QUOTA_SCOPE_OPTIONS} title="事件范围" />
          <FilterSelect value={filters.threshold} onChange={(value) => apply({ threshold: value })} options={QUOTA_THRESHOLD_OPTIONS} title="阈值" />
          <FilterSelect value={filters.since} onChange={(value) => apply({ since: value })} options={SINCE_OPTIONS} title="时间窗" />
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
          <span>共 {formatCount(total)} 条事件</span>
          <span className="text-slate-400">事件保留 180 天（TTL）；同一账期同一阈值只写一次。</span>
        </div>
      </InfoPanel>

      {error && rows.length > 0 ? <InlineError message={error} onRetry={() => void load()} /> : null}

      <InfoPanel compact>
        <TableWrap minWidth="min-w-[1080px]">
          <thead>
            <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
              <Th>时间</Th>
              <Th>范围</Th>
              <Th>资源</Th>
              <Th>阈值</Th>
              <Th>账期 / 周期</Th>
              <Th>用户 / Key</Th>
              <Th>code</Th>
              <Th>操作</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            <TableState
              loading={loading && rows.length === 0}
              error={error}
              empty={!loading && rows.length === 0}
              emptyText="当前条件下没有配额事件。账户预算默认处于观察期（API_KEY_ACCOUNT_BUDGET_MODE=off），开启 observe/enforce 后才会产生事件。"
              colSpan={8}
              onRetry={() => void load()}
            />
            {rows.map((row) => (
              <React.Fragment key={row.id}>
                <tr className="align-top transition hover:bg-slate-50/80">
                  <Td>
                    <div className="flex flex-col gap-0.5 text-[11px]">
                      <span className="text-slate-700">{formatTime(row.createdAt)}</span>
                      <span className="text-slate-400">{formatRelativeTime(row.createdAt)}</span>
                    </div>
                  </Td>
                  <Td><InfoBadge tone={row.scope === 'upstream' ? 'rose' : 'slate'}>{quotaScopeLabel(row.scope)}</InfoBadge></Td>
                  <Td>
                    <div className="flex flex-col gap-0.5">
                      <span className="text-[11px] text-slate-700">{quotaResourceLabel(row.resource)}</span>
                      <span className="font-mono text-[10px] text-slate-400">{row.resource}</span>
                    </div>
                  </Td>
                  <Td><Badge style={thresholdStyle(row.threshold)} /></Td>
                  <Td>
                    <div className="flex flex-col gap-0.5 text-[11px] text-slate-600">
                      <span className="font-mono">{row.periodKey}</span>
                      <span className="text-slate-400">周期 #{row.cycle}</span>
                    </div>
                  </Td>
                  <Td>
                    <div className="flex flex-col gap-0.5 text-[11px]">
                      <span className="font-mono text-slate-600">{row.userId ?? '-'}</span>
                      {row.keyId ? <span className="font-mono text-slate-400">key {row.keyId}</span> : null}
                    </div>
                  </Td>
                  <Td><span className="font-mono text-[10px] text-slate-500">{row.code}</span></Td>
                  <Td>
                    <button
                      type="button"
                      onClick={() => setExpandedId(expandedId === row.id ? null : row.id)}
                      aria-expanded={expandedId === row.id}
                      className="whitespace-nowrap rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                    >
                      {expandedId === row.id ? '收起' : 'detail'}
                    </button>
                  </Td>
                </tr>
                {expandedId === row.id ? (
                  <tr>
                    <td colSpan={8} className="bg-slate-50/70 px-3 py-2">
                      <JsonBlock className="max-h-64" value={row.detail} />
                    </td>
                  </tr>
                ) : null}
              </React.Fragment>
            ))}
          </tbody>
        </TableWrap>
        <Pager total={total} limit={limit} offset={offset} loading={loading} onChange={setOffset} />
      </InfoPanel>

      <DataPanel>
        <div className="flex items-start gap-2 text-xs leading-5 text-slate-600">
          <FaReceipt className="mt-0.5 shrink-0 text-slate-400" aria-hidden />
          <div className="min-w-0">
            <p className="font-semibold text-slate-700">上游额度与用户额度的区别</p>
            <p className="mt-1">
              上游耗尽（402 / insufficient_quota / billing hard limit）写独立事件与 error 日志，
              不会冒充用户额度错误 —— 否则用户会以为是自己余额不够。普通 429 限流不算上游耗尽。
            </p>
          </div>
        </div>
      </DataPanel>
    </div>
  );
};

export default RateLimitsQuotaEventsTab;
