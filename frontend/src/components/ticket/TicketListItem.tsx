import React from 'react';
import { motion } from 'framer-motion';
import { FiAlertCircle, FiCheckSquare, FiClock, FiFileText, FiSquare, FiUser } from 'react-icons/fi';
import type { ITicketSummary } from '../../api/ticketApi';
import { cn } from '../../utils/cn';
import { studioBadgeClassName, studioEyebrowClassName } from '../studioTheme';
import {
  TICKET_CATEGORY_META,
  TICKET_PRIORITY_META,
  TICKET_STATUS_META,
  formatTicketAge,
  formatTicketTime,
  isTicketSlaBreached,
} from './ticketConstants';

interface TicketListItemProps {
  ticket: ITicketSummary;
  selected: boolean;
  isAdmin: boolean;
  bulkMode: boolean;
  checked: boolean;
  index: number;
  onToggleCheck: (id: string) => void;
  onOpen: (ticket: ITicketSummary) => void;
}

/**
 * 工单列表行：未读圆点 / 分类 / 优先级 / 状态 / 最后一条预览 / 消息数 / 逾期标记。
 *
 * 可键盘操作（role=button + Enter/Space）：原实现是纯 `div onClick`，
 * 键盘与读屏用户无法打开任何工单。
 */
const TicketListItem: React.FC<TicketListItemProps> = ({
  ticket,
  selected,
  isAdmin,
  bulkMode,
  checked,
  index,
  onToggleCheck,
  onOpen,
}) => {
  const statusMeta = TICKET_STATUS_META[ticket.status] || TICKET_STATUS_META.open;
  const priorityMeta = TICKET_PRIORITY_META[ticket.priority] || TICKET_PRIORITY_META.medium;
  const categoryMeta = TICKET_CATEGORY_META[ticket.category] || TICKET_CATEGORY_META.other;
  const slaBreached = isAdmin && isTicketSlaBreached(ticket);
  const senderPrefix = ticket.lastSenderRole === 'user'
    ? '用户'
    : ticket.lastSenderRole === 'ai'
      ? '智能助手'
      : ticket.lastSenderRole === 'admin'
        ? '客服'
        : '';

  const open = () => onOpen(ticket);

  return (
    <motion.div
      role="button"
      tabIndex={0}
      aria-label={`打开工单：${ticket.title}`}
      aria-current={selected ? 'true' : undefined}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
          event.preventDefault();
          open();
        }
      }}
      className={cn(
        // 桌面端不再随 sm 增重行高：同样高度多显示 1~2 行工单（列表是可滚动区，行高直接决定信息密度）。
        'group cursor-pointer border-l-2 px-4 py-3 transition-all duration-200 sm:px-5 sm:py-3.5',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-slate-400',
        selected ? 'border-slate-900 bg-slate-50' : 'border-transparent hover:bg-slate-50/60 active:bg-slate-100',
      )}
      initial={{ opacity: 0, x: -16 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.2, delay: Math.min(index, 12) * 0.03 }}
    >
      <div className="flex items-start gap-2">
        {bulkMode && (
          <button
            type="button"
            aria-label={checked ? `取消选择 ${ticket.title}` : `选择 ${ticket.title}`}
            aria-pressed={checked}
            onClick={(event) => {
              event.stopPropagation();
              onToggleCheck(ticket._id);
            }}
            className="mt-0.5 shrink-0 text-slate-400 transition hover:text-slate-700"
          >
            {checked ? <FiCheckSquare className="text-slate-900" /> : <FiSquare />}
          </button>
        )}

        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-start justify-between gap-2 sm:mb-2">
            <h4 className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-xs font-semibold text-slate-900 sm:text-sm">
              {ticket.hasUnread && (
                <span
                  className="h-2 w-2 shrink-0 rounded-full bg-sky-500"
                  aria-label="未读"
                  title={isAdmin ? '有未读的用户消息' : '有未读回复'}
                />
              )}
              <span className="truncate">{ticket.title}</span>
            </h4>
            <span className={cn(studioBadgeClassName(priorityMeta.tone), 'shrink-0')}>{priorityMeta.label}</span>
          </div>

          {ticket.lastMessagePreview ? (
            <p className="mb-1.5 line-clamp-2 text-[11px] leading-5 text-slate-500 sm:text-[11.5px]">
              {senderPrefix ? <span className="font-medium text-slate-400">{senderPrefix}：</span> : null}
              {ticket.lastMessagePreview}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-slate-500 sm:text-[11px]">
            <span className={studioBadgeClassName(statusMeta.tone)}>{statusMeta.label}</span>
            <span className={cn(studioBadgeClassName(categoryMeta.tone), 'hidden sm:inline-flex')}>
              {categoryMeta.label}
            </span>
            {slaBreached ? (
              <span className={studioBadgeClassName('rose')} title={`待回复超过 ${formatTicketAge(ticket.ageHours)}`}>
                <FiAlertCircle /> 逾期
              </span>
            ) : null}
            {isAdmin && (ticket.internalNoteCount ?? 0) > 0 ? (
              <span className={studioBadgeClassName('violet')} title="含内部备注">
                <FiFileText /> {ticket.internalNoteCount}
              </span>
            ) : null}
            <span className="inline-flex items-center gap-1 text-slate-400">
              <FiClock className="shrink-0" /> {formatTicketTime(ticket.lastMessageAt || ticket.updatedAt)}
            </span>
            <span className="text-slate-400">{ticket.messageCount} 条</span>
          </div>

          {isAdmin && (
            <div className={cn(studioEyebrowClassName, 'mt-1.5 flex items-center justify-between gap-1 text-[10px] text-slate-500')}>
              <span className="inline-flex min-w-0 items-center gap-1">
                <FiUser size={10} /> <span className="truncate">{ticket.username}</span>
              </span>
              {ticket.assigneeName ? (
                <span className="shrink-0 truncate text-slate-400">受理：{ticket.assigneeName}</span>
              ) : (
                <span className="shrink-0 text-amber-500">未分配</span>
              )}
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
};

export default TicketListItem;
