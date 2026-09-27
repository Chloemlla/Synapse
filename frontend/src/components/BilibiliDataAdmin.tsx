import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FaCookieBite,
  FaDatabase,
  FaExclamationTriangle,
  FaFingerprint,
  FaMobileAlt,
  FaRedo,
  FaSearch,
  FaShieldAlt,
  FaUserTag,
} from 'react-icons/fa';
import { useAuth } from '@/hooks/useAuth';
import { isAdminRole } from '@/utils/rbac';
import {
  InfoBadge,
  InfoMetricCard,
  InfoPanel,
  InfoQueryHero,
  studioFieldClassName,
  studioSecondaryButtonClassName,
} from './studioTheme';

type BilibiliTab = 'reports' | 'accounts';

interface DeviceSummary {
  platform?: unknown;
  model?: unknown;
  brand?: unknown;
  appVersion?: unknown;
  sdkInt?: unknown;
}

interface ClientIdentity {
  clientId?: string;
  clientName?: string;
  clientVersion?: string;
  clientBuild?: string;
  deviceId?: string;
  deviceName?: string;
  platform?: string;
}

interface CookieReportRow {
  clientId: string;
  deviceId: string;
  uid: string;
  isPrimary: boolean;
  status: 'active' | 'invalid';
  reportCount: number;
  firstReportedAt: string;
  lastReportedAt: string;
  deviceSummary: DeviceSummary;
  permissionsCount: number;
  client: ClientIdentity;
}

interface AccountBindingRow {
  userId: string;
  uid: string;
  status: 'active' | 'invalid';
  isPrimary: boolean;
  boundAt: string;
  lastSyncedAt: string;
  deviceSummary: DeviceSummary;
  permissionsCount: number;
  client: ClientIdentity;
}

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

const EMPTY_PAGINATION: Pagination = { page: 1, limit: 20, total: 0, totalPages: 0 };

const formatDate = (value?: string): string => {
  if (!value) return '-';
  try {
    return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  } catch {
    return value;
  }
};

const asText = (value: unknown): string => {
  if (value === null || value === undefined || value === '') return '-';
  return String(value);
};

const getErrorMessage = (error: unknown, fallback: string): string => {
  if (typeof error === 'object' && error !== null) {
    const maybe = error as { response?: { data?: { error?: string } }; message?: string };
    return maybe.response?.data?.error || maybe.message || fallback;
  }
  return fallback;
};

const TAB_META: Record<
  BilibiliTab,
  { label: string; endpoint: string; description: string }
> = {
  reports: {
    label: '登录 Cookie 上报',
    endpoint: '/api/admin/bilibili-reports',
    description: 'bilibili_cookie_reports · 客户端登录后按设备 id 上报的登录凭据（只存密文）',
  },
  accounts: {
    label: '账号绑定',
    endpoint: '/api/admin/bilibili-accounts',
    description: 'bilibili_account_bindings · 授权用户在设备间同步的多账号绑定（只存密文）',
  },
};

const deviceLabel = (summary: DeviceSummary): string => {
  const brand = asText(summary.brand);
  const model = asText(summary.model);
  if (brand !== '-' && model !== '-') return `${brand} ${model}`;
  if (model !== '-') return model;
  if (brand !== '-') return brand;
  return '-';
};

const statusBadge = (status: string) =>
  status === 'active' ? (
    <InfoBadge tone='emerald'>有效</InfoBadge>
  ) : (
    <InfoBadge tone='rose'>失效</InfoBadge>
  );

const BilibiliDataAdmin: React.FC = () => {
  const { user } = useAuth();
  const isAdmin = isAdminRole(user?.role);

  const [tab, setTab] = useState<BilibiliTab>('reports');
  const [keyword, setKeyword] = useState('');
  const [reports, setReports] = useState<CookieReportRow[]>([]);
  const [accounts, setAccounts] = useState<AccountBindingRow[]>([]);
  const [pagination, setPagination] = useState<Pagination>(EMPTY_PAGINATION);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const fetchData = useCallback(
    async (currentTab: BilibiliTab, page: number, searchTerm: string) => {
      setLoading(true);
      setError('');
      try {
        const params = new URLSearchParams({ page: String(page), limit: '20' });
        if (searchTerm) params.set('search', searchTerm);
        const res = await fetch(`${TAB_META[currentTab].endpoint}?${params}`, {
          credentials: 'include',
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (!json.success) throw new Error(json.error || '请求失败');
        if (currentTab === 'reports') {
          setReports(json.data as CookieReportRow[]);
          setAccounts([]);
        } else {
          setAccounts(json.data as AccountBindingRow[]);
          setReports([]);
        }
        setPagination(json.pagination as Pagination);
      } catch (e) {
        setError(getErrorMessage(e, '加载失败'));
        setReports([]);
        setAccounts([]);
        setPagination(EMPTY_PAGINATION);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (isAdmin) fetchData(tab, 1, '');
    // Reset the search box when switching collections.
    setKeyword('');
  }, [tab, isAdmin, fetchData]);

  const handleSearch = () => fetchData(tab, 1, keyword);
  const handlePageChange = (page: number) => fetchData(tab, page, keyword);

  const stats = useMemo(() => {
    if (tab === 'reports') {
      const total = pagination.total;
      const active = reports.filter((r) => r.status === 'active').length;
      const totalReports = reports.reduce((sum, r) => sum + (r.reportCount || 0), 0);
      const devices = new Set(reports.map((r) => r.deviceId)).size;
      return { total, active, extra: totalReports, devices };
    }
    const total = pagination.total;
    const active = accounts.filter((a) => a.status === 'active').length;
    const primary = accounts.filter((a) => a.isPrimary).length;
    const users = new Set(accounts.map((a) => a.userId)).size;
    return { total, active, extra: primary, devices: users };
  }, [tab, reports, accounts, pagination.total]);

  const rangeStart = pagination.total === 0 ? 0 : (pagination.page - 1) * pagination.limit + 1;
  const rangeEnd = Math.min(pagination.page * pagination.limit, pagination.total);

  return (
    <div className='space-y-6'>
      <InfoQueryHero
        eyebrow='PiliPlus'
        title='Bilibili 凭据与设备'
        description='查看 PiliPlus 上报到 Synapse 的 B 站登录凭据与账号绑定。所有 Cookie 仅以密文存档，此处只展示元数据，绝不回传明文。'
        icon={FaDatabase}
        tone='violet'
        meta={
          <>
            <InfoBadge tone='violet'>{TAB_META[tab].description.split(' · ')[0]}</InfoBadge>
            <InfoBadge tone='slate'>管理员专属</InfoBadge>
            <InfoBadge tone='slate'>{pagination.total} 条记录</InfoBadge>
          </>
        }
        actions={
          <button
            type='button'
            className={studioSecondaryButtonClassName}
            onClick={() => fetchData(tab, pagination.page, keyword)}
            disabled={loading}
          >
            <FaRedo className={loading ? 'animate-spin' : ''} />
            刷新
          </button>
        }
      />

      {!isAdmin && (
        <InfoPanel>
          <div className='flex items-start gap-3'>
            <div className='flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-red-100 text-red-700'>
              <FaExclamationTriangle />
            </div>
            <div>
              <h2 className='text-base font-semibold text-slate-900'>权限不足</h2>
              <p className='mt-1 text-sm leading-6 text-slate-600'>需要管理员权限才能查看此页面。</p>
            </div>
          </div>
        </InfoPanel>
      )}

      {isAdmin && (
        <>
          <div className='flex flex-wrap gap-2'>
            {(Object.keys(TAB_META) as BilibiliTab[]).map((key) => (
              <button
                key={key}
                type='button'
                onClick={() => setTab(key)}
                className={`inline-flex items-center gap-2 rounded-2xl border-2 px-4 py-2.5 text-sm font-semibold transition ${
                  tab === key
                    ? 'border-violet-300 bg-violet-50 text-violet-700'
                    : 'border-slate-200 bg-white/80 text-slate-600 hover:border-slate-300 hover:text-slate-900'
                }`}
              >
                {key === 'reports' ? <FaCookieBite /> : <FaUserTag />}
                {TAB_META[key].label}
              </button>
            ))}
          </div>

          <p className='text-xs leading-6 text-slate-500'>{TAB_META[tab].description}</p>

          <div className='grid gap-4 md:grid-cols-4'>
            <InfoMetricCard label='本页记录' value={stats.total} detail='数据库全部记录' icon={FaDatabase} />
            <InfoMetricCard
              label='凭据有效'
              value={stats.active}
              detail={`${reports.length + accounts.length > 0 ? ((stats.active / Math.max(1, reports.length + accounts.length)) * 100).toFixed(0) : 0}% 本页有效`}
              icon={FaShieldAlt}
            />
            {tab === 'reports' ? (
              <>
                <InfoMetricCard label='累计上报' value={stats.extra} detail='本页 reportCount 之和' icon={FaCookieBite} />
                <InfoMetricCard label='涉及设备' value={stats.devices} detail='本页去重设备数' icon={FaMobileAlt} />
              </>
            ) : (
              <>
                <InfoMetricCard label='主账号' value={stats.extra} detail='本页 isPrimary 数' icon={FaUserTag} />
                <InfoMetricCard label='涉及用户' value={stats.devices} detail='本页去重 Synapse 用户' icon={FaFingerprint} />
              </>
            )}
          </div>

          <InfoPanel>
            <div className='flex flex-col gap-3 sm:flex-row'>
              <div className='relative flex-1'>
                <FaSearch className='pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400' />
                <input
                  type='text'
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                  placeholder={tab === 'reports' ? '搜索 设备 id / UID / 客户端' : '搜索 Synapse 用户 id / UID'}
                  className={`${studioFieldClassName} pl-11`}
                />
              </div>
              <button type='button' className={studioSecondaryButtonClassName} onClick={handleSearch} disabled={loading}>
                <FaSearch />
                搜索
              </button>
            </div>
          </InfoPanel>

          {error && (
            <InfoPanel>
              <div className='flex items-center gap-3 text-rose-700'>
                <FaExclamationTriangle />
                <span className='text-sm'>{error}</span>
              </div>
            </InfoPanel>
          )}

          <InfoPanel compact>
            <div className='overflow-x-auto'>
              {tab === 'reports' ? (
                <table className='w-full min-w-[720px] text-left text-sm'>
                  <thead>
                    <tr className='border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500'>
                      <th className='px-3 py-3'>UID</th>
                      <th className='px-3 py-3'>状态</th>
                      <th className='px-3 py-3'>设备</th>
                      <th className='px-3 py-3'>客户端</th>
                      <th className='px-3 py-3'>上报次数</th>
                      <th className='px-3 py-3'>首次 / 最近</th>
                      <th className='px-3 py-3'>设备 id</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reports.map((row) => (
                      <tr key={`${row.clientId}:${row.deviceId}:${row.uid}`} className='border-b border-slate-100 align-top'>
                        <td className='px-3 py-3 font-semibold text-slate-900'>
                          {row.uid}
                          {row.isPrimary && <InfoBadge tone='violet' className='ml-2'>主</InfoBadge>}
                        </td>
                        <td className='px-3 py-3'>{statusBadge(row.status)}</td>
                        <td className='px-3 py-3 text-slate-700'>
                          {deviceLabel(row.deviceSummary)}
                          <div className='text-xs text-slate-400'>{asText(row.deviceSummary.platform)}</div>
                        </td>
                        <td className='px-3 py-3 text-slate-700'>
                          {asText(row.client.clientName || row.clientId)}
                          <div className='text-xs text-slate-400'>{asText(row.client.clientVersion)}</div>
                        </td>
                        <td className='px-3 py-3 text-slate-700'>{row.reportCount}</td>
                        <td className='px-3 py-3 text-xs text-slate-500'>
                          <div>{formatDate(row.firstReportedAt)}</div>
                          <div className='text-slate-700'>{formatDate(row.lastReportedAt)}</div>
                        </td>
                        <td className='px-3 py-3'>
                          <code className='rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600'>
                            {row.deviceId.slice(0, 12)}…
                          </code>
                        </td>
                      </tr>
                    ))}
                    {reports.length === 0 && !loading && (
                      <tr>
                        <td colSpan={7} className='px-3 py-10 text-center text-slate-400'>
                          暂无记录
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              ) : (
                <table className='w-full min-w-[720px] text-left text-sm'>
                  <thead>
                    <tr className='border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500'>
                      <th className='px-3 py-3'>UID</th>
                      <th className='px-3 py-3'>状态</th>
                      <th className='px-3 py-3'>Synapse 用户</th>
                      <th className='px-3 py-3'>设备</th>
                      <th className='px-3 py-3'>权限数</th>
                      <th className='px-3 py-3'>绑定 / 最近同步</th>
                    </tr>
                  </thead>
                  <tbody>
                    {accounts.map((row) => (
                      <tr key={`${row.userId}:${row.uid}`} className='border-b border-slate-100 align-top'>
                        <td className='px-3 py-3 font-semibold text-slate-900'>
                          {row.uid}
                          {row.isPrimary && <InfoBadge tone='violet' className='ml-2'>主</InfoBadge>}
                        </td>
                        <td className='px-3 py-3'>{statusBadge(row.status)}</td>
                        <td className='px-3 py-3'>
                          <code className='rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600'>{row.userId}</code>
                        </td>
                        <td className='px-3 py-3 text-slate-700'>
                          {deviceLabel(row.deviceSummary)}
                          <div className='text-xs text-slate-400'>{asText(row.deviceSummary.platform)}</div>
                        </td>
                        <td className='px-3 py-3 text-slate-700'>{row.permissionsCount}</td>
                        <td className='px-3 py-3 text-xs text-slate-500'>
                          <div>{formatDate(row.boundAt)}</div>
                          <div className='text-slate-700'>{formatDate(row.lastSyncedAt)}</div>
                        </td>
                      </tr>
                    ))}
                    {accounts.length === 0 && !loading && (
                      <tr>
                        <td colSpan={6} className='px-3 py-10 text-center text-slate-400'>
                          暂无记录
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              )}
            </div>

            {pagination.totalPages > 1 && (
              <div className='mt-4 flex items-center justify-between text-sm text-slate-500'>
                <span>
                  第 {rangeStart}–{rangeEnd} 条，共 {pagination.total} 条
                </span>
                <div className='flex gap-2'>
                  <button
                    type='button'
                    className={studioSecondaryButtonClassName}
                    disabled={pagination.page <= 1 || loading}
                    onClick={() => handlePageChange(pagination.page - 1)}
                  >
                    上一页
                  </button>
                  <button
                    type='button'
                    className={studioSecondaryButtonClassName}
                    disabled={pagination.page >= pagination.totalPages || loading}
                    onClick={() => handlePageChange(pagination.page + 1)}
                  >
                    下一页
                  </button>
                </div>
              </div>
            )}
          </InfoPanel>
        </>
      )}
    </div>
  );
};

export default BilibiliDataAdmin;
