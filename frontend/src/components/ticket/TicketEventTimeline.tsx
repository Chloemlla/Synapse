import React, { useState } from 'react';
import { FiChevronDown, FiClock } from 'react-icons/fi';
import type { ITicketEvent } from '../../api/ticketApi';
import { cn } from '../../utils/cn';
import {
  TICKET_EVENT_META,
  formatTicketTime,
  ticketEventDescription,
  type BadgeTone,
} from './ticketConstants';

/**
 * 工单处理记录时间线（状态 / 优先级 / 分类 / 受理人 / 满意度变更）。
 *
 * 默认折叠：它服务于「交接时确认上一班做到哪一步」，不是每次打开工单都要读的内容。
 * 事件里的管理员姓名已由后端 `toTicketView` 对属主脱敏为「客服」，前端不再二次加工。
 */

interface TicketEventTimelineProps {
  events?: ITicketEvent[] | null;
  defaultOpen?: boolean;
}

const TONE_DOT: Record<BadgeTone, string> = {
  blue: 'bg-sky-500',
  yellow: 'bg-amber-500',
  green: 'bg-emerald-500',
  slate: 'bg-slate-400',
  rose: 'bg-rose-500',
  // violet 只用于内部备注；事件时间线不使用，回落成中性色（避免语义扩散）。
  violet: 'bg-slate-400',
};

function actorLabel(event: ITicketEvent): string {
  if (event.actorName) return event.actorName;
  switch (event.actorRole) {
    case 'ai':
      return '智能助手';
    case 'system':
      return '系统';
    case 'admin':
    case 'superadmin':
      return '客服';
    default:
      return '用户';
  }
}

const TicketEventTimeline: React.FC<TicketEventTimelineProps> = ({ events, defaultOpen = false }) => {
  // 受控 open：<details open={false}> 在父组件因 WS 更新重渲染时会把用户展开的状态弹回去，
  // 所以展开状态自己持有，默认值只取一次 initial state。
  const [open, setOpen] = useState(defaultOpen);
  if (!events || events.length === 0) return null;

  return (
    <details
      open={open}
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
      className="group rounded-2xl border border-slate-200 bg-white/80 px-4 py-3"
    >
      <summary className="cursor-pointer list-none rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2">
        <span className="flex items-center justify-between gap-2">
          <span className="flex min-w-0 items-center gap-2">
            <FiClock className="shrink-0 text-slate-400" size={13} aria-hidden />
            <span className="min-w-0 text-sm font-semibold text-slate-900">处理记录</span>
            <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">
              {events.length} 条
            </span>
          </span>
          <FiChevronDown
            className="shrink-0 text-slate-400 transition group-open:rotate-180"
            size={14}
            aria-hidden
          />
        </span>
      </summary>

      <ol className="relative mt-3 space-y-3 border-l border-slate-200 pl-4">
        {events.map((event, index) => {
          const meta = TICKET_EVENT_META[event.type];
          const tone = meta?.tone ?? 'slate';
          return (
            <li key={`${event.type}-${event.createdAt}-${index}`} className="relative min-w-0">
              <span
                className={cn(
                  'absolute -left-[21px] top-1.5 h-2 w-2 rounded-full',
                  TONE_DOT[tone],
                )}
                aria-hidden
              />
              <div className="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-3">
                <p className="min-w-0 break-words text-xs text-slate-700">
                  {ticketEventDescription(event)}
                </p>
                <span className="shrink-0 text-[10px] text-slate-400">
                  {actorLabel(event)} ·{' '}
                  <time dateTime={event.createdAt} title={new Date(event.createdAt).toLocaleString()}>
                    {formatTicketTime(event.createdAt)}
                  </time>
                </span>
              </div>
            </li>
          );
        })}
      </ol>
    </details>
  );
};

export default TicketEventTimeline;
