import React from 'react';
import { FiAlertCircle, FiCheckCircle, FiClock, FiInbox, FiLayers, FiXCircle } from 'react-icons/fi';
import type { TicketStats } from '../../api/ticketApi';
import { cn } from '../../utils/cn';
import { studioEyebrowClassName } from '../studioTheme';
import { TICKET_SLA_HOURS, formatTicketAge } from './ticketConstants';
import type { TicketFilterValue } from './TicketFilters';

interface TicketStatsBarProps {
  stats: TicketStats | null;
  loading: boolean;
  onQuickFilter: (patch: Partial<TicketFilterValue>) => void;
}

interface StatCard {
  key: string;
  label: string;
  value: number;
  hint?: string;
  tone: string;
  patch: Partial<TicketFilterValue>;
}

/**
 * 管理端概览条：把「今天该处理什么」直接摆在列表上方（待回复 / 逾期），
 * 点击任一卡片即等于应用对应筛选。
 */
const TicketStatsBar: React.FC<TicketStatsBarProps> = ({ stats, loading, onQuickFilter }) => {
  if (!stats && loading) {
    return (
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        {Array.from({ length: 7 }).map((_, index) => (
          <div key={index} className="h-14 animate-pulse rounded-2xl border border-slate-200 bg-slate-50" />
        ))}
      </div>
    );
  }
  if (!stats) return null;

  const cards: StatCard[] = [
    {
      key: 'awaitingReply',
      label: '待我回复',
      value: stats.awaitingReply,
      hint: stats.oldestAwaitingHours > 0 ? `最久 ${formatTicketAge(stats.oldestAwaitingHours)}` : undefined,
      tone: 'border-amber-200 bg-amber-50 text-amber-700',
      patch: { awaitingReply: '1', status: '' },
    },
    {
      key: 'slaBreached',
      label: `逾期 > ${TICKET_SLA_HOURS}h`,
      value: stats.slaBreached,
      tone: 'border-rose-200 bg-rose-50 text-rose-700',
      patch: { awaitingReply: '1', sort: 'oldest', status: '' },
    },
    {
      key: 'open',
      label: '待处理',
      value: stats.status?.open || 0,
      tone: 'border-sky-200 bg-sky-50 text-sky-700',
      patch: { status: 'open', awaitingReply: '' },
    },
    {
      key: 'in-progress',
      label: '处理中',
      value: stats.status?.['in-progress'] || 0,
      tone: 'border-yellow-200 bg-yellow-50 text-yellow-700',
      patch: { status: 'in-progress', awaitingReply: '' },
    },
    {
      key: 'resolved',
      label: '已解决',
      value: stats.status?.resolved || 0,
      tone: 'border-emerald-200 bg-emerald-50 text-emerald-700',
      patch: { status: 'resolved', awaitingReply: '' },
    },
    {
      key: 'closed',
      label: '已关闭',
      value: stats.status?.closed || 0,
      tone: 'border-slate-200 bg-slate-50 text-slate-600',
      patch: { status: 'closed', awaitingReply: '' },
    },
    {
      key: 'total',
      label: '全部工单',
      value: stats.total,
      tone: 'border-slate-200 bg-white text-slate-700',
      patch: { status: '', awaitingReply: '', unread: '', priority: '', category: '', assignee: '' },
    },
  ];

  const icons: Record<string, React.ReactNode> = {
    awaitingReply: <FiClock size={13} />,
    slaBreached: <FiAlertCircle size={13} />,
    open: <FiInbox size={13} />,
    'in-progress': <FiLayers size={13} />,
    resolved: <FiCheckCircle size={13} />,
    closed: <FiXCircle size={13} />,
    total: <FiLayers size={13} />,
  };

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
      {cards.map((card) => (
        <button
          key={card.key}
          type="button"
          onClick={() => onQuickFilter(card.patch)}
          title={card.hint || `筛选：${card.label}`}
          className={cn(
            // 概览条常驻在列表上方，压缩 8~10px 高度就是列表多一行。
            'min-w-0 rounded-2xl border px-3 py-2 text-left transition hover:brightness-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400',
            card.tone,
          )}
        >
          <span className={cn(studioEyebrowClassName, 'flex items-center gap-1 text-[10px] opacity-80')}>
            {icons[card.key]} {card.label}
          </span>
          <span className="mt-1 block text-base font-semibold leading-none">{card.value}</span>
          {card.hint ? <span className="mt-1 block truncate text-[10px] opacity-70">{card.hint}</span> : null}
        </button>
      ))}
    </div>
  );
};

export default TicketStatsBar;
