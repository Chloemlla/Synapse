import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  FaChevronLeft,
  FaChevronRight,
  FaCopy,
  FaDownload,
  FaFilter,
  FaSearch,
  FaSync,
  FaTachometerAlt,
  FaUnlock,
  FaUserShield,
} from 'react-icons/fa';
import { turnstileApi, type IPBan, type IPBanListSummary } from '../../api/turnstile';
import { useNotification } from '../Notification';
import { useConfirm } from '../confirm/ConfirmDialogProvider';
import { useSearchParams } from 'react-router-dom';
import { getBackendErrorMessage } from '../../utils/backendError';
import { buildCsv, csvFileStamp, downloadCsv } from '../../utils/csv';
import { cn } from '../../utils/cn';
import {
  InfoBadge,
  InfoPanel,
  InfoSectionTitle,
  studioFieldClassName,
  studioSecondaryButtonClassName,
} from '../studioTheme';

type StatusFilter = 'all' | 'active' | 'expired';
type SortField = 'bannedAt' | 'expiresAt' | 'violationCount' | 'ipAddress';
type SortOrder = 'asc' | 'desc';

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;

const STATUS_FILTERS: StatusFilter[] = ['all', 'active', 'expired'];
const SORT_FIELDS: SortField[] = ['bannedAt', 'expiresAt', 'violationCount', 'ipAddress'];

/** 从 URL 还原筛选/页码，刷新或分享链接后不丢（F4-18）。 */
const readStatusFilter = (params: URLSearchParams): StatusFilter => {
  const value = params.get('status');
  return value && STATUS_FILTERS.includes(value as StatusFilter) ? (value as StatusFilter) : 'all';
};

const readSortField = (params: URLSearchParams): SortField => {
  const value = params.get('sort');
  return value && SORT_FIELDS.includes(value as SortField) ? (value as SortField) : 'bannedAt';
};

const readPageSizeParam = (params: URLSearchParams): number => {
  const value = Number(params.get('pageSize'));
  return (PAGE_SIZE_OPTIONS as readonly number[]).includes(value) ? value : 20;
};

const readPageParam = (params: URLSearchParams): number => {
  const value = Number(params.get('page'));
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1;
};

const formatDateTime = (value?: string | null): string => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', { hour12: false });
};

const formatRemaining = (expiresAt?: string | null): string => {
  if (!expiresAt) return '—';
  const target = new Date(expiresAt).getTime();
  if (!Number.isFinite(target)) return '—';
  const diff = target - Date.now();
  if (diff <= 0) return '已过期';
  const minutes = Math.floor(diff / 60000);
  if (minutes < 60) return `${minutes} 分钟后到期`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时后到期`;
  return `${Math.floor(hours / 24)} 天后到期`;
};

interface Props {
  /** 非超管只能看，按钮禁用时给出原因而不是静默置灰。 */
  canWrite: boolean;
  /** 顶层封禁/解封动作完成后自增，触发列表重新拉取。 */
  reloadToken: number;
  /** 让顶层统计卡片与列表保持同一份数据口径。 */
  onSummary?: (summary: IPBanListSummary) => void;
}

/**
 * 封禁名单。
 *
 * 为什么要有它：这一页以前只有 4 个数字，封禁是「只写不读」的——误封网段、批量粘贴里的
 * 非法行、某条是自动判的还是手工封的、什么时候到期，管理员全都看不到。
 */
const BanListPanel: React.FC<Props> = ({ canWrite, reloadToken, onSummary }) => {
  const { setNotification } = useNotification();
  const confirmDialog = useConfirm();
  // `onSummary` 由父组件传入；用 ref 承接，避免把回调身份放进 load 的依赖里
  // ——父组件每渲染一次都会给出新函数，那样 load 会变、加载 effect 会重跑，形成死循环。
  const onSummaryRef = useRef<Props['onSummary']>(undefined);
  useEffect(() => {
    onSummaryRef.current = onSummary;
  }, [onSummary]);
  const [bans, setBans] = useState<IPBan[]>([]);
  const [total, setTotal] = useState(0);
  const [searchParams, setSearchParams] = useSearchParams();
  const [page, setPage] = useState(() => readPageParam(searchParams));
  const [pageSize, setPageSize] = useState<number>(() => readPageSizeParam(searchParams));
  const [keyword, setKeyword] = useState(() => searchParams.get('q') ?? '');
  const [debouncedKeyword, setDebouncedKeyword] = useState(() => searchParams.get('q') ?? '');
  const [status, setStatus] = useState<StatusFilter>(() => readStatusFilter(searchParams));
  const [sort, setSort] = useState<SortField>(() => readSortField(searchParams));
  const [order, setOrder] = useState<SortOrder>(() => (searchParams.get('order') === 'asc' ? 'asc' : 'desc'));
  const [loading, setLoading] = useState(false);
  const [busyIp, setBusyIp] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);

  // 关键词防抖：输入每个字符都打一次接口既浪费 adminLimiter 配额，也让列表闪。
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedKeyword(keyword.trim()), 350);
    return () => clearTimeout(timer);
  }, [keyword]);

  // 筛选条件变化时回到第 1 页，否则会停在一个空页上；首次挂载保留 URL 里的页码。
  const filtersMountedRef = useRef(false);
  useEffect(() => {
    if (!filtersMountedRef.current) {
      filtersMountedRef.current = true;
      return;
    }
    setPage(1);
  }, [debouncedKeyword, status, sort, order, pageSize]);

  // 筛选/页码写入 URL（F4-18）。
  useEffect(() => {
    const params = new URLSearchParams();
    if (debouncedKeyword) params.set('q', debouncedKeyword);
    if (status !== 'all') params.set('status', status);
    if (sort !== 'bannedAt') params.set('sort', sort);
    if (order !== 'desc') params.set('order', order);
    if (pageSize !== 20) params.set('pageSize', String(pageSize));
    if (page > 1) params.set('page', String(page));
    setSearchParams(params, { replace: true });
  }, [debouncedKeyword, order, page, pageSize, setSearchParams, sort, status]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await turnstileApi.listIPBans({
        page,
        pageSize,
        keyword: debouncedKeyword,
        status,
        sort,
        order,
      });
      setBans(result.bans);
      setTotal(result.total);
      if (result.summary) onSummaryRef.current?.(result.summary);
      setSelected((prev) => prev.filter((ip) => result.bans.some((ban) => ban.ipAddress === ip)));
    } catch (error) {
      setNotification({ type: 'error', message: getBackendErrorMessage(error, '获取封禁名单失败') });
    } finally {
      setLoading(false);
    }
  }, [debouncedKeyword, order, page, pageSize, setNotification, sort, status]);

  useEffect(() => {
    void load();
  }, [load, reloadToken]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const toggleSort = (field: SortField) => {
    if (sort === field) {
      setOrder((prev) => (prev === 'desc' ? 'asc' : 'desc'));
      return;
    }
    setSort(field);
    setOrder(field === 'ipAddress' ? 'asc' : 'desc');
  };

  const copyIp = async (ip: string) => {
    try {
      await navigator.clipboard.writeText(ip);
      setNotification({ type: 'success', message: `已复制 ${ip}` });
    } catch {
      setNotification({ type: 'info', message: `当前 IP：${ip}` });
    }
  };

  const unbanOne = async (ip: string) => {
    const ok = await confirmDialog({
      title: '解封该 IP',
      description: `确认解除 ${ip} 的封禁？该地址将立即恢复访问。`,
      confirmLabel: '解封',
    });
    if (!ok) return;
    setBusyIp(ip);
    try {
      await turnstileApi.unbanIP(ip);
      setNotification({ type: 'success', message: `已解除 ${ip} 的封禁` });
      await load();
    } catch (error) {
      setNotification({ type: 'error', message: getBackendErrorMessage(error, '解封失败') });
    } finally {
      setBusyIp(null);
    }
  };

  const unbanSelected = async () => {
    if (selected.length === 0) return;
    const ok = await confirmDialog({
      title: `批量解封 ${selected.length} 个地址`,
      description: `将解除：${selected.slice(0, 5).join('、')}${selected.length > 5 ? ' 等' : ''}`,
      confirmLabel: '解封',
    });
    if (!ok) return;
    try {
      const result = await turnstileApi.unbanIPs(selected);
      setNotification({ type: 'success', message: `批量解封完成，解除 ${result.unbannedCount} 个地址` });
      setSelected([]);
      await load();
    } catch (error) {
      setNotification({ type: 'error', message: getBackendErrorMessage(error, '批量解封失败') });
    }
  };

  const exportCsv = () => {
    if (bans.length === 0) {
      setNotification({ type: 'warning', message: '当前没有可导出的记录' });
      return;
    }
    // 字段来自被封 IP 的 reason / UA，均可能含外部可控内容 —— 走共用 csvCell 做公式注入中和。
    const csv = buildCsv(
      ['ipAddress', 'source', 'status', 'violationCount', 'reason', 'bannedAt', 'expiresAt', 'fingerprint', 'userAgent'],
      bans.map((ban) => [
        ban.ipAddress,
        ban.source === 'manual' ? 'manual' : 'auto',
        ban.active === false ? 'expired' : 'active',
        ban.violationCount,
        ban.reason,
        ban.bannedAt ?? '',
        ban.expiresAt ?? '',
        ban.fingerprint ?? '',
        ban.userAgent ?? '',
      ]),
    );
    downloadCsv(`ip-bans-${csvFileStamp()}.csv`, csv);
    setNotification({ type: 'success', message: `已导出当前页 ${bans.length} 条记录` });
  };

  const allOnPageSelected = bans.length > 0 && selected.length === bans.length;
  const pageIpList = useMemo(() => bans.map((ban) => ban.ipAddress), [bans]);

  return (
    <InfoPanel>
      <InfoSectionTitle
        eyebrow="Ban List"
        title="封禁名单"
        description="查看、检索与逐条核销当前生效或已过期的 IP / CIDR 封禁记录。"
        icon={FaUserShield}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void load()} disabled={loading} className={studioSecondaryButtonClassName}>
              <FaSync className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
              刷新
            </button>
            <button type="button" onClick={exportCsv} className={studioSecondaryButtonClassName}>
              <FaDownload className="h-3.5 w-3.5" />
              导出当前页
            </button>
          </div>
        }
      />

      {!canWrite ? (
        <p className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          当前账号为普通管理员：可以查看与检索名单，但封禁 / 解封操作只对超级管理员开放。
        </p>
      ) : null}

      {/* 筛选区 */}
      <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-slate-600">关键词（IP / 原因 / 指纹）</span>
          <span className="relative block">
            <FaSearch className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
            <input
              type="search"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="例如 10.0.0.1 或 撞库"
              className={cn(studioFieldClassName, 'pl-9')}
              aria-label="按关键词筛选封禁记录"
            />
          </span>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-slate-600">状态</span>
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as StatusFilter)}
            className={studioFieldClassName}
          >
            <option value="all">全部</option>
            <option value="active">生效中</option>
            <option value="expired">已过期</option>
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-semibold text-slate-600">每页条数</span>
          <select
            value={pageSize}
            onChange={(event) => setPageSize(Number(event.target.value))}
            className={studioFieldClassName}
          >
            {PAGE_SIZE_OPTIONS.map((size) => (
              <option key={size} value={size}>
                {size} 条 / 页
              </option>
            ))}
          </select>
        </label>

        <div className="flex items-end gap-2">
          <button
            type="button"
            disabled={selected.length === 0 || !canWrite}
            onClick={unbanSelected}
            className={cn(studioSecondaryButtonClassName, 'flex-1 disabled:cursor-not-allowed disabled:opacity-50')}
            title={canWrite ? undefined : '需要超级管理员权限'}
          >
            <FaUnlock className="h-3.5 w-3.5" />
            批量解封{selected.length > 0 ? `（${selected.length}）` : ''}
          </button>
        </div>
      </div>

      {/* 列表 */}
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[52rem] border-collapse text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-left text-xs font-semibold text-slate-500">
              <th scope="col" className="w-10 py-2 pr-2">
                <input
                  type="checkbox"
                  checked={allOnPageSelected}
                  onChange={() => setSelected(allOnPageSelected ? [] : pageIpList)}
                  aria-label="全选本页"
                />
              </th>
              <th scope="col" className="py-2 pr-3">
                <button type="button" onClick={() => toggleSort('ipAddress')} className="inline-flex items-center gap-1 hover:text-slate-700">
                  地址{sort === 'ipAddress' ? (order === 'asc' ? ' ↑' : ' ↓') : ''}
                </button>
              </th>
              <th scope="col" className="py-2 pr-3">来源</th>
              <th scope="col" className="py-2 pr-3">
                <button type="button" onClick={() => toggleSort('violationCount')} className="inline-flex items-center gap-1 hover:text-slate-700">
                  违规次数{sort === 'violationCount' ? (order === 'asc' ? ' ↑' : ' ↓') : ''}
                </button>
              </th>
              <th scope="col" className="py-2 pr-3">原因</th>
              <th scope="col" className="py-2 pr-3">
                <button type="button" onClick={() => toggleSort('bannedAt')} className="inline-flex items-center gap-1 hover:text-slate-700">
                  封禁时间{sort === 'bannedAt' ? (order === 'asc' ? ' ↑' : ' ↓') : ''}
                </button>
              </th>
              <th scope="col" className="py-2 pr-3">
                <button type="button" onClick={() => toggleSort('expiresAt')} className="inline-flex items-center gap-1 hover:text-slate-700">
                  到期{sort === 'expiresAt' ? (order === 'asc' ? ' ↑' : ' ↓') : ''}
                </button>
              </th>
              <th scope="col" className="py-2 pr-2 text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            {bans.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-10 text-center text-sm text-slate-500">
                  {loading ? '正在加载封禁名单…' : debouncedKeyword || status !== 'all' ? '当前筛选条件下没有封禁记录' : '封禁名单为空'}
                </td>
              </tr>
            ) : (
              bans.map((ban) => {
                const active = ban.active !== false;
                const isSelected = selected.includes(ban.ipAddress);
                return (
                  <motion.tr
                    key={ban.ipAddress}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className={cn('border-b border-slate-100 align-top', isSelected && 'bg-slate-50/80')}
                  >
                    <td className="py-2.5 pr-2">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() =>
                          setSelected((prev) =>
                            prev.includes(ban.ipAddress)
                              ? prev.filter((value) => value !== ban.ipAddress)
                              : [...prev, ban.ipAddress],
                          )
                        }
                        aria-label={`选择 ${ban.ipAddress}`}
                      />
                    </td>
                    <td className="py-2.5 pr-3 font-mono text-xs text-slate-800">{ban.ipAddress}</td>
                    <td className="py-2.5 pr-3">
                      <InfoBadge tone={ban.source === 'manual' ? 'violet' : 'slate'}>
                        {ban.source === 'manual' ? '手工' : '自动'}
                      </InfoBadge>
                    </td>
                    <td className="py-2.5 pr-3 tabular-nums text-slate-700">{ban.violationCount}</td>
                    <td className="max-w-[16rem] py-2.5 pr-3 text-xs text-slate-600">
                      <span className="line-clamp-2" title={ban.reason}>{ban.reason || '—'}</span>
                    </td>
                    <td className="py-2.5 pr-3 text-xs text-slate-600">{formatDateTime(ban.bannedAt)}</td>
                    <td className="py-2.5 pr-3 text-xs">
                      <span className={cn('block', active ? 'text-slate-600' : 'text-slate-400')}>{formatDateTime(ban.expiresAt)}</span>
                      <span className={cn('block text-[11px]', active ? 'text-slate-400' : 'text-slate-400')}>{formatRemaining(ban.expiresAt)}</span>
                    </td>
                    <td className="py-2.5 pr-2">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => void copyIp(ban.ipAddress)}
                          title="复制地址"
                          aria-label={`复制 ${ban.ipAddress}`}
                          className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
                        >
                          <FaCopy className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          disabled={!canWrite || busyIp === ban.ipAddress}
                          onClick={() => unbanOne(ban.ipAddress)}
                          title={canWrite ? '解封' : '需要超级管理员权限'}
                          aria-label={`解封 ${ban.ipAddress}`}
                          className={cn(
                            'flex h-7 items-center gap-1 rounded-lg px-2 text-xs font-semibold transition',
                            canWrite
                              ? 'text-rose-600 hover:bg-rose-50'
                              : 'cursor-not-allowed text-slate-300',
                          )}
                        >
                          <FaUnlock className="h-3 w-3" />
                          解封
                        </button>
                      </div>
                    </td>
                  </motion.tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* 分页 */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
        <span className="inline-flex items-center gap-1.5">
          <FaFilter className="h-3 w-3" aria-hidden="true" />
          共 {total} 条匹配 · 第 {page} / {totalPages} 页
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={page <= 1 || loading}
            onClick={() => setPage((prev) => Math.max(1, prev - 1))}
            className={cn(studioSecondaryButtonClassName, 'px-2 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-40')}
          >
            <FaChevronLeft className="h-3 w-3" />
            上一页
          </button>
          <button
            type="button"
            disabled={page >= totalPages || loading}
            onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
            className={cn(studioSecondaryButtonClassName, 'px-2 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-40')}
          >
            下一页
            <FaChevronRight className="h-3 w-3" />
          </button>
        </div>
      </div>

      {loading && bans.length === 0 ? (
        <p className="mt-3 inline-flex items-center gap-2 text-xs text-slate-400">
          <FaTachometerAlt className="h-3 w-3 animate-pulse" />
          正在加载…
        </p>
      ) : null}
    </InfoPanel>
  );
};

export default BanListPanel;
