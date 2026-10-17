import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FaChevronLeft,
  FaChevronRight,
  FaCopy,
  FaDatabase,
  FaDownload,
  FaInfoCircle,
  FaLayerGroup,
  FaLock,
  FaSearch,
  FaSync,
} from 'react-icons/fa';
import {
  adminMongoApi,
  extractAdminMongoErrorMessage,
  type MongoAdminCollectionDetail,
  type MongoAdminCollectionSummary,
  type MongoAdminDocumentPage,
  type MongoAdminOverview,
} from '../../api/adminMongo';
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
import {
  StudioEmptyState,
  StudioErrorState,
  StudioLoadingState,
} from '../studioFeedback';
import { useAuth } from '../../hooks/useAuth';
import { useSecuritySession } from '../../hooks/useSecuritySession';
import { isSuperAdmin } from '../../utils/rbac';

/**
 * 管理端 MongoDB 在库数据浏览器（挂在 `/admin/system`，与 Redis 浏览器并列）。
 *
 * 安全模型与 Redis 浏览器一致：页面只对超管可见，服务端再校一次超管 + 安全会话；
 * 会话未建立时不发任何请求，会话失效立即清空已拉到的数据。
 *
 * 与 Redis 的差别在**内容**：Mongo 文档以用户 PII 为主，因此这里默认**原样显示**
 * （安全会话已经强制建立，等于管理员当场验过一次身份），同时提供一个「脱敏显示」开关：
 * 打开后服务端把密码材料 / 令牌 / 密钥 / 密文 / 内部存储键替换为 `[redacted]`，
 * 供截图、录屏或共享屏幕时使用。不脱敏时页面会明确标注「原始数据」。
 */

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];
const SORT_FIELD_SUGGESTIONS = ['_id', 'createdAt', 'updatedAt', 'lastActivityAt'];

const formatBytes = (value: number | null | undefined): string => {
  if (value === null || value === undefined) return '未知';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

const formatCount = (value: number | null | undefined): string => (
  typeof value === 'number' ? value.toLocaleString('zh-CN') : '未知'
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 列表行的摘要：`_id` + 前几个标量字段（长值截断），避免整份 JSON 挤进表格。 */
function summarizeDocument(document: unknown): Array<{ key: string; value: string }> {
  if (!isRecord(document)) return [{ key: 'value', value: String(document).slice(0, 120) }];
  const rows: Array<{ key: string; value: string }> = [];
  const push = (key: string, raw: unknown) => {
    if (rows.length >= 5) return;
    if (raw === null || raw === undefined) return;
    if (typeof raw !== 'string' && typeof raw !== 'number' && typeof raw !== 'boolean') return;
    const text = String(raw).replace(/\s+/g, ' ');
    rows.push({ key, value: text.length > 60 ? `${text.slice(0, 60)}…` : text });
  };
  push('_id', document._id);
  for (const key of ['username', 'email', 'name', 'title', 'status', 'type', 'action', 'kind']) {
    push(key, document[key]);
  }
  for (const [key, value] of Object.entries(document)) {
    if (rows.length >= 5) break;
    if (rows.some((row) => row.key === key)) continue;
    push(key, value);
  }
  return rows;
}

export default function MongoDataBrowser() {
  const { user } = useAuth();
  const { setNotification } = useNotification();
  const { verificationToken, isActive, clear } = useSecuritySession();
  const canView = isSuperAdmin(user?.role);

  const [overview, setOverview] = useState<MongoAdminOverview | null>(null);
  const [collections, setCollections] = useState<MongoAdminCollectionSummary[]>([]);
  const [collectionSearch, setCollectionSearch] = useState('');
  const [selected, setSelected] = useState<string>('');
  const [detail, setDetail] = useState<MongoAdminCollectionDetail | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const [page, setPage] = useState<MongoAdminDocumentPage | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [filterInput, setFilterInput] = useState('');
  const [appliedFilter, setAppliedFilter] = useState('');
  const [sortField, setSortField] = useState('_id');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  // 默认不脱敏（安全会话下查看原始数据）；打开后请求带 redact=1，由服务端替换凭据字段。
  const [redact, setRedact] = useState(false);

  const [loadingOverview, setLoadingOverview] = useState(false);
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [docError, setDocError] = useState<string | null>(null);
  const [openDocumentIndex, setOpenDocumentIndex] = useState<number | null>(null);

  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportMaxDocs, setExportMaxDocs] = useState(5000);

  const requestSeq = useRef(0);
  const docsSeq = useRef(0);

  // 会话失效/结束时立刻丢掉已拉到的数据（即便服务端已脱敏，也不该继续留在页面上）。
  useEffect(() => {
    if (isActive) return;
    ++requestSeq.current;
    ++docsSeq.current;
    setOverview(null);
    setCollections([]);
    setSelected('');
    setDetail(null);
    setPage(null);
    setError(null);
    setDocError(null);
    setOpenDocumentIndex(null);
    setExportProgress(0);
  }, [isActive]);

  const loadOverview = useCallback(async () => {
    if (!canView || !isActive || !verificationToken) return;
    const seq = ++requestSeq.current;
    setLoadingOverview(true);
    setError(null);
    try {
      const [overviewResult, collectionsResult] = await Promise.all([
        adminMongoApi.getOverview(verificationToken),
        adminMongoApi.listCollections(verificationToken),
      ]);
      if (seq !== requestSeq.current) return;
      setOverview(overviewResult);
      setCollections(collectionsResult);
      // 首次加载默认选中第一个集合，避免右侧空白。
      setSelected((current) => current || collectionsResult[0]?.name || '');
    } catch (loadError) {
      if (seq !== requestSeq.current) return;
      setError(await extractAdminMongoErrorMessage(loadError, '读取 MongoDB 在库数据失败'));
      if ((loadError as { response?: { status?: number } })?.response?.status === 403) {
        setNotification({ message: '安全会话已失效，请重新建立', type: 'warning' });
        clear();
      }
    } finally {
      if (seq === requestSeq.current) setLoadingOverview(false);
    }
  }, [canView, clear, isActive, setNotification, verificationToken]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  const loadDocuments = useCallback(async () => {
    if (!canView || !isActive || !verificationToken || !selected) return;
    const seq = ++docsSeq.current;
    setLoadingDocs(true);
    setDocError(null);
    try {
      const result = await adminMongoApi.listDocuments(
        selected,
        {
          page: pageNumber,
          pageSize,
          filter: appliedFilter || undefined,
          sortField,
          sortOrder,
          redact,
        },
        verificationToken,
      );
      if (seq !== docsSeq.current) return;
      setPage(result);
      setOpenDocumentIndex(null);
    } catch (loadError) {
      if (seq !== docsSeq.current) return;
      setPage(null);
      setDocError(await extractAdminMongoErrorMessage(loadError, '读取集合文档失败'));
      if ((loadError as { response?: { status?: number } })?.response?.status === 403) {
        setNotification({ message: '安全会话已失效，请重新建立', type: 'warning' });
        clear();
      }
    } finally {
      if (seq === docsSeq.current) setLoadingDocs(false);
    }
  }, [appliedFilter, canView, clear, isActive, pageNumber, pageSize, redact, selected, setNotification, sortField, sortOrder, verificationToken]);

  useEffect(() => {
    void loadDocuments();
  }, [loadDocuments]);

  // 切换集合：一次性重置分页/过滤/排序，再懒加载集合结构（索引/选项）。
  // 重置放在事件里而不是 effect 里，避免「先用旧过滤条件请求新集合，再重置后请求一次」。
  const selectCollection = useCallback((name: string) => {
    if (!name || name === selected) return;
    setSelected(name);
    setPageNumber(1);
    setFilterInput('');
    setAppliedFilter('');
    setSortField('_id');
    setSortOrder('desc');
    setOpenDocumentIndex(null);
    setPage(null);
  }, [selected]);

  useEffect(() => {
    if (!selected || !isActive || !verificationToken) {
      setDetail(null);
      return;
    }
    setDetail(null);
    let cancelled = false;
    void adminMongoApi
      .getCollectionDetail(selected, verificationToken)
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      });
    return () => {
      cancelled = true;
    };
  }, [isActive, selected, verificationToken]);

  const filteredCollections = useMemo(() => {
    const keyword = collectionSearch.trim().toLowerCase();
    if (!keyword) return collections;
    return collections.filter((item) => item.name.toLowerCase().includes(keyword));
  }, [collectionSearch, collections]);

  const copy = (value: string) => {
    navigator.clipboard?.writeText(value).then(
      () => setNotification({ message: '已复制到剪贴板', type: 'success' }),
      () => setNotification({ message: '复制失败', type: 'error' }),
    );
  };

  const applyFilter = () => {
    setPageNumber(1);
    setAppliedFilter(filterInput.trim());
  };

  const resetFilter = () => {
    setFilterInput('');
    setAppliedFilter('');
    setSortField('_id');
    setSortOrder('desc');
    setPageNumber(1);
  };

  const handleExport = async () => {
    if (!verificationToken || !selected) return;
    setExporting(true);
    setExportProgress(0);
    try {
      const { blob, filename } = await adminMongoApi.exportCollection(
        {
          collection: selected,
          filter: appliedFilter || undefined,
          sortField,
          sortOrder,
          maxDocs: exportMaxDocs,
          redact,
        },
        verificationToken,
        setExportProgress,
      );
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename || `synapse-mongo-${selected}-${Date.now()}.ndjson`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setNotification({ message: `集合已导出（${formatBytes(blob.size)}）`, type: 'success' });
    } catch (exportError) {
      const message = await extractAdminMongoErrorMessage(exportError, '导出集合失败');
      if ((exportError as { response?: { status?: number } })?.response?.status === 403) clear();
      setNotification({ message, type: 'error' });
    } finally {
      setExporting(false);
    }
  };

  if (!canView) return null;

  const totalForPage = page?.total ?? page?.estimatedTotal ?? null;
  const pageCount = totalForPage !== null
    ? Math.max(1, Math.ceil(totalForPage / Math.max(1, page?.pageSize ?? pageSize)))
    : null;
  const canNext = page ? page.hasMore : false;

  return (
    <InfoPanel>
      <InfoSectionTitle
        eyebrow="MongoDB In-Store Data"
        title="MongoDB 在库数据"
        description="只读浏览当前数据库中的集合与文档，支持受限 JSON 过滤、分页与 NDJSON 导出。需要超级管理员身份 + 安全会话；默认原样显示，可切换为脱敏显示。"
        icon={FaDatabase}
        action={<span className="text-xs text-slate-500">超管 · 安全会话 · 只读 · 可脱敏 · 操作审计</span>}
      />

      {!isActive ? (
        <div className="space-y-3">
          <div className="flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50/70 p-3 text-sm text-amber-800">
            <FaLock className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden />
            <span>
              MongoDB 在库数据包含账号与业务记录，需先建立安全会话（默认 10 分钟）后才会加载；
              未建立会话时不会向服务端发起任何请求。
            </span>
          </div>
          <EstablishSecuritySession showActiveBar={false} />
        </div>
      ) : (
        <div className="space-y-4">
          {/* 连接与体量 */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
            <InfoMetricCard
              label="连接状态"
              value={overview?.connected ? '已连接' : '未连接'}
              detail={overview?.serverVersion ? `MongoDB ${overview.serverVersion}` : '连接信息不可用'}
              icon={FaDatabase}
            />
            <InfoMetricCard
              label="数据库"
              value={overview?.database ?? '未知'}
              detail="当前连接使用的库名"
              icon={FaDatabase}
            />
            <InfoMetricCard
              label="集合 / 估算文档"
              value={formatCount(overview?.collections)}
              detail={`约 ${formatCount(overview?.estimatedDocuments)} 条文档`}
              icon={FaLayerGroup}
            />
            <InfoMetricCard
              label="数据 / 索引体积"
              value={formatBytes(overview?.dataSizeBytes)}
              detail={`索引 ${formatBytes(overview?.indexSizeBytes)}`}
              icon={FaInfoCircle}
            />
          </div>

          {error ? <StudioErrorState message={error} onRetry={() => void loadOverview()} /> : null}

          <div className="grid grid-cols-1 gap-3 xl:grid-cols-[18rem_minmax(0,1fr)]">
            {/* 集合列表 */}
            <section aria-label="集合列表" className="min-w-0 rounded-2xl border border-slate-200 bg-white/70">
              <div className="border-b border-slate-200 p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-slate-700">集合</span>
                  <span className="text-[11px] text-slate-500">{filteredCollections.length} / {collections.length}</span>
                </div>
                <label className="relative block">
                  <FaSearch className="pointer-events-none absolute left-3 top-1/2 h-3 w-3 -translate-y-1/2 text-slate-400" aria-hidden />
                  <input
                    value={collectionSearch}
                    onChange={(event) => setCollectionSearch(event.target.value)}
                    placeholder="按集合名过滤"
                    aria-label="按集合名过滤"
                    className={`${studioFieldClassName} py-2 pl-8 text-xs`}
                  />
                </label>
              </div>
              <div className="max-h-[24rem] overflow-auto">
                {loadingOverview && collections.length === 0 ? (
                  <StudioLoadingState minHeightClassName="min-h-[160px]" text="正在读取集合…" />
                ) : filteredCollections.length === 0 ? (
                  <StudioEmptyState
                    className="rounded-none border-0 bg-transparent px-3 py-6"
                    message="没有匹配的集合。"
                  />
                ) : (
                  <ul className="divide-y divide-slate-100">
                    {filteredCollections.map((item) => {
                      const active = item.name === selected;
                      return (
                        <li key={item.name}>
                          <button
                            type="button"
                            onClick={() => selectCollection(item.name)}
                            aria-pressed={active}
                            className={`flex w-full min-w-0 items-center justify-between gap-2 px-3 py-2 text-left transition ${
                              active ? 'bg-sky-50/70' : 'hover:bg-slate-50'
                            }`}
                          >
                            <span className="min-w-0">
                              <span className="block truncate font-mono text-xs text-slate-800" title={item.name}>
                                {item.name}
                              </span>
                              <span className="mt-0.5 flex flex-wrap items-center gap-1">
                                <span className="text-[10px] text-slate-400">{formatCount(item.estimatedCount)} 条</span>
                                {item.capped ? <InfoBadge tone="amber">capped</InfoBadge> : null}
                                {item.hasValidator ? <InfoBadge tone="slate">校验</InfoBadge> : null}
                              </span>
                            </span>
                            <FaChevronRight className="h-3 w-3 shrink-0 text-slate-300" aria-hidden />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </section>

            {/* 文档浏览 */}
            <section aria-label="集合文档" className="min-w-0 space-y-3">
              <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white/70 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-mono text-sm font-semibold text-slate-800">
                        {selected || '未选择集合'}
                      </span>
                      {detail ? <InfoBadge tone="slate">{detail.indexes.length} 个索引</InfoBadge> : null}
                      {detail?.capped ? <InfoBadge tone="amber">capped</InfoBadge> : null}
                      <InfoBadge tone={redact ? 'emerald' : 'rose'}>{redact ? '已脱敏' : '原始数据'}</InfoBadge>
                    </div>
                    <p className="mt-0.5 text-[11px] text-slate-500">
                      {redact
                        ? '脱敏显示：密码材料 / 令牌 / 密钥 / 密文 / 内部存储键显示为 [redacted]，二进制只报大小。'
                        : '原始数据：包含账号凭据材料与个人信息，仅用于当场排查；截图或共享前请打开「脱敏显示」。'}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {detail ? (
                      <button
                        type="button"
                        className={studioSecondaryButtonClassName}
                        onClick={() => setDetailOpen((current) => !current)}
                        aria-expanded={detailOpen}
                      >
                        <FaLayerGroup className="h-3 w-3" aria-hidden />
                        {detailOpen ? '收起索引' : '查看索引'}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      role="switch"
                      aria-checked={redact}
                      onClick={() => setRedact((current) => !current)}
                      title="打开后由服务端把密码材料 / 令牌 / 密钥 / 密文替换为 [redacted]"
                      className={
                        redact
                          ? `${studioPrimaryButtonClassName} gap-1`
                          : `${studioSecondaryButtonClassName} gap-1`
                      }
                    >
                      <FaLock className="h-3 w-3" aria-hidden />
                      {redact ? '脱敏显示：开' : '脱敏显示：关'}
                    </button>
                    <button
                      type="button"
                      className={studioSecondaryButtonClassName}
                      disabled={!selected || loadingDocs}
                      onClick={() => void loadDocuments()}
                    >
                      <FaSync className={`h-3 w-3 ${loadingDocs ? 'animate-spin' : ''}`} aria-hidden />
                      刷新
                    </button>
                  </div>
                </div>

                {detailOpen && detail ? (
                  <div className="rounded-2xl border border-slate-200 bg-slate-50/70 p-3">
                    <table className="w-full border-collapse text-[11px]">
                      <thead className="text-slate-500">
                        <tr>
                          <th className="py-1 pr-2 text-left font-medium">索引</th>
                          <th className="py-1 pr-2 text-left font-medium">字段</th>
                          <th className="py-1 pr-2 text-left font-medium">属性</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.indexes.map((index, position) => (
                          <tr key={String(index.name ?? position)} className="border-t border-slate-200/70">
                            <td className="break-all py-1 pr-2 font-mono text-slate-700">{String(index.name ?? '-')}</td>
                            <td className="break-all py-1 pr-2 font-mono text-slate-600">
                              {index.key ? JSON.stringify(index.key) : '-'}
                            </td>
                            <td className="py-1 pr-2 text-slate-500">
                              {[
                                index.unique ? 'unique' : null,
                                index.sparse ? 'sparse' : null,
                                typeof index.expireAfterSeconds === 'number' ? `TTL ${index.expireAfterSeconds}s` : null,
                              ].filter(Boolean).join(' · ') || '-'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}

                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_9rem_6rem_auto]">
                  <label className="flex min-w-0 flex-col gap-1 text-xs text-slate-600">
                    受限 JSON 过滤（留空 = 全部）
                    <input
                      value={filterInput}
                      onChange={(event) => setFilterInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') applyFilter();
                      }}
                      placeholder='{"userId":"u1"} 或 {"status":"active"}'
                      aria-label="集合查询过滤条件"
                      className={`${studioFieldClassName} py-2 font-mono text-xs`}
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-slate-600">
                    排序字段
                    <input
                      value={sortField}
                      onChange={(event) => setSortField(event.target.value.trim() || '_id')}
                      list="mongo-sort-fields"
                      aria-label="排序字段"
                      className={`${studioFieldClassName} py-2 font-mono text-xs`}
                    />
                    <datalist id="mongo-sort-fields">
                      {SORT_FIELD_SUGGESTIONS.map((field) => (
                        <option key={field} value={field} />
                      ))}
                    </datalist>
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-slate-600">
                    方向
                    <select
                      value={sortOrder}
                      onChange={(event) => {
                        setSortOrder(event.target.value === 'asc' ? 'asc' : 'desc');
                        setPageNumber(1);
                      }}
                      className={studioFieldClassName}
                    >
                      <option value="desc">降序</option>
                      <option value="asc">升序</option>
                    </select>
                  </label>
                  <div className="flex items-end gap-2">
                    <button type="button" className={studioPrimaryButtonClassName} onClick={applyFilter}>
                      <FaSearch className="h-3 w-3" aria-hidden />
                      查询
                    </button>
                    <button type="button" className={studioSecondaryButtonClassName} onClick={resetFilter}>
                      重置
                    </button>
                  </div>
                </div>
              </div>

              {docError ? <StudioErrorState message={docError} onRetry={() => void loadDocuments()} /> : null}

              <div className="overflow-hidden rounded-2xl border border-slate-200">
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
                  <span>
                    第 {page?.page ?? pageNumber} 页 · 本页 {page?.documents.length ?? 0} 条
                    {page && page.total !== null ? ` · 匹配 ${formatCount(page.total)} 条` : page && page.estimatedTotal !== null ? ` · 约 ${formatCount(page.estimatedTotal)} 条` : ''}
                    {appliedFilter ? ' · 已应用过滤' : ''}
                    {page ? ` · ${page.sort.field} ${page.sort.order === 'asc' ? '升序' : '降序'}` : ''}
                    {page ? ` · ${page.redacted ? '已脱敏' : '原始数据'}` : ''}
                  </span>
                  <span className="flex items-center gap-2">
                    <select
                      value={pageSize}
                      onChange={(event) => {
                        setPageSize(Number(event.target.value));
                        setPageNumber(1);
                      }}
                      aria-label="每页条数"
                      className={`${studioFieldClassName} w-auto py-1 text-xs`}
                    >
                      {PAGE_SIZE_OPTIONS.map((size) => (
                        <option key={size} value={size}>每页 {size} 条</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className={studioSecondaryButtonClassName}
                      disabled={pageNumber <= 1 || loadingDocs}
                      onClick={() => setPageNumber((current) => Math.max(1, current - 1))}
                    >
                      <FaChevronLeft className="h-3 w-3" aria-hidden />
                      上一页
                    </button>
                    <span className="whitespace-nowrap">
                      {pageNumber}{pageCount ? ` / ${pageCount}` : ''}
                    </span>
                    <button
                      type="button"
                      className={studioSecondaryButtonClassName}
                      disabled={!canNext || loadingDocs}
                      onClick={() => setPageNumber((current) => current + 1)}
                    >
                      下一页
                      <FaChevronRight className="h-3 w-3" aria-hidden />
                    </button>
                  </span>
                </div>

                {loadingDocs && !page ? (
                  <StudioLoadingState minHeightClassName="min-h-[200px]" text="正在读取文档…" />
                ) : page && page.documents.length > 0 ? (
                  <div className="max-h-[26rem] overflow-auto">
                    <table className="w-full border-collapse text-sm">
                      <thead className="sticky top-0 bg-white/95 text-xs text-slate-500">
                        <tr>
                          <th className="px-3 py-2 text-left font-medium">摘要</th>
                          <th className="px-3 py-2 text-right font-medium">操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {page.documents.map((document, index) => {
                          const open = openDocumentIndex === index;
                          return (
                            <tr key={`${page.collection}-${page.page}-${index}`} className="border-t border-slate-100 align-top">
                              <td className="min-w-0 px-3 py-2">
                                <div className="flex flex-wrap gap-x-3 gap-y-1">
                                  {summarizeDocument(document).map((row) => (
                                    <span key={row.key} className="min-w-0 text-[11px] text-slate-600">
                                      <span className="font-mono text-slate-400">{row.key}</span>
                                      <span className="mx-1 text-slate-300">=</span>
                                      <span className="break-all font-mono">{row.value}</span>
                                    </span>
                                  ))}
                                </div>
                                {open ? (
                                  <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-2xl border border-slate-200 bg-white p-3 text-[11px] text-slate-800">
                                    {JSON.stringify(document, null, 2)}
                                  </pre>
                                ) : null}
                              </td>
                              <td className="whitespace-nowrap px-3 py-2 text-right">
                                <button
                                  type="button"
                                  onClick={() => setOpenDocumentIndex(open ? null : index)}
                                  aria-expanded={open}
                                  className="inline-flex min-h-11 items-center text-xs text-sky-600 underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 sm:min-h-0"
                                >
                                  {open ? '收起' : '查看'}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => copy(JSON.stringify(document, null, 2))}
                                  aria-label="复制该文档 JSON"
                                  className="ml-2 inline-flex min-h-11 items-center gap-1 text-xs text-slate-500 underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 sm:min-h-0"
                                >
                                  <FaCopy className="h-3 w-3" aria-hidden />
                                  复制
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                ) : loadingDocs ? (
                  <StudioLoadingState minHeightClassName="min-h-[200px]" text="正在读取文档…" />
                ) : (
                  <StudioEmptyState
                    className="rounded-none border-0 bg-transparent px-3 py-6"
                    message="没有匹配的文档。检查过滤条件，或换一个集合。"
                  />
                )}
              </div>

              {pageNumber >= (overview?.maxPage ?? 200) ? (
                <p className="text-[11px] text-amber-700">
                  已达深页上限（skip 在深页是 O(n)）：请用过滤条件缩小范围，而不是继续翻页。
                </p>
              ) : null}

              {/* 导出 */}
              <div className="space-y-3 rounded-2xl border border-slate-200 bg-white/70 p-3">
                <div>
                  <div className="flex items-center gap-2">
                    <FaDownload className="h-4 w-4 text-slate-500" aria-hidden />
                    <span className="text-sm font-semibold text-slate-700">导出当前集合</span>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    NDJSON 流（首行头信息、末行汇总），导出范围跟随上面的过滤与排序；
                    导出内容与当前「{redact ? '脱敏显示：开' : '脱敏显示：关'}」一致。
                    {redact ? '' : ' 未脱敏的导出文件含凭据材料，请按敏感文件保管。'}
                  </p>
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <label className="flex flex-col gap-1 text-xs text-slate-600">
                    最多导出条数
                    <input
                      type="number"
                      min={1}
                      max={overview?.maxExportDocs ?? 20000}
                      value={exportMaxDocs}
                      onChange={(event) => setExportMaxDocs(Number(event.target.value) || 1)}
                      className={`${studioFieldClassName} w-36`}
                    />
                  </label>
                  <button
                    type="button"
                    className={studioSecondaryButtonClassName}
                    disabled={!selected || exporting}
                    onClick={() => void handleExport()}
                  >
                    {exporting ? <UnifiedLoadingSpinner size="sm" /> : <FaDownload className="h-4 w-4" aria-hidden />}
                    {exporting ? `导出中…（${formatBytes(exportProgress)}）` : '导出 NDJSON'}
                  </button>
                </div>
              </div>
            </section>
          </div>
        </div>
      )}
    </InfoPanel>
  );
}
