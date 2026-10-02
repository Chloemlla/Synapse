import React from 'react';
import { FiDownload, FiEye, FiFilter, FiRefreshCw, FiSearch, FiX } from 'react-icons/fi';
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

/** 管理端筛选栏：关键词 + 状态/优先级/分类/受理人 + 待回复/未读 + 排序 + 导出 + 重置。 */
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
  const dirty = Boolean(
    value.status || value.priority || value.category || value.assignee
    || value.awaitingReply || value.unread || searchInput,
  );

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
          onClick={onRefresh}
          className={cn(studioGhostButtonClassName, 'h-9 w-9 shrink-0 px-0 py-0')}
          aria-label="刷新工单列表"
          title="刷新列表"
        >
          <FiRefreshCw size={14} className={loading ? 'animate-spin' : undefined} />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <select
          aria-label="按状态筛选"
          className={cn(studioFieldClassName, 'py-2 text-xs')}
          value={value.status}
          onChange={(event) => onChange({ status: event.target.value })}
        >
          <option value="">所有状态</option>
          {TICKET_STATUS_ORDER.map((status) => (
            <option key={status} value={status}>{TICKET_STATUS_META[status].label}</option>
          ))}
        </select>
        <select
          aria-label="按优先级筛选"
          className={cn(studioFieldClassName, 'py-2 text-xs')}
          value={value.priority}
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
          value={value.category}
          onChange={(event) => onChange({ category: event.target.value })}
        >
          <option value="">所有分类</option>
          {TICKET_CATEGORY_ORDER.map((category) => (
            <option key={category} value={category}>{TICKET_CATEGORY_META[category].label}</option>
          ))}
        </select>
        <select
          aria-label="按受理人筛选"
          className={cn(studioFieldClassName, 'py-2 text-xs')}
          value={value.assignee}
          onChange={(event) => onChange({ assignee: event.target.value })}
        >
          <option value="">所有受理人</option>
          <option value="me">我受理的</option>
          <option value="unassigned">未分配</option>
        </select>
        <select
          aria-label="排序方式"
          className={cn(studioFieldClassName, 'col-span-2 py-2 text-xs')}
          value={value.sort}
          onChange={(event) => onChange({ sort: event.target.value })}
        >
          {TICKET_SORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => toggleFlag('awaitingReply')}
          aria-pressed={value.awaitingReply === '1'}
          className={cn(
            'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition',
            value.awaitingReply === '1'
              ? 'border-amber-300 bg-amber-50 text-amber-700'
              : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300',
          )}
        >
          <FiFilter size={11} /> 待我回复
        </button>
        <button
          type="button"
          onClick={() => toggleFlag('unread')}
          aria-pressed={value.unread === '1'}
          className={cn(
            'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition',
            value.unread === '1'
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
      </div>

      <div className={cn(studioEyebrowClassName, 'flex items-center justify-between text-[10px] text-slate-400')}>
        <span>已加载 {shown} 条{dirty ? '（筛选后）' : ''}</span>
        {total > 0 ? <span>共 {total} 条</span> : null}
      </div>
    </div>
  );
};

export default TicketFilters;
