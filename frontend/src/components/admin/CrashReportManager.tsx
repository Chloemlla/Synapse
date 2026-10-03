import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FaExclamationTriangle, FaSync } from 'react-icons/fa';
import { crashReportsApi, type CrashGroup, type FullCrashReport } from '@/api/crashReports';
import { useNotification } from '@/components/Notification';
import { InfoPanel, InfoPrimaryButton, InfoQueryShell } from '@/components/studioTheme';
import { getBackendErrorMessage } from '@/utils/backendError';
import CrashGroupDetailView from './crash-reports/CrashGroupDetailView';
import CrashGroupListView from './crash-reports/CrashGroupListView';
import { INITIAL_GROUP_QUERY, REPORT_PAGE_SIZE, type GroupQueryState } from './crash-reports/constants';

const isTypingTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
};

const CrashReportManager: React.FC = () => {
  const { setNotification } = useNotification();

  const [query, setQuery] = useState<GroupQueryState>(INITIAL_GROUP_QUERY);
  const [groups, setGroups] = useState<CrashGroup[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [autoRefreshMs, setAutoRefreshMs] = useState(0);

  const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
  const [reports, setReports] = useState<FullCrashReport[]>([]);
  const [reportTotal, setReportTotal] = useState(0);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportLoadingMore, setReportLoadingMore] = useState(false);
  const [reportUpdatedAt, setReportUpdatedAt] = useState<number | null>(null);

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const groupRequestRef = useRef(0);
  const reportRequestRef = useRef(0);

  const deviceFilter = query.device.trim();

  const loadGroups = useCallback(async () => {
    const requestId = ++groupRequestRef.current;
    setLoading(true);
    try {
      setLoadError(null);
      const res = await crashReportsApi.listGroups({
        limit: query.pageSize,
        offset: query.offset,
        source: query.source || undefined,
        risk: query.risk || undefined,
        search: query.search || undefined,
        device: query.device.trim() || undefined,
        sort: query.sort,
        order: query.order,
      });
      if (requestId !== groupRequestRef.current) return;
      setGroups(res.groups ?? []);
      setTotal(res.total ?? 0);
      setLastUpdatedAt(Date.now());
    } catch (error) {
      if (requestId !== groupRequestRef.current) return;
      setNotification({ message: getBackendErrorMessage(error, '加载崩溃组失败'), type: 'error' });
      setLoadError(getBackendErrorMessage(error, '获取崩溃报告失败，请稍后重试'));
    } finally {
      if (requestId === groupRequestRef.current) setLoading(false);
    }
  }, [query, setNotification]);

  const loadReports = useCallback(
    async (groupKey: string, offset: number, mode: 'replace' | 'append') => {
      const requestId = ++reportRequestRef.current;
      if (mode === 'append') setReportLoadingMore(true);
      else setReportLoading(true);
      try {
        const res = await crashReportsApi.getGroupReports(groupKey, {
          limit: REPORT_PAGE_SIZE,
          offset,
          device: deviceFilter || undefined,
        });
        if (requestId !== reportRequestRef.current) return;
        const incoming = res.reports ?? [];
        setReports((current) => (mode === 'append' ? [...current, ...incoming] : incoming));
        setReportTotal(res.total ?? incoming.length);
        setReportUpdatedAt(Date.now());
      } catch (error) {
        if (requestId !== reportRequestRef.current) return;
        setNotification({ message: getBackendErrorMessage(error, '加载崩溃报告失败'), type: 'error' });
      } finally {
        if (requestId === reportRequestRef.current) {
          setReportLoading(false);
          setReportLoadingMore(false);
        }
      }
    },
    [deviceFilter, setNotification],
  );

  useEffect(() => {
    void loadGroups();
  }, [loadGroups]);

  useEffect(() => {
    if (!selectedGroup) return;
    setReports([]);
    setReportTotal(0);
    void loadReports(selectedGroup, 0, 'replace');
  }, [selectedGroup, loadReports]);

  const refresh = useCallback(() => {
    if (selectedGroup) void loadReports(selectedGroup, 0, 'replace');
    else void loadGroups();
  }, [selectedGroup, loadGroups, loadReports]);

  useEffect(() => {
    if (autoRefreshMs <= 0) return;
    const timer = window.setInterval(refresh, autoRefreshMs);
    return () => window.clearInterval(timer);
  }, [autoRefreshMs, refresh]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'Escape' && selectedGroup && !isTypingTarget(event.target)) {
        setSelectedGroup(null);
        return;
      }
      if (isTypingTarget(event.target)) return;
      if (event.key === '/') {
        event.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      if (event.key === 'r' || event.key === 'R') {
        event.preventDefault();
        refresh();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [refresh, selectedGroup]);

  const onQueryChange = useCallback((patch: Partial<GroupQueryState>) => {
    setQuery((current) => ({ ...current, ...patch }));
  }, []);

  const onFilterDevice = useCallback((device: string) => {
    setQuery((current) => ({ ...current, device, offset: 0 }));
    setSelectedGroup(null);
  }, []);

  if (selectedGroup) {
    return (
      <CrashGroupDetailView
        groupKey={selectedGroup}
        reports={reports}
        total={reportTotal}
        loading={reportLoading}
        loadingMore={reportLoadingMore}
        lastUpdatedAt={reportUpdatedAt}
        deviceFilter={deviceFilter}
        searchInputRef={searchInputRef}
        onBack={() => setSelectedGroup(null)}
        onRefresh={refresh}
        onFilterDevice={onFilterDevice}
        onLoadMore={() => void loadReports(selectedGroup, reports.length, 'append')}
      />
    );
  }

  // 崩溃组列表拉取失败且无任何数据时，渲染独立错误面板（与「暂无崩溃报告」空态区分），并提供重试。
  // 注：列表本身的渲染在 CrashGroupListView 内，此处以整体错误态替代，避免错误与空态共用同一块 UI。
  if (loadError && groups.length === 0) {
    return (
      <InfoQueryShell>
        <InfoPanel className="mt-6">
          <div className="flex flex-col items-center gap-3 py-10 text-center">
            <FaExclamationTriangle className="text-2xl text-rose-500" />
            <p className="text-sm font-semibold text-slate-700">崩溃报告加载失败</p>
            <p className="text-sm text-slate-500">{loadError}</p>
            <InfoPrimaryButton onClick={() => void loadGroups()}>
              <FaSync /> 重试
            </InfoPrimaryButton>
          </div>
        </InfoPanel>
      </InfoQueryShell>
    );
  }

  return (
    <CrashGroupListView
      groups={groups}
      total={total}
      loading={loading}
      query={query}
      autoRefreshMs={autoRefreshMs}
      lastUpdatedAt={lastUpdatedAt}
      searchInputRef={searchInputRef}
      onQueryChange={onQueryChange}
      onAutoRefreshChange={setAutoRefreshMs}
      onRefresh={refresh}
      onOpenGroup={setSelectedGroup}
    />
  );
};

export default CrashReportManager;
