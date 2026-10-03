import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FaBellSlash,
  FaBoxOpen,
  FaDatabase,
  FaEnvelopeOpenText,
  FaExclamationTriangle,
  FaGlobe,
  FaLayerGroup,
  FaLightbulb,
  FaLink,
  FaPlus,
  FaSync,
  FaTrashAlt,
  FaUsers,
  FaPlug,
} from 'react-icons/fa';
import {
  integrationsApi,
  type IntegrationsOverview,
  type RegistrationInviteStats,
  type RecommendationAnalytics,
  type SuppressionListResponse,
  type SuppressionReason,
  type WebhookHealthResponse,
} from '@/api/integrations';
import { useNotification } from '@/components/Notification';
import { InfoBadge, InfoMetricCard, InfoPanel, InfoQueryHero, InfoQueryShell, InfoSectionTitle } from '@/components/studioTheme';
import { cn } from '@/lib/utils';
import { getBackendErrorMessage } from '@/utils/backendError';

/**
 * 集成健康中心：Webhook（Svix）/ 邮件（Resend 抑制名单）/ 缓存（Redis）/ 推荐 / 邀请码
 * 五个集成面的可运维视图。读为主，写操作（清缓存、名单增删、事件清理）需超管权限。
 * 界面只讲「现在什么状态、能做什么」，诊断细节放在各分区说明里，不铺协议与实现。
 */

type TabKey = 'overview' | 'cache' | 'email' | 'webhooks' | 'recommendations' | 'invites';

const TABS: ReadonlyArray<{ key: TabKey; label: string; icon: React.ReactNode; hint: string }> = [
  { key: 'overview', label: '总览', icon: <FaLayerGroup />, hint: '五个集成面的关键指标' },
  { key: 'cache', label: '缓存层', icon: <FaDatabase />, hint: 'Redis 状态、命中率、按前缀失效' },
  { key: 'email', label: '邮件抑制', icon: <FaBellSlash />, hint: '退信 / 投诉 / 退订名单' },
  { key: 'webhooks', label: 'Webhook', icon: <FaPlug />, hint: '端点健康、密钥、事件清理' },
  { key: 'recommendations', label: '推荐系统', icon: <FaLightbulb />, hint: '活跃度与反馈分布' },
  { key: 'invites', label: '邀请码', icon: <FaUsers />, hint: '注册邀请码用量与趋势' },
];

const REASON_LABELS: Record<SuppressionReason, string> = {
  bounce: '退信',
  complaint: '投诉',
  unsubscribe: '主动退订',
  manual: '人工添加',
};

const formatBytes = (value: number | null): string => {
  if (value === null || !Number.isFinite(value)) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
};

const formatPct = (value: number): string => `${(value * 100).toFixed(1)}%`;

const formatTime = (value: string | null): string => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', { hour12: false });
};

const IntegrationsHealthPanel: React.FC = () => {
  const { setNotification } = useNotification();
  const [tab, setTab] = useState<TabKey>('overview');
  const [refreshNonce, setRefreshNonce] = useState(0);

  const [overview, setOverview] = useState<IntegrationsOverview | null>(null);
  const [loading, setLoading] = useState(true);
  // 「Webhook 端点健康」列表的拉取错误态（与空态区分，失败时保留已有数据）
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const requestRef = useRef(0);

  const [suppressions, setSuppressions] = useState<SuppressionListResponse | null>(null);
  const [suppressionQuery, setSuppressionQuery] = useState('');
  const [suppressionReason, setSuppressionReason] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newReason, setNewReason] = useState<SuppressionReason>('manual');

  const [webhooks, setWebhooks] = useState<WebhookHealthResponse | null>(null);
  const [pruneDays, setPruneDays] = useState(90);
  const [pruneDryRun, setPruneDryRun] = useState(true);
  const [cachePrefix, setCachePrefix] = useState('recommendation:');

  const [invites, setInvites] = useState<RegistrationInviteStats | null>(null);
  const [recommendations, setRecommendations] = useState<RecommendationAnalytics | null>(null);

  const notifyError = useCallback(
    (error: unknown, fallback: string) => {
      setNotification({ message: getBackendErrorMessage(error, fallback), type: 'error' });
    },
    [setNotification],
  );

  const loadOverview = useCallback(async () => {
    const requestId = ++requestRef.current;
    setLoading(true);
    try {
      const res = await integrationsApi.overview();
      if (requestId !== requestRef.current) return;
      setOverview(res);
      setLastUpdatedAt(Date.now());
    } catch (error) {
      if (requestId !== requestRef.current) return;
      notifyError(error, '加载集成总览失败');
    } finally {
      if (requestId === requestRef.current) setLoading(false);
    }
  }, [notifyError]);

  const loadSuppressions = useCallback(async () => {
    try {
      const res = await integrationsApi.listSuppressions({
        page: 1,
        pageSize: 50,
        q: suppressionQuery || undefined,
        reason: suppressionReason || undefined,
      });
      setSuppressions(res);
    } catch (error) {
      notifyError(error, '加载邮件抑制名单失败');
    }
  }, [notifyError, suppressionQuery, suppressionReason]);

  const loadWebhooks = useCallback(async () => {
    try {
      setLoadError(null);
      setWebhooks(await integrationsApi.webhooks());
    } catch (error) {
      notifyError(error, '加载 Webhook 健康信息失败');
      setLoadError(getBackendErrorMessage(error, '获取 Webhook 健康信息失败，请稍后重试'));
    }
  }, [notifyError]);

  const loadInvites = useCallback(async () => {
    try {
      const res = await integrationsApi.invites();
      setInvites(res.stats);
    } catch (error) {
      notifyError(error, '加载邀请码统计失败');
    }
  }, [notifyError]);

  const loadRecommendations = useCallback(async () => {
    try {
      const res = await integrationsApi.recommendations();
      setRecommendations(res.analytics);
    } catch (error) {
      notifyError(error, '加载推荐分析失败');
    }
  }, [notifyError]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview, refreshNonce]);

  useEffect(() => {
    if (tab === 'email') void loadSuppressions();
  }, [tab, loadSuppressions, refreshNonce]);

  useEffect(() => {
    if (tab === 'webhooks') void loadWebhooks();
  }, [tab, loadWebhooks, refreshNonce]);

  useEffect(() => {
    if (tab === 'invites') void loadInvites();
  }, [tab, loadInvites, refreshNonce]);

  useEffect(() => {
    if (tab === 'recommendations') void loadRecommendations();
  }, [tab, loadRecommendations, refreshNonce]);

  const providerBadges = useMemo(() => {
    if (!overview) return null;
    const { openai, resend, svix } = overview.providers;
    return (
      <>
        <InfoBadge tone={openai.apiKeyConfigured ? 'emerald' : 'rose'}>
          OpenAI {openai.apiKeyConfigured ? '已配置' : '未配置'}
        </InfoBadge>
        <InfoBadge tone={resend.apiKeyConfigured ? 'emerald' : 'rose'}>
          Resend {resend.apiKeyConfigured ? '已配置' : '未配置'}
        </InfoBadge>
        <InfoBadge tone={svix.envSecretConfigured ? 'emerald' : 'amber'}>
          Svix 签名密钥 {svix.envSecretConfigured ? '环境变量已配' : '仅 DB/未配'}
        </InfoBadge>
        <InfoBadge tone={overview.mongoReady ? 'emerald' : 'rose'}>
          数据库 {overview.mongoReady ? '正常' : '未连接'}
        </InfoBadge>
      </>
    );
  }, [overview]);

  const handleAddSuppression = async () => {
    if (!newEmail.trim()) {
      setNotification({ message: '请填写要抑制的邮箱', type: 'warning' });
      return;
    }
    setBusy(true);
    try {
      await integrationsApi.addSuppression({ email: newEmail.trim(), reason: newReason });
      setNotification({ message: `已加入抑制名单：${newEmail.trim()}`, type: 'success' });
      setNewEmail('');
      await loadSuppressions();
    } catch (error) {
      notifyError(error, '加入抑制名单失败');
    } finally {
      setBusy(false);
    }
  };

  const handleRemoveSuppression = async (email: string) => {
    setBusy(true);
    try {
      await integrationsApi.removeSuppression(email);
      setNotification({ message: `已移出抑制名单：${email}`, type: 'success' });
      await loadSuppressions();
    } catch (error) {
      notifyError(error, '移出抑制名单失败');
    } finally {
      setBusy(false);
    }
  };

  const handleInvalidateCache = async () => {
    setBusy(true);
    try {
      const res = await integrationsApi.invalidateCache(cachePrefix.trim());
      setNotification({ message: `已失效 ${res.deleted} 个缓存键（前缀 ${res.prefix}）`, type: 'success' });
      setRefreshNonce((current) => current + 1);
    } catch (error) {
      notifyError(error, '缓存失效失败');
    } finally {
      setBusy(false);
    }
  };

  const handleFlushMemory = async () => {
    setBusy(true);
    try {
      const res = await integrationsApi.flushMemoryCache();
      setNotification({ message: `已清空本进程内存缓存（${res.cleared} 条）`, type: 'success' });
      setRefreshNonce((current) => current + 1);
    } catch (error) {
      notifyError(error, '清空内存缓存失败');
    } finally {
      setBusy(false);
    }
  };

  const handlePrune = async () => {
    setBusy(true);
    try {
      const res = await integrationsApi.pruneWebhooks({ days: pruneDays, dryRun: pruneDryRun });
      setNotification({
        message: res.dryRun
          ? `预检：可清理 ${res.matched} 条（早于 ${formatTime(res.cutoff)}）`
          : `已清理 ${res.deleted} 条事件`,
        type: 'success',
      });
      if (!res.dryRun) {
        await loadWebhooks();
        setRefreshNonce((current) => current + 1);
      }
    } catch (error) {
      notifyError(error, '清理 Webhook 事件失败');
    } finally {
      setBusy(false);
    }
  };

  const cacheStats = overview?.cache?.stats ?? null;
  const redisStatus = overview?.cache?.redis ?? null;

  return (
    <InfoQueryShell maxWidthClassName="max-w-7xl">
      <InfoQueryHero
        eyebrow="集成可观测性"
        title="集成健康中心"
        description="把五条对外集成链路的状态集中在一处：Webhook 端点是否在收事件、有没有配签名密钥；邮件有没有因为退信/投诉被抑制；Redis 缓存层是走共享层还是单机内存；推荐系统有多少活跃用户与正负反馈；注册邀请码用量与趋势。写操作（清缓存、名单增删、事件清理）需要超管权限并写审计日志。"
        icon={FaLink}
        tone="sky"
        meta={
          <>
            {providerBadges}
            <InfoBadge>
              {lastUpdatedAt ? `更新于 ${new Date(lastUpdatedAt).toLocaleTimeString('zh-CN', { hour12: false })}` : '尚未加载'}
            </InfoBadge>
          </>
        }
        actions={
          <button
            type="button"
            onClick={() => setRefreshNonce((current) => current + 1)}
            disabled={loading || busy}
            className="inline-flex items-center gap-2 rounded-2xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-50"
          >
            <FaSync className={cn((loading || busy) && 'animate-spin')} /> 刷新
          </button>
        }
      />

      <div className="mt-4 flex flex-wrap gap-1.5 rounded-2xl border border-slate-200/80 bg-white/80 p-1.5">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            title={item.hint}
            onClick={() => setTab(item.key)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-semibold transition',
              tab === item.key ? 'bg-slate-900 text-white shadow-sm' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700',
            )}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </div>

      <div className="mt-5 space-y-5">
        {tab === 'overview' ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <InfoMetricCard
                label="缓存命中率"
                value={cacheStats ? formatPct(cacheStats.hitRate) : '—'}
                detail={cacheStats ? `${cacheStats.tier === 'redis' ? '共享层 Redis' : '单机内存'} · 命中 ${cacheStats.hits} / 未命中 ${cacheStats.misses}` : '缓存层不可用'}
                icon={FaDatabase}
                tone="sky"
              />
              <InfoMetricCard
                label="7 天 Webhook"
                value={overview?.webhooks ? overview.webhooks.total7d : '—'}
                detail={overview?.webhooks ? `24h ${overview.webhooks.last24h} · 失败 ${overview.webhooks.failed}` : '暂无数据'}
                icon={FaPlug}
                tone="violet"
              />
              <InfoMetricCard
                label="邮件抑制"
                value={overview?.emailSuppressions ? overview.emailSuppressions.active : '—'}
                detail={overview?.emailSuppressions ? `累计 ${overview.emailSuppressions.total} · 近 7 天新增 ${overview.emailSuppressions.last7d}` : '暂无数据'}
                icon={FaBellSlash}
                tone="amber"
              />
              <InfoMetricCard
                label="推荐活跃用户"
                value={overview?.recommendations ? overview.recommendations.totalUsers : '—'}
                detail={overview?.recommendations ? `生成记录 ${overview.recommendations.totalGenerations} · 反馈 ${overview.recommendations.feedback.total}` : '暂无数据'}
                icon={FaLightbulb}
                tone="emerald"
              />
            </div>

            <InfoPanel>
              <InfoSectionTitle
                title="Webhook 端点"
                description="按 routeKey 聚合近 7 天事件量、失败率与最近一次到达时间；「密钥」列表示该端点是否已配置签名密钥（只看有无，不显示密钥内容）。"
                icon={FaPlug}
                tone="violet"
              />
              {overview?.webhooks && overview.webhooks.routes.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[520px] text-sm">
                    <thead>
                      <tr className="text-left text-xs uppercase tracking-wider text-slate-500">
                        <th className="px-2 py-2">端点</th>
                        <th className="px-2 py-2">7 天</th>
                        <th className="px-2 py-2">24 小时</th>
                        <th className="px-2 py-2">失败率</th>
                        <th className="px-2 py-2">最近到达</th>
                        <th className="px-2 py-2">密钥</th>
                      </tr>
                    </thead>
                    <tbody>
                      {overview.webhooks.routes.map((route) => (
                        <tr key={route.routeKey ?? '__default__'} className="border-t border-slate-100">
                          <td className="px-2 py-2 font-mono text-xs">{route.routeKey ?? '默认端点'}</td>
                          <td className="px-2 py-2">{route.total7d}</td>
                          <td className="px-2 py-2">{route.total24h}</td>
                          <td className="px-2 py-2">{formatPct(route.failureRate)}</td>
                          <td className="px-2 py-2 text-xs text-slate-500">{formatTime(route.lastReceivedAt)}</td>
                          <td className="px-2 py-2">
                            <InfoBadge tone={route.secretConfigured ? 'emerald' : 'rose'}>
                              {route.secretConfigured ? '已配置' : '缺失'}
                            </InfoBadge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-sm text-slate-500">近 7 天没有收到任何 Webhook 事件。</p>
              )}
            </InfoPanel>

            <InfoPanel>
              <InfoSectionTitle title="提供方配置" description="只显示「是否配置」与掩码前缀，密钥原文不会回传到浏览器。" icon={FaGlobe} tone="sky" />
              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-xs uppercase tracking-wider text-slate-500">OpenAI</dt>
                  <dd className="mt-1">
                    {overview?.providers.openai.apiKeyConfigured ? (
                      <span className="font-mono text-xs">{overview.providers.openai.apiKeyPreview ?? '已配置'}</span>
                    ) : (
                      '未配置 API Key'
                    )}
                    {overview?.providers.openai.model ? <span className="ml-2 text-slate-500">模型 {overview.providers.openai.model}</span> : null}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wider text-slate-500">Resend</dt>
                  <dd className="mt-1">
                    {overview?.providers.resend.domain ?? '—'}
                    {overview?.providers.resend.outemailEnabled ? <span className="ml-2 text-slate-500">对外发信已启用</span> : null}
                  </dd>
                </div>
              </dl>
            </InfoPanel>
          </>
        ) : null}

        {tab === 'cache' ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <InfoMetricCard label="缓存分层" value={cacheStats ? (cacheStats.tier === 'redis' ? 'Redis' : '内存') : '—'} detail={redisStatus ? (redisStatus.available ? 'Redis 可用' : 'Redis 不可用，已降级') : ''} icon={FaDatabase} tone="sky" />
              <InfoMetricCard label="命中率" value={cacheStats ? formatPct(cacheStats.hitRate) : '—'} detail={cacheStats ? `${cacheStats.hits} 命中 / ${cacheStats.misses} 未命中` : ''} icon={FaBoxOpen} tone="emerald" />
              <InfoMetricCard label="进程内存条目" value={cacheStats ? cacheStats.memoryEntries : '—'} detail={cacheStats ? `在飞回源 ${cacheStats.inflight}` : ''} icon={FaLayerGroup} tone="violet" />
              <InfoMetricCard label="Redis 键总数" value={overview?.cache?.server.dbsize ?? '—'} detail={`内存占用 ${formatBytes(overview?.cache?.server.usedMemoryBytes ?? null)}`} icon={FaDatabase} tone="amber" />
            </div>

            <InfoPanel>
              <InfoSectionTitle title="缓存失效" description="按 key 前缀清理。前缀至少 3 个字符，避免一个字符误清整个命名空间。" icon={FaTrashAlt} tone="rose" />
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <input
                  value={cachePrefix}
                  onChange={(event) => setCachePrefix(event.target.value)}
                  placeholder="例如 recommendation:user"
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-slate-400 sm:max-w-sm"
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={handleInvalidateCache}
                    disabled={busy || cachePrefix.trim().length < 3}
                    className="rounded-xl bg-rose-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-rose-700 disabled:opacity-50"
                  >
                    失效前缀
                  </button>
                  <button
                    type="button"
                    onClick={handleFlushMemory}
                    disabled={busy}
                    className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100 disabled:opacity-50"
                  >
                    清空本进程内存
                  </button>
                </div>
              </div>
              {cacheStats && cacheStats.errors > 0 ? (
                <p className="mt-3 text-xs text-amber-600">缓存层已记录 {cacheStats.errors} 次错误，建议检查 Redis 连通性。</p>
              ) : null}
            </InfoPanel>
          </>
        ) : null}

        {tab === 'email' ? (
          <>
            <InfoPanel>
              <InfoSectionTitle
                title="手动抑制"
                description="把地址加入抑制名单后，后续发送会自动跳过该地址。退信与投诉由 Resend Webhook 自动写入，退订由邮件里的链接自动写入。"
                icon={FaPlus}
                tone="amber"
              />
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <input
                  value={newEmail}
                  onChange={(event) => setNewEmail(event.target.value)}
                  placeholder="user@example.com"
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-slate-400 sm:max-w-sm"
                />
                <select
                  value={newReason}
                  onChange={(event) => setNewReason(event.target.value as SuppressionReason)}
                  className="rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-slate-400"
                >
                  <option value="manual">人工添加</option>
                  <option value="bounce">退信</option>
                  <option value="complaint">投诉</option>
                  <option value="unsubscribe">主动退订</option>
                </select>
                <button
                  type="button"
                  onClick={handleAddSuppression}
                  disabled={busy}
                  className="rounded-xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-50"
                >
                  加入名单
                </button>
              </div>
            </InfoPanel>

            <InfoPanel>
              <InfoSectionTitle title="抑制名单" description="只有超管能查看（含邮箱明文）。可按关键词与原因筛选。" icon={FaBellSlash} tone="rose" />
              <div className="mb-4 flex flex-col gap-2 sm:flex-row">
                <input
                  value={suppressionQuery}
                  onChange={(event) => setSuppressionQuery(event.target.value)}
                  placeholder="按邮箱搜索"
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-slate-400 sm:max-w-xs"
                />
                <select
                  value={suppressionReason}
                  onChange={(event) => setSuppressionReason(event.target.value)}
                  className="rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-slate-400"
                >
                  <option value="">全部原因</option>
                  {Object.entries(REASON_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => void loadSuppressions()}
                  className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100"
                >
                  查询
                </button>
              </div>

              {suppressions && suppressions.items.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-sm">
                    <thead>
                      <tr className="text-left text-xs uppercase tracking-wider text-slate-500">
                        <th className="px-2 py-2">邮箱</th>
                        <th className="px-2 py-2">原因</th>
                        <th className="px-2 py-2">来源</th>
                        <th className="px-2 py-2">加入时间</th>
                        <th className="px-2 py-2">到期</th>
                        <th className="px-2 py-2" />
                      </tr>
                    </thead>
                    <tbody>
                      {suppressions.items.map((row) => (
                        <tr key={row.email} className="border-t border-slate-100">
                          <td className="px-2 py-2 font-mono text-xs">{row.email}</td>
                          <td className="px-2 py-2">{REASON_LABELS[row.reason] ?? row.reason}</td>
                          <td className="px-2 py-2 text-xs text-slate-500">{row.source}</td>
                          <td className="px-2 py-2 text-xs text-slate-500">{formatTime(row.createdAt)}</td>
                          <td className="px-2 py-2 text-xs text-slate-500">{row.permanent ? '永久' : formatTime(row.expiresAt)}</td>
                          <td className="px-2 py-2 text-right">
                            <button
                              type="button"
                              onClick={() => void handleRemoveSuppression(row.email)}
                              disabled={busy}
                              className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-600 transition hover:bg-slate-100 disabled:opacity-50"
                            >
                              <FaTrashAlt /> 移出
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-sm text-slate-500">名单为空，或当前筛选没有匹配记录。</p>
              )}
              {suppressions && suppressions.total > suppressions.items.length ? (
                <p className="mt-3 text-xs text-slate-500">
                  共 {suppressions.total} 条，当前显示前 {suppressions.items.length} 条。
                </p>
              ) : null}
            </InfoPanel>
          </>
        ) : null}

        {tab === 'webhooks' ? (
          <>
            <InfoPanel>
              <InfoSectionTitle
                title="端点健康"
                description="失败 = 事件状态属于 failed / error / bounced / complained / delivery_delayed。"
                icon={FaPlug}
                tone="violet"
              />
              {loadError ? (
                <div className="flex flex-col items-center gap-3 py-8 text-center">
                  <FaExclamationTriangle className="text-2xl text-rose-500" />
                  <p className="text-sm text-slate-500">{loadError}</p>
                  <button
                    type="button"
                    onClick={() => void loadWebhooks()}
                    className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-100"
                  >
                    重试
                  </button>
                </div>
              ) : webhooks && webhooks.routes.length > 0 ? (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px] text-sm">
                    <thead>
                      <tr className="text-left text-xs uppercase tracking-wider text-slate-500">
                        <th className="px-2 py-2">端点</th>
                        <th className="px-2 py-2">7 天</th>
                        <th className="px-2 py-2">24 小时</th>
                        <th className="px-2 py-2">失败率</th>
                        <th className="px-2 py-2">最近到达</th>
                        <th className="px-2 py-2">密钥</th>
                      </tr>
                    </thead>
                    <tbody>
                      {webhooks.routes.map((route) => (
                        <tr key={route.routeKey ?? '__default__'} className="border-t border-slate-100">
                          <td className="px-2 py-2 font-mono text-xs">{route.routeKey ?? '默认端点'}</td>
                          <td className="px-2 py-2">{route.total7d}</td>
                          <td className="px-2 py-2">{route.total24h}</td>
                          <td className="px-2 py-2">{formatPct(route.failureRate)}</td>
                          <td className="px-2 py-2 text-xs text-slate-500">{formatTime(route.lastReceivedAt)}</td>
                          <td className="px-2 py-2">
                            <InfoBadge tone={route.secretConfigured ? 'emerald' : 'rose'}>
                              {route.secretConfigured ? '已配置' : '缺失'}
                            </InfoBadge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-sm text-slate-500">近 7 天没有收到任何 Webhook 事件。</p>
              )}
            </InfoPanel>

            <InfoPanel>
              <InfoSectionTitle
                title="签名密钥"
                description="只显示掩码前缀与更新时间。新增/替换密钥在「环境变量」页或对应配置页完成。"
                icon={FaLink}
                tone="sky"
              />
              {webhooks && webhooks.secrets.length > 0 ? (
                <ul className="space-y-2 text-sm">
                  {webhooks.secrets.map((secret) => (
                    <li key={secret.key} className="flex flex-wrap items-center gap-3">
                      <InfoBadge tone="slate">{secret.key}</InfoBadge>
                      <span className="font-mono text-xs">{secret.secretPreview}</span>
                      <span className="text-xs text-slate-500">更新于 {formatTime(secret.updatedAt)}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-slate-500">数据库里没有存过签名密钥（可能只配了环境变量）。</p>
              )}
            </InfoPanel>

            <InfoPanel>
              <InfoSectionTitle
                title="事件保留清理"
                description="按天清理历史事件。默认「预检」只统计条数，不删除；确认后再执行实际删除。"
                icon={FaTrashAlt}
                tone="rose"
              />
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                <label className="flex items-center gap-2 text-sm text-slate-600">
                  保留
                  <input
                    type="number"
                    min={1}
                    max={3650}
                    value={pruneDays}
                    onChange={(event) => setPruneDays(Number(event.target.value) || 90)}
                    className="w-24 rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-slate-400"
                  />
                  天
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-600">
                  <input type="checkbox" checked={pruneDryRun} onChange={(event) => setPruneDryRun(event.target.checked)} />
                  仅预检（不删除）
                </label>
                <button
                  type="button"
                  onClick={handlePrune}
                  disabled={busy}
                  className={cn(
                    'rounded-xl px-4 py-2 text-sm font-semibold text-white transition disabled:opacity-50',
                    pruneDryRun ? 'bg-slate-900 hover:bg-slate-800' : 'bg-rose-600 hover:bg-rose-700',
                  )}
                >
                  {pruneDryRun ? '预检' : '执行清理'}
                </button>
              </div>
            </InfoPanel>
          </>
        ) : null}

        {tab === 'recommendations' ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <InfoMetricCard label="活跃用户" value={recommendations?.totalUsers ?? '—'} detail="有生成历史的用户数" icon={FaUsers} tone="emerald" />
              <InfoMetricCard label="生成记录" value={recommendations?.totalGenerations ?? '—'} detail="累计记录条数" icon={FaBoxOpen} tone="sky" />
              <InfoMetricCard label="正向反馈" value={recommendations?.feedback.like ?? '—'} detail="标记「喜欢」的风格数" icon={FaLightbulb} tone="emerald" />
              <InfoMetricCard
                label="负向反馈"
                value={recommendations ? recommendations.feedback.dislike + recommendations.feedback.notInterested : '—'}
                detail="不喜欢 / 不感兴趣，会从推荐中排除"
                icon={FaBellSlash}
                tone="rose"
              />
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              <InfoPanel>
                <InfoSectionTitle title="热门风格" description="按生成记录次数统计的前 10 个风格。" icon={FaLightbulb} tone="violet" />
                {recommendations && recommendations.topStyles.length > 0 ? (
                  <ul className="space-y-2 text-sm">
                    {recommendations.topStyles.map((row) => (
                      <li key={row.styleId} className="flex items-center justify-between gap-3">
                        <span className="font-mono text-xs">{row.styleId}</span>
                        <span className="text-slate-500">{row.total}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-slate-500">暂无数据。</p>
                )}
              </InfoPanel>

              <InfoPanel>
                <InfoSectionTitle title="语言分布" description="按生成记录的语言统计。" icon={FaGlobe} tone="sky" />
                {recommendations && recommendations.topLanguages.length > 0 ? (
                  <ul className="space-y-2 text-sm">
                    {recommendations.topLanguages.map((row) => (
                      <li key={row.language} className="flex items-center justify-between gap-3">
                        <span>{row.language}</span>
                        <span className="text-slate-500">{row.total}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-slate-500">暂无数据。</p>
                )}
              </InfoPanel>
            </div>
          </>
        ) : null}

        {tab === 'invites' ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <InfoMetricCard label="邀请码总数" value={invites?.total ?? '—'} detail={invites ? `启用 ${invites.active} · 已过期 ${invites.expired}` : ''} icon={FaUsers} tone="violet" />
              <InfoMetricCard label="累计使用" value={invites?.totalUses ?? '—'} detail={invites ? `剩余可用次数 ${invites.remainingUses}` : ''} icon={FaEnvelopeOpenText} tone="sky" />
              <InfoMetricCard label="已用尽" value={invites?.exhausted ?? '—'} detail="达到最大使用次数" icon={FaBoxOpen} tone="amber" />
              <InfoMetricCard label="近 30 天使用" value={invites ? invites.trend.reduce((sum, row) => sum + row.uses, 0) : '—'} detail="按天聚合的注册用量" icon={FaLightbulb} tone="emerald" />
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              <InfoPanel>
                <InfoSectionTitle title="用量最高的邀请码" icon={FaUsers} tone="violet" />
                {invites && invites.topCodes.length > 0 ? (
                  <ul className="space-y-2 text-sm">
                    {invites.topCodes.map((row) => (
                      <li key={row.code} className="flex items-center justify-between gap-3">
                        <span className="font-mono text-xs">{row.code}</span>
                        <span className="text-slate-500">
                          {row.usedCount} / {row.maxUses}
                          {row.active ? '' : '（已停用）'}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-slate-500">暂无数据。</p>
                )}
              </InfoPanel>

              <InfoPanel>
                <InfoSectionTitle title="最近使用" icon={FaEnvelopeOpenText} tone="sky" />
                {invites && invites.recentUses.length > 0 ? (
                  <ul className="space-y-2 text-sm">
                    {invites.recentUses.map((row) => (
                      <li key={`${row.code}-${row.usedAt}-${row.username}`} className="flex items-center justify-between gap-3">
                        <span className="truncate">
                          <span className="font-mono text-xs">{row.code}</span>
                          <span className="ml-2 text-slate-500">{row.username || '—'}</span>
                        </span>
                        <span className="shrink-0 text-xs text-slate-500">{formatTime(row.usedAt)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-slate-500">暂无数据。</p>
                )}
              </InfoPanel>
            </div>
          </>
        ) : null}
      </div>
    </InfoQueryShell>
  );
};

export default IntegrationsHealthPanel;
