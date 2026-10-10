import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FaChevronLeft,
  FaChevronRight,
  FaCopy,
  FaDatabase,
  FaDownload,
  FaExclamationTriangle,
  FaInfoCircle,
  FaKey,
  FaLock,
  FaSearch,
  FaSync,
} from 'react-icons/fa';
import {
  adminRedisApi,
  extractAdminRedisErrorMessage,
  type RedisAdminKeyDetail,
  type RedisAdminKeysPage,
  type RedisAdminOverview,
} from '../../api/adminRedis';
import EstablishSecuritySession from '../EstablishSecuritySession';
import { UnifiedLoadingSpinner } from '../LoadingSpinner';
import { useNotification } from '../Notification';
import {
  InfoBadge,
  InfoMetricCard,
  InfoPanel,
  InfoSectionTitle,
  studioFieldClassName,
  studioPrimaryButtonClassName,
  studioSecondaryButtonClassName,
} from '../studioTheme';
import { useAuth } from '../../hooks/useAuth';
import { useSecuritySession } from '../../hooks/useSecuritySession';
import { isSuperAdmin } from '../../utils/rbac';

/**
 * 管理端 Redis 在库数据浏览器（挂在 `/admin/system`）。
 *
 * 安全模型：页面本身只对超管可见，服务端再校一次超管 + **安全会话**（10 分钟）。
 * 因此这里在会话未建立时**一个请求都不发**，只展示「建立安全会话」；会话失效立即清空已拉到的明文。
 * 数据来自 `GET/POST /api/admin/system/redis/*`（只读，SCAN 分页，绝不 KEYS）。
 */

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];

const formatBytes = (value: number | null | undefined): string => {
  if (value === null || value === undefined) return '未知';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

const formatTtl = (ttlMs: number): string => {
  if (ttlMs === -1) return '永久';
  if (ttlMs === -2) return '已不存在';
  if (ttlMs < 1000) return `${ttlMs} ms`;
  const totalSeconds = Math.round(ttlMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes} 分 ${totalSeconds % 60} 秒`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分`;
  return `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
};

const TYPE_TONE: Record<string, 'sky' | 'emerald' | 'amber' | 'rose' | 'slate'> = {
  string: 'sky',
  hash: 'emerald',
  list: 'amber',
  set: 'rose',
  zset: 'slate',
};

export default function RedisDataBrowser() {
  const { user } = useAuth();
  const { setNotification } = useNotification();
  const { verificationToken, isActive, clear } = useSecuritySession();
  const canView = isSuperAdmin(user?.role);

  const [overview, setOverview] = useState<RedisAdminOverview | null>(null);
  const [page, setPage] = useState<RedisAdminKeysPage | null>(null);
  // SCAN 游标不是可回退的位置，但把访问过的游标压栈就能让「上一页」重新扫一遍上一步。
  const [cursorStack, setCursorStack] = useState<string[]>(['0']);
  const [namespace, setNamespace] = useState('');
  const [filterInput, setFilterInput] = useState('');
  const [filter, setFilter] = useState('');
  const [pageSize, setPageSize] = useState(50);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<RedisAdminKeyDetail | null>(null);
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportMaxKeys, setExportMaxKeys] = useState(50000);

  const requestSeq = useRef(0);

  const resetToFirstPage = useCallback(() => {
    setCursorStack(['0']);
    setDetail(null);
    setDetailKey(null);
    setDetailError(null);
  }, []);

  useEffect(() => {
    resetToFirstPage();
  }, [namespace, filter, pageSize, resetToFirstPage]);

  // 会话失效/结束时立刻丢掉已拉到的明文，避免它继续留在页面上。
  useEffect(() => {
    if (isActive) return;
    ++requestSeq.current;
    setOverview(null);
    setPage(null);
    setError(null);
    setDetail(null);
    setDetailKey(null);
    setDetailError(null);
    setExportProgress(0);
  }, [isActive]);

  const cursor = cursorStack[cursorStack.length - 1] ?? '0';

  const load = useCallback(async () => {
    if (!canView || !isActive || !verificationToken) return;
    const seq = ++requestSeq.current;
    const currentCursor = cursor;
    setLoading(true);
    setError(null);
    try {
      const [overviewResult, pageResult] = await Promise.all([
        adminRedisApi.getOverview(verificationToken),
        adminRedisApi.listKeys(
          {
            cursor: currentCursor,
            namespace: namespace || undefined,
            filter: filter || undefined,
            limit: pageSize,
          },
          verificationToken,
        ),
      ]);
      if (seq !== requestSeq.current) return;
      setOverview(overviewResult);
      setPage(pageResult);
    } catch (loadError) {
      if (seq !== requestSeq.current) return;
      const message = await extractAdminRedisErrorMessage(loadError, '读取 Redis 在库数据失败');
      setError(message);
      if ((loadError as { response?: { status?: number } })?.response?.status === 403) {
        setNotification({ message: '安全会话已失效，请重新建立', type: 'warning' });
        clear();
      }
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [canView, clear, cursor, filter, isActive, namespace, pageSize, setNotification, verificationToken]);

  useEffect(() => {
    void load();
  }, [load]);

  const openDetail = async (key: string) => {
    if (!verificationToken) return;
    setDetailKey(key);
    setDetail(null);
    setDetailError(null);
    try {
      setDetail(await adminRedisApi.getKey(key, verificationToken));
    } catch (detailFailure) {
      const message = await extractAdminRedisErrorMessage(detailFailure, '读取键内容失败');
      setDetailError(message);
      if ((detailFailure as { response?: { status?: number } })?.response?.status === 403) clear();
    }
  };

  const copy = (value: string) => {
    navigator.clipboard?.writeText(value).then(
      () => setNotification({ message: '已复制到剪贴板', type: 'success' }),
      () => setNotification({ message: '复制失败', type: 'error' }),
    );
  };

  const handleExport = async () => {
    if (!verificationToken) return;
    setExporting(true);
    setExportProgress(0);
    try {
      const { blob, filename } = await adminRedisApi.exportSnapshot(
        {
          namespace: namespace || undefined,
          filter: filter || undefined,
          maxKeys: exportMaxKeys,
        },
        verificationToken,
        setExportProgress,
      );
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename || `synapse-redis-snapshot-${Date.now()}.ndjson`;
      anchor.click();
      // 立即 revoke 会让部分浏览器（Firefox）拿不到数据，留一拍再释放。
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setNotification({ message: `快照已导出（${formatBytes(blob.size)}）`, type: 'success' });
    } catch (exportError) {
      const message = await extractAdminRedisErrorMessage(exportError, '导出快照失败');
      if ((exportError as { response?: { status?: number } })?.response?.status === 403) clear();
      setNotification({ message, type: 'error' });
    } finally {
      setExporting(false);
    }
  };

  if (!canView) return null;

  const scope = overview?.scope ?? page?.scope ?? null;

  return (
    <InfoPanel>
      <InfoSectionTitle
        eyebrow="Redis In-Store Data"
        title="Redis 在库数据"
        description="只读浏览当前服务在 Redis 里的键与明文内容，并可导出全库快照。需要超级管理员身份 + 安全会话；列表用 SCAN 分页，不使用会阻塞实例的 KEYS。"
        icon={FaDatabase}
        action={<span className="text-xs text-slate-500">超管 · 安全会话 · 只读 · 操作审计</span>}
      />

      {!isActive ? (
        <div className="space-y-3">
          <div className="flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50/70 p-3 text-sm text-amber-800">
            <FaLock className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>Redis 在库数据属敏感明文，需先建立安全会话（10 分钟）后才会加载，未建立会话时不会向服务端发起任何请求。</span>
          </div>
          <EstablishSecuritySession showActiveBar={false} />
        </div>
      ) : (
        <div className="space-y-4">
          {/* 连接与体量 */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
            <InfoMetricCard
              label="连接状态"
              value={overview?.status.available ? '可用' : overview?.status.configured ? '已配置未就绪' : '未配置'}
              detail={overview?.status.ready ? 'ready' : overview?.status.enabled ? '已连接未就绪' : 'Redis 未启用'}
              icon={FaDatabase}
            />
            <InfoMetricCard label="键总数" value={overview?.dbsize ?? '未知'} detail="当前 DB 的 DBSIZE" icon={FaKey} />
            <InfoMetricCard
              label="内存占用"
              value={formatBytes(overview?.usedMemoryBytes)}
              detail="used_memory"
              icon={FaDatabase}
            />
            <InfoMetricCard
              label="浏览范围"
              value={scope?.restricted ? `${scope.prefixes.length} 个命名空间` : '整个当前 DB'}
              detail={scope?.restricted ? 'ADMIN_REDIS_KEY_PREFIXES 已收紧' : '未配置前缀白名单'}
              icon={FaSearch}
            />
          </div>

          {scope?.restricted ? (
            <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <span className="font-medium text-slate-600">允许的命名空间：</span>
              {scope.prefixes.map((prefix) => (
                <code key={prefix} className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-700">
                  {prefix}
                </code>
              ))}
            </div>
          ) : (
            <div className="flex items-start gap-2 rounded-2xl border border-sky-200 bg-sky-50/70 p-3 text-xs text-sky-800">
              <FaInfoCircle className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
              <span>
                当前会列出整个 Redis DB 的键。如果该实例与其它服务共享，请配置 <code>ADMIN_REDIS_KEY_PREFIXES</code>{' '}
                把范围收窄到本服务的命名空间。
              </span>
            </div>
          )}

          {/* 工具栏 */}
          <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white/70 p-3 lg:flex-row lg:items-end">
            {scope?.restricted ? (
              <label className="flex flex-col gap-1 text-xs text-slate-600">
                命名空间
                <select
                  value={namespace || scope.prefixes[0] || ''}
                  onChange={(event) => {
                    setNamespace(event.target.value);
                    resetToFirstPage();
                  }}
                  className={studioFieldClassName}
                >
                  {scope.prefixes.map((prefix) => (
                    <option key={prefix} value={prefix}>
                      {prefix}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <label className="flex flex-1 flex-col gap-1 text-xs text-slate-600">
              键名包含
              <input
                value={filterInput}
                onChange={(event) => setFilterInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    setFilter(filterInput.trim());
                    resetToFirstPage();
                  }
                }}
                placeholder="例如 ipban: 或 user:u1"
                className={studioFieldClassName}
              />
            </label>

            <label className="flex flex-col gap-1 text-xs text-slate-600">
              每页
              <select
                value={pageSize}
                onChange={(event) => {
                  setPageSize(Number(event.target.value));
                  resetToFirstPage();
                }}
                className={studioFieldClassName}
              >
                {PAGE_SIZE_OPTIONS.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </label>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={studioPrimaryButtonClassName}
                onClick={() => {
                  setFilter(filterInput.trim());
                  resetToFirstPage();
                }}
              >
                <FaSearch className="h-4 w-4" />
                查询
              </button>
              <button type="button" className={studioSecondaryButtonClassName} disabled={loading} onClick={() => void load()}>
                <FaSync className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                刷新
              </button>
            </div>
          </div>

          {error ? (
            <div className="flex flex-col gap-3 rounded-2xl border border-rose-200 bg-rose-50 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-2 text-sm text-rose-700">
                <FaExclamationTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <span>{error}</span>
              </div>
              <button type="button" onClick={() => void load()} className={studioSecondaryButtonClassName}>
                <FaSync className="h-4 w-4" />
                重试
              </button>
            </div>
          ) : null}

          {/* 键列表 */}
          <div className="overflow-hidden rounded-2xl border border-slate-200">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
              <span>
                本页 {page?.keys.length ?? 0} 个 · 已扫描 {page?.scanned ?? 0} 个
                {page && page.outOfScope > 0 ? ` · 范围外跳过 ${page.outOfScope} 个` : ''}
                {page?.hasFilter ? ` · 过滤 ${page.match}` : ''}
              </span>
              <span className="flex items-center gap-2">
                {loading ? <UnifiedLoadingSpinner size="sm" /> : null}
                <button
                  type="button"
                  className={studioSecondaryButtonClassName}
                  disabled={cursorStack.length <= 1 || loading}
                  onClick={() => setCursorStack((stack) => (stack.length > 1 ? stack.slice(0, -1) : stack))}
                >
                  <FaChevronLeft className="h-3 w-3" />
                  上一页
                </button>
                <button
                  type="button"
                  className={studioSecondaryButtonClassName}
                  disabled={!page || page.done || loading}
                  onClick={() => {
                    if (page && !page.done) setCursorStack((stack) => [...stack, page.cursor]);
                  }}
                >
                  下一页
                  <FaChevronRight className="h-3 w-3" />
                </button>
              </span>
            </div>

            {page && page.keys.length > 0 ? (
              <div className="max-h-[22rem] overflow-auto">
                <table className="w-full border-collapse text-sm">
                  <thead className="sticky top-0 bg-white/95 text-xs text-slate-500">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">键</th>
                      <th className="px-3 py-2 text-left font-medium">类型</th>
                      <th className="px-3 py-2 text-left font-medium">TTL</th>
                      <th className="px-3 py-2 text-right font-medium">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.keys.map((entry) => (
                      <tr
                        key={entry.key}
                        className={`border-t border-slate-100 ${detailKey === entry.key ? 'bg-sky-50/60' : ''}`}
                      >
                        <td className="max-w-[22rem] break-all px-3 py-2 font-mono text-xs text-slate-700">{entry.key}</td>
                        <td className="px-3 py-2">
                          <InfoBadge tone={TYPE_TONE[entry.type] ?? 'slate'}>{entry.type}</InfoBadge>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-xs text-slate-500">{formatTtl(entry.ttlMs)}</td>
                        <td className="px-3 py-2 text-right">
                          <button
                            type="button"
                            className="text-xs text-sky-600 underline"
                            onClick={() => void openDetail(entry.key)}
                          >
                            查看
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="px-3 py-6 text-center text-sm text-slate-500">
                {loading ? '正在读取…' : '没有匹配的键（换了命名空间或过滤条件再试，也可能确实为空）。'}
              </div>
            )}
          </div>

          {/* 单键明文 */}
          {detailKey ? (
            <div className="space-y-3 rounded-2xl border border-amber-200 bg-amber-50/50 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-slate-700">明文内容</span>
                    <InfoBadge tone="amber">敏感</InfoBadge>
                    {detail ? <InfoBadge tone={TYPE_TONE[detail.content.type] ?? 'slate'}>{detail.content.type}</InfoBadge> : null}
                  </div>
                  <code className="mt-1 block break-all text-xs text-slate-600">{detailKey}</code>
                </div>
                <div className="flex flex-wrap gap-2">
                  {detail?.content.value ? (
                    <button
                      type="button"
                      className={studioSecondaryButtonClassName}
                      onClick={() => copy(detail.content.value as string)}
                    >
                      <FaCopy className="h-3 w-3" />
                      复制值
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={studioSecondaryButtonClassName}
                    onClick={() => {
                      setDetail(null);
                      setDetailKey(null);
                      setDetailError(null);
                    }}
                  >
                    收起
                  </button>
                </div>
              </div>

              {detailError ? (
                <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700">
                  <FaExclamationTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                  <span>{detailError}</span>
                </div>
              ) : !detail ? (
                <div className="flex items-center gap-2 text-sm text-slate-500">
                  <UnifiedLoadingSpinner size="sm" />
                  正在读取…
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                    <span>TTL：{formatTtl(detail.content.ttlMs)}</span>
                    <span>编码：{detail.content.encoding ?? '未知'}</span>
                    <span>内存：{formatBytes(detail.content.sizeBytes)}</span>
                    {detail.content.stringLength !== null ? <span>字符数：{detail.content.stringLength}</span> : null}
                    {detail.content.totalEntries !== null ? <span>条目数：{detail.content.totalEntries}</span> : null}
                  </div>

                  {detail.content.truncated ? (
                    <div className="rounded-lg border border-amber-300 bg-amber-100/70 px-3 py-2 text-xs text-amber-800">
                      内容过长，已按服务端上限截断显示；完整内容请用「导出快照」。
                    </div>
                  ) : null}

                  {detail.content.value !== null ? (
                    <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-800">
                      {detail.content.value || '（空字符串）'}
                    </pre>
                  ) : null}

                  {detail.content.entries !== null ? (
                    <div className="max-h-80 overflow-auto rounded-xl border border-slate-200 bg-white">
                      <table className="w-full border-collapse text-xs">
                        <thead className="sticky top-0 bg-slate-50 text-slate-500">
                          <tr>
                            <th className="px-3 py-2 text-left font-medium">
                              {detail.content.type === 'hash' ? '字段' : detail.content.type === 'zset' ? '成员' : '位置'}
                            </th>
                            <th className="px-3 py-2 text-left font-medium">值</th>
                            {detail.content.type === 'zset' ? <th className="px-3 py-2 text-left font-medium">分数</th> : null}
                          </tr>
                        </thead>
                        <tbody>
                          {detail.content.entries.map((entry, index) => (
                            <tr key={`${entry.field ?? index}`} className="border-t border-slate-100">
                              <td className="max-w-[14rem] break-all px-3 py-1.5 font-mono text-slate-500">
                                {entry.field ?? `[${index}]`}
                              </td>
                              <td className="max-w-[26rem] break-all px-3 py-1.5 font-mono text-slate-800">{entry.value}</td>
                              {detail.content.type === 'zset' ? (
                                <td className="px-3 py-1.5 font-mono text-slate-500">{entry.score ?? ''}</td>
                              ) : null}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}

                  {detail.content.value === null && detail.content.entries === null ? (
                    <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-500">
                      该类型（{detail.content.type}）暂不支持内容预览，仅展示元信息。
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          ) : null}

          {/* 快照导出 */}
          <div className="space-y-3 rounded-2xl border border-slate-200 bg-white/70 p-3">
            <div>
              <div className="flex items-center gap-2">
                <FaDownload className="h-4 w-4 text-slate-500" />
                <span className="text-sm font-semibold text-slate-700">导出全库快照</span>
              </div>
              <p className="mt-1 text-xs text-slate-500">
                逐键 <code>DUMP</code> + <code>PTTL</code> 流式导出为 NDJSON，字节精确、可用 <code>RESTORE</code>{' '}
                恢复；导出范围跟随上面的命名空间/过滤条件。
              </p>
              <p className="mt-1 text-xs text-slate-400">
                需要物理 RDB（<code>--rdb</code>）时只能在 Redis 宿主机执行{' '}
                <code>deploy/openresty/backup-redis.sh</code> —— 应用进程看不到 Redis 数据目录。
              </p>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1 text-xs text-slate-600">
                最多导出键数
                <input
                  type="number"
                  min={1}
                  max={500000}
                  value={exportMaxKeys}
                  onChange={(event) => setExportMaxKeys(Number(event.target.value) || 1)}
                  className={`${studioFieldClassName} w-36`}
                />
              </label>
              <button
                type="button"
                className={studioSecondaryButtonClassName}
                disabled={exporting}
                onClick={() => void handleExport()}
              >
                {exporting ? <UnifiedLoadingSpinner size="sm" /> : <FaDownload className="h-4 w-4" />}
                {exporting ? `导出中…（${formatBytes(exportProgress)}）` : '导出快照'}
              </button>
            </div>
          </div>
        </div>
      )}
    </InfoPanel>
  );
}
