import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FaClipboardCheck, FaExclamationTriangle, FaFileSignature, FaListUl, FaSync } from 'react-icons/fa';
import { policyConsentApi, type PolicyConsentOverviewResponse } from '@/api/policyConsents';
import { useNotification } from '@/components/Notification';
import { InfoBadge, InfoQueryHero, InfoQueryShell } from '@/components/studioTheme';
import { cn } from '@/lib/utils';
import { getBackendErrorMessage } from '@/utils/backendError';
import { AUTO_REFRESH_OPTIONS } from './ip-risk-log/format';
import { FilterSelect } from './ip-risk-log/ui';
import PolicyConsentOverviewTab from './policy-consent/PolicyConsentOverviewTab';
import PolicyConsentRecordsTab from './policy-consent/PolicyConsentRecordsTab';
import { TREND_WINDOW_OPTIONS } from './policy-consent/shared';

/**
 * 隐私政策同意记录只读面板：概览计数 + 版本/来源分布 + 逐条记录（分页 + 多条件筛选 + CSV 导出）。
 * 数据源为 policy_consents 集合，由 policyConsentService.writePolicyConsent 单点写入（登录/注册/TTS 门禁）。
 * 面板全部只读，唯一的批量出口（导出）由服务端挂审计留痕并封顶行数。
 */

type TabKey = 'overview' | 'records';

const TABS: ReadonlyArray<{ key: TabKey; label: string; icon: React.ReactNode; hint: string }> = [
  { key: 'overview', label: '概览', icon: <FaClipboardCheck />, hint: '计数 / 版本与来源分布 / 趋势' },
  { key: 'records', label: '同意记录', icon: <FaListUl />, hint: 'policy_consents 逐条记录（可导出 CSV）' },
];

const PolicyConsentPanel: React.FC = () => {
  const { setNotification } = useNotification();

  const [tab, setTab] = useState<TabKey>('overview');
  const [autoRefreshMs, setAutoRefreshMs] = useState(0);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [trendDays, setTrendDays] = useState(7);
  // 「仅看勾选不完整」：概览卡片与记录 tab 共用，点击卡片即切到筛选后的列表
  const [incompleteOnly, setIncompleteOnly] = useState(false);

  const [overview, setOverview] = useState<PolicyConsentOverviewResponse | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const overviewRequestRef = useRef(0);
  const lastNoticeRef = useRef<string | null>(null);

  const loadOverview = useCallback(async () => {
    const requestId = ++overviewRequestRef.current;
    setOverviewLoading(true);
    try {
      const res = await policyConsentApi.overview(trendDays);
      if (requestId !== overviewRequestRef.current) return;
      setOverview(res);
      setOverviewError(null);
      setLastUpdatedAt(Date.now());
      lastNoticeRef.current = null;
    } catch (error) {
      if (requestId !== overviewRequestRef.current) return;
      const message = getBackendErrorMessage(error, '加载同意记录概览失败');
      setOverviewError(message);
      if (lastNoticeRef.current !== message) {
        lastNoticeRef.current = message;
        setNotification({ message, type: 'error' });
      }
    } finally {
      if (requestId === overviewRequestRef.current) setOverviewLoading(false);
    }
  }, [setNotification, trendDays]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview, refreshNonce]);

  useEffect(() => {
    if (autoRefreshMs <= 0) return;
    // 显式声明为 number：本仓 CI 把 ReturnType<typeof window.setInterval> 解析成 DOM Timeout。
    const timer: number = window.setInterval(() => {
      setRefreshNonce((current) => current + 1);
    }, autoRefreshMs);
    return () => window.clearInterval(timer);
  }, [autoRefreshMs]);

  return (
    <InfoQueryShell maxWidthClassName="max-w-7xl">
      <InfoQueryHero
        eyebrow="隐私政策合规"
        title="政策同意记录"
        description={
          '把 policy_consents 集合摊开：谁（设备指纹）在什么时候、从哪个入口（登录/注册/TTS 门禁）同意了哪个版本的政策、勾选了哪几份文件、什么时候到期、同意的是哪份条文。同一设备重复同意会原地续期而非堆积；用户主动撤回会留下撤回时间与 IP。本页只读，导出会写审计日志。'
        }
        icon={FaFileSignature}
        tone="violet"
        meta={
          <>
            {overview ? <InfoBadge tone="violet">当前版本 {overview.currentVersion}</InfoBadge> : null}
            {overview ? <InfoBadge tone="slate">同意有效期 {overview.validityDays} 天</InfoBadge> : null}
            <InfoBadge>
              {lastUpdatedAt
                ? `概览更新于 ${new Date(lastUpdatedAt).toLocaleTimeString('zh-CN', { hour12: false })}`
                : '概览尚未加载'}
            </InfoBadge>
            <InfoBadge>本页只读 · 导出留痕</InfoBadge>
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
              title="趋势窗口"
              value={trendDays}
              options={TREND_WINDOW_OPTIONS}
              onChange={(value) => setTrendDays(Number(value))}
            />
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
              className="inline-flex items-center gap-2 rounded-2xl bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:opacity-50"
            >
              <FaSync className={cn(overviewLoading && 'animate-spin')} /> 刷新全部
            </button>
          </>
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
          <PolicyConsentOverviewTab
            overview={overview}
            loading={overviewLoading}
            error={overviewError}
            onFocusIncomplete={() => {
              setIncompleteOnly(true);
              setTab('records');
            }}
          />
        ) : null}
        {tab === 'records' ? (
          <PolicyConsentRecordsTab
            refreshNonce={refreshNonce}
            agreementKeys={overview?.agreementKeys ?? []}
            incompleteOnly={incompleteOnly}
            onIncompleteOnlyChange={setIncompleteOnly}
          />
        ) : null}
      </div>
    </InfoQueryShell>
  );
};

export default PolicyConsentPanel;
