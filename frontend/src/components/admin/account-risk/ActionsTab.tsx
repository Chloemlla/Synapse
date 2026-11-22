import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FaGavel, FaSearch } from 'react-icons/fa';
import { accountRiskApi, type AccountRiskActionRow } from '@/api/accountRisk';
import { InfoBadge, InfoPanel } from '@/components/studioTheme';
import { useNotification } from '@/components/Notification';
import { getBackendErrorMessage } from '@/utils/backendError';
import { formatCount, formatRelativeTime, formatTime } from '../ip-risk-log/format';
import { ACTION_OPTIONS, actionLabel, tierConfig } from './format';
import {
  FilterSelect,
  InlineError,
  JsonBlock,
  Pager,
  RefreshButton,
  TableState,
  TableWrap,
  Td,
  Th,
  TierBadge,
  useUrlFilters,
} from './ui';

const FILTER_DEFAULTS = {
  userId: '',
  action: '',
  operatorId: '',
  since: '',
} as const;

const PAGE_SIZES = [20, 50, 100, 200];

const SINCE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '全部时间' },
  { value: '1', label: '最近 24 小时' },
  { value: '7', label: '最近 7 天' },
  { value: '30', label: '最近 30 天' },
  { value: '180', label: '最近 180 天' },
];

const sinceToIso = (days: string): string | undefined => {
  if (!days) return undefined;
  const num = Number(days);
  if (!Number.isFinite(num) || num <= 0) return undefined;
  return new Date(Date.now() - num * 24 * 60 * 60 * 1000).toISOString();
};

/**
 * 处置记录：账户风险动作与档位变化。
 *
 * 为什么单独一页签而不是塞进信号表：这两类事件的**语义不同**。
 * 信号是「系统观察到的证据」，处置是「人（或自动规则）据此做的决定」。
 * 混在一起会让「谁在什么时候把谁推进了受限档」被大量登录信号淹没。
 *
 * 数据源是 `security_events` 里的 `ACCOUNT_RISK_ACTION` / `ACCOUNT_RISK_TIER_CHANGED`，
 * 由唯一出口 `applyAccountRiskAction` 写入；本页只读。
 */
const AccountRiskActionsTab: React.FC<{ refreshNonce: number }> = ({ refreshNonce }) => {
  const { setNotification } = useNotification();
  const [filters, patchFilters] = useUrlFilters(FILTER_DEFAULTS);
  const [userInput, setUserInput] = useState(filters.userId);
  const [operatorInput, setOperatorInput] = useState(filters.operatorId);
  const [limit, setLimit] = useState(20);
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<AccountRiskActionRow[]>([]);
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
      const res = await accountRiskApi.actions({
        userId: filters.userId,
        action: filters.action,
        operatorId: filters.operatorId,
        since: sinceToIso(filters.since),
        limit,
        offset,
      });
      if (requestId !== requestRef.current) return;
      setRows(res.actions);
      setTotal(res.total);
      setError(null);
      lastNoticeRef.current = null;
    } catch (err) {
      if (requestId !== requestRef.current) return;
      const message = getBackendErrorMessage(err, '读取处置记录失败');
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
      if (userInput.trim() !== filters.userId) {
        patchFilters({ userId: userInput.trim() });
        setOffset(0);
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [filters.userId, patchFilters, userInput]);

  useEffect(() => {
    const timer: number = window.setTimeout(() => {
      if (operatorInput.trim() !== filters.operatorId) {
        patchFilters({ operatorId: operatorInput.trim() });
        setOffset(0);
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [filters.operatorId, operatorInput, patchFilters]);

  const apply = useCallback(
    (patch: Partial<Record<keyof typeof FILTER_DEFAULTS, string>>) => {
      patchFilters(patch);
      setOffset(0);
    },
    [patchFilters],
  );

  const autoCount = rows.filter((row) => row.automatic).length;

  return (
    <div className="space-y-4">
      <InfoPanel compact>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex min-w-0 flex-1 items-center gap-2 rounded-2xl border border-slate-200 bg-white/80 px-3">
            <FaSearch className="shrink-0 text-slate-400" aria-hidden />
            <input
              type="search"
              value={userInput}
              onChange={(event) => setUserInput(event.target.value)}
              placeholder="按目标用户 ID 过滤"
              aria-label="按目标用户过滤"
              className="min-h-11 w-full min-w-0 bg-transparent py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none sm:min-h-0"
            />
          </label>
          <label className="flex min-w-0 flex-1 items-center gap-2 rounded-2xl border border-slate-200 bg-white/80 px-3">
            <FaSearch className="shrink-0 text-slate-400" aria-hidden />
            <input
              type="search"
              value={operatorInput}
              onChange={(event) => setOperatorInput(event.target.value)}
              placeholder="按操作者 ID 过滤（auto = 自动规则）"
              aria-label="按操作者过滤"
              className="min-h-11 w-full min-w-0 bg-transparent py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none sm:min-h-0"
            />
          </label>
          <FilterSelect value={filters.action} onChange={(value) => apply({ action: value })} options={ACTION_OPTIONS} title="动作" />
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
          <span>共 {formatCount(total)} 条处置记录</span>
          {autoCount > 0 ? <InfoBadge tone="amber">本页 {autoCount} 条由自动规则产生</InfoBadge> : null}
          <span className="text-slate-400">所有处置都经服务端 applyAccountRiskAction 单一出口写库并留痕。</span>
        </div>
      </InfoPanel>

      {error && rows.length > 0 ? <InlineError message={error} onRetry={() => void load()} /> : null}

      <InfoPanel compact>
        <TableWrap minWidth="min-w-[1020px]">
          <thead>
            <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
              <Th>时间</Th>
              <Th>目标账户</Th>
              <Th>动作</Th>
              <Th>档位变化</Th>
              <Th>操作者</Th>
              <Th>理由</Th>
              <Th>操作</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            <TableState
              loading={loading && rows.length === 0}
              error={error}
              empty={!loading && rows.length === 0}
              emptyText="还没有风险处置记录。管理员在用户管理页执行封停 / 标记观察 / 设受限 / 解除时会写入这里。"
              colSpan={7}
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
                  <Td><span className="font-mono text-[11px] text-slate-600">{row.userId ?? '-'}</span></Td>
                  <Td>
                    <div className="flex flex-col gap-1">
                      <InfoBadge tone={row.automatic ? 'amber' : 'sky'} className="w-fit whitespace-nowrap">
                        {actionLabel(row.action)}
                      </InfoBadge>
                      <span className="font-mono text-[10px] text-slate-400">{row.eventType}</span>
                    </div>
                  </Td>
                  <Td>
                    <div className="flex flex-wrap items-center gap-1">
                      {row.fromTier ? <TierBadge tier={row.fromTier} /> : <span className="text-slate-400">-</span>}
                      <span className="text-slate-400">→</span>
                      {row.toTier ? <TierBadge tier={row.toTier} /> : <span className="text-slate-400">-</span>}
                    </div>
                  </Td>
                  <Td>
                    <span className="text-[11px] text-slate-600">
                      {row.operatorId === 'auto' ? '自动规则' : row.operatorId ?? '-'}
                    </span>
                  </Td>
                  <Td>
                    <span className="block max-w-[260px] truncate text-[11px] text-slate-600" title={row.reason ?? undefined}>
                      {row.reason || '-'}
                    </span>
                  </Td>
                  <Td>
                    <button
                      type="button"
                      onClick={() => setExpandedId(expandedId === row.id ? null : row.id)}
                      aria-expanded={expandedId === row.id}
                      className="whitespace-nowrap rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                    >
                      {expandedId === row.id ? '收起' : '载荷'}
                    </button>
                  </Td>
                </tr>
                {expandedId === row.id ? (
                  <tr>
                    <td colSpan={7} className="bg-slate-50/70 px-3 py-2">
                      <div className="flex items-center gap-2 text-[11px] text-slate-500">
                        <FaGavel aria-hidden />
                        <span>
                          动作 {actionLabel(row.action)}；当前档位说明：{tierConfig(row.toTier).hint}
                        </span>
                      </div>
                      <JsonBlock className="mt-1.5 max-h-64" value={row.eventData} />
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

export default AccountRiskActionsTab;
