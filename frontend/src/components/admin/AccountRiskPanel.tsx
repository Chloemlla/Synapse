import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  FaExclamationTriangle,
  FaFingerprint,
  FaGavel,
  FaListUl,
  FaNetworkWired,
  FaShieldAlt,
  FaSlidersH,
  FaSync,
  FaUsers,
} from 'react-icons/fa';
import { accountRiskApi, type AccountRiskOverviewResponse } from '@/api/accountRisk';
import {
  InfoBadge,
  InfoMetricCard,
  InfoPanel,
  InfoQueryHero,
  InfoQueryShell,
  studioPrimaryButtonClassName,
} from '@/components/studioTheme';
import { StudioErrorState, StudioLoadingState } from '@/components/studioFeedback';
import { useNotification } from '@/components/Notification';
import { cn } from '@/lib/utils';
import { getBackendErrorMessage } from '@/utils/backendError';
import { AUTO_REFRESH_OPTIONS, formatCount, formatRelativeTime } from '../ip-risk-log/format';
import { FilterSelect } from '../ip-risk-log/ui';
import type { AccountRiskQuickFilter } from './format';
import { Collapsible } from './ui';
import AccountRiskOverviewTab from './OverviewTab';
import AccountRiskAccountsTab from './AccountsTab';
import AccountRiskSignalsTab from './SignalsTab';
import AccountRiskIpFactsTab from './IpFactsTab';
import AccountRiskActionsTab from './ActionsTab';
import AccountRiskConfigTab from './ConfigTab';

type TabKey = 'overview' | 'accounts' | 'signals' | 'ip-facts' | 'actions' | 'config';

const TABS: ReadonlyArray<{ key: TabKey; label: string; icon: React.ReactNode; hint: string }> = [
  { key: 'overview', label: '概览', icon: <FaSlidersH />, hint: '风险档分布 / 24h 信号 / 索引自检' },
  { key: 'accounts', label: '账户风险', icon: <FaUsers />, hint: 'user_datas 风险字段 + 单账户详情抽屉' },
  { key: 'signals', label: '账户信号', icon: <FaListUl />, hint: 'security_events：RC-14/15/20/26/56/57 落下的证据' },
  { key: 'ip-facts', label: '登录 IP 事实', icon: <FaNetworkWired />, hint: 'account_ip_signals：账户 × IP 长期事实' },
  { key: 'actions', label: '处置记录', icon: <FaGavel />, hint: 'ACCOUNT_RISK_ACTION / 档位变化' },
  { key: 'config', label: '配置与口径', icon: <FaShieldAlt />, hint: '运行时开关 / 阈值 / 权重 / 通道矩阵' },
];

const TAB_KEYS = new Set<string>(TABS.map((tab) => tab.key));

/**
 * 账户风险与自动化信号管理页（`/admin/account-risk`）。
 *
 * 这个页面补的是十月十七日那批「后端有、管理面没有」的缺口：RC-14（IDC 出口升档）、
 * RC-15（属地跳变）、RC-20（登录前验证失败按账户聚合）、RC-26/56（探测报告加权）、
 * RC-38（通道株连）、RC-57（自动化痕迹）与 RC-07 的统一处置出口。
 *
 * 三条设计取舍：
 *   1. **只读**：处置仍走用户管理页的批量动作，服务端唯一出口 `applyAccountRiskAction`。
 *      本页连一个写按钮都不提供，避免出现「没有审计的第二条处罚路径」。
 *   2. **PII 打码**：IP 只留前两段、指纹只留前 12 位；完整值只存在于服务端与取证导出。
 *   3. **不伪造数据**：没有结论的风险分显示「无结论」而不是 0；缺索引在概览里直接报出来。
 *
 * 页签与筛选都写进 URL（`?tab=accounts&tier=watch`），便于把排查链接发给同事。
 */
const AccountRiskPanel: React.FC = () => {
  const { setNotification } = useNotification();
  const [searchParams, setSearchParams] = useSearchParams();

  const tabParam = searchParams.get('tab') ?? '';
  const tab: TabKey = TAB_KEYS.has(tabParam) ? (tabParam as TabKey) : 'overview';

  const [autoRefreshMs, setAutoRefreshMs] = useState(0);
  /** 每次自动/手动刷新自增；各页签据此重新拉取自己的数据。 */
  const [refreshNonce, setRefreshNonce] = useState(0);

  const [overview, setOverview] = useState<AccountRiskOverviewResponse | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);

  const overviewRequestRef = useRef(0);
  const lastNoticeRef = useRef<string | null>(null);

  const loadOverview = useCallback(async () => {
    const requestId = ++overviewRequestRef.current;
    setOverviewLoading(true);
    try {
      const res = await accountRiskApi.overview();
      if (requestId !== overviewRequestRef.current) return;
      setOverview(res);
      setOverviewError(null);
      setLastUpdatedAt(Date.now());
      lastNoticeRef.current = null;
    } catch (error) {
      if (requestId !== overviewRequestRef.current) return;
      const message = getBackendErrorMessage(error, '加载账户风险概览失败');
      setOverviewError(message);
      // 自动刷新失败时不重复弹同一个错误，避免通知风暴。
      if (lastNoticeRef.current !== message) {
        lastNoticeRef.current = message;
        setNotification({ message, type: 'error' });
      }
    } finally {
      if (requestId === overviewRequestRef.current) setOverviewLoading(false);
    }
  }, [setNotification]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview, refreshNonce]);

  useEffect(() => {
    if (autoRefreshMs <= 0) return;
    // 显式声明为 number：本仓 CI 把 ReturnType<typeof window.setInterval> 解析成 DOM Timeout。
    const timer: number = window.setInterval(() => {
      // 页面不可见时不刷新：后台标签页刷 15 秒一次只是白烧服务端配额。
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      setRefreshNonce((current) => current + 1);
    }, autoRefreshMs);
    return () => window.clearInterval(timer);
  }, [autoRefreshMs]);

  const refreshAll = useCallback(() => {
    setRefreshNonce((current) => current + 1);
  }, []);

  const setTab = useCallback(
    (next: TabKey) => {
      const params = new URLSearchParams(searchParams);
      if (next === 'overview') params.delete('tab');
      else params.set('tab', next);
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  /**
   * 概览卡片 → 对应页签 + 筛选。
   * 只改 URL，让列表页签自己从 URL 读筛选 —— 页面之间不共享 React 状态，刷新后仍可复现。
   */
  const applyQuickFilter = useCallback(
    (filter: AccountRiskQuickFilter) => {
      const params = new URLSearchParams(searchParams);
      const filterKeys = ['tier', 'status', 'flag', 'eventType', 'datacenter', 'action', 'userId'];
      for (const key of filterKeys) params.delete(key);
      params.set('tab', filter.tab);
      for (const [key, value] of Object.entries(filter)) {
        if (key === 'tab' || value === undefined || value === '') continue;
        params.set(key, String(value));
      }
      setSearchParams(params, { replace: true });
      setRefreshNonce((current) => current + 1);
    },
    [searchParams, setSearchParams],
  );

  const accounts = overview?.accounts;
  const events = overview?.events24h;
  const events24hTotal = events?.total ?? null;

  const heroMeta = useMemo(
    () => (
      <>
        <InfoBadge tone="slate">只读页面 · 处置在用户管理页</InfoBadge>
        <InfoBadge>{lastUpdatedAt ? `概览更新于 ${formatRelativeTime(lastUpdatedAt)}` : '概览尚未加载'}</InfoBadge>
        {overview ? <InfoBadge tone="sky">IP 与指纹已打码</InfoBadge> : null}
        {overviewError ? (
          <InfoBadge tone="rose">
            <FaExclamationTriangle className="mr-1 inline" />
            概览读取失败
          </InfoBadge>
        ) : null}
      </>
    ),
    [lastUpdatedAt, overview, overviewError],
  );

  return (
    <InfoQueryShell maxWidthClassName="max-w-7xl">
      <InfoQueryHero
        eyebrow="账户安全与风险"
        title="账户风险与自动化信号"
        description={[
          '把账户风险这一层完全摊开：每个账户当前的档位与旗标、触发它的原始证据（IDC 出口、属地跳变、',
          '登录前验证失败、WebRTC 出口不一致、自动化痕迹）、账户历来用过的登录 IP，以及每一次人工或自动处置。',
          '判据与真正回给业务的完全同源：档位来自 evaluateAccountRisk，处置来自 applyAccountRiskAction。',
          '本页不修改任何数据；处置入口在用户管理页，避免出现没有审计的第二条处罚路径。',
        ].join('')}
        icon={FaShieldAlt}
        tone="rose"
        meta={heroMeta}
        actions={
          <>
            <FilterSelect
              title="自动刷新间隔"
              value={autoRefreshMs}
              options={AUTO_REFRESH_OPTIONS}
              onChange={(value) => setAutoRefreshMs(Number(value))}
            />
            <button
              type="button"
              onClick={refreshAll}
              disabled={overviewLoading}
              className={cn(studioPrimaryButtonClassName, 'min-h-11 px-4 py-2 sm:min-h-0')}
            >
              <FaSync className={cn(overviewLoading && 'animate-spin')} /> 刷新全部
            </button>
          </>
        }
      />

      {/* 概览失败不能渲染成「全是 —」的完成态：失败与加载态都要显式。 */}
      {overviewError && !overview ? (
        <StudioErrorState
          className="mt-6"
          message="概览数据读取失败，下方各分页仍可单独使用。"
          onRetry={() => void loadOverview()}
        />
      ) : overviewLoading && !overview ? (
        <StudioLoadingState className="mt-6" minHeightClassName="min-h-[240px]" text="正在读取账户风险概览…" />
      ) : null}

      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <InfoMetricCard
          label="观察档"
          value={accounts ? formatCount(accounts.tiers.watch) : '—'}
          detail={accounts ? `账户总数 ${formatCount(accounts.total)}；有信号但不冻结功能` : '等待概览'}
          icon={FaShieldAlt}
          tone="sky"
        />
        <InfoMetricCard
          label="受限 + 危险"
          value={accounts ? formatCount(accounts.tiers.restricted + accounts.tiers.danger) : '—'}
          detail={
            accounts
              ? `受限 ${formatCount(accounts.tiers.restricted)} · 危险 ${formatCount(accounts.tiers.danger)}；受限档保留工单申诉`
              : '等待概览'
          }
          icon={FaExclamationTriangle}
          tone={accounts && accounts.tiers.restricted + accounts.tiers.danger > 0 ? 'amber' : 'slate'}
        />
        <InfoMetricCard
          label="已封停"
          value={accounts ? formatCount(accounts.statuses.suspended) : '—'}
          detail={accounts ? `待逐步验证 ${formatCount(accounts.stepUpPending)} 个账户` : '等待概览'}
          icon={FaUsers}
          tone={accounts && accounts.statuses.suspended > 0 ? 'rose' : 'slate'}
        />
        <InfoMetricCard
          label="24 小时信号"
          value={events ? formatCount(events.total) : '—'}
          detail={
            events
              ? `IDC ${formatCount(events.idcEgress)} · 属地跳变 ${formatCount(events.geoJump)} · 自动化 ${formatCount(events.automationTrace)}`
              : '等待概览'
          }
          icon={FaNetworkWired}
          tone={events24hTotal && events24hTotal > 0 ? 'sky' : 'slate'}
        />
        <InfoMetricCard
          label="24 小时处置"
          value={events ? formatCount(events.riskActions) : '—'}
          detail={events ? `风险动作与档位变化合计；自动规则的 operatorId 为 auto` : '等待概览'}
          icon={FaGavel}
          tone={events && events.riskActions > 0 ? 'emerald' : 'slate'}
        />
      </div>

      <InfoPanel className="mt-6" compact>
        <Collapsible
          title="口径说明（务必先读）"
          subtitle="分数方向 · 匿名信号封顶 · 打码规则 · 处置唯一出口"
          defaultOpen
        >
          <div className="space-y-2 text-xs leading-5 text-slate-600">
            <p>
              <span className="font-semibold text-slate-700">分数方向</span>：本页的 riskScore
              <span className="font-semibold"> 越高越危险</span>（0-100），与个人页「账户安全摘要」里越高越安全的分数方向相反，勿混用。
            </p>
            <p>
              <span className="font-semibold text-slate-700">匿名信号</span>：登录前的人机验证失败等拿不到可信 userId 的路径，
              按半权重计分且总额封顶，单靠它到不了观察档；写入时还要求该 (用户, IP) 曾出现过（requireKnownIp）。
            </p>
            <p>
              <span className="font-semibold text-slate-700">打码</span>：列表里的 IP 保留前两段、设备指纹保留前 12 位，
              事件载荷按日志同一份敏感字段名单递归脱敏。需要完整值请走取证导出流程。
            </p>
            <p>
              <span className="font-semibold text-slate-700">处置</span>：所有处罚/降档只经
              <code className="mx-1 rounded bg-slate-100 px-1">applyAccountRiskAction</code>
              一个出口，会同时写档位、security_events 与审计。本页不提供写入口。
            </p>
          </div>
        </Collapsible>
      </InfoPanel>

      <div className="mt-4 flex flex-wrap gap-1.5 rounded-2xl border border-slate-200/80 bg-white/80 p-1.5">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            title={item.hint}
            onClick={() => setTab(item.key)}
            aria-pressed={tab === item.key}
            className={cn(
              'inline-flex min-h-11 items-center gap-1.5 rounded-full px-3.5 py-2 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 sm:min-h-0',
              tab === item.key
                ? 'bg-slate-900 text-white shadow-sm'
                : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700',
            )}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </div>

      <div className="mt-5">
        {tab === 'overview' ? (
          <AccountRiskOverviewTab
            overview={overview}
            loading={overviewLoading}
            error={overviewError}
            onRefresh={() => void loadOverview()}
            onQuickFilter={applyQuickFilter}
          />
        ) : null}
        {tab === 'accounts' ? <AccountRiskAccountsTab refreshNonce={refreshNonce} /> : null}
        {tab === 'signals' ? <AccountRiskSignalsTab refreshNonce={refreshNonce} /> : null}
        {tab === 'ip-facts' ? <AccountRiskIpFactsTab refreshNonce={refreshNonce} /> : null}
        {tab === 'actions' ? <AccountRiskActionsTab refreshNonce={refreshNonce} /> : null}
        {tab === 'config' ? <AccountRiskConfigTab refreshNonce={refreshNonce} /> : null}
      </div>

      <p className="mt-6 flex items-center gap-1.5 text-[11px] text-slate-400">
        <FaFingerprint aria-hidden />
        账户风险数据源：user_datas（档位/旗标）、security_events（信号与处置）、account_ip_signals（登录 IP 事实）。
      </p>
    </InfoQueryShell>
  );
};

export default AccountRiskPanel;
