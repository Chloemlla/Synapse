import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  FaBolt,
  FaCogs,
  FaExclamationTriangle,
  FaTachometerAlt,
  FaLayerGroup,
  FaListOl,
  FaShieldAlt,
  FaSync,
} from 'react-icons/fa';
import { rateLimitsApi, type RateLimitsOverviewResponse } from '@/api/rateLimits';
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
import { AUTO_REFRESH_OPTIONS, formatCount, formatRelativeTime } from './ip-risk-log/format';
import { FilterSelect } from './ip-risk-log/ui';
import { Collapsible } from './account-risk/ui';
import RateLimitsOverviewTab from './rate-limits/OverviewTab';
import RateLimitsBurstTab from './rate-limits/BurstTab';
import RateLimitsQuotaEventsTab from './rate-limits/QuotaEventsTab';
import RateLimitsLaddersTab from './rate-limits/LaddersTab';
import RateLimitsTtsTab from './rate-limits/TtsTab';
import RateLimitsResourcesTab from './rate-limits/ResourcesTab';
import RateLimitsLimitersTab from './rate-limits/LimitersTab';

type TabKey = 'overview' | 'burst' | 'quota-events' | 'ladders' | 'tts' | 'resources' | 'limiters';

const TABS: ReadonlyArray<{ key: TabKey; label: string; icon: React.ReactNode; hint: string }> = [
  { key: 'overview', label: '概览', icon: <FaTachometerAlt />, hint: '在途并发 / 配额事件 / TTS 占用 / 闸门生效值' },
  { key: 'burst', label: '在途并发', icon: <FaBolt />, hint: 'RC-27：按身份键限制同时进行的请求数，超顶立即 429' },
  { key: 'quota-events', label: '配额事件', icon: <FaListOl />, hint: 'RC-28：quota_events 的 80% / 100% 预警台账' },
  { key: 'ladders', label: '阶梯与封禁', icon: <FaLayerGroup />, hint: 'RC-29/37：每用户日额度、警告与累计封禁次数' },
  { key: 'tts', label: 'TTS 占用', icon: <FaTachometerAlt />, hint: 'RC-30：全局并发、每用户上限与占用 Top' },
  { key: 'resources', label: '资源闸门', icon: <FaShieldAlt />, hint: 'RC-39：文件沙箱四道硬顶与子进程看门狗' },
  { key: 'limiters', label: '限流器清单', icon: <FaCogs />, hint: 'LIMITER_DEFINITIONS 快照：窗口 / 额度 / 键口径 / 存储' },
];

const TAB_KEYS = new Set<string>(TABS.map((tab) => tab.key));

/**
 * 限流、配额与资源闸门管理页（`/admin/rate-limits`）。
 *
 * 补的是十月十七日 RC-27 / RC-28 / RC-29 / RC-30 / RC-37 / RC-39 这六条的后台可观测面：
 * 这些机制此前只有日志与 429 响应，管理员无法回答「现在谁在占队列」「谁的账户预算快用完」
 * 「这个端点限多少、走的 Redis 还是内存」。
 *
 * 三条取舍：
 *   1. **只读**：所有阈值仍是 env 或运行时配置；页面给「生效值 + env 名 + 默认值」并指向改动位置。
 *   2. **不伪造**：Mongo 未连接、Redis 未配置、队列未注册都给出可读原因，不渲染成 0。
 *   3. **短周期刷新只给瞬时数据**：在途并发与 TTS 占用可 5/15/30 秒自刷；列表页签保持手动。
 */
const RateLimitsPanel: React.FC = () => {
  const { setNotification } = useNotification();
  const [searchParams, setSearchParams] = useSearchParams();

  const tabParam = searchParams.get('tab') ?? '';
  const tab: TabKey = TAB_KEYS.has(tabParam) ? (tabParam as TabKey) : 'overview';

  const [autoRefreshMs, setAutoRefreshMs] = useState(0);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [overview, setOverview] = useState<RateLimitsOverviewResponse | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);

  const requestRef = useRef(0);
  const lastNoticeRef = useRef<string | null>(null);

  const loadOverview = useCallback(async () => {
    const requestId = ++requestRef.current;
    setOverviewLoading(true);
    try {
      const res = await rateLimitsApi.overview();
      if (requestId !== requestRef.current) return;
      setOverview(res);
      setOverviewError(null);
      setLastUpdatedAt(Date.now());
      lastNoticeRef.current = null;
    } catch (error) {
      if (requestId !== requestRef.current) return;
      const message = getBackendErrorMessage(error, '加载限流与配额概览失败');
      setOverviewError(message);
      if (lastNoticeRef.current !== message) {
        lastNoticeRef.current = message;
        setNotification({ message, type: 'error' });
      }
    } finally {
      if (requestId === requestRef.current) setOverviewLoading(false);
    }
  }, [setNotification]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview, refreshNonce]);

  useEffect(() => {
    if (autoRefreshMs <= 0) return;
    // 显式声明为 number：本仓 CI 把 ReturnType<typeof window.setInterval> 解析成 DOM Timeout。
    const timer: number = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      setRefreshNonce((current) => current + 1);
    }, autoRefreshMs);
    return () => window.clearInterval(timer);
  }, [autoRefreshMs]);

  const setTab = useCallback(
    (next: string) => {
      const params = new URLSearchParams(searchParams);
      if (next === 'overview') params.delete('tab');
      else params.set('tab', next);
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  // 就地收窄（不要抽成布尔变量：两个成员没有共同属性，TS 不会跟着收窄）。
  const quota = overview && !('unavailableReason' in overview.quota) ? overview.quota : null;
  const overCap = overview ? overview.burst.guards.filter((guard) => guard.active > guard.maxConcurrent) : [];

  return (
    <InfoQueryShell maxWidthClassName="max-w-7xl">
      <InfoQueryHero
        eyebrow="成本与资源闸门"
        title="限流、配额与资源限制"
        description={[
          '把十月十七日落地的成本闸门摊开：同一秒能打进来几个昂贵请求（在途并发）、',
          '谁的余额或预算跨过 80% / 100%（配额事件）、LibreChat 的日额度阶梯与封禁时长、',
          'TTS 队列被谁占满，以及文件沙箱与子进程看门狗的生效值。',
          '本页不修改任何阈值 —— 所有闸门仍由 env 与运行时配置决定，改动走「运行时配置」页并留审计。',
        ].join('')}
        icon={FaTachometerAlt}
        tone="amber"
        meta={
          <>
            <InfoBadge tone="slate">只读页面 · 阈值在运行时配置</InfoBadge>
            <InfoBadge>{lastUpdatedAt ? `概览更新于 ${formatRelativeTime(lastUpdatedAt)}` : '概览尚未加载'}</InfoBadge>
            {overview ? (
              <InfoBadge tone={overview.storage.redisConfigured ? 'emerald' : 'amber'}>
                {overview.storage.redisConfigured ? 'Redis 共享档' : '进程内存档'}
              </InfoBadge>
            ) : null}
            {overviewError ? (
              <InfoBadge tone="rose">
                <FaExclamationTriangle className="mr-1 inline" />
                概览读取失败
              </InfoBadge>
            ) : null}
          </>
        }
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
              onClick={() => setRefreshNonce((current) => current + 1)}
              disabled={overviewLoading}
              className={cn(studioPrimaryButtonClassName, 'min-h-11 px-4 py-2 sm:min-h-0')}
            >
              <FaSync className={cn(overviewLoading && 'animate-spin')} /> 刷新全部
            </button>
          </>
        }
      />

      {overviewError && !overview ? (
        <StudioErrorState
          className="mt-6"
          message="概览数据读取失败，下方各分页仍可单独使用。"
          onRetry={() => void loadOverview()}
        />
      ) : overviewLoading && !overview ? (
        <StudioLoadingState className="mt-6" minHeightClassName="min-h-[240px]" text="正在读取限流与配额概览…" />
      ) : null}

      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <InfoMetricCard
          label="在途合计"
          value={overview ? formatCount(overview.burst.totalActive) : '—'}
          detail={
            overview
              ? `${overview.burst.guards.length} 个守卫${overCap.length > 0 ? ` · ${overCap.length} 个超顶` : ''}`
              : '等待概览'
          }
          icon={FaBolt}
          tone={overCap.length > 0 ? 'rose' : 'sky'}
        />
        <InfoMetricCard
          label="配额事件（24h）"
          value={quota ? formatCount(quota.total24h) : '—'}
          detail={
            quota
              ? `预警 ${formatCount(quota.warning24h)} · 用尽 ${formatCount(quota.exhausted24h)} · 上游 ${formatCount(quota.upstream24h)}`
              : '等待概览或数据库未连接'
          }
          icon={FaTachometerAlt}
          tone={quota && quota.total24h > 0 ? 'amber' : 'slate'}
        />
        <InfoMetricCard
          label="TTS 每用户上限"
          value={overview && overview.tts.perUserMaxActive !== null ? formatCount(overview.tts.perUserMaxActive) : '—'}
          detail={
            overview && overview.tts.global
              ? `全局并发 ${formatCount(overview.tts.global.concurrency)} · ${overview.tts.global.processing ? '处理中' : '空闲'}`
              : (overview?.tts.reason ?? '等待概览')
          }
          icon={FaTachometerAlt}
          tone="sky"
        />
        <InfoMetricCard
          label="占用最多"
          value={overview && overview.tts.topOwners.length > 0 ? `${formatCount(overview.tts.topOwners[0]!.active)} 个` : '—'}
          detail={
            overview && overview.tts.topOwners.length > 0
              ? `用户 ${overview.tts.topOwners[0]!.userId}`
              : '当前没有排队或运行中的任务'
          }
          icon={FaTachometerAlt}
          tone="slate"
        />
        <InfoMetricCard
          label="看门狗模式"
          value={overview ? overview.limits.watchdogMode : '—'}
          detail="observe 只告警；enforce 会终止超限的子进程树"
          icon={FaShieldAlt}
          tone={overview?.limits.watchdogMode === 'enforce' ? 'rose' : 'slate'}
        />
      </div>

      <InfoPanel className="mt-6" compact>
        <Collapsible
          title="口径说明（务必先读）"
          subtitle="窗口限流 ≠ 在途并发 · 配额事件是台账不是余额 · 阈值改哪里"
          defaultOpen
        >
          <div className="space-y-2 text-xs leading-5 text-slate-600">
            <p>
              <span className="font-semibold text-slate-700">两种限流</span>：固定窗口限流管「一分钟内允许几次」；
              在途并发硬顶管「同一时刻允许几个请求还没结束」。后者超顶**立即拒绝**，不排队 ——
              排队本身就是新的内存压力。
            </p>
            <p>
              <span className="font-semibold text-slate-700">配额事件不是余额</span>：`quota_events` 只记录
              「某账期内跨过 80% / 100% 这条线」这一事实，同一条线一个账期只写一次；余额以计费服务为准。
            </p>
            <p>
              <span className="font-semibold text-slate-700">改阈值</span>：并发上限（`BURST_*`）、每用户活跃任务
              （`TTS_PER_USER_MAX_ACTIVE`）、账户预算（`API_KEY_ACCOUNT_BUDGET_*`）、沙箱与看门狗
              （`MEDIA_TOOL_*` / `PROCESS_WATCHDOG_*`）都在「运行时配置」页，写入需要超管 + 安全会话并留审计。
              LibreChat 阶梯额度（`LIBRECHAT_*`）是 env，随重启生效。
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
          <RateLimitsOverviewTab
            overview={overview}
            loading={overviewLoading}
            error={overviewError}
            onRefresh={() => void loadOverview()}
            onOpenTab={setTab}
          />
        ) : null}
        {tab === 'burst' ? <RateLimitsBurstTab refreshNonce={refreshNonce} /> : null}
        {tab === 'quota-events' ? <RateLimitsQuotaEventsTab refreshNonce={refreshNonce} /> : null}
        {tab === 'ladders' ? <RateLimitsLaddersTab refreshNonce={refreshNonce} /> : null}
        {tab === 'tts' ? <RateLimitsTtsTab refreshNonce={refreshNonce} /> : null}
        {tab === 'resources' ? <RateLimitsResourcesTab refreshNonce={refreshNonce} /> : null}
        {tab === 'limiters' ? <RateLimitsLimitersTab refreshNonce={refreshNonce} /> : null}
      </div>
    </InfoQueryShell>
  );
};

export default RateLimitsPanel;
