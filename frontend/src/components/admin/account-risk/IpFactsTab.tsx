import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FaDatabase, FaSearch } from 'react-icons/fa';
import { accountRiskApi, type AccountRiskIpFactRow } from '@/api/accountRisk';
import { InfoBadge, InfoPanel } from '@/components/studioTheme';
import { useNotification } from '@/components/Notification';
import { getBackendErrorMessage } from '@/utils/backendError';
import { formatCount, formatRelativeTime, formatTime } from '../ip-risk-log/format';
import { DATACENTER_OPTIONS, RISK_LEVEL_OPTIONS } from './format';
import {
  FilterSelect,
  InlineError,
  Pager,
  RefreshButton,
  RiskScoreCell,
  TableState,
  TableWrap,
  Td,
  Th,
  useUrlFilters,
} from './ui';

// 显式标成 string：`as const` 会把初值推成字面量类型，导致 setter 只接受 `""`。
const FILTER_DEFAULTS: Record<'userId' | 'ip' | 'datacenter' | 'level' | 'since', string> = {
  userId: '',
  ip: '',
  datacenter: '',
  level: '',
  since: '',
};

const PAGE_SIZES = [20, 50, 100, 200];

const SINCE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '全部时间' },
  { value: '1', label: '最近 24 小时出现' },
  { value: '7', label: '最近 7 天出现' },
  { value: '30', label: '最近 30 天出现' },
];

const sinceToIso = (days: string): string | undefined => {
  if (!days) return undefined;
  const num = Number(days);
  if (!Number.isFinite(num) || num <= 0) return undefined;
  return new Date(Date.now() - num * 24 * 60 * 60 * 1000).toISOString();
};

/**
 * 账户 × 登录 IP 事实表（`account_ip_signals`）。
 *
 * 为什么这张表重要：`proxycheck_risk_cache` 是 IP 维度、24 小时的临时结论，
 * 一旦过期就查不到「这个账户历史上从哪些高危出口登录过」。这张表是账户维度的长期事实，
 * 也是 RC-14（IDC 出口升档）与 RC-26/56（探测报告归因）的唯一数据源。
 *
 * 取证约束：集合不设 TTL，保留期由 `accountRisk.ipSignalRetentionDays` 表达，
 * 清理必须走应用层任务并在删除前校验 legal hold —— 所以这里只读，不提供删除入口。
 */
const AccountRiskIpFactsTab: React.FC<{ refreshNonce: number }> = ({ refreshNonce }) => {
  const { setNotification } = useNotification();
  const [filters, patchFilters] = useUrlFilters(FILTER_DEFAULTS);
  const [userInput, setUserInput] = useState(filters.userId);
  const [ipInput, setIpInput] = useState(filters.ip);
  const [limit, setLimit] = useState(20);
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<AccountRiskIpFactRow[]>([]);
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
      const res = await accountRiskApi.ipFacts({
        userId: filters.userId,
        ip: filters.ip,
        datacenter: (filters.datacenter as 'true' | 'false' | '') || '',
        level: filters.level,
        since: sinceToIso(filters.since),
        limit,
        offset,
      });
      if (requestId !== requestRef.current) return;
      setRows(res.ipFacts);
      setTotal(res.total);
      setError(null);
      lastNoticeRef.current = null;
    } catch (err) {
      if (requestId !== requestRef.current) return;
      const message = getBackendErrorMessage(err, '读取登录 IP 事实失败');
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
      if (ipInput.trim() !== filters.ip) {
        patchFilters({ ip: ipInput.trim() });
        setOffset(0);
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [filters.ip, ipInput, patchFilters]);

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
          <label className="flex min-w-0 flex-1 items-center gap-2 rounded-2xl border border-slate-200 bg-white/80 px-3">
            <FaSearch className="shrink-0 text-slate-400" aria-hidden />
            <input
              type="search"
              value={userInput}
              onChange={(event) => setUserInput(event.target.value)}
              placeholder="按用户 ID 过滤"
              aria-label="按用户 ID 过滤"
              className="min-h-11 w-full min-w-0 bg-transparent py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none sm:min-h-0"
            />
          </label>
          <label className="flex min-w-0 flex-1 items-center gap-2 rounded-2xl border border-slate-200 bg-white/80 px-3">
            <FaSearch className="shrink-0 text-slate-400" aria-hidden />
            <input
              type="search"
              value={ipInput}
              onChange={(event) => setIpInput(event.target.value)}
              placeholder="按 IP 精确过滤（同 IP 跨账户反查）"
              aria-label="按 IP 过滤"
              className="min-h-11 w-full min-w-0 bg-transparent py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none sm:min-h-0"
            />
          </label>
          <FilterSelect value={filters.datacenter} onChange={(value) => apply({ datacenter: value })} options={DATACENTER_OPTIONS} title="出口类型" />
          <FilterSelect value={filters.level} onChange={(value) => apply({ level: value })} options={RISK_LEVEL_OPTIONS} title="风险等级" />
          <FilterSelect value={filters.since} onChange={(value) => apply({ since: value })} options={SINCE_OPTIONS} title="最近出现时间" />
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
          <span>共 {formatCount(total)} 条事实</span>
          {filters.datacenter === 'true' ? <InfoBadge tone="amber">仅 IDC / 机房出口</InfoBadge> : null}
          <span className="text-slate-400">同一账户对一个 IP 只留一行，重复登录累加次数。</span>
        </div>
      </InfoPanel>

      {error && rows.length > 0 ? <InlineError message={error} onRetry={() => void load()} /> : null}

      <InfoPanel compact>
        <TableWrap minWidth="min-w-[1120px]">
          <thead>
            <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
              <Th>账户</Th>
              <Th>IP / 属地</Th>
              <Th>登录次数</Th>
              <Th>风险</Th>
              <Th>网络 / ASN</Th>
              <Th>组织</Th>
              <Th>来源</Th>
              <Th>首 / 末次</Th>
              <Th>操作</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            <TableState
              loading={loading && rows.length === 0}
              error={error}
              empty={!loading && rows.length === 0}
              emptyText="没有登录 IP 事实。该表在登录成功路径上写入（accountRisk.evaluateOnLogin）；可清除筛选或放宽时间窗。"
              colSpan={9}
              onRetry={() => void load()}
            />
            {rows.map((row) => (
              <React.Fragment key={row.id}>
                <tr className="align-top transition hover:bg-slate-50/80">
                  <Td><span className="font-mono text-[11px] text-slate-600">{row.userId ?? '-'}</span></Td>
                  <Td>
                    <div className="flex flex-col gap-0.5">
                      <span className="font-mono text-[11px] text-slate-700">{row.ip ?? '-'}</span>
                      <span className="text-[11px] text-slate-400">{row.ipLocation || '-'}</span>
                    </div>
                  </Td>
                  <Td><span className="tabular-nums">{formatCount(row.loginCount)}</span></Td>
                  <Td>
                    <div className="flex flex-wrap items-center gap-1">
                      <RiskScoreCell score={row.riskScore} />
                      {row.riskLevel ? <InfoBadge tone={row.riskLevel === 'high' || row.riskLevel === 'critical' ? 'rose' : 'slate'}>{row.riskLevel}</InfoBadge> : null}
                      {row.isDatacenter ? <InfoBadge tone="amber">IDC</InfoBadge> : null}
                    </div>
                  </Td>
                  <Td>
                    <div className="flex flex-col gap-0.5 text-[11px] text-slate-600">
                      <span>{row.networkType || '-'}</span>
                      <span className="text-slate-400">{row.asn || '-'}</span>
                    </div>
                  </Td>
                  <Td><span className="max-w-[180px] truncate text-[11px] text-slate-600" title={row.organisation ?? undefined}>{row.organisation || '-'}</span></Td>
                  <Td>
                    <div className="flex flex-col gap-0.5 text-[11px]">
                      <span className="text-slate-600">{row.source}</span>
                      <span className="text-slate-400">{row.riskCheckedAt ? formatRelativeTime(row.riskCheckedAt) : '未核查'}</span>
                    </div>
                  </Td>
                  <Td>
                    <div className="flex flex-col gap-0.5 text-[11px] text-slate-500">
                      <span>{formatRelativeTime(row.firstSeenAt)}</span>
                      <span>{formatRelativeTime(row.lastSeenAt)}</span>
                    </div>
                  </Td>
                  <Td>
                    <button
                      type="button"
                      onClick={() => setExpandedId(expandedId === row.id ? null : row.id)}
                      aria-expanded={expandedId === row.id}
                      className="whitespace-nowrap rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                    >
                      {expandedId === row.id ? '收起' : '事实'}
                    </button>
                  </Td>
                </tr>
                {expandedId === row.id ? (
                  <tr>
                    <td colSpan={9} className="bg-slate-50/70 px-3 py-2">
                      <div className="grid gap-x-6 gap-y-1 text-[11px] text-slate-600 sm:grid-cols-2">
                        <span>首次出现：{formatTime(row.firstSeenAt)}</span>
                        <span>最后出现：{formatTime(row.lastSeenAt)}</span>
                        <span>风险核查于：{formatTime(row.riskCheckedAt)}</span>
                        <span>结论来源：{row.source === 'cache' ? '命中 proxycheck 缓存' : row.source === 'proxycheck' ? '同步补查上游' : '暂无结论'}</span>
                        <span className="sm:col-span-2">旗标：{row.flags.length > 0 ? row.flags.join('、') : '-'}</span>
                      </div>
                      <div className="mt-1.5 flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setUserInput(row.userId ?? '');
                            apply({ userId: row.userId ?? '' });
                          }}
                          className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-600 hover:border-slate-300 hover:text-slate-900"
                        >
                          看该账户全部 IP
                        </button>
                        <span className="rounded-full border border-dashed border-slate-200 px-2.5 py-1 text-[11px] text-slate-400">
                          列表 IP 已打码；跨账户精确反查请把完整 IP 粘进上方搜索框
                        </span>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </React.Fragment>
            ))}
          </tbody>
        </TableWrap>
        <Pager total={total} limit={limit} offset={offset} loading={loading} onChange={setOffset} />
      </InfoPanel>

      <InfoPanel compact>
        <div className="flex items-start gap-2 text-xs leading-5 text-slate-500">
          <FaDatabase className="mt-0.5 shrink-0 text-slate-400" aria-hidden />
          <span>
            本表不设 TTL：保留期由 <code className="rounded bg-slate-100 px-1">accountRisk.ipSignalRetentionDays</code> 表达，
            清理走应用层任务并在删除前校验法律保留。因此页面不提供删除入口 —— 需要清理由取证流程处理。
          </span>
        </div>
      </InfoPanel>
    </div>
  );
};

export default AccountRiskIpFactsTab;
