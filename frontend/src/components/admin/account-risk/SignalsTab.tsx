import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FaSearch, FaUserTag } from 'react-icons/fa';
import { accountRiskApi, type AccountRiskSignalRow } from '@/api/accountRisk';
import { InfoBadge, InfoPanel } from '@/components/studioTheme';
import { useNotification } from '@/components/Notification';
import { cn } from '@/lib/utils';
import { getBackendErrorMessage } from '@/utils/backendError';
import { formatCount, formatRelativeTime, formatTime } from '../ip-risk-log/format';
import { SIGNAL_SORT_OPTIONS, eventTypeLabel, isRiskActionEvent } from './format';
import { AccountRiskDetailModal } from './AccountsTab';
import {
  FilterSelect,
  InlineError,
  JsonBlock,
  Pager,
  RefreshButton,
  RiskScoreCell,
  TableState,
  TableWrap,
  Td,
  Th,
  useUrlFilters,
} from './ui';

const FILTER_DEFAULTS = {
  userId: '',
  eventType: '',
  ip: '',
  anonymous: '',
  since: '',
  sort: 'recent',
} as const;

const PAGE_SIZES = [20, 50, 100, 200];

const SINCE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '全部时间' },
  { value: '1', label: '最近 24 小时' },
  { value: '7', label: '最近 7 天' },
  { value: '30', label: '最近 30 天' },
];

const sinceToIso = (days: string): string | undefined => {
  if (!days) return undefined;
  const num = Number(days);
  if (!Number.isFinite(num) || num <= 0) return undefined;
  return new Date(Date.now() - num * 24 * 60 * 60 * 1000).toISOString();
};

/**
 * 账户级信号表（`security_events`）。
 *
 * 这里不是「审计日志」：它只含账户风险聚合会消费的那批事件（`ACCOUNT_ABUSE_*`、`AUTOMATION_TRACE`
 * 与 `ACCOUNT_RISK_*` 处置记录）。通用操作审计另有 `/admin/audit-log` 页面。
 *
 * 行可展开：`eventData` 已经过服务端脱敏（与日志同一份敏感字段名单），展开是为了核对
 * 「这条信号到底带了什么事实」，而不是看原始载荷。
 */
const AccountRiskSignalsTab: React.FC<{ refreshNonce: number }> = ({ refreshNonce }) => {
  const { setNotification } = useNotification();
  const [filters, patchFilters] = useUrlFilters(FILTER_DEFAULTS);
  const [userIdInput, setUserIdInput] = useState(filters.userId);
  const [limit, setLimit] = useState(20);
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<AccountRiskSignalRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detailUserId, setDetailUserId] = useState<string | null>(null);
  const lastNoticeRef = useRef<string | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    try {
      const res = await accountRiskApi.signals({
        userId: filters.userId,
        eventType: filters.eventType,
        ip: filters.ip,
        anonymous: filters.anonymous === 'true' ? true : undefined,
        since: sinceToIso(filters.since),
        sort: filters.sort as 'recent' | 'oldest',
        limit,
        offset,
      });
      if (requestId !== requestRef.current) return;
      setRows(res.signals);
      setTotal(res.total);
      setError(null);
      lastNoticeRef.current = null;
    } catch (err) {
      if (requestId !== requestRef.current) return;
      const message = getBackendErrorMessage(err, '读取账户信号失败');
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

  const eventTypeOptions = useMemo(
    () => [
      { value: '', label: '全部事件类型' },
      { value: 'ACCOUNT_ABUSE_IDC_EGRESS', label: 'IDC 出口命中' },
      { value: 'ACCOUNT_ABUSE_GEO_JUMP', label: '跨地域跳变' },
      { value: 'ACCOUNT_ABUSE_CAPTCHA_FAILED', label: '人机验证失败' },
      { value: 'AUTOMATION_TRACE', label: '自动化痕迹' },
      { value: 'ACCOUNT_RISK_ACTION', label: '风险处置' },
      { value: 'ACCOUNT_RISK_TIER_CHANGED', label: '档位变化' },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <InfoPanel compact>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex min-w-0 flex-1 items-center gap-2 rounded-2xl border border-slate-200 bg-white/80 px-3">
            <FaSearch className="shrink-0 text-slate-400" aria-hidden />
            <input
              type="search"
              value={userIdInput}
              onChange={(event) => setUserIdInput(event.target.value)}
              placeholder="按用户 ID 过滤"
              aria-label="按用户 ID 过滤"
              className="min-h-11 w-full min-w-0 bg-transparent py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none sm:min-h-0"
            />
          </label>
          <FilterSelect value={filters.eventType} onChange={(value) => apply({ eventType: value })} options={eventTypeOptions} title="事件类型" />
          <FilterSelect value={filters.since} onChange={(value) => apply({ since: value })} options={SINCE_OPTIONS} title="时间窗" />
          <FilterSelect value={filters.sort} onChange={(value) => apply({ sort: value })} options={SIGNAL_SORT_OPTIONS} title="排序" />
          <FilterSelect
            value={filters.anonymous}
            onChange={(value) => apply({ anonymous: value })}
            options={[
              { value: '', label: '含全部来源' },
              { value: 'true', label: '仅匿名来源' },
            ]}
            title="来源"
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
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <span>共 {formatCount(total)} 条信号</span>
          {filters.userId ? (
            <InfoBadge tone="sky">
              用户 {filters.userId}
              <button type="button" onClick={() => { setUserIdInput(''); apply({ userId: '' }); }} className="ml-1.5 underline-offset-2 hover:underline">
                清除
              </button>
            </InfoBadge>
          ) : null}
          {filters.anonymous === 'true' ? <InfoBadge tone="amber">只看匿名来源</InfoBadge> : null}
          <span className="text-slate-400">匿名来源事件按半权重计分，单独到不了观察档。</span>
        </div>
      </InfoPanel>

      {error && rows.length > 0 ? <InlineError message={error} onRetry={() => void load()} /> : null}

      <InfoPanel compact>
        <TableWrap minWidth="min-w-[980px]">
          <thead>
            <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
              <Th>时间</Th>
              <Th>事件</Th>
              <Th>账户</Th>
              <Th>IP</Th>
              <Th>指纹</Th>
              <Th>风险分</Th>
              <Th>来源</Th>
              <Th>操作</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            <TableState
              loading={loading && rows.length === 0}
              error={error}
              empty={!loading && rows.length === 0}
              emptyText="当前条件下没有信号。风险信号由登录、首访验证与客户端上报写入；可放宽时间窗或清除筛选。"
              colSpan={8}
              onRetry={() => void load()}
            />
            {rows.map((row) => (
              <React.Fragment key={row.id}>
                <tr className={cn('align-top transition hover:bg-slate-50/80', expandedId === row.id && 'bg-slate-50/60')}>
                  <Td>
                    <div className="flex flex-col gap-0.5 text-[11px]">
                      <span className="text-slate-700">{formatTime(row.createdAt)}</span>
                      <span className="text-slate-400">{formatRelativeTime(row.createdAt)}</span>
                    </div>
                  </Td>
                  <Td>
                    <div className="flex flex-col gap-1">
                      <InfoBadge tone={isRiskActionEvent(row.eventType) ? 'slate' : 'sky'} className="w-fit whitespace-nowrap">
                        {eventTypeLabel(row.eventType)}
                      </InfoBadge>
                      <span className="font-mono text-[10px] text-slate-400">{row.eventType}</span>
                    </div>
                  </Td>
                  <Td>
                    {row.userId ? (
                      <button
                        type="button"
                        onClick={() => setDetailUserId(row.userId)}
                        className="font-mono text-[11px] text-slate-600 underline-offset-2 hover:text-slate-900 hover:underline"
                        title="查看该账户的风险详情"
                      >
                        {row.userId}
                      </button>
                    ) : (
                      <span className="text-slate-400">-</span>
                    )}
                  </Td>
                  <Td><span className="font-mono text-[11px]">{row.ip ?? '-'}</span></Td>
                  <Td><span className="font-mono text-[11px] text-slate-500">{row.deviceFingerprint ?? '-'}</span></Td>
                  <Td><RiskScoreCell score={row.riskScore} /></Td>
                  <Td>
                    {row.anonymous ? <InfoBadge tone="amber">匿名</InfoBadge> : <InfoBadge tone="slate">已认证</InfoBadge>}
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
                    <td colSpan={8} className="bg-slate-50/70 px-3 py-2">
                      <div className="flex items-center gap-2 text-[11px] text-slate-500">
                        <FaUserTag aria-hidden />
                        <span>事件载荷（服务端已递归脱敏；空值表示这条事件没有附加事实）</span>
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

      <AccountRiskDetailModal userId={detailUserId} onClose={() => setDetailUserId(null)} />
    </div>
  );
};

export default AccountRiskSignalsTab;
