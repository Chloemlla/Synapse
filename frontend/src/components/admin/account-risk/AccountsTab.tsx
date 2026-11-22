import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { FaExternalLinkAlt, FaSearch, FaSync, FaUserSlash } from 'react-icons/fa';
import {
  accountRiskApi,
  type AccountRiskAccountDetailResponse,
  type AccountRiskAccountRow,
} from '@/api/accountRisk';
import { InfoBadge, InfoPanel, studioSecondaryButtonClassName } from '@/components/studioTheme';
import { StudioErrorState, StudioLoadingState, StudioModal } from '@/components/studioFeedback';
import { useNotification } from '@/components/Notification';
import { cn } from '@/lib/utils';
import { getBackendErrorMessage } from '@/utils/backendError';
import { formatCount, formatRelativeTime, formatTime } from '../ip-risk-log/format';
import {
  ACCOUNT_SORT_OPTIONS,
  STATUS_OPTIONS,
  TIER_OPTIONS,
  eventTypeLabel,
  riskFlagLabel,
  tierConfig,
} from './format';
import {
  Collapsible,
  CopyIconButton,
  DataPanel,
  FieldGrid,
  FieldRow,
  FilterSelect,
  FlagList,
  InlineError,
  JsonBlock,
  Pager,
  RefreshButton,
  RiskScoreCell,
  TableState,
  TableWrap,
  Td,
  Th,
  TierBadge,
  useUrlFilters,
} from './ui';

const FILTER_DEFAULTS = {
  q: '',
  tier: '',
  status: '',
  flag: '',
  sort: 'risk_desc',
} as const;

type AccountsFilterKey = keyof typeof FILTER_DEFAULTS;

const PAGE_SIZES = [20, 50, 100, 200];

/**
 * 账户风险列表。
 *
 * 为什么展开行而不是跳页看详情：管理员在这张表上的动作是「扫一眼 → 判断要不要处置」，
 * 跳到另一页会丢掉筛选上下文。展开行直接给最近信号、登录 IP 事实与处置记录。
 */
const AccountRiskAccountsTab: React.FC<{ refreshNonce: number }> = ({ refreshNonce }) => {
  const { setNotification } = useNotification();
  const [filters, patchFilters] = useUrlFilters(FILTER_DEFAULTS);
  const [searchInput, setSearchInput] = useState(filters.q);
  const [sort, setSort] = useState<string>(filters.sort);
  const [limit, setLimit] = useState(20);
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<AccountRiskAccountRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const lastNoticeRef = useRef<string | null>(null);
  const requestRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    try {
      const res = await accountRiskApi.accounts({
        q: filters.q,
        tier: filters.tier,
        status: filters.status,
        flag: filters.flag,
        sort: sort as 'risk_desc' | 'recent' | 'created',
        limit,
        offset,
      });
      if (requestId !== requestRef.current) return;
      setRows(res.accounts);
      setTotal(res.total);
      setError(null);
      setLastUpdatedAt(Date.now());
      lastNoticeRef.current = null;
    } catch (err) {
      if (requestId !== requestRef.current) return;
      const message = getBackendErrorMessage(err, '读取账户风险列表失败');
      setError(message);
      if (lastNoticeRef.current !== message) {
        lastNoticeRef.current = message;
        setNotification({ message, type: 'error' });
      }
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [filters.flag, filters.q, filters.status, filters.tier, limit, offset, setNotification, sort]);

  useEffect(() => {
    void load();
  }, [load, refreshNonce]);

  // 搜索防抖：输入框与 URL 分离，避免每敲一个字就重新查库。
  useEffect(() => {
    const timer: number = window.setTimeout(() => {
      if (searchInput !== filters.q) {
        patchFilters({ q: searchInput });
        setOffset(0);
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [filters.q, patchFilters, searchInput]);

  const applyFilter = useCallback(
    (key: AccountsFilterKey, value: string) => {
      patchFilters({ [key]: value } as Partial<Record<AccountsFilterKey, string>>);
      setOffset(0);
    },
    [patchFilters],
  );

  const activeFilterCount = useMemo(
    () => [filters.q, filters.tier, filters.status, filters.flag].filter(Boolean).length,
    [filters.flag, filters.q, filters.status, filters.tier],
  );

  return (
    <div className="space-y-4">
      <InfoPanel compact>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex min-w-0 flex-1 items-center gap-2 rounded-2xl border border-slate-200 bg-white/80 px-3">
            <FaSearch className="shrink-0 text-slate-400" aria-hidden />
            <input
              type="search"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="按用户名 / 邮箱 / 用户 ID 搜索"
              aria-label="搜索账户"
              className="min-h-11 w-full min-w-0 bg-transparent py-1.5 text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none sm:min-h-0"
            />
          </label>
          <FilterSelect value={filters.tier} onChange={(value) => applyFilter('tier', value)} options={TIER_OPTIONS} title="风险档" />
          <FilterSelect value={filters.status} onChange={(value) => applyFilter('status', value)} options={STATUS_OPTIONS} title="账户状态" />
          <FilterSelect
            value={sort}
            onChange={(value) => {
              setSort(value);
              patchFilters({ sort: value });
              setOffset(0);
            }}
            options={ACCOUNT_SORT_OPTIONS}
            title="排序"
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
          <span>共 {formatCount(total)} 个账户</span>
          {activeFilterCount > 0 ? <InfoBadge tone="sky">{activeFilterCount} 个筛选条件</InfoBadge> : null}
          {filters.flag ? (
            <InfoBadge tone="amber">
              旗标：{riskFlagLabel(filters.flag)}
              <button
                type="button"
                onClick={() => applyFilter('flag', '')}
                className="ml-1.5 underline-offset-2 hover:underline"
                aria-label="清除旗标筛选"
              >
                清除
              </button>
            </InfoBadge>
          ) : null}
          <span className="text-slate-400" title="riskScore 越高越危险；与账户安全摘要方向相反">
            {lastUpdatedAt ? `更新于 ${formatRelativeTime(lastUpdatedAt)}` : '尚未加载'}
          </span>
        </div>
      </InfoPanel>

      {error && rows.length > 0 ? <InlineError message={error} onRetry={() => void load()} /> : null}

      <InfoPanel compact>
        <TableWrap minWidth="min-w-[1040px]">
          <thead>
            <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
              <Th>账户</Th>
              <Th>档位</Th>
              <Th>风险分</Th>
              <Th>旗标</Th>
              <Th>状态</Th>
              <Th>最近评估</Th>
              <Th>最近登录</Th>
              <Th>操作</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            <TableState
              loading={loading && rows.length === 0}
              error={error}
              empty={!loading && rows.length === 0}
              emptyText="没有符合当前筛选的账户。风险档由 accountRisk 聚合任务写入；也可清除筛选看全部账户。"
              colSpan={8}
              onRetry={() => void load()}
            />
            {rows.map((row) => (
              <React.Fragment key={row.id}>
                <tr className={cn('align-top transition hover:bg-slate-50/80', expandedId === row.id && 'bg-slate-50/60')}>
                  <Td>
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate font-semibold text-slate-800">{row.username ?? '-'}</span>
                        {row.role !== 'user' ? <InfoBadge tone={row.role === 'superadmin' ? 'rose' : 'sky'}>{row.role}</InfoBadge> : null}
                      </span>
                      <span className="truncate text-[11px] text-slate-400" title={row.email ?? undefined}>{row.email ?? '-'}</span>
                      <span className="flex items-center gap-1 font-mono text-[11px] text-slate-400">
                        {row.id}
                        <CopyIconButton getValue={() => row.id} title="复制用户 ID" />
                      </span>
                    </div>
                  </Td>
                  <Td><TierBadge tier={row.riskTier} /></Td>
                  <Td><RiskScoreCell score={row.riskScore} /></Td>
                  <Td><FlagList flags={row.riskFlags} /></Td>
                  <Td>
                    <div className="flex flex-col gap-1">
                      <InfoBadge tone={row.accountStatus === 'suspended' ? 'rose' : 'emerald'}>
                        {row.accountStatus === 'suspended' ? '已封停' : '正常'}
                      </InfoBadge>
                      {row.stepUpUntil ? (
                        <InfoBadge tone="amber" className="whitespace-nowrap">逐步验证至 {formatTime(row.stepUpUntil)}</InfoBadge>
                      ) : null}
                    </div>
                  </Td>
                  <Td>
                    <div className="flex flex-col gap-0.5 text-[11px]">
                      <span className="text-slate-600">{formatRelativeTime(row.riskUpdatedAt)}</span>
                      {row.flagReason ? <span className="max-w-[220px] truncate text-slate-400" title={row.flagReason}>{row.flagReason}</span> : null}
                      {row.flaggedBy ? <span className="text-slate-400">处置人 {row.flaggedBy}</span> : null}
                    </div>
                  </Td>
                  <Td>
                    <div className="flex flex-col gap-0.5 text-[11px]">
                      <span className="text-slate-600">{row.lastLoginIp ?? '-'}</span>
                      <span className="text-slate-400">{formatRelativeTime(row.lastLoginAt)}</span>
                    </div>
                  </Td>
                  <Td>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => setExpandedId(expandedId === row.id ? null : row.id)}
                        aria-expanded={expandedId === row.id}
                        className={cn(studioSecondaryButtonClassName, 'whitespace-nowrap px-2.5 py-1 text-[11px]')}
                      >
                        {expandedId === row.id ? '收起' : '详情'}
                      </button>
                      <Link
                        to={`/admin/users?focus=${encodeURIComponent(row.id)}`}
                        className={cn(studioSecondaryButtonClassName, 'whitespace-nowrap px-2.5 py-1 text-[11px]')}
                        title="跳到用户管理页处置（封停 / 标记观察 / 设受限）"
                      >
                        <FaExternalLinkAlt className="mr-1 inline" />去处置
                      </Link>
                    </div>
                  </Td>
                </tr>
                {expandedId === row.id ? (
                  <tr>
                    <td colSpan={8} className="bg-slate-50/70 px-3 py-3">
                      <AccountRiskDetail userId={row.id} />
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

/** 展开行：直接拉单账户详情，避免把跨账户详情塞进列表响应。 */
const AccountRiskDetail: React.FC<{ userId: string }> = ({ userId }) => {
  const [detail, setDetail] = useState<AccountRiskAccountDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setDetail(await accountRiskApi.accountDetail(userId));
      setError(null);
    } catch (err) {
      setError(getBackendErrorMessage(err, '读取账户风险详情失败'));
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !detail) return <StudioLoadingState minHeightClassName="min-h-[160px]" text="正在读取账户详情…" />;
  if (error && !detail) return <StudioErrorState message={error} onRetry={() => void load()} />;
  if (!detail) return null;

  const { account, channels, signals, ipFacts, actions } = detail;
  const lockedChannels = channels.filter((channel) => channel.locked);

  return (
    <div className="space-y-3">
      <div className="grid gap-3 lg:grid-cols-2">
        <DataPanel>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">账户事实</h4>
          <FieldGrid>
            <FieldRow label="风险档" value={tierConfig(account.riskTier).label} />
            <FieldRow label="风险分" value={<RiskScoreCell score={account.riskScore} />} />
            <FieldRow label="旗标" value={<FlagList flags={account.riskFlags} max={account.riskFlags.length} />} />
            <FieldRow label="最近评估" value={formatTime(account.riskUpdatedAt)} />
            <FieldRow label="处置人" value={account.flaggedBy} />
            <FieldRow label="处置理由" value={account.flagReason} />
            <FieldRow label="逐步验证到期" value={formatTime(account.stepUpUntil)} />
            <FieldRow label="逐步验证范围" value={account.stepUpMode} />
            <FieldRow label="账户创建" value={formatTime(account.createdAt)} />
            <FieldRow label="最近登录 IP" value={account.lastLoginIp} mono />
          </FieldGrid>
        </DataPanel>

        <DataPanel>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">通道准入（当前档位）</h4>
          {lockedChannels.length === 0 ? (
            <p className="mt-2 text-xs text-slate-500">当前档位没有冻结任何通道。</p>
          ) : (
            <p className="mt-1 text-xs text-slate-500">
              已冻结 {lockedChannels.length} 个通道；申诉入口：
              {lockedChannels[0]?.appealChannel === 'ticket' ? '工单' : '支持邮箱'}。
            </p>
          )}
          <ul className="mt-2 grid grid-cols-2 gap-1.5">
            {channels.map((channel) => (
              <li key={channel.channel} className="flex items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-white/80 px-2.5 py-1.5 text-[11px]">
                <span className="min-w-0 truncate text-slate-600">{channel.channel}</span>
                <InfoBadge tone={channel.locked ? 'rose' : 'emerald'}>{channel.locked ? '冻结' : '开放'}</InfoBadge>
              </li>
            ))}
          </ul>
        </DataPanel>
      </div>

      <Collapsible title="最近 30 天信号" count={signals.length} defaultOpen>
        {signals.length === 0 ? (
          <p className="text-xs text-slate-500">最近 30 天没有账户级信号。</p>
        ) : (
          <ul className="space-y-1.5">
            {signals.map((signal) => (
              <li key={signal.id} className="rounded-2xl border border-slate-200 bg-white/80 px-2.5 py-1.5 text-[11px]">
                <div className="flex flex-wrap items-center gap-2 text-slate-600">
                  <InfoBadge tone="sky">{eventTypeLabel(signal.eventType)}</InfoBadge>
                  {signal.anonymous ? <InfoBadge tone="amber">匿名来源</InfoBadge> : null}
                  <span>{signal.ip ?? '-'}</span>
                  <span className="text-slate-400">{formatTime(signal.createdAt)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Collapsible>

      <Collapsible title="登录 IP 事实" count={ipFacts.length}>
        {ipFacts.length === 0 ? (
          <p className="text-xs text-slate-500">该账户还没有登录 IP 事实行。</p>
        ) : (
          <TableWrap minWidth="min-w-[760px]">
            <thead>
              <tr className="border-b border-slate-200 text-[11px] uppercase tracking-wide text-slate-400">
                <Th>IP</Th>
                <Th>属地</Th>
                <Th>登录次数</Th>
                <Th>风险</Th>
                <Th>网络</Th>
                <Th>首 / 末次</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {ipFacts.map((fact) => (
                <tr key={fact.id}>
                  <Td><span className="font-mono">{fact.ip ?? '-'}</span></Td>
                  <Td>{fact.ipLocation ?? '-'}</Td>
                  <Td>{formatCount(fact.loginCount)}</Td>
                  <Td>
                    <span className="flex items-center gap-1.5">
                      <RiskScoreCell score={fact.riskScore} />
                      {fact.isDatacenter ? <InfoBadge tone="amber">IDC</InfoBadge> : null}
                    </span>
                  </Td>
                  <Td>{fact.networkType || fact.asn || '-'}</Td>
                  <Td>
                    <span className="text-[11px] text-slate-500">
                      {formatRelativeTime(fact.firstSeenAt)} / {formatRelativeTime(fact.lastSeenAt)}
                    </span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Collapsible>

      <Collapsible title="处置记录" count={actions.length}>
        {actions.length === 0 ? (
          <p className="text-xs text-slate-500">还没有处置记录。</p>
        ) : (
          <ul className="space-y-1.5">
            {actions.map((action) => (
              <li key={action.id} className="rounded-2xl border border-slate-200 bg-white/80 px-2.5 py-1.5 text-[11px]">
                <div className="flex flex-wrap items-center gap-2 text-slate-600">
                  <InfoBadge tone="slate">{action.eventType}</InfoBadge>
                  <span>{action.action ?? '-'}</span>
                  <span className="text-slate-400">
                    {action.fromTier ?? '-'} → {action.toTier ?? '-'}
                  </span>
                  <span className="text-slate-400">操作者 {action.operatorId ?? '-'}</span>
                  <span className="text-slate-400">{formatTime(action.createdAt)}</span>
                </div>
                {action.reason ? <p className="mt-1 text-slate-500">{action.reason}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </Collapsible>

      <div className="flex flex-wrap items-center gap-2">
        <Link
          to={`/admin/account-risk?tab=signals&userId=${encodeURIComponent(userId)}`}
          className={cn(studioSecondaryButtonClassName, 'px-2.5 py-1 text-[11px]')}
        >
          在信号总表中查看
        </Link>
        <button type="button" onClick={() => void load()} className={cn(studioSecondaryButtonClassName, 'px-2.5 py-1 text-[11px]')}>
          <FaSync className="mr-1 inline" />刷新详情
        </button>
      </div>
    </div>
  );
};

/** 说明块：账户风险页在做「事后解释」，不是「实时拦截」，这一点必须在页面上写清楚。 */
export const AccountsLegend: React.FC = () => (
  <DataPanel>
    <div className="flex items-start gap-2 text-xs leading-5 text-slate-600">
      <FaUserSlash className="mt-0.5 shrink-0 text-slate-400" aria-hidden />
      <div className="min-w-0">
        <p className="font-semibold text-slate-700">这张表回答什么</p>
        <p className="mt-1">
          每一行是「账户当前的风险档 + 触发它的旗标 + 谁在什么时候处置过」。处置动作本身仍走用户管理页的
          <code className="mx-1 rounded bg-slate-100 px-1">POST /api/admin/users/bulk-action</code>
          （服务端唯一出口 <code className="rounded bg-slate-100 px-1">applyAccountRiskAction</code>），
          本页不提供第二条写路径。IP 与指纹已打码；完整值只存在于服务端与取证导出里。
        </p>
      </div>
    </div>
  </DataPanel>
);

/** 单账户详情弹窗（供其它页签复用，例如信号表里点用户名）。 */
export const AccountRiskDetailModal: React.FC<{ userId: string | null; onClose: () => void }> = ({ userId, onClose }) => (
  <StudioModal open={Boolean(userId)} onClose={onClose} titleId="account-risk-detail-title">
    <div className="max-h-[80vh] overflow-y-auto px-1 py-2">
      <h3 id="account-risk-detail-title" className="text-base font-semibold text-slate-900">
        账户风险详情
      </h3>
      <p className="mt-1 font-mono text-xs text-slate-400">{userId ?? '-'}</p>
      {userId ? <AccountRiskDetail userId={userId} /> : null}
    </div>
  </StudioModal>
);
