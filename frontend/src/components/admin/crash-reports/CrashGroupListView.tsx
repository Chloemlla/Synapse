import React, { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import {
  FaBug,
  FaChevronDown,
  FaChevronUp,
  FaClock,
  FaExclamationTriangle,
  FaLayerGroup,
  FaMobileAlt,
  FaSortAmountDown,
  FaSortAmountUp,
  FaSync,
  FaTimes,
  FaUsers,
} from 'react-icons/fa';
import type { CrashGroup } from '@/api/crashReports';
import {
  InfoBadge,
  InfoMetricCard,
  InfoPanel,
  InfoPrimaryButton,
  InfoQueryHero,
  InfoQueryShell,
  studioFieldClassName,
  studioGhostButtonClassName,
} from '@/components/studioTheme';
import {
  StudioEmptyState,
  StudioErrorNote,
  StudioErrorState,
  StudioLoadingState,
  StudioPager,
} from '@/components/studioFeedback';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import {
  AUTO_REFRESH_OPTIONS,
  GROUP_SORTS,
  PAGE_SIZE_OPTIONS,
  RISK_CONFIG,
  RISK_FILTERS,
  SOURCE_TABS,
  type GroupQueryState,
} from './constants';
import { buildGroupSummaryText, formatRelativeTime, formatTime, shortKey, topFrame } from './format';
import { buildGroupsCsv, downloadCsvFile, downloadJsonFile, fileStamp } from './exporters';
import { CopyButton, DownloadButton, FilterChip, ToolbarSelect } from './ui';

interface Props {
  groups: CrashGroup[];
  total: number;
  loading: boolean;
  /** 列表拉取失败：必须与「本来就没有」的空态分开渲染。 */
  error?: string | null;
  query: GroupQueryState;
  autoRefreshMs: number;
  lastUpdatedAt: number | null;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  onQueryChange: (patch: Partial<GroupQueryState>) => void;
  onAutoRefreshChange: (ms: number) => void;
  onRefresh: () => void;
  onOpenGroup: (groupKey: string) => void;
}

const CrashGroupListView: React.FC<Props> = ({
  groups,
  total,
  loading,
  error = null,
  query,
  autoRefreshMs,
  lastUpdatedAt,
  searchInputRef,
  onQueryChange,
  onAutoRefreshChange,
  onRefresh,
  onOpenGroup,
}) => {
  const [draftSearch, setDraftSearch] = useState(query.search);
  const [draftDevice, setDraftDevice] = useState(query.device);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set());

  useEffect(() => setDraftSearch(query.search), [query.search]);

  useEffect(() => {
    if (draftSearch === query.search) return;
    const timer = window.setTimeout(() => onQueryChange({ search: draftSearch, offset: 0 }), 400);
    return () => window.clearTimeout(timer);
  }, [draftSearch, query.search, onQueryChange]);

  useEffect(() => setDraftDevice(query.device), [query.device]);

  useEffect(() => {
    if (draftDevice === query.device) return;
    const timer = window.setTimeout(() => onQueryChange({ device: draftDevice, offset: 0 }), 400);
    return () => window.clearTimeout(timer);
  }, [draftDevice, query.device, onQueryChange]);

  const stats = useMemo(() => {
    let crashes = 0;
    let users = 0;
    let high = 0;
    for (const group of groups) {
      crashes += group.count || 0;
      users += group.affectedUsers || 0;
      if (group.risk === 'high') high += 1;
    }
    return { crashes, users, high };
  }, [groups]);

  const totalPages = Math.max(1, Math.ceil(total / query.pageSize));
  const currentPage = Math.min(totalPages, Math.floor(query.offset / query.pageSize) + 1);

  const toggleExpanded = (groupKey: string) =>
    setExpandedKeys((current) => {
      const next = new Set(current);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });

  const allExpanded = groups.length > 0 && groups.every((group) => expandedKeys.has(group.groupKey));

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'e' && event.key !== 'E') return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
      }
      event.preventDefault();
      setExpandedKeys(allExpanded ? new Set() : new Set(groups.map((group) => group.groupKey)));
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [allExpanded, groups]);

  return (
    <InfoQueryShell>
      <InfoQueryHero
        eyebrow="崩溃报告"
        title="Lumen 崩溃报告"
        description="聚合 Lumen 应用与匿名崩溃 SDK 两个来源上报的崩溃数据。筛选、排序、搜索作用于全部崩溃组，而非仅当前页。"
        icon={FaBug}
        meta={
          <>
            <InfoBadge>{lastUpdatedAt ? `更新于 ${formatRelativeTime(lastUpdatedAt)}` : '尚未加载'}</InfoBadge>
            <InfoBadge>快捷键：R 刷新 / 斜杠 搜索 / E 展开</InfoBadge>
          </>
        }
        actions={
          <InfoPrimaryButton onClick={onRefresh} disabled={loading}>
            <FaSync className={loading ? 'animate-spin' : ''} /> 刷新
          </InfoPrimaryButton>
        }
      />

      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <InfoMetricCard label="崩溃组" value={total.toLocaleString()} detail="符合当前筛选条件" icon={FaLayerGroup} />
        <InfoMetricCard label="本页崩溃次数" value={stats.crashes.toLocaleString()} icon={FaBug} />
        <InfoMetricCard label="本页影响设备" value={stats.users.toLocaleString()} icon={FaUsers} />
        <InfoMetricCard label="本页高危组" value={stats.high.toLocaleString()} icon={FaExclamationTriangle} />
      </div>

      <InfoPanel className="mt-6" compact>
        <div className="flex flex-col gap-3 lg:flex-row">
          <div className="relative flex-1">
            <input
              ref={searchInputRef}
              value={draftSearch}
              onChange={(event) => setDraftSearch(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onQueryChange({ search: draftSearch, offset: 0 });
                if (event.key === 'Escape') setDraftSearch('');
              }}
              placeholder="搜索 groupKey 或堆栈内容（回车立即查询）"
              className={studioFieldClassName}
            />
            {draftSearch ? (
              <button
                type="button"
                onClick={() => setDraftSearch('')}
                title="清空搜索"
                className="inline-flex min-h-11 min-w-11 items-center justify-center absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 sm:min-h-0 sm:min-w-0"
              >
                <FaTimes />
              </button>
            ) : null}
          </div>
          <div className="relative lg:w-80">
            <input
              value={draftDevice}
              onChange={(event) => setDraftDevice(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') onQueryChange({ device: draftDevice, offset: 0 });
                if (event.key === 'Escape') setDraftDevice('');
              }}
              placeholder="按设备 ID 筛选（支持前缀）"
              aria-label="按设备 ID 筛选"
              className={`${studioFieldClassName} ${
                query.device ? 'border-sky-300 bg-sky-50/60' : ''
              }`}
            />
            {draftDevice ? (
              <button
                type="button"
                onClick={() => setDraftDevice('')}
                title="清空设备筛选"
                className="inline-flex min-h-11 min-w-11 items-center justify-center absolute right-3 top-1/2 -translate-y-1/2 rounded-full p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 sm:min-h-0 sm:min-w-0"
              >
                <FaTimes />
              </button>
            ) : null}
          </div>
        </div>

        {query.device ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="inline-flex min-h-11 items-center gap-1.5 rounded-full border border-sky-200 bg-sky-50 px-3 py-1 text-xs font-semibold text-sky-700 sm:min-h-0">
              <FaMobileAlt />
              <span className="font-mono" title={query.device}>
                {shortKey(query.device, 20)}
              </span>
              <span className="font-normal text-sky-600">命中 {total.toLocaleString()} 个崩溃组</span>
              <button
                type="button"
                onClick={() => onQueryChange({ device: '', offset: 0 })}
                title="清除设备筛选"
                aria-label="清除设备筛选"
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full transition hover:bg-sky-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300 sm:min-h-0 sm:min-w-0"
              >
                <FaTimes />
              </button>
            </span>
          </div>
        ) : null}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          {SOURCE_TABS.map((tab) => (
            <FilterChip
              key={tab.key || 'all'}
              active={query.source === tab.key}
              label={tab.label}
              onClick={() => onQueryChange({ source: tab.key, offset: 0 })}
            />
          ))}
          <span className="mx-1 h-4 w-px bg-slate-200" />
          {RISK_FILTERS.map((item) => (
            <FilterChip
              key={item.key || 'any'}
              active={query.risk === item.key}
              label={item.label}
              onClick={() => onQueryChange({ risk: item.key, offset: 0 })}
            />
          ))}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <ToolbarSelect
            title="排序字段"
            value={query.sort}
            options={GROUP_SORTS.map((item) => ({ value: item.key, label: `排序：${item.label}` }))}
            onChange={(value) => onQueryChange({ sort: value as GroupQueryState['sort'], offset: 0 })}
          />
          <button
            type="button"
            title={query.order === 'desc' ? '当前降序，点击改升序' : '当前升序，点击改降序'}
            onClick={() => onQueryChange({ order: query.order === 'desc' ? 'asc' : 'desc', offset: 0 })}
            className="inline-flex items-center gap-1.5 rounded-2xl border border-slate-200 bg-white/80 px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-slate-300"
          >
            {query.order === 'desc' ? <FaSortAmountDown /> : <FaSortAmountUp />}
            {query.order === 'desc' ? '降序' : '升序'}
          </button>
          <ToolbarSelect
            title="每页条数"
            value={query.pageSize}
            options={PAGE_SIZE_OPTIONS.map((size) => ({ value: size, label: `每页 ${size} 条` }))}
            onChange={(value) => onQueryChange({ pageSize: Number(value), offset: 0 })}
          />
          <ToolbarSelect
            title="自动刷新间隔"
            value={autoRefreshMs}
            options={AUTO_REFRESH_OPTIONS}
            onChange={(value) => onAutoRefreshChange(Number(value))}
          />
          <button
            type="button"
            onClick={() =>
              setExpandedKeys(allExpanded ? new Set() : new Set(groups.map((group) => group.groupKey)))
            }
            className="inline-flex items-center gap-1.5 rounded-2xl border border-slate-200 bg-white/80 px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-slate-300"
          >
            {allExpanded ? <FaChevronUp /> : <FaChevronDown />}
            {allExpanded ? '折叠全部' : '展开全部'}
          </button>
          <CopyButton
            getValue={() => groups.map(buildGroupSummaryText).join('\n\n---\n\n')}
            label="复制本页摘要"
            message={`已复制 ${groups.length} 个崩溃组摘要`}
          />
          <DownloadButton
            label="导出 CSV"
            onDownload={() => downloadCsvFile(`crash-groups-${fileStamp()}.csv`, buildGroupsCsv(groups))}
          />
          <DownloadButton
            label="导出 JSON"
            onDownload={() => downloadJsonFile(`crash-groups-${fileStamp()}.json`, groups)}
          />
        </div>
      </InfoPanel>

      <div className="mt-6 space-y-4">
        {error && groups.length === 0 ? (
          <StudioErrorState message={error} onRetry={onRefresh} />
        ) : loading && groups.length === 0 ? (
          <StudioLoadingState minHeightClassName="min-h-[280px]" text="正在读取崩溃组…" />
        ) : groups.length === 0 ? (
          <StudioEmptyState
            message={
              query.search || query.risk || query.source || query.device
                ? '当前筛选条件下没有崩溃组。放宽筛选条件或清空搜索后再看。'
                : '还没有崩溃上报。可以先刷新；或核对该应用的崩溃上报是否已经接入。'
            }
            action={
              query.search || query.risk || query.source || query.device ? (
                <button
                  type="button"
                  onClick={() => onQueryChange({ search: '', risk: '', source: '', device: '', offset: 0 })}
                  className={studioGhostButtonClassName}
                >
                  清除筛选
                </button>
              ) : (
                <button type="button" onClick={onRefresh} className={studioGhostButtonClassName}>
                  <FaSync /> 刷新
                </button>
              )
            }
          />
        ) : (
          <>
            {error ? <StudioErrorNote>{error}</StudioErrorNote> : null}
            {groups.map((group) => (
              <GroupCard
                key={group.groupKey}
                group={group}
                expanded={expandedKeys.has(group.groupKey)}
                onToggle={() => toggleExpanded(group.groupKey)}
                onOpen={() => onOpenGroup(group.groupKey)}
              />
            ))}
          </>
        )}
      </div>

      <StudioPager
        page={currentPage}
        pageSize={query.pageSize}
        total={total}
        loading={loading}
        onPageChange={(page) => onQueryChange({ offset: (page - 1) * query.pageSize })}
        label="崩溃组分页"
      />
    </InfoQueryShell>
  );
};

const GroupCard: React.FC<{
  group: CrashGroup;
  expanded: boolean;
  onToggle: () => void;
  onOpen: () => void;
}> = ({ group, expanded, onToggle, onOpen }) => {
  const reducedMotion = useReducedMotion();
  const risk = RISK_CONFIG[group.risk] || RISK_CONFIG.low;
  const frame = topFrame(group.cleanStack);

  return (
    <InfoPanel compact>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span
              className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${risk.badgeClass}`}
            >
              <span className={`h-2 w-2 rounded-full ${risk.dotClass}`} />
              {risk.label}
            </span>
            <InfoBadge>{group.count} 次</InfoBadge>
            <InfoBadge>{group.affectedUsers} 设备</InfoBadge>
            <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600">v{group.versionCode}</span>
            <span className="font-mono text-xs text-slate-400" title={group.groupKey}>
              {shortKey(group.groupKey, 12)}
            </span>
          </div>
          {frame ? (
            <div className="mt-2 truncate font-mono text-xs text-slate-700" title={frame}>
              {frame}
            </div>
          ) : null}
          <div className="mt-2 text-xs text-slate-400" title={formatTime(group.lastSeenAt)}>
            <FaClock className="mr-1 inline" />
            {formatRelativeTime(group.lastSeenAt)}
          </div>
        </div>
        <div className="flex flex-shrink-0 flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onOpen}
            className="rounded-2xl border border-slate-200 bg-white/80 px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-slate-300 hover:text-slate-900"
          >
            查看详情
          </button>
          <CopyButton getValue={() => group.groupKey} label="复制 Key" message="已复制 groupKey" />
          <CopyButton
            getValue={() => buildGroupSummaryText(group)}
            label="复制摘要"
            message="已复制崩溃组摘要"
          />
          <button
            type="button"
            title={expanded ? '折叠堆栈摘要' : '展开堆栈摘要'}
            onClick={onToggle}
            className="rounded-2xl border border-slate-200 bg-white/80 px-2 py-1.5 text-xs text-slate-500 transition hover:border-slate-300"
          >
            {expanded ? <FaChevronUp /> : <FaChevronDown />}
          </button>
        </div>
      </div>

      {expanded ? (
        <motion.div
          initial={reducedMotion ? false : { opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          className="mt-4 border-t border-slate-100 pt-4"
        >
          {group.cleanStack && group.cleanStack.length > 0 ? (
            <>
              <span className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">堆栈摘要</span>
              <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-2xl border border-slate-200 bg-white/80 p-3 text-xs backdrop-blur-xl">
                {group.cleanStack.join('\n')}
              </pre>
            </>
          ) : (
            <div className="text-xs text-slate-400">无堆栈摘要</div>
          )}
        </motion.div>
      ) : null}
    </InfoPanel>
  );
};

export default CrashGroupListView;
