import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { useSearchParams } from 'react-router-dom';
import {
  FaChevronLeft,
  FaChevronRight,
  FaCopy,
  FaDownload,
  FaFilter,
  FaSearch,
  FaSync,
  FaTimes,
} from 'react-icons/fa';
import { useNotification } from './Notification';
import { getBackendErrorMessage } from '../utils/backendError';
import {
  auditLogApi,
  type AuditLogEntry,
  type AuditLogMeta,
  type AuditLogQuery,
  type AuditLogStats,
} from '../api/auditLog';
import { cn } from '../utils/cn';
import {
  builtInAuditLogPresets,
  createCustomAuditLogPreset,
  readCustomAuditLogPresets,
  writeCustomAuditLogPresets,
  type AuditLogPreset,
} from '../utils/auditLogPresets';
import { studioInfoRowClassName, studioSurfaceClassName, studioTileClassName } from './studioTheme';
import { AuditLogFilterPanel } from './admin/audit-log/AuditLogFilterPanel';
import { AuditLogStatsPanels } from './admin/audit-log/AuditLogStatsPanels';
import {
  moduleLabel,
  resultLabel,
  resultTone,
  roleLabel,
  roleTone,
  statusTone,
} from './admin/audit-log/labels';

const DEFAULT_FILTERS: AuditLogQuery = {
  module: '',
  result: '',
  keyword: '',
  requestId: '',
  action: '',
  userId: '',
  username: '',
  role: '',
  method: '',
  path: '',
  ip: '',
  targetId: '',
  targetName: '',
  statusCode: '',
  minDurationMs: '',
  maxDurationMs: '',
  startDate: '',
  endDate: '',
  sort: 'desc',
};

const PAGE_SIZE_OPTIONS = [20, 50, 100];

/** 从 URL 还原筛选条件与页码，刷新/分享链接后不丢（F4-18）。 */
const readAuditLogFilters = (params: URLSearchParams): AuditLogQuery => ({
  module: params.get('module') ?? '',
  result: params.get('result') ?? '',
  keyword: params.get('keyword') ?? '',
  requestId: params.get('requestId') ?? '',
  action: params.get('action') ?? '',
  userId: params.get('userId') ?? '',
  username: params.get('username') ?? '',
  role: params.get('role') ?? '',
  method: params.get('method') ?? '',
  path: params.get('path') ?? '',
  ip: params.get('ip') ?? '',
  targetId: params.get('targetId') ?? '',
  targetName: params.get('targetName') ?? '',
  statusCode: params.get('statusCode') ?? '',
  minDurationMs: params.get('minDurationMs') ?? '',
  maxDurationMs: params.get('maxDurationMs') ?? '',
  startDate: params.get('startDate') ?? '',
  endDate: params.get('endDate') ?? '',
  sort: params.get('sort') === 'asc' ? 'asc' : 'desc',
});

const readPageSize = (params: URLSearchParams): number => {
  const value = Number(params.get('pageSize'));
  return PAGE_SIZE_OPTIONS.includes(value) ? value : 20;
};

const AuditLogViewer: React.FC = () => {
  const { setNotification } = useNotification();
  const logsRequestRef = useRef(0);
  const statsRequestRef = useRef(0);
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [searchParams, setSearchParams] = useSearchParams();
  const [page, setPage] = useState(() => {
    const value = Number(searchParams.get('page'));
    return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 1;
  });
  const [pageSize, setPageSize] = useState(() => readPageSize(searchParams));
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [stats, setStats] = useState<AuditLogStats | null>(null);
  const [meta, setMeta] = useState<AuditLogMeta | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filters, setFilters] = useState<AuditLogQuery>(() => readAuditLogFilters(searchParams));
  const [appliedFilters, setAppliedFilters] = useState<AuditLogQuery>(() => readAuditLogFilters(searchParams));
  const [queryVersion, setQueryVersion] = useState(0);
  // 筛选预设：内置几条常用条件 + 允许把当前筛选存成自己的（localStorage，只存条件）。
  const [customPresets, setCustomPresets] = useState<AuditLogPreset[]>(() => readCustomAuditLogPresets());
  const [presetDraftName, setPresetDraftName] = useState('');
  const [showPresetInput, setShowPresetInput] = useState(false);
  const presets = useMemo(
    () => [...builtInAuditLogPresets(), ...customPresets],
    [customPresets],
  );

  const fetchLogs = useCallback(async (query: AuditLogQuery, nextPage: number, nextPageSize: number) => {
    const request = ++logsRequestRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const response = await auditLogApi.query({ ...query, page: nextPage, pageSize: nextPageSize });
      if (request !== logsRequestRef.current) return;
      setLogs(response.logs);
      setTotal(response.total);
      setPage(response.page);
      setExpandedId((current) => (response.logs.some((log) => log._id === current) ? current : null));
    } catch (error) {
      if (request !== logsRequestRef.current) return;
      setNotification({
        message: getBackendErrorMessage(error, '获取审计日志失败'),
        type: 'error',
      });
      setLoadError(getBackendErrorMessage(error, '获取审计日志失败'));
    } finally {
      if (request === logsRequestRef.current) setLoading(false);
    }
  }, [setNotification]);

  const fetchStats = useCallback(async (query: AuditLogQuery) => {
    const request = ++statsRequestRef.current;
    setStats(null);
    try {
      const response = await auditLogApi.getStats(query);
      if (request !== statsRequestRef.current) return;
      setStats(response);
    } catch (error) {
      if (request !== statsRequestRef.current) return;
      setNotification({
        message: getBackendErrorMessage(error, '获取审计统计失败'),
        type: 'error',
      });
    }
  }, [setNotification]);

  useEffect(() => {
    void auditLogApi.getMeta().then(setMeta).catch(() => undefined);
  }, []);

  useEffect(() => {
    void fetchLogs(appliedFilters, page, pageSize);
    return () => { logsRequestRef.current++; };
  }, [appliedFilters, fetchLogs, page, pageSize, queryVersion]);

  useEffect(() => {
    void fetchStats(appliedFilters);
    return () => { statsRequestRef.current++; };
  }, [appliedFilters, fetchStats, queryVersion]);

  // 已应用的筛选与页码写入 URL，便于刷新与分享（F4-18）。
  useEffect(() => {
    const params = new URLSearchParams();
    (Object.keys(appliedFilters) as Array<keyof AuditLogQuery>).forEach((key) => {
      const value = appliedFilters[key];
      // 默认排序写进 URL 只会让分享链接变脏；只有非默认值才持久化。
      if (key === 'sort' && (value === 'desc' || value === undefined || value === '')) return;
      if (value !== undefined && value !== '') params.set(key, String(value));
    });
    if (page > 1) params.set('page', String(page));
    if (pageSize !== 20) params.set('pageSize', String(pageSize));
    setSearchParams(params, { replace: true });
  }, [appliedFilters, page, pageSize, setSearchParams]);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const activeFilters = useMemo(() => {
    const labels: Partial<Record<keyof AuditLogQuery, string>> = {
      keyword: '关键词',
      requestId: '请求ID',
      module: '模块',
      result: '结果',
      action: '操作',
      userId: '用户ID',
      username: '用户名',
      role: '角色',
      method: '方法',
      path: '路径',
      ip: 'IP',
      targetId: '目标ID',
      targetName: '目标名称',
      statusCode: '状态码',
      minDurationMs: '最小耗时',
      maxDurationMs: '最大耗时',
      startDate: '开始日期',
      endDate: '结束日期',
    };

    return Object.entries(appliedFilters)
      // `sort` 是排序偏好而不是筛选条件：混进 chip 里会被误点掉。
      .filter(([key, value]) => key !== 'sort' && value !== undefined && value !== '')
      .map(([key, value]) => {
        const typedKey = key as keyof AuditLogQuery;
        const rawValue = String(value);
        const displayValue =
          typedKey === 'module'
            ? moduleLabel(rawValue, meta)
            : typedKey === 'result'
              ? resultLabel(rawValue, meta)
              : typedKey === 'role'
                ? roleLabel(rawValue, meta)
                : rawValue;
        return { key: typedKey, label: labels[typedKey] || key, value: displayValue };
      });
  }, [appliedFilters, meta]);

  const updateFilter = (key: keyof AuditLogQuery, value: string) => {
    setFilters((current) => ({ ...current, [key]: value }));
  };

  /** `patch` 用于「点一下就该筛好」的入口（快捷时间窗），始终覆盖在草稿之上。 */
  const applySearch = (patch?: Partial<AuditLogQuery>) => {
    const next = { ...DEFAULT_FILTERS, ...filters, ...patch };
    setFilters(next);
    setAppliedFilters(next);
    setPage(1);
    setQueryVersion((value) => value + 1);
  };

  const resetFilters = () => {
    setFilters(DEFAULT_FILTERS);
    setAppliedFilters(DEFAULT_FILTERS);
    setPage(1);
    setQueryVersion((value) => value + 1);
  };

  const removeFilter = (key: keyof AuditLogQuery) => {
    setFilters((current) => ({ ...current, [key]: '' }));
    setAppliedFilters((current) => ({ ...current, [key]: '' }));
    setPage(1);
    setQueryVersion((value) => value + 1);
  };

  /** 点分布条 = 立即按该维度筛选（同时同步草稿，打开面板时看到的是同一份条件）。 */
  const filterByFacet = (key: keyof AuditLogQuery, value: string) => {
    if (!value) return;
    const next = { ...DEFAULT_FILTERS, ...appliedFilters, [key]: value };
    setFilters(next);
    setAppliedFilters(next);
    setPage(1);
    setQueryVersion((version) => version + 1);
  };

  const refresh = () => {
    setQueryVersion((value) => value + 1);
  };

  /** 套用预设：同时写进草稿与已应用状态，否则输入框会显示旧值、看着像没生效。 */
  const applyPreset = (preset: AuditLogPreset) => {
    const next = { ...DEFAULT_FILTERS, ...preset.query };
    setFilters(next);
    setAppliedFilters(next);
    setPage(1);
    setQueryVersion((value) => value + 1);
  };

  const savePreset = () => {
    const created = createCustomAuditLogPreset(presetDraftName, filters);
    if (!created) {
      setNotification({ message: '请先填预设名称，并至少设置一个筛选条件', type: 'warning' });
      return;
    }
    setCustomPresets(writeCustomAuditLogPresets([...customPresets, created]));
    setPresetDraftName('');
    setShowPresetInput(false);
    setNotification({ message: `已保存预设「${created.name}」`, type: 'success' });
  };

  const deletePreset = (id: string) => {
    setCustomPresets(writeCustomAuditLogPresets(customPresets.filter((preset) => preset.id !== id)));
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const count = await auditLogApi.exportCsv(appliedFilters);
      setNotification({
        message: count === null ? '审计日志导出已开始' : `已导出 ${count.toLocaleString()} 条审计日志`,
        type: 'success',
      });
    } catch (error) {
      setNotification({
        message: getBackendErrorMessage(error, '导出审计日志失败'),
        type: 'error',
      });
    } finally {
      setExporting(false);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') {
      applySearch();
    }
  };

  const copyText = async (value?: string) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setNotification({ message: '已复制', type: 'success' });
    } catch {
      setNotification({ message: '复制失败', type: 'error' });
    }
  };

  return (
    <div className="space-y-4">
      <AuditLogStatsPanels stats={stats} meta={meta} onSelect={filterByFacet} />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <FaSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="搜索请求ID、用户、操作、目标或IP"
            className="w-full rounded-2xl border-2 border-slate-200 bg-white/80 py-2 pl-9 pr-3 text-sm text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-slate-400 focus:bg-white focus:ring-2 focus:ring-slate-300"
            value={filters.keyword}
            onChange={(event) => updateFilter('keyword', event.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>
        <button
          type="button"
          onClick={() => setShowFilters((value) => !value)}
          className={`inline-flex items-center gap-1 rounded-2xl px-3 py-2 text-sm transition ${
            showFilters ? 'bg-slate-200 text-slate-800' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
          }`}
          aria-expanded={showFilters}
        >
          <FaFilter aria-hidden /> 筛选
          {activeFilters.length > 0 ? (
            <span className="ml-1 rounded-full bg-slate-900 px-1.5 py-0.5 text-[10px] font-semibold text-white">
              {activeFilters.length}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          onClick={() => applySearch()}
          className="rounded-2xl bg-slate-900 px-4 py-2 text-sm text-white transition hover:bg-slate-800"
        >
          搜索
        </button>
        <button
          type="button"
          onClick={() => void exportCsv()}
          disabled={exporting || total === 0}
          className="rounded-2xl bg-slate-900 px-3 py-2 text-sm text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
          title={meta ? `最多导出 ${meta.maxExportRows.toLocaleString()} 条` : '导出CSV'}
          aria-label="导出 CSV"
        >
          <FaDownload className={exporting ? 'animate-pulse' : ''} />
        </button>
        <button
          type="button"
          onClick={refresh}
          className="rounded-2xl bg-slate-100 px-3 py-2 text-sm text-slate-600 transition hover:bg-slate-200"
          title="刷新"
          aria-label="刷新"
        >
          <FaSync className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* 快速筛选：18 个维度每次重填太慢，值班复盘几乎总是重复同样几组条件 */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-slate-400">快速筛选</span>
        {presets.map((preset) => (
          <span
            key={preset.id}
            className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white py-1 pr-1 pl-3 text-xs font-medium text-slate-600"
          >
            <button
              type="button"
              onClick={() => applyPreset(preset)}
              className="transition hover:text-slate-900"
              title={Object.keys(preset.query).length > 0 ? JSON.stringify(preset.query) : undefined}
            >
              {preset.name}
            </button>
            {preset.builtIn ? null : (
              <button
                type="button"
                onClick={() => deletePreset(preset.id)}
                aria-label={`删除预设 ${preset.name}`}
                className="flex size-5 items-center justify-center rounded-full text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"
              >
                <FaTimes className="h-2.5 w-2.5" />
              </button>
            )}
          </span>
        ))}

        {showPresetInput ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white py-1 pr-1 pl-3">
            <input
              autoFocus
              value={presetDraftName}
              onChange={(event) => setPresetDraftName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') savePreset();
                if (event.key === 'Escape') setShowPresetInput(false);
              }}
              placeholder="预设名称"
              maxLength={24}
              className="w-24 bg-transparent text-xs text-slate-700 outline-none"
              aria-label="预设名称"
            />
            <button
              type="button"
              onClick={savePreset}
              className="rounded-full bg-slate-900 px-2 py-0.5 text-[11px] font-semibold text-white"
            >
              保存
            </button>
            <button
              type="button"
              onClick={() => setShowPresetInput(false)}
              aria-label="取消保存预设"
              className="flex size-5 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100"
            >
              <FaTimes className="h-2.5 w-2.5" />
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setShowPresetInput(true)}
            disabled={activeFilters.length === 0}
            className="rounded-full border border-dashed border-slate-300 px-3 py-1 text-xs font-medium text-slate-500 transition hover:border-slate-400 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
            title={activeFilters.length === 0 ? '先设置至少一个筛选条件' : '把当前筛选条件存为预设'}
          >
            + 存为预设
          </button>
        )}

        {activeFilters.length > 0 ? (
          <button
            type="button"
            onClick={resetFilters}
            className="text-xs font-medium text-slate-400 transition hover:text-slate-600"
          >
            清空筛选
          </button>
        ) : null}
      </div>

      {showFilters ? (
        <AuditLogFilterPanel
          filters={filters}
          meta={meta}
          onChange={updateFilter}
          onApply={applySearch}
          onReset={resetFilters}
          onKeyDown={handleKeyDown}
        />
      ) : null}

      {activeFilters.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          {activeFilters.map((filter) => (
            <button
              type="button"
              key={String(filter.key)}
              onClick={() => removeFilter(filter.key)}
              className="inline-flex max-w-full items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-700 transition hover:bg-slate-200"
            >
              <span className="truncate">{filter.label}: {filter.value}</span>
              <FaTimes className="h-3 w-3 flex-shrink-0" />
            </button>
          ))}
        </div>
      ) : null}

      <div className={cn(studioSurfaceClassName)}>
        {loading && logs.length === 0 ? (
          <div className="p-8 text-center text-slate-400">加载中...</div>
        ) : loadError ? (
          <div className="p-8 text-center">
            <FaTimes className="mx-auto text-2xl text-rose-500" />
            <div className="mt-2 text-sm text-rose-600">{loadError}</div>
            <button
              type="button"
              onClick={() => { void fetchLogs(appliedFilters, page, pageSize); }}
              className="mx-auto mt-3 inline-flex items-center gap-1 rounded-2xl bg-slate-100 px-3 py-2 text-sm text-slate-600 transition hover:bg-slate-200"
            >
              <FaSync className={loading ? 'animate-spin' : ''} />
              <span>重试</span>
            </button>
          </div>
        ) : logs.length === 0 ? (
          <div className="p-8 text-center text-slate-400">暂无审计日志</div>
        ) : (
          <div className="divide-y divide-slate-100">
            {logs.map((log) => {
              const statusCode = getStatusCode(log);
              const durationMs = getDurationMs(log);
              const expanded = expandedId === log._id;
              const detailRest = getDetailWithoutBodies(log.detail);

              return (
                <div key={log._id} className="transition hover:bg-slate-50/80">
                  <button
                    type="button"
                    onClick={() => setExpandedId(expanded ? null : log._id)}
                    aria-expanded={expanded}
                    className="w-full px-3 py-3 text-left sm:px-4"
                  >
                    <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <span
                            className={`h-2 w-2 flex-shrink-0 rounded-full ${
                              log.result === 'success' ? 'bg-emerald-400' : 'bg-rose-400'
                            }`}
                          />
                          <span className="rounded bg-slate-50 px-1.5 py-0.5 text-xs text-slate-600">
                            {moduleLabel(log.module, meta)}
                          </span>
                          <span className={`rounded px-1.5 py-0.5 text-xs ${resultTone(log.result)}`}>
                            {resultLabel(log.result, meta)}
                          </span>
                          <span className={`rounded px-1.5 py-0.5 text-xs ${roleTone(log.role)}`}>
                            {roleLabel(log.role, meta)}
                          </span>
                          {log.method ? <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">{log.method}</span> : null}
                          {statusCode ? <span className={`rounded px-1.5 py-0.5 text-xs ${statusTone(statusCode)}`}>{statusCode}</span> : null}
                          {durationMs !== undefined ? (
                            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
                              {formatDuration(durationMs)}
                            </span>
                          ) : null}
                          <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800">{log.action}</span>
                        </div>
                        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-400">
                          <span className="truncate">by {log.username || 'unknown'}</span>
                          <span className="truncate">{log.ip}</span>
                          {log.path ? <span className="max-w-full truncate">{log.path}</span> : null}
                        </div>
                      </div>
                      <div className="flex flex-shrink-0 items-center gap-3 text-xs text-slate-400">
                        {log.requestId ? <span className="hidden max-w-[160px] truncate xl:inline">{log.requestId}</span> : null}
                        <span>{formatTime(log.createdAt)}</span>
                      </div>
                    </div>
                  </button>

                  {expanded ? (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      className="mx-3 mb-3 rounded-2xl bg-slate-50/80 p-3 text-xs sm:mx-4"
                    >
                      <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2 xl:grid-cols-3">
                        <DetailField label="请求ID" value={log.requestId} onCopy={() => void copyText(log.requestId)} />
                        <DetailField label="操作者ID" value={log.userId} onCopy={() => void copyText(log.userId)} />
                        <DetailField label="角色" value={`${roleLabel(log.role, meta)}（${log.role}）`} />
                        <DetailField label="模块" value={`${moduleLabel(log.module, meta)}（${log.module}）`} />
                        <DetailField label="请求" value={`${log.method || '-'} ${log.path || '-'}`} className="xl:col-span-2" />
                        <DetailField label="IP" value={log.ip} onCopy={() => void copyText(log.ip)} />
                        <DetailField label="目标ID" value={log.targetId} onCopy={() => void copyText(log.targetId)} />
                        <DetailField label="目标名称" value={log.targetName} />
                        <DetailField label="状态码" value={statusCode} />
                        <DetailField label="耗时" value={durationMs !== undefined ? formatDuration(durationMs) : undefined} />
                        {log.errorMessage ? (
                          <DetailField label="错误" value={log.errorMessage} className="text-rose-500 sm:col-span-2 xl:col-span-3" />
                        ) : null}
                      </div>

                      {log.detail?.reqBody !== undefined ? (
                        <JsonBlock label="前端请求" value={log.detail.reqBody} />
                      ) : null}
                      {log.detail?.resBody !== undefined ? (
                        <JsonBlock label="后端响应" value={log.detail.resBody} />
                      ) : null}
                      {detailRest ? <JsonBlock label="详情" value={detailRest} /> : null}
                      {log.userAgent ? (
                        <div className="mt-2 break-all text-slate-600">
                          <span className="text-slate-500">UA：</span>{log.userAgent}
                        </div>
                      ) : null}
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <QuickFilterButton label="按此用户筛选" onClick={() => filterByFacet('userId', log.userId)} />
                        <QuickFilterButton label="按此 IP 筛选" onClick={() => filterByFacet('ip', log.ip)} />
                        <QuickFilterButton label="按此模块筛选" onClick={() => filterByFacet('module', log.module)} />
                        {log.action ? (
                          <QuickFilterButton label="按此操作筛选" onClick={() => filterByFacet('action', log.action)} />
                        ) : null}
                        {log.requestId ? (
                          <QuickFilterButton label="按此请求ID筛选" onClick={() => filterByFacet('requestId', log.requestId as string)} />
                        ) : null}
                      </div>
                    </motion.div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className={cn(studioInfoRowClassName, 'gap-2 text-xs text-slate-500')}>
        <div className="flex flex-wrap items-center gap-2">
          <span>共 {total.toLocaleString()} 条，{page}/{totalPages} 页</span>
          {meta ? <span>保留 {meta.retentionDays} 天</span> : null}
          <select
            value={appliedFilters.sort || 'desc'}
            onChange={(event) => {
              const next = { ...appliedFilters, sort: event.target.value === 'asc' ? 'asc' : 'desc' } as AuditLogQuery;
              setFilters((current) => ({ ...current, sort: next.sort }));
              setAppliedFilters(next);
              setPage(1);
              setQueryVersion((value) => value + 1);
            }}
            aria-label="时间排序"
            className={cn(studioTileClassName, 'px-2 py-1 text-xs text-slate-600')}
          >
            {(meta?.sortOptions?.length ? meta.sortOptions : [
              { value: 'desc', label: '最新在前' },
              { value: 'asc', label: '最早在前' },
            ]).map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <select
            value={pageSize}
            onChange={(event) => {
              setPageSize(Number(event.target.value));
              setPage(1);
            }}
            aria-label="每页条数"
            className={cn(studioTileClassName, 'px-2 py-1 text-xs text-slate-600')}
          >
            {PAGE_SIZE_OPTIONS.map((size) => (
              <option key={size} value={size}>每页 {size}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            aria-label="上一页"
            className="rounded-2xl border border-slate-200 bg-white/80 px-2 py-1 transition hover:bg-slate-100 disabled:opacity-40"
          >
            <FaChevronLeft />
          </button>
          <button
            type="button"
            disabled={page >= totalPages}
            onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
            aria-label="下一页"
            className="rounded-2xl border border-slate-200 bg-white/80 px-2 py-1 transition hover:bg-slate-100 disabled:opacity-40"
          >
            <FaChevronRight />
          </button>
        </div>
      </div>
    </div>
  );
};

const formatTime = (iso: string) => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString('zh-CN', { hour12: false });
};

const formatDuration = (value: number | string) => {
  const ms = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(ms)) {
    return '-';
  }
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(2)}s`;
  }
  return `${Math.round(ms)}ms`;
};

const formatJson = (value: unknown) => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const getDetailWithoutBodies = (detail?: Record<string, unknown>) => {
  if (!detail) return null;
  const { reqBody, resBody, ...rest } = detail;
  const cleaned = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined));
  return Object.keys(cleaned).length > 0 ? cleaned : null;
};

const getStatusCode = (log: AuditLogEntry) => {
  const value = log.detail?.statusCode;
  return typeof value === 'number' || typeof value === 'string' ? value : undefined;
};

const getDurationMs = (log: AuditLogEntry) => {
  const value = log.detail?.durationMs;
  return typeof value === 'number' ? value : undefined;
};

const QuickFilterButton: React.FC<{ label: string; onClick: () => void }> = ({ label, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
  >
    {label}
  </button>
);

const DetailField: React.FC<{
  label: string;
  value?: React.ReactNode;
  className?: string;
  onCopy?: () => void;
}> = ({ label, value, className = '', onCopy }) => {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  return (
    <div className={`min-w-0 ${className}`}>
      <span className="text-slate-500">{label}：</span>
      <span className="break-all text-slate-700">{value}</span>
      {onCopy ? (
        <button
          type="button"
          onClick={onCopy}
          className="ml-1 inline-flex text-slate-400 transition hover:text-slate-700"
          title="复制"
          aria-label={`复制${label}`}
        >
          <FaCopy />
        </button>
      ) : null}
    </div>
  );
};

const JsonBlock: React.FC<{ label: string; value: unknown }> = ({ label, value }) => (
  <div className="mt-2">
    <span className="text-slate-500">{label}：</span>
    <pre className={cn(studioTileClassName, 'mt-1 max-h-48 overflow-x-auto whitespace-pre-wrap break-all p-2 text-xs')}>
      {formatJson(value)}
    </pre>
  </div>
);

export default AuditLogViewer;
