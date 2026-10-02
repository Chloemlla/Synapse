import React, { useState } from 'react';
import { FiChevronDown, FiChevronUp, FiDownload, FiEye, FiFilter, FiRefreshCw, FiSearch, FiSliders, FiX } from 'react-icons/fi';
import { cn } from '../../utils/cn';
import { studioEyebrowClassName, studioFieldClassName, studioGhostButtonClassName } from '../studioTheme';
import {
  TICKET_CATEGORY_META,
  TICKET_CATEGORY_ORDER,
  TICKET_PRIORITY_META,
  TICKET_SORT_OPTIONS,
  TICKET_STATUS_META,
  TICKET_STATUS_ORDER,
} from './ticketConstants';

export interface TicketFilterValue {
  status: string;
  priority: string;
  category: string;
  assignee: string;
  awaitingReply: string;
  unread: string;
  sort: string;
  /** 关键词（标题/描述/用户名）。 */
  q: string;
}

export const EMPTY_TICKET_FILTER: TicketFilterValue = {
  status: '',
  priority: '',
  category: '',
  assignee: '',
  awaitingReply: '',
  unread: '',
  sort: 'updated',
  q: '',
};

interface TicketFiltersProps {
  value: TicketFilterValue;
  searchInput: string;
  onSearchChange: (value: string) => void;
  onChange: (patch: Partial<TicketFilterValue>) => void;
  onReset: () => void;
  onRefresh: () => void;
  onExport: () => void;
  loading: boolean;
  total: number;
  shown: number;
}

/**
 * 管理端筛选栏：关键词 + 状态/优先级/分类/受理人 + 待回复/未读 + 排序 + 导出 + 重置。
 *
 * 布局取舍：五个下拉展开占约 160px，而左侧列表总高只有 500px 上下，默认展开会让
 * 列表第一屏只剩三四行。所以默认只留「搜索 + 常用开关 + 计数」三行以内的紧凑形态，
 * 其余筛选收进「更多筛选」，并用计数徽标提示有筛选在生效（不会悄悄藏掉条件）。
 */
const TicketFilters: React.FC<TicketFiltersProps> = ({
  value,
  searchInput,
  onSearchChange,
  onChange,
  onReset,
  onRefresh,
  onExport,
  loading,
  total,
  shown,
}) => {
  const [expanded, setExpanded] = useState(false);

  const {
    status = '',
    priority = '',
    category = '',
    assignee = '',
    awaitingReply = '',
    unread = '',
  } = value ?? EMPTY_TICKET_FILTER;

  const advancedCount = [status, priority, category, assignee, awaitingReply, unread].filter(Boolean).length;
  const dirty = advancedCount > 0 || Boolean(searchInput);
  // 收起状态下用一个 title 把「到底开了哪几个筛选」说清楚，避免只剩一个数字徽标让人猜。
  const activeFilterLabels = [
    status ? TICKET_STATUS_META[status as keyof typeof TICKET_STATUS_META]?.label : null,
    priority ? TICKET_PRIORITY_META[priority as keyof typeof TICKET_PRIORITY_META]?.label : null,
    category ? TICKET_CATEGORY_META[category as keyof typeof TICKET_CATEGORY_META]?.label : null,
    assignee ? (assignee === 'me' ? '我受理的' : '未分配') : null,
    awaitingReply ? '待我回复' : null,
    unread ? '仅未读' : null,
  ].filter((label): label is string => Boolean(label));

  const toggleFlag = (key: 'awaitingReply' | 'unread') => {
    onChange({ [key]: value[key] === '1' ? '' : '1' } as Partial<TicketFilterValue>);
  };

  return (
    <div className="shrink-0 space-y-2 border-b border-slate-200/80 bg-slate-50/60 p-3">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <FiSearch className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={14} />
          <input
            type="search"
            value={searchInput}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="搜索标题 / 描述 / 用户名"
            aria-label="搜索工单"
            className={cn(studioFieldClassName, 'py-2 pl-9 text-xs')}
          />
        </div>
        <button
          type="button"
          onClick={() => setExpanded((current) => !current)}
          aria-expanded={expanded}
          aria-controls="ticket-advanced-filters"
          className={cn(
            studioGhostButtonClassName,
            // ghost 默认是「全大写 + 宽字距」的窄标签样式，中文长标签要显式收回。
            'h-9 shrink-0 gap-1 px-2.5 py-0 text-xs normal-case tracking-normal',
            advancedCount > 0 && 'border-slate-900 text-slate-900',
          )}
          title={
            expanded
              ? '收起筛选条件'
              : activeFilterLabels.length
                ? `当前筛选：${activeFilterLabels.join(' / ')}（点击展开调整）`
                : '展开状态 / 优先级 / 分类 / 受理人等筛选'
          }
        >
          <FiSliders size={14} />
          {/* 手机窄屏下让位给搜索框：只留图标与数量徽标，文字从 sm 起显示。 */}
          <span className="hidden sm:inline">更多筛选</span>
          {advancedCount > 0 ? (
            <span className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-slate-900 px-1 text-[10px] font-semibold text-white">
              {advancedCount}
            </span>
          ) : null}
          {expanded ? <FiChevronUp size={13} /> : <FiChevronDown size={13} />}
        </button>
        <button
          type="button"
          onClick={onRefresh}
          className={cn(studioGhostButtonClassName, 'h-9 w-9 shrink-0 px-0 py-0')}
          aria-label="刷新工单列表"
          title="刷新列表"
        >
          <FiRefreshCw size={14} className={loading ? 'animate-spin' : undefined} />
        </button>
      </div>

      {expanded ? (
        <div id="ticket-advanced-filters" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <select
            aria-label="按状态筛选"
            className={cn(studioFieldClassName, 'py-2 text-xs')}
            value={status}
            onChange={(event) => onChange({ status: event.target.value })}
          >
            <option value="">所有状态</option>
            {TICKET_STATUS_ORDER.map((item) => (
              <option key={item} value={item}>{TICKET_STATUS_META[item].label}</option>
            ))}
          </select>
          <select
            aria-label="按优先级筛选"
            className={cn(studioFieldClassName, 'py-2 text-xs')}
            value={priority}
            onChange={(event) => onChange({ priority: event.target.value })}
          >
            <option value="">所有优先级</option>
            {Object.entries(TICKET_PRIORITY_META).map(([key, meta]) => (
              <option key={key} value={key}>{meta.label}</option>
            ))}
          </select>
          <select
            aria-label="按分类筛选"
            className={cn(studioFieldClassName, 'py-2 text-xs')}
            value={category}
            onChange={(event) => onChange({ category: event.target.value })}
          >
            <option value="">所有分类</option>
            {TICKET_CATEGORY_ORDER.map((item) => (
              <option key={item} value={item}>{TICKET_CATEGORY_META[item].label}</option>
            ))}
          </select>
          <select
            aria-label="按受理人筛选"
            className={cn(studioFieldClassName, 'py-2 text-xs')}
            value={assignee}
            onChange={(event) => onChange({ assignee: event.target.value })}
          >
            <option value="">所有受理人</option>
            <option value="me">我受理的</option>
            <option value="unassigned">未分配</option>
          </select>
          <select
            aria-label="排序方式"
            className={cn(studioFieldClassName, 'col-span-2 py-2 text-xs sm:col-span-2')}
            value={value.sort}
            onChange={(event) => onChange({ sort: event.target.value })}
          >
            {TICKET_SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => toggleFlag('awaitingReply')}
          aria-pressed={awaitingReply === '1'}
          className={cn(
            'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition',
            awaitingReply === '1'
              ? 'border-amber-300 bg-amber-50 text-amber-700'
              : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300',
          )}
        >
          <FiFilter size={11} /> 待我回复
        </button>
        <button
          type="button"
          onClick={() => toggleFlag('unread')}
          aria-pressed={unread === '1'}
          className={cn(
            'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition',
            unread === '1'
              ? 'border-sky-300 bg-sky-50 text-sky-700'
              : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300',
          )}
        >
          <FiEye size={11} /> 仅未读
        </button>
        {dirty && (
          <button
            type="button"
            onClick={onReset}
            className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-500 transition hover:border-slate-300 hover:text-slate-800"
          >
            <FiX size={11} /> 清空筛选
          </button>
        )}
        <button
          type="button"
          onClick={onExport}
          disabled={shown === 0}
          className="ml-auto inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-600 transition hover:border-slate-300 hover:text-slate-900 disabled:opacity-50"
          title="把当前已加载的工单导出为 CSV"
        >
          <FiDownload size={11} /> 导出
        </button>
        <span className={cn(studioEyebrowClassName, 'shrink-0 text-[10px] text-slate-400')}>
          已加载 {shown} 条{dirty ? '（筛选后）' : ''}
          {total > 0 ? ` · 共 ${total} 条` : ''}
        </span>
      </div>
    </div>
  );
};

export default TicketFilters;
