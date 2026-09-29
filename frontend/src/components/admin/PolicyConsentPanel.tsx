import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  FaCheckCircle,
  FaClipboardCheck,
  FaExclamationTriangle,
  FaFileSignature,
  FaHourglassHalf,
  FaListUl,
  FaSync,
} from 'react-icons/fa';
import {
  policyConsentApi,
  type PolicyConsentListResponse,
  type PolicyConsentOverviewResponse,
  type PolicyConsentRow,
  type PolicyConsentSource,
  type PolicyConsentState,
} from '@/api/policyConsents';
import { useNotification } from '@/components/Notification';
import {
  InfoBadge,
  InfoMetricCard,
  InfoPanel,
  InfoQueryHero,
  InfoQueryShell,
} from '@/components/studioTheme';
import { cn } from '@/lib/utils';
import { getBackendErrorMessage } from '@/utils/backendError';
import {
  AUTO_REFRESH_OPTIONS,
  PAGE_SIZE_OPTIONS,
  type BadgeStyle,
  formatCount,
} from './ip-risk-log/format';
import {
  Badge,
  FilterSelect,
  Pager,
  RefreshButton,
  SectionNote,
  TableState,
  TableWrap,
  Td,
  Th,
  useErrorNotice,
} from './ip-risk-log/ui';

/**
 * 隐私政策同意记录只读面板：概览计数 + 版本/来源分布 + 逐条记录（分页 + 指纹/IP/版本/来源/状态筛选）。
 * 数据源为 policy_consents 集合，由 policyConsentService.writePolicyConsent 单点写入（登录/注册/TTS 门禁）。
 * 本页全部只读，checksum 只展示前 12 位预览。
 */

type TabKey = 'overview' | 'records';

const TABS: ReadonlyArray<{ key: TabKey; label: string; icon: React.ReactNode; hint: string }> = [
  { key: 'overview', label: '概览', icon: <FaClipboardCheck />, hint: '计数 / 版本与来源分布 / 近 7 天趋势' },
  { key: 'records', label: '同意记录', icon: <FaListUl />, hint: 'policy_consents 逐条记录' },
];

const VALID_BADGE: BadgeStyle = {
  label: '有效',
  badgeClass: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  dotClass: 'bg-emerald-500',
};
const EXPIRED_BADGE: BadgeStyle = {
  label: '已过期',
  badgeClass: 'border-slate-200 bg-slate-100 text-slate-500',
  dotClass: 'bg-slate-400',
};
const INVALID_BADGE: BadgeStyle = {
  label: '已失效',
  badgeClass: 'border-orange-200 bg-orange-50 text-orange-700',
  dotClass: 'bg-orange-500',
};

/** 一条记录的状态徽标：先判是否置无效（撤销/顶替），再判是否过期，否则有效。 */
const consentBadge = (row: PolicyConsentRow): BadgeStyle => {
  if (!row.isValid) return INVALID_BADGE;
  if (row.expired) return EXPIRED_BADGE;
  return VALID_BADGE;
};

const SOURCE_LABELS: Record<string, string> = {
  login: '登录',
  register: '注册',
  feature: 'TTS 门禁',
};

const sourceLabel = (source: string): string => SOURCE_LABELS[source] ?? (source || '（未知）');

const SOURCE_FILTER_OPTIONS: ReadonlyArray<{ value: PolicyConsentSource | ''; label: string }> = [
  { value: '', label: '全部来源' },
  { value: 'login', label: '登录' },
  { value: 'register', label: '注册' },
  { value: 'feature', label: 'TTS 门禁' },
];

const STATE_FILTER_OPTIONS: ReadonlyArray<{ value: PolicyConsentState; label: string }> = [
  { value: 'valid', label: '仅有效' },
  { value: 'expired', label: '仅已过期/失效' },
  { value: 'all', label: '全部' },
];

const formatIso = (value: string | null): string =>
  value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '-';

const Mono: React.FC<{ value: string | null | undefined; title?: string; max?: number }> = ({
  value,
  title,
  max,
}) => {
  const display = value && max && value.length > max ? `${value.slice(0, max)}…` : value;
  return (
    <span className="font-mono text-[11px] text-slate-600" title={title ?? value ?? undefined}>
      {display || '-'}
    </span>
  );
};

const AgreementsCell: React.FC<{ row: PolicyConsentRow }> = ({ row }) => {
  if (row.agreementsComplete) {
    return (
      <span className="inline-flex items-center gap-1.5 text-emerald-700">
        <FaCheckCircle className="text-[11px]" />
        <span className="text-xs font-semibold">四项齐全</span>
      </span>
    );
  }
  if (row.agreements.length === 0) {
    return <span className="text-xs text-slate-400" title="老记录没有 agreements 字段">未记录</span>;
  }
  return (
    <span className="text-xs text-amber-700" title={row.agreements.join(', ')}>
      {row.agreements.length} / 4 项
    </span>
  );
};

const OverviewTab: React.FC<{
  overview: PolicyConsentOverviewResponse | null;
  loading: boolean;
  error: string | null;
}> = ({ overview, loading, error }) => {
  const counts = overview?.counts;
  const maxVersion = Math.max(1, ...(overview?.versions.map((row) => row.count) ?? [1]));
  const maxSource = Math.max(1, ...(overview?.sources.map((row) => row.count) ?? [1]));
  const maxTrend = Math.max(1, ...(overview?.recentTrend.map((row) => row.count) ?? [1]));

  return (
    <div className="space-y-5">
      <SectionNote>
        {loading && !overview
          ? '正在读取同意记录统计……'
          : '每一条记录 = 一个设备指纹对某个版本政策的一次同意。同一指纹 + 版本已有有效记录时原地续期（不新增行）。'}
        {overview ? (
          <>
            {' '}当前版本 <code>{overview.currentVersion}</code>，同意有效期 {overview.validityDays} 天；
            版本号变化会让旧同意不再覆盖新条文，依赖同意的功能会要求重新同意。
          </>
        ) : null}
      </SectionNote>

      {error ? (
        <InfoPanel compact>
          <div className="px-4 py-3 text-sm text-rose-600">{error}</div>
        </InfoPanel>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        <InfoMetricCard
          label="记录总量（含已过期）"
          value={counts ? formatCount(counts.total) : '—'}
          detail={overview ? `集合 ${overview.collection.name}` : '等待概览'}
          icon={FaFileSignature}
          tone="sky"
        />
        <InfoMetricCard
          label="当前有效"
          value={counts ? formatCount(counts.valid) : '—'}
          detail="isValid 且未过期"
          icon={FaCheckCircle}
          tone="teal"
        />
        <InfoMetricCard
          label="已过期 / 失效"
          value={counts ? formatCount(counts.expired) : '—'}
          detail="过期或被撤销顶替；TTL 索引会陆续清理"
          icon={FaHourglassHalf}
          tone="slate"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <InfoPanel compact>
          <div className="mb-3 flex items-center gap-2 px-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">按版本分布</span>
          </div>
          {overview && overview.versions.length > 0 ? (
            <div className="space-y-2">
              {overview.versions.map((row) => (
                <div key={row.key} className="flex items-center gap-3">
                  <span className="w-16 shrink-0 font-mono text-xs text-slate-600">{row.key}</span>
                  <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full bg-sky-400"
                      style={{ width: `${Math.round((row.count / maxVersion) * 100)}%` }}
                    />
                  </div>
                  <span className="w-16 shrink-0 text-right text-xs font-semibold text-slate-700">
                    {formatCount(row.count)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="px-1 text-xs text-slate-400">暂无数据</p>
          )}
        </InfoPanel>

        <InfoPanel compact>
          <div className="mb-3 flex items-center gap-2 px-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">按来源分布</span>
          </div>
          {overview && overview.sources.length > 0 ? (
            <div className="space-y-2">
              {overview.sources.map((row) => (
                <div key={row.key} className="flex items-center gap-3">
                  <span className="w-20 shrink-0 text-xs text-slate-600">{sourceLabel(row.key)}</span>
                  <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full bg-violet-400"
                      style={{ width: `${Math.round((row.count / maxSource) * 100)}%` }}
                    />
                  </div>
                  <span className="w-16 shrink-0 text-right text-xs font-semibold text-slate-700">
                    {formatCount(row.count)}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="px-1 text-xs text-slate-400">暂无数据</p>
          )}
        </InfoPanel>
      </div>

      <InfoPanel compact>
        <div className="mb-3 flex items-center gap-2 px-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">近 7 天同意趋势</span>
          <span className="text-xs text-slate-400">按 recordedAt 分日计数</span>
        </div>
        {overview && overview.recentTrend.length > 0 ? (
          <div className="flex items-end gap-2 px-1 pb-1">
            {overview.recentTrend.map((row) => (
              <div key={row.date} className="flex flex-1 flex-col items-center gap-1">
                <span className="text-[10px] font-semibold text-slate-600">{formatCount(row.count)}</span>
                <div
                  className="w-full rounded-t-lg bg-emerald-400"
                  style={{ height: `${Math.max(4, Math.round((row.count / maxTrend) * 96))}px` }}
                  title={`${row.date}：${row.count} 条`}
                />
                <span className="text-[10px] text-slate-400">{row.date.slice(5)}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="px-1 text-xs text-slate-400">近 7 天暂无新增同意记录</p>
        )}
      </InfoPanel>

      {overview ? (
        <InfoPanel compact>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">集合索引</span>
            <span className="text-xs text-slate-400">{overview.collection.name}</span>
            {overview.collection.exists ? (
              <InfoBadge tone="emerald" className="text-[10px]">存在</InfoBadge>
            ) : (
              <InfoBadge tone="amber" className="text-[10px]">集合尚未创建</InfoBadge>
            )}
          </div>
          {overview.collection.indexes.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5 px-1">
              {overview.collection.indexes.map((index) => (
                <span
                  key={index}
                  className="rounded-full border border-slate-200 bg-white/80 px-2.5 py-0.5 font-mono text-[11px] text-slate-600"
                >
                  {index}
                </span>
              ))}
            </div>
          ) : (
            <p className="mt-2 px-1 text-xs text-slate-400">无可读取的索引信息</p>
          )}
        </InfoPanel>
      ) : null}
    </div>
  );
};

const RecordsTab: React.FC<{ refreshNonce: number; agreementKeys: string[] }> = ({
  refreshNonce,
  agreementKeys,
}) => {
  const reportError = useErrorNotice();

  const [fingerprintDraft, setFingerprintDraft] = useState('');
  const [ipDraft, setIpDraft] = useState('');
  const [fingerprint, setFingerprint] = useState('');
  const [ip, setIp] = useState('');
  const [source, setSource] = useState<PolicyConsentSource | ''>('');
  const [state, setState] = useState<PolicyConsentState>('valid');
  const [limit, setLimit] = useState(PAGE_SIZE_OPTIONS[1] ?? 50);
  const [offset, setOffset] = useState(0);
  const [manualNonce, setManualNonce] = useState(0);

  const [data, setData] = useState<PolicyConsentListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    const requestId = ++requestRef.current;
    setLoading(true);
    void (async () => {
      try {
        const res = await policyConsentApi.list({
          limit,
          offset,
          fingerprint: fingerprint || undefined,
          ip: ip || undefined,
          source: source || undefined,
          state,
        });
        if (requestId !== requestRef.current) return;
        setData(res);
        setError(null);
      } catch (caught) {
        if (requestId !== requestRef.current) return;
        const message = getBackendErrorMessage(caught, '加载同意记录失败');
        setError(message);
        reportError(message);
      } finally {
        if (requestId === requestRef.current) setLoading(false);
      }
    })();
  }, [limit, offset, fingerprint, ip, source, state, refreshNonce, manualNonce, reportError]);

  const applyText = () => {
    setFingerprint(fingerprintDraft.trim());
    setIp(ipDraft.trim());
    setOffset(0);
  };

  const resetFilters = () => {
    setFingerprintDraft('');
    setIpDraft('');
    setFingerprint('');
    setIp('');
    setSource('');
    setState('valid');
    setOffset(0);
  };

  const rows = data?.consents ?? [];
  const total = data?.total ?? 0;

  return (
    <div className="space-y-4">
      <SectionNote>
        指纹与 IP 为<span className="font-semibold">精确匹配</span>（服务端只接受非空短字符串，非法值忽略），
        排序固定为 <code>recordedAt</code> 倒序。checksum 是服务端 HMAC 签名，只回前 12 位用于辨识，无法反推。
        同一设备重复同意时记录原地续期，所以「有效」记录数通常约等于活跃设备数，而非同意次数。
      </SectionNote>

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={fingerprintDraft}
          onChange={(event) => setFingerprintDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') applyText();
          }}
          placeholder="按设备指纹精确匹配（可选）"
          aria-label="按设备指纹精确匹配"
          className="min-w-0 flex-1 rounded-2xl border border-slate-200 bg-white/80 px-4 py-2 font-mono text-xs text-slate-700 transition focus:outline-none focus:ring-2 focus:ring-slate-300 sm:max-w-xs"
        />
        <input
          type="text"
          value={ipDraft}
          onChange={(event) => setIpDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') applyText();
          }}
          placeholder="按 IP 精确匹配（可选）"
          aria-label="按 IP 精确匹配"
          className="min-w-0 flex-1 rounded-2xl border border-slate-200 bg-white/80 px-4 py-2 font-mono text-xs text-slate-700 transition focus:outline-none focus:ring-2 focus:ring-slate-300 sm:max-w-xs"
        />
        <button
          type="button"
          onClick={applyText}
          className="inline-flex items-center gap-2 rounded-2xl bg-slate-900 px-4 py-2 text-xs font-semibold text-white transition hover:bg-slate-800"
        >
          查询
        </button>
        <FilterSelect
          title="按来源筛选"
          value={source}
          options={SOURCE_FILTER_OPTIONS}
          onChange={(value) => {
            setSource(value as PolicyConsentSource | '');
            setOffset(0);
          }}
        />
        <FilterSelect
          title="按状态筛选"
          value={state}
          options={STATE_FILTER_OPTIONS}
          onChange={(value) => {
            setState(value as PolicyConsentState);
            setOffset(0);
          }}
        />
        <FilterSelect
          title="每页条数"
          value={limit}
          options={PAGE_SIZE_OPTIONS.map((size) => ({ value: size, label: `每页 ${size} 条` }))}
          onChange={(value) => {
            setLimit(Number(value));
            setOffset(0);
          }}
        />
        <RefreshButton onClick={() => setManualNonce((current) => current + 1)} loading={loading} />
        {fingerprint || ip || source || state !== 'valid' ? (
          <button
            type="button"
            onClick={resetFilters}
            className="rounded-2xl border border-slate-200 bg-white/80 px-4 py-2 text-xs font-semibold text-slate-600 transition hover:border-slate-300"
          >
            重置筛选
          </button>
        ) : null}
        <span className="text-xs text-slate-500">
          命中 {formatCount(total)} 条{loading ? '（正在刷新…）' : ''}
        </span>
      </div>

      <InfoPanel compact>
        <TableWrap minWidth="min-w-[1180px]">
          <thead>
            <tr>
              <Th>同意时间</Th>
              <Th>状态</Th>
              <Th>版本</Th>
              <Th>来源</Th>
              <Th>设备指纹</Th>
              <Th>IP</Th>
              <Th>
                <span title={`需勾选：${agreementKeys.join(', ')}`}>勾选文件</span>
              </Th>
              <Th>到期时间</Th>
              <Th>checksum</Th>
              <Th>User-Agent</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            <TableState
              loading={loading && rows.length === 0}
              error={rows.length === 0 ? error : null}
              empty={!loading && rows.length === 0}
              emptyText="当前筛选条件下没有同意记录"
              colSpan={10}
            />
            {rows.map((row) => (
              <tr key={row.id} className="align-top hover:bg-slate-50/60">
                <Td className="whitespace-nowrap text-slate-700">{formatIso(row.recordedAt)}</Td>
                <Td>
                  <Badge style={consentBadge(row)} />
                </Td>
                <Td className="font-mono text-xs text-slate-600">{row.version || '-'}</Td>
                <Td className="text-slate-600">{sourceLabel(row.source)}</Td>
                <Td>
                  <Mono value={row.fingerprint} max={20} title={row.fingerprint} />
                </Td>
                <Td>
                  <Mono value={row.ipAddress} title={row.ipAddress} />
                </Td>
                <Td>
                  <AgreementsCell row={row} />
                </Td>
                <Td className="whitespace-nowrap text-slate-600">{formatIso(row.expiresAt)}</Td>
                <Td>
                  <Mono value={row.checksumPreview ? `${row.checksumPreview}…` : null} />
                </Td>
                <Td className="max-w-[220px]">
                  <span className="block truncate text-[11px] text-slate-500" title={row.userAgent}>
                    {row.userAgent || '-'}
                  </span>
                </Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
        {data && data.total > 0 ? (
          <Pager total={data.total} limit={data.limit} offset={data.offset} loading={loading} onChange={setOffset} />
        ) : null}
      </InfoPanel>
    </div>
  );
};

const PolicyConsentPanel: React.FC = () => {
  const { setNotification } = useNotification();

  const [tab, setTab] = useState<TabKey>('overview');
  const [autoRefreshMs, setAutoRefreshMs] = useState(0);
  const [refreshNonce, setRefreshNonce] = useState(0);

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
      const res = await policyConsentApi.overview();
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
  }, [setNotification]);

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
          '把 policy_consents 集合摊开：谁（设备指纹）在什么时候、从哪个入口（登录/注册/TTS 门禁）同意了哪个版本的政策、勾选了哪几份文件、什么时候到期。同一设备重复同意会原地续期而非堆积。本页全部只读。'
        }
        icon={FaFileSignature}
        tone="violet"
        meta={
          <>
            {overview ? <InfoBadge tone="violet">当前版本 {overview.currentVersion}</InfoBadge> : null}
            <InfoBadge>
              {lastUpdatedAt
                ? `概览更新于 ${new Date(lastUpdatedAt).toLocaleTimeString('zh-CN', { hour12: false })}`
                : '概览尚未加载'}
            </InfoBadge>
            <InfoBadge>本页全部只读</InfoBadge>
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
          <OverviewTab overview={overview} loading={overviewLoading} error={overviewError} />
        ) : null}
        {tab === 'records' ? (
          <RecordsTab refreshNonce={refreshNonce} agreementKeys={overview?.agreementKeys ?? []} />
        ) : null}
      </div>
    </InfoQueryShell>
  );
};

export default PolicyConsentPanel;
