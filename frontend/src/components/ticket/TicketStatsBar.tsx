import React from 'react';
import {
  FiAlertCircle, FiCalendar, FiCheckCircle, FiClock, FiInbox, FiLayers, FiStar, FiTrendingUp,
  FiUserCheck, FiUserPlus, FiXCircle,
} from 'react-icons/fi';
import type { TicketStats } from '../../api/ticketApi';
import { cn } from '../../utils/cn';
import { studioEyebrowClassName } from '../studioTheme';
import { TICKET_SLA_HOURS, formatTicketAge } from './ticketConstants';
import { ticketQuickViewPatch, type TicketFilterValue } from './TicketFilters';

/**
 * 后端统计的新字段（PRD §6.2）在 ticketApi 里可能是可选的：旧响应 / 旧后端
 * 只返回存量计数。这里显式声明成可选，缺失时回退 0 或「—」，避免白屏。
 */
type TicketStatsV2 = TicketStats & {
  awaitingMine?: number;
  mineOpen?: number;
  unassigned?: number;
  createdToday?: number;
  resolvedToday?: number;
  avgFirstResponseHours?: number | null;
  csatAverage?: number | null;
  csatCount?: number;
};

interface TicketStatsBarProps {
  stats: TicketStats | null;
  loading: boolean;
  onQuickFilter: (patch: Partial<TicketFilterValue>, view?: string) => void;
  /** 当前快捷视图 key，用于高亮对应卡片（all/mine/unassigned/awaiting/overdue/lowCsat）。 */
  activeView?: string;
}

interface StatCard {
  key: string;
  label: string;
  value: number | string;
  hint?: string;
  tone: string;
  /** 有 patch 才可点击；没有 patch 的卡片渲染成 div（平均首响就是这样）。 */
  patch?: Partial<TicketFilterValue>;
  /** 与 TicketFilters 的快捷视图 key 对齐，用于当前视图高亮。 */
  view?: string;
}

/**
 * 响应式容器：<sm 为单行横滑（手机竖屏下多列网格要占好几行，直接挤掉列表首屏），
 * ≥sm 2 列、≥md 3 列、≥lg 5 列；横滑容器自身裁剪，不会把页面撑出横向滚动条。
 */
const STATS_CONTAINER_CLASS =
  'flex gap-2 overflow-x-auto pb-1 sm:grid sm:grid-cols-2 sm:overflow-x-visible sm:pb-0 md:grid-cols-3 lg:grid-cols-5';

const STAT_CARD_BASE_CLASS =
  'w-[8.5rem] shrink-0 snap-start rounded-2xl border px-3 py-2 text-left sm:w-auto sm:shrink';

const STAT_CARD_INTERACTIVE_CLASS = cn(
  STAT_CARD_BASE_CLASS,
  'transition hover:brightness-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400',
);

const ICONS: Record<string, React.ReactNode> = {
  mine: <FiUserCheck size={13} aria-hidden />,
  awaitingReply: <FiClock size={13} aria-hidden />,
  slaBreached: <FiAlertCircle size={13} aria-hidden />,
  unassigned: <FiUserPlus size={13} aria-hidden />,
  createdToday: <FiCalendar size={13} aria-hidden />,
  resolvedToday: <FiCheckCircle size={13} aria-hidden />,
  avgFirstResponse: <FiTrendingUp size={13} aria-hidden />,
  csat: <FiStar size={13} aria-hidden />,
  open: <FiInbox size={13} aria-hidden />,
  'in-progress': <FiLayers size={13} aria-hidden />,
  resolved: <FiCheckCircle size={13} aria-hidden />,
  closed: <FiXCircle size={13} aria-hidden />,
  total: <FiLayers size={13} aria-hidden />,
};

/** 本地自然日（yyyy-mm-dd），与筛选栏的 `from/to` 口径一致（后端按本地日期边界解析）。 */
function todayDateValue(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

/**
 * 管理端概览条：把「今天该处理什么」直接摆在列表上方。
 *
 * 点击任一可交互卡片即应用对应筛选；当前快捷视图对应的卡片加一圈 slate-900。
 * 「今日解决」没有独立的 `resolvedAt` 查询参数，退化为「已解决 + 最近更新」——
 * 比做成不可点击更接近客服的意图，也不会误导成按解决时间过滤。
 */
const TicketStatsBar: React.FC<TicketStatsBarProps> = ({ stats, loading, onQuickFilter, activeView }) => {
  if (!stats && loading) {
    return (
      <div className={STATS_CONTAINER_CLASS}>
        {Array.from({ length: 13 }).map((_, index) => (
          <div
            key={index}
            className="h-14 w-[8.5rem] shrink-0 animate-pulse rounded-2xl border border-slate-200 bg-slate-50 sm:w-auto sm:shrink"
          />
        ))}
      </div>
    );
  }
  if (!stats) return null;

  const v2 = stats as TicketStatsV2;
  const status = stats.status ?? {};
  const today = todayDateValue();
  const oldestAwaitingHours = stats.oldestAwaitingHours ?? 0;
  const avgFirstResponseHours = v2.avgFirstResponseHours;
  const csatAverage = v2.csatAverage;
  const csatCount = v2.csatCount ?? 0;

  const cards: StatCard[] = [
    {
      key: 'mine',
      label: '我的待办',
      value: v2.awaitingMine ?? 0,
      tone: 'border-sky-200 bg-sky-50 text-sky-700',
      patch: ticketQuickViewPatch('mine'),
      view: 'mine',
    },
    {
      key: 'awaitingReply',
      label: '待回复',
      value: stats.awaitingReply ?? 0,
      hint: oldestAwaitingHours > 0 ? `最久 ${formatTicketAge(oldestAwaitingHours)}` : undefined,
      tone: 'border-amber-200 bg-amber-50 text-amber-700',
      patch: ticketQuickViewPatch('awaiting'),
      view: 'awaiting',
    },
    {
      key: 'slaBreached',
      label: `逾期 > ${TICKET_SLA_HOURS}h`,
      value: stats.slaBreached ?? 0,
      tone: 'border-rose-200 bg-rose-50 text-rose-700',
      patch: ticketQuickViewPatch('overdue'),
      view: 'overdue',
    },
    {
      key: 'unassigned',
      label: '未分配',
      value: v2.unassigned ?? 0,
      tone: 'border-amber-200 bg-amber-50 text-amber-700',
      patch: ticketQuickViewPatch('unassigned'),
      view: 'unassigned',
    },
    {
      key: 'createdToday',
      label: '今日新增',
      value: v2.createdToday ?? 0,
      tone: 'border-sky-200 bg-sky-50 text-sky-700',
      // 没有专门的 createdToday 参数：用创建时间区间表达同一天。
      patch: { ...ticketQuickViewPatch('all'), from: today, to: today },
    },
    {
      key: 'resolvedToday',
      label: '今日解决',
      value: v2.resolvedToday ?? 0,
      tone: 'border-emerald-200 bg-emerald-50 text-emerald-700',
      patch: { ...ticketQuickViewPatch('all'), status: 'resolved', sort: 'updated' },
    },
    {
      key: 'avgFirstResponse',
      label: '平均首响',
      value: typeof avgFirstResponseHours === 'number' && Number.isFinite(avgFirstResponseHours)
        ? `${avgFirstResponseHours.toFixed(1)}h`
        : '—',
      hint: '近 30 天',
      tone: 'border-slate-200 bg-slate-50 text-slate-600',
    },
    {
      key: 'csat',
      label: '满意度',
      value: typeof csatAverage === 'number' && Number.isFinite(csatAverage)
        ? csatAverage.toFixed(1)
        : '—',
      hint: csatCount > 0 ? `${csatCount} 条评价` : '暂无评价',
      tone: 'border-rose-200 bg-rose-50 text-rose-700',
      patch: ticketQuickViewPatch('lowCsat'),
      view: 'lowCsat',
    },
    {
      key: 'open',
      label: '待处理',
      value: status.open || 0,
      tone: 'border-sky-200 bg-sky-50 text-sky-700',
      patch: { status: 'open', awaitingReply: '', csat: '' },
    },
    {
      key: 'in-progress',
      label: '处理中',
      value: status['in-progress'] || 0,
      tone: 'border-amber-200 bg-amber-50 text-amber-700',
      patch: { status: 'in-progress', awaitingReply: '', csat: '' },
    },
    {
      key: 'resolved',
      label: '已解决',
      value: status.resolved || 0,
      tone: 'border-emerald-200 bg-emerald-50 text-emerald-700',
      patch: { status: 'resolved', awaitingReply: '', csat: '' },
    },
    {
      key: 'closed',
      label: '已关闭',
      value: status.closed || 0,
      tone: 'border-slate-200 bg-slate-50 text-slate-600',
      patch: { status: 'closed', awaitingReply: '', csat: '' },
    },
    {
      key: 'total',
      label: '全部',
      value: stats.total ?? 0,
      tone: 'border-slate-200 bg-white text-slate-700',
      patch: ticketQuickViewPatch('all'),
      view: 'all',
    },
  ];

  const cardBody = (card: StatCard) => (
    <>
      <span className={cn(studioEyebrowClassName, 'flex items-center gap-1 text-[10px] opacity-80')}>
        {ICONS[card.key]} {card.label}
      </span>
      <span className="mt-1 block text-base font-semibold leading-none">{card.value}</span>
      {card.hint ? <span className="mt-1 block truncate text-[10px] opacity-70">{card.hint}</span> : null}
    </>
  );

  return (
    <div className={STATS_CONTAINER_CLASS}>
      {cards.map((card) => {
        const active = Boolean(card.view && activeView === card.view);
        const ringClass = active ? 'ring-2 ring-slate-900' : undefined;

        // 平均首响是信息卡，不是筛选入口：渲染成 div，避免用户点了没反应。
        if (!card.patch) {
          return (
            <div
              key={card.key}
              title={card.hint || card.label}
              className={cn(STAT_CARD_BASE_CLASS, card.tone, ringClass)}
            >
              {cardBody(card)}
            </div>
          );
        }

        return (
          <button
            key={card.key}
            type="button"
            onClick={() => onQuickFilter(card.patch as Partial<TicketFilterValue>, card.view)}
            title={card.hint || `筛选：${card.label}`}
            aria-pressed={active}
            className={cn(STAT_CARD_INTERACTIVE_CLASS, card.tone, ringClass)}
          >
            {cardBody(card)}
          </button>
        );
      })}
    </div>
  );
};

export default TicketStatsBar;
