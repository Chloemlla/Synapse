import React from 'react';
import { FiRefreshCw, FiSearch, FiX } from 'react-icons/fi';
import { cn } from '../../utils/cn';
import {
  studioFieldClassName,
  studioGhostButtonClassName,
  studioPillClassName,
} from '../studioTheme';
import {
  TICKET_SORT_OPTIONS,
  TICKET_STATUS_META,
  TICKET_STATUS_ORDER,
  USER_TICKET_FILTER_DEFAULT,
  type UserTicketFilterValue,
} from './ticketConstants';

export type { UserTicketFilterValue };

/**
 * 用户端筛选默认值别名。
 *
 * 名称沿用工作清单里的契约（`EMPTY_USER_TICKET_FILTER`），值仍来自 ticketConstants，
 * 避免两处默认值漂移。
 */
export const EMPTY_USER_TICKET_FILTER: UserTicketFilterValue = { ...USER_TICKET_FILTER_DEFAULT };

interface TicketUserFiltersProps {
  value: UserTicketFilterValue;
  /** 搜索框的即时值；防抖由父组件负责（350ms 后才写回 `value.q`）。 */
  searchInput: string;
  onSearchChange: (value: string) => void;
  onChange: (patch: Partial<UserTicketFilterValue>) => void;
  onReset: () => void;
  onRefresh: () => void;
  loading: boolean;
  total: number;
  shown: number;
}

const STATUS_PILLS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '全部' },
  ...TICKET_STATUS_ORDER.map((status) => ({
    value: status as string,
    label: TICKET_STATUS_META[status]?.label ?? status,
  })),
];

/**
 * 用户端「我的工单」筛选栏：搜索 + 状态胶囊 + 排序 + 计数 + 刷新。
 *
 * 与管理端 TicketFilters 的区别：
 * - 用户只有「自己的工单」，不需要优先级/分类/受理人/日期这些分诊维度；
 * - 状态是单选胶囊而不是下拉 —— 最常用的五个选项一屏可见，少一次展开；
 * - 手机端胶囊横滑，不把页面撑出横向滚动条。
 */
const TicketUserFilters: React.FC<TicketUserFiltersProps> = ({
  value,
  searchInput,
  onSearchChange,
  onChange,
  onReset,
  onRefresh,
  loading,
  total,
  shown,
}) => {
  const sort = value.sort || 'updated';
  const filtered = Boolean(value.q.trim()) || Boolean(value.status) || sort !== 'updated';

  return (
    <div className="shrink-0 space-y-2 border-b border-slate-200/80 bg-slate-50/60 p-3">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <FiSearch
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
            size={14}
            aria-hidden
          />
          <input
            type="search"
            value={searchInput}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="搜索标题或描述"
            aria-label="搜索我的工单"
            className={cn(studioFieldClassName, 'py-2 pl-9 text-xs')}
          />
        </div>
        <button
          type="button"
          onClick={onRefresh}
          aria-label="刷新工单列表"
          title="刷新列表"
          className={cn(studioGhostButtonClassName, 'h-9 w-9 shrink-0 px-0 py-0')}
        >
          <FiRefreshCw size={14} className={loading ? 'animate-spin' : undefined} aria-hidden />
        </button>
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div
          role="group"
          aria-label="按状态筛选"
          className="-mx-1 flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto px-1 pb-1"
        >
          {STATUS_PILLS.map((pill) => {
            const active = value.status === pill.value;
            return (
              <button
                key={pill.value || 'all'}
                type="button"
                onClick={() => onChange({ status: pill.value })}
                aria-pressed={active}
                className={cn(
                  studioPillClassName(active),
                  // studioPill 是英文大写窄标签口径，中文状态需要收回字距与大小写。
                  'inline-flex items-center normal-case tracking-normal',
                )}
              >
                {pill.label}
              </button>
            );
          })}
        </div>
        <select
          aria-label="排序方式"
          title="排序方式"
          className="shrink-0 rounded-2xl border-2 border-slate-200 bg-white/80 px-3 py-1.5 text-xs text-slate-900 outline-none transition focus:border-slate-400 focus:bg-white focus:ring-2 focus:ring-slate-300"
          value={sort}
          onChange={(event) => onChange({ sort: event.target.value })}
        >
          {TICKET_SORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-slate-500">
          已加载 {shown} 条{filtered ? '（筛选后）' : ''}
          {total > 0 ? ` · 共 ${total} 条` : ''}
        </span>
        {filtered ? (
          <button
            type="button"
            onClick={onReset}
            className={cn(
              studioPillClassName(false),
              'ml-auto inline-flex items-center gap-1 normal-case tracking-normal hover:text-slate-800',
            )}
          >
            <FiX size={11} aria-hidden /> 清空筛选
          </button>
        ) : null}
      </div>
    </div>
  );
};

export default TicketUserFilters;
