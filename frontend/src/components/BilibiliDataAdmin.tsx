import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FaCookieBite,
  FaDatabase,
  FaExclamationTriangle,
  FaEye,
  FaEyeSlash,
  FaFingerprint,
  FaKey,
  FaLock,
  FaMobileAlt,
  FaRedo,
  FaRegCopy,
  FaSearch,
  FaShieldAlt,
  FaTrash,
  FaUserTag,
} from 'react-icons/fa';
import { useAuth } from '@/hooks/useAuth';
import { isAdminRole, isSuperAdmin } from '@/utils/rbac';
import { getSecuritySessionToken, useSecuritySession } from '@/hooks/useSecuritySession';
import EstablishSecuritySession from './EstablishSecuritySession';
import {
  InfoBadge,
  InfoMetricCard,
  InfoPanel,
  InfoQueryHero,
  studioFieldClassName,
  studioSecondaryButtonClassName,
} from './studioTheme';
import { StudioModal, StudioModalDangerButton, StudioModalHeader } from './studioFeedback';

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

const TAB_META: Record<BilibiliTab, { label: string; endpoint: string; description: string }> = {
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

/** 解密结果：`cookie` 为 null 时看 `error` 说原因。 */
interface RevealEntry {
  cookie: string | null;
  error?: 'not-found' | 'undecryptable' | string;
}

/** 一次 POST 里的一条目标：key 用于把响应按行回写到 state。 */
interface RevealTarget {
  key: string;
  payload: Record<string, string>;
}

const reportRevealKey = (row: CookieReportRow): string => `r:${row.clientId}:${row.deviceId}:${row.uid}`;
const accountRevealKey = (row: AccountBindingRow): string => `a:${row.userId}:${row.uid}`;

const revealErrorText = (error?: string): string => {
  if (error === 'undecryptable') {
    return '密文无法用当前密钥链解开（可能已轮换密钥或存档损坏），需要直接用数据库密钥排查。';
  }
  if (error === 'not-found') return '记录已不存在（可能刚被删除，或客户端已重新上报）。';
  return error ? `解密失败：${error}` : '未返回明文。';
};

/**
 * 单片明文展示：默认显示，可隐藏、可复制。
 *
 * 刻意不把明文直接铺在表格里：明文只在该行的展开块里存在，收起后从 DOM 移除（配合后端的
 * `Cache-Control: no-store`，不落浏览器缓存）。
 */
const RevealBox: React.FC<{ entry: RevealEntry; onHide: () => void }> = ({ entry, onHide }) => {
  const [visible, setVisible] = useState(true);
  const [copied, setCopied] = useState(false);

  if (!entry.cookie) {
    return (
      <div className='rounded-2xl border border-amber-200 bg-amber-50/70 p-3 text-xs leading-6 text-amber-800'>
        {revealErrorText(entry.error)}
      </div>
    );
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(entry.cookie ?? '');
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className='rounded-2xl border border-rose-200 bg-rose-50/50 p-3'>
      <div className='mb-2 flex flex-wrap items-center gap-2 text-xs text-rose-700'>
        <FaLock className='h-3 w-3' aria-hidden />
        <span className='font-semibold'>明文 Cookie</span>
        <span className='text-rose-500'>仅本屏可见 · 本次操作已写入审计</span>
        <button
          type='button'
          onClick={() => setVisible((current) => !current)}
          className='ml-auto inline-flex items-center gap-1 rounded-xl px-2 py-1 font-semibold text-slate-600 transition hover:bg-white'
        >
          {visible ? <FaEyeSlash className='h-3 w-3' /> : <FaEye className='h-3 w-3' />}
          {visible ? '隐藏' : '显示'}
        </button>
        <button
          type='button'
          onClick={() => void copy()}
          className='inline-flex items-center gap-1 rounded-xl px-2 py-1 font-semibold text-slate-600 transition hover:bg-white'
        >
          <FaRegCopy className='h-3 w-3' />
          {copied ? '已复制' : '复制'}
        </button>
        <button
          type='button'
          onClick={onHide}
          className='inline-flex items-center gap-1 rounded-xl px-2 py-1 font-semibold text-slate-600 transition hover:bg-white'
        >
          收起
        </button>
      </div>
      {visible ? (
        <textarea
          readOnly
          value={entry.cookie}
          rows={3}
          spellCheck={false}
          className='w-full resize-y rounded-xl border border-rose-200 bg-white p-2 font-mono text-[11px] leading-5 text-slate-800'
        />
      ) : (
        <p className='text-xs text-slate-500'>已隐藏（明文仍在本次响应内，刷新页面即消失）。</p>
      )}
    </div>
  );
};

const BilibiliDataAdmin: React.FC = () => {
  const { user } = useAuth();
  const isAdmin = isAdminRole(user?.role);
  // 删除是隐私删除权路径：只对超管开放，且按 (clientId, deviceId, uid) 精确命中。
  const canDelete = isSuperAdmin(user?.role);

  const requestRef = useRef(0);
  const [tab, setTab] = useState<BilibiliTab>('reports');
  const [keyword, setKeyword] = useState('');
  const [reports, setReports] = useState<CookieReportRow[]>([]);
  const [accounts, setAccounts] = useState<AccountBindingRow[]>([]);
  const [pagination, setPagination] = useState<Pagination>(EMPTY_PAGINATION);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<CookieReportRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  // 解密查看（超管 + 安全会话）。`revealed` 按行 key 存明文，收起时从 state 删掉。
  const { isActive: sessionActive, clear: clearSession } = useSecuritySession();
  const [revealed, setRevealed] = useState<Record<string, RevealEntry>>({});
  const [revealing, setRevealing] = useState(false);
  const [sessionOpen, setSessionOpen] = useState(false);
  /** 因“还没建安全会话”被拦下的目标：建立成功后自动重试，不让用户再点一遍。 */
  const pendingRevealRef = useRef<RevealTarget[] | null>(null);

  const revealRows = useCallback(
    async (targets: RevealTarget[]) => {
      if (targets.length === 0) return;
      // 直接从会话单例取 token：从 EstablishSecuritySession 回调里重试时，组件里的快照还是旧的。
      const token = getSecuritySessionToken();
      if (!token) {
        pendingRevealRef.current = targets;
        setSessionOpen(true);
        return;
      }
      setRevealing(true);
      setError('');
      try {
        const res = await fetch(`${TAB_META[tab].endpoint}/credentials`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'x-verification-token': token },
          body: JSON.stringify({ items: targets.map((target) => target.payload) }),
        });
        const json = await res.json().catch(() => null);
        const code = typeof json?.code === 'string' ? json.code : '';
        if (code.startsWith('SECURITY_SESSION')) {
          // 会话过期/环境变了：清掉本地会话并引导重新验证，而不是反复抡一个注定 403 的请求。
          clearSession();
          pendingRevealRef.current = targets;
          setSessionOpen(true);
          return;
        }
        if (!res.ok || !json?.success) throw new Error(json?.error || `HTTP ${res.status}`);
        const rows = Array.isArray(json.data) ? (json.data as RevealEntry[]) : [];
        const next: Record<string, RevealEntry> = {};
        rows.forEach((row, index) => {
          const key = targets[index]?.key;
          if (key) next[key] = { cookie: row.cookie ?? null, error: row.error };
        });
        setRevealed((current) => ({ ...current, ...next }));
      } catch (e) {
        setError(getErrorMessage(e, '解密查看失败'));
      } finally {
        setRevealing(false);
      }
    },
    [clearSession, tab],
  );

  const handleSessionEstablished = useCallback(() => {
    setSessionOpen(false);
    const pending = pendingRevealRef.current;
    pendingRevealRef.current = null;
    // 等一帧再重试：EstablishSecuritySession 是先用 setSession 再调本回调的，
    // 这里重新读单例里的 token，确保拿到的是刚签发的那枚。
    if (pending && pending.length > 0) window.setTimeout(() => void revealRows(pending), 0);
  }, [revealRows]);

  const confirmDeleteReport = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const path = [deleteTarget.clientId, deleteTarget.deviceId, deleteTarget.uid]
        .map((part) => encodeURIComponent(part))
        .join('/');
      const res = await fetch(`/api/admin/bilibili-reports/${path}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
      setDeleteTarget(null);
      await fetchData(tab, pagination.page, keyword);
    } catch (e) {
      setError(getErrorMessage(e, '删除上报记录失败'));
    } finally {
      setDeleting(false);
    }
  };

  const fetchData = useCallback(
    async (currentTab: BilibiliTab, page: number, searchTerm: string) => {
      const request = ++requestRef.current;
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
        if (request !== requestRef.current) return;
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
        if (request !== requestRef.current) return;
        setError(getErrorMessage(e, '加载失败'));
        setReports([]);
        setAccounts([]);
        setPagination(EMPTY_PAGINATION);
      } finally {
        if (request === requestRef.current) setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (isAdmin) fetchData(tab, 1, '');
    // Reset the search box when switching collections.
    setKeyword('');
    // 明文不跟着标签页留下去（上一页的解密结果不应在新集合里继续可见）。
    setRevealed({});
    pendingRevealRef.current = null;
    return () => { requestRef.current++; };
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
        description='查看 PiliPlus 上报到 Synapse 的 B 站登录凭据与账号绑定。Cookie 仅以 AES-GCM 密文存档；元数据只读展示，明文需超管 + 安全会话逐次解密，每次解密都写入审计。'
        icon={FaDatabase}
        tone='sky'
        meta={
          <>
            <InfoBadge tone='sky'>{TAB_META[tab].description.split(' · ')[0]}</InfoBadge>
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
            <div className='flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-rose-100 text-rose-700'>
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
                    ? 'border-sky-300 bg-sky-50 text-sky-700'
                    : 'border-slate-200 bg-white/80 text-slate-600 hover:border-slate-300 hover:text-slate-900'
                }`}
              >
                {key === 'reports' ? <FaCookieBite /> : <FaUserTag />}
                {TAB_META[key].label}
              </button>
            ))}
          </div>

          <p className='text-xs leading-6 text-slate-500'>{TAB_META[tab].description}</p>

          {/* 解密查看的入口与状态：未建立安全会话时不发任何明文请求，先在这里把会话建起来。 */}
          {/* 门禁与删除同一条：`canDelete`（超管）。元数据列表对普通 admin 开放，明文只给超管。 */}
          {canDelete ? (
            <InfoPanel compact>
              <div className='flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between'>
                <div className='flex items-start gap-3'>
                  <div
                    className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl ${
                      sessionActive ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700'
                    }`}
                  >
                    {sessionActive ? <FaKey /> : <FaLock />}
                  </div>
                  <div>
                    <p className='text-sm font-semibold text-slate-900'>
                      {sessionActive ? '安全会话已建立，可以解密查看' : '解密查看需要先建立安全会话'}
                    </p>
                    <p className='mt-1 text-xs leading-6 text-slate-500'>
                      {sessionActive
                        ? '解出的明文只在当前屏幕存在，并带 no-store 不落缓存；每次解密都会记一条只含计数与标识的审计。'
                        : '明文 Cookie 属于最高敏感级别：需要超管身份 + 密码/TOTP/Passkey 二次验证。未建立会话时不会向服务端发起解密请求。'}
                    </p>
                  </div>
                </div>
                <div className='flex flex-wrap gap-2'>
                  <button
                    type='button'
                    className={studioSecondaryButtonClassName}
                    onClick={() => setSessionOpen(true)}
                  >
                    <FaLock className='h-3 w-3' />
                    {sessionActive ? '换个身份验证' : '建立安全会话'}
                  </button>
                  <button
                    type='button'
                    className={studioSecondaryButtonClassName}
                    disabled={revealing || (!reports.length && !accounts.length)}
                    onClick={() => {
                      const targets =
                        tab === 'reports'
                          ? reports.map((row) => ({
                              key: reportRevealKey(row),
                              payload: { clientId: row.clientId, deviceId: row.deviceId, uid: row.uid },
                            }))
                          : accounts.map((row) => ({
                              key: accountRevealKey(row),
                              payload: { userId: row.userId, uid: row.uid },
                            }));
                      void revealRows(targets);
                    }}
                  >
                    <FaKey className='h-3 w-3' />
                    {revealing ? '解密中…' : '解密本页全部'}
                  </button>
                </div>
              </div>
            </InfoPanel>
          ) : (
            <InfoPanel compact>
              <div className='flex items-center gap-3 text-xs text-slate-500'>
                <FaLock className='h-3 w-3' aria-hidden />
                解密查看明文 Cookie 仅对超级管理员开放（当前身份只能看元数据）。
              </div>
            </InfoPanel>
          )}

          <div className='grid gap-4 md:grid-cols-4'>
            <InfoMetricCard label='记录总数' value={stats.total} detail='数据库全部记录' icon={FaDatabase} />
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
                      {canDelete ? <th className='px-3 py-3 text-right'>操作</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {reports.map((row) => {
                      const revealKey = reportRevealKey(row);
                      const entry = revealed[revealKey];
                      return (
                        <React.Fragment key={revealKey}>
                          <tr className='border-b border-slate-100 align-top'>
                            <td className='px-3 py-3 font-semibold text-slate-900'>
                              {row.uid}
                              {row.isPrimary && <InfoBadge tone='sky' className='ml-2'>主</InfoBadge>}
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
                            {canDelete ? (
                              <td className='px-3 py-3 text-right whitespace-nowrap'>
                                <button
                                  type='button'
                                  onClick={() =>
                                    void revealRows([
                                      {
                                        key: revealKey,
                                        payload: { clientId: row.clientId, deviceId: row.deviceId, uid: row.uid },
                                      },
                                    ])
                                  }
                                  disabled={revealing}
                                  title='解密这条存档的 Cookie（需要安全会话；会写入审计）'
                                  aria-label={`解密 UID ${row.uid} 在设备 ${row.deviceId} 上的 Cookie`}
                                  className='inline-flex min-h-11 items-center gap-1 rounded-2xl px-2 py-1 text-xs font-semibold text-sky-600 transition hover:bg-sky-50 disabled:opacity-50'
                                >
                                  <FaKey className='h-3 w-3' />
                                  查看凭据
                                </button>
                                <button
                                  type='button'
                                  onClick={() => setDeleteTarget(row)}
                                  title='删除这条上报记录（仅删除密文存档，操作会写入审计日志）'
                                  aria-label={`删除 UID ${row.uid} 在设备 ${row.deviceId} 上的上报记录`}
                                  className='inline-flex min-h-11 items-center gap-1 rounded-2xl px-2 py-1 text-xs font-semibold text-rose-600 transition hover:bg-rose-50'
                                >
                                  <FaTrash className='h-3 w-3' />
                                  删除
                                </button>
                              </td>
                            ) : null}
                          </tr>
                          {entry ? (
                            <tr className='border-b border-slate-100 bg-slate-50/60'>
                              <td colSpan={canDelete ? 8 : 7} className='px-3 pb-3'>
                                <RevealBox
                                  entry={entry}
                                  onHide={() =>
                                    setRevealed((current) => {
                                      const next = { ...current };
                                      delete next[revealKey];
                                      return next;
                                    })
                                  }
                                />
                              </td>
                            </tr>
                          ) : null}
                        </React.Fragment>
                      );
                    })}
                    {reports.length === 0 && !loading && (
                      <tr>
                        <td colSpan={canDelete ? 8 : 7} className='px-3 py-10 text-center text-slate-400'>
                          {keyword ? '没有匹配的记录：换个关键词，或清除搜索条件重新查询' : '暂无记录：点上方的「刷新」重新读取'}
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
                      {canDelete ? <th className='px-3 py-3 text-right'>操作</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {accounts.map((row) => {
                      const revealKey = accountRevealKey(row);
                      const entry = revealed[revealKey];
                      return (
                        <React.Fragment key={revealKey}>
                          <tr className='border-b border-slate-100 align-top'>
                            <td className='px-3 py-3 font-semibold text-slate-900'>
                              {row.uid}
                              {row.isPrimary && <InfoBadge tone='sky' className='ml-2'>主</InfoBadge>}
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
                            {canDelete ? (
                              <td className='px-3 py-3 text-right whitespace-nowrap'>
                                <button
                                  type='button'
                                  onClick={() =>
                                    void revealRows([
                                      { key: revealKey, payload: { userId: row.userId, uid: row.uid } },
                                    ])
                                  }
                                  disabled={revealing}
                                  title='解密这条绑定的 Cookie（需要安全会话；会写入审计）'
                                  aria-label={`解密用户 ${row.userId} 的 UID ${row.uid} 绑定凭据`}
                                  className='inline-flex min-h-11 items-center gap-1 rounded-2xl px-2 py-1 text-xs font-semibold text-sky-600 transition hover:bg-sky-50 disabled:opacity-50'
                                >
                                  <FaKey className='h-3 w-3' />
                                  查看凭据
                                </button>
                              </td>
                            ) : null}
                          </tr>
                          {entry ? (
                            <tr className='border-b border-slate-100 bg-slate-50/60'>
                              <td colSpan={canDelete ? 7 : 6} className='px-3 pb-3'>
                                <RevealBox
                                  entry={entry}
                                  onHide={() =>
                                    setRevealed((current) => {
                                      const next = { ...current };
                                      delete next[revealKey];
                                      return next;
                                    })
                                  }
                                />
                              </td>
                            </tr>
                          ) : null}
                        </React.Fragment>
                      );
                    })}
                    {accounts.length === 0 && !loading && (
                      <tr>
                        <td colSpan={canDelete ? 7 : 6} className='px-3 py-10 text-center text-slate-400'>
                          {keyword ? '没有匹配的记录：换个关键词，或清除搜索条件重新查询' : '暂无记录：点上方的「刷新」重新读取'}
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

      <StudioModal
        open={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        labelledBy="bilibili-delete-report-title"
        maxWidthClassName="max-w-lg"
      >
        {deleteTarget ? (
          <>
            <StudioModalHeader
              title="删除上报记录"
              titleId="bilibili-delete-report-title"
              icon={<FaTrash className="h-4 w-4" aria-hidden />}
              iconClassName="bg-rose-100 text-rose-700"
              onClose={() => setDeleteTarget(null)}
            />
            <p className="mt-4 text-sm leading-6 text-slate-600">
              将删除 UID <strong>{deleteTarget.uid}</strong> 在设备 <strong>{deleteTarget.deviceId}</strong>
              （客户端 {deleteTarget.clientId}）上的密文存档。此操作不可撤销，且会写入审计日志；
              客户端下次登录会重新上报。
            </p>
            <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                className={studioSecondaryButtonClassName}
                disabled={deleting}
              >
                取消
              </button>
              <StudioModalDangerButton onClick={() => void confirmDeleteReport()} disabled={deleting}>
                {deleting ? '删除中…' : '确认删除'}
              </StudioModalDangerButton>
            </div>
          </>
        ) : null}
      </StudioModal>

      {/* 建立安全会话（解密查看的前置条件）：放在弹窗里，不打断正在看列表的上下文。 */}
      <StudioModal
        open={sessionOpen}
        onClose={() => setSessionOpen(false)}
        labelledBy="bilibili-security-session-title"
        maxWidthClassName="max-w-2xl"
      >
        <StudioModalHeader
          title="建立安全会话"
          titleId="bilibili-security-session-title"
          icon={<FaLock className="h-4 w-4" aria-hidden />}
          iconClassName="bg-amber-100 text-amber-700"
          onClose={() => setSessionOpen(false)}
        />
        <p className="mt-4 text-sm leading-6 text-slate-600">
          解密查看会拿到 B 站登录 Cookie 的<strong>明文</strong>，因此需要先做一次二次验证。
          会话仅在当前浏览器标签页内有效（默认 10 分钟，由后台策略决定）；验证不会消耗登录态，
          也不会取代常规登录。
        </p>
        <div className="mt-4">
          <EstablishSecuritySession showActiveBar={false} onEstablished={handleSessionEstablished} />
        </div>
      </StudioModal>
    </div>
  );
};

export default BilibiliDataAdmin;
