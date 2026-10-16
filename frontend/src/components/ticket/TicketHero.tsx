import React from 'react';
import { FiChevronDown, FiMessageSquare, FiMinimize2 } from 'react-icons/fi';
import { cn } from '../../utils/cn';
import { PenaltyAppealActions } from '../PenaltyAppealActions';
import {
  InfoBadge,
  InfoQueryHero,
  studioDisplayFont,
  studioEyebrowAccentPillClassName,
  studioGhostButtonClassName,
  studioHeroCardClassName,
} from '../studioTheme';

/**
 * 支持中心顶部的说明区（含处罚申诉横幅）。
 *
 * 抽成独立组件是为了两件事：
 *  1. TicketSystem.tsx 已逼近 1500 行的源码体积闸门，把整块纯展示 JSX 搬出来；
 *  2. 说明区有「展开 / 专注模式」两种形态，把它收在一处，改动时不会误伤页面骨架。
 *
 * 展开态复用基线的 `InfoQueryHero`（hero 卡片样式与装饰由它自带），专注态保留自定义的
 * 一行紧凑条；两种形态都自持卡片样式，父组件不再额外套卡片，否则会出现卡中卡的双层边框。
 * 外层 motion.div 仍由父组件持有，进出场动画不变。
 */

export interface TicketPenaltyAppeal {
  kind: 'ticket_moderation' | 'ticket_permission_ban';
  title: string;
  reason: string;
  details?: string;
}

interface TicketHeroBodyProps {
  isAdmin: boolean;
  unreadCount: number;
  /** 专注模式：只留一行标题，把纵向空间让给列表与会话。 */
  focusMode: boolean;
  onToggleFocusMode: () => void;
  penaltyAppeal: TicketPenaltyAppeal | null;
}

/** 处罚申诉横幅：两种形态都必须保留，它带着申诉入口，收起说明区不能顺带把它藏掉。 */
const PenaltyAppealBanner: React.FC<{ appeal: TicketPenaltyAppeal }> = ({ appeal }) => (
  <div className="w-full max-w-xl">
    <div className="mb-2 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
      <div className="font-semibold">{appeal.title}</div>
      <div className="mt-1 leading-6">{appeal.reason}</div>
      {appeal.details && (
        <div className="mt-2 whitespace-pre-line text-xs leading-5 text-rose-800/90">{appeal.details}</div>
      )}
    </div>
    <PenaltyAppealActions kind={appeal.kind} reason={appeal.reason} details={appeal.details} />
  </div>
);

const TicketHeroBody: React.FC<TicketHeroBodyProps> = ({
  isAdmin,
  unreadCount,
  focusMode,
  onToggleFocusMode,
  penaltyAppeal,
}) => {
  if (focusMode) {
    return (
      <div className={cn(studioHeroCardClassName, 'relative space-y-3 p-3')}>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <div className={cn(studioEyebrowAccentPillClassName, 'shrink-0')}>
            <FiMessageSquare />
            Synapse Support
          </div>
          <h1
            className="min-w-0 flex-1 truncate text-base font-semibold text-slate-900 md:text-lg"
            style={{ fontFamily: studioDisplayFont }}
          >
            支持中心
          </h1>
          {unreadCount > 0 && (
            <span className="shrink-0 rounded-full bg-sky-100 px-2.5 py-1 text-xs font-semibold text-sky-700">
              {unreadCount} 条未读
            </span>
          )}
          <button
            type="button"
            onClick={onToggleFocusMode}
            aria-pressed={true}
            className={cn(
              studioGhostButtonClassName,
              'shrink-0 gap-1 px-2.5 py-1.5 text-[11px] normal-case tracking-normal',
            )}
            title="展开顶部说明区"
          >
            <FiChevronDown size={13} /> 展开说明
          </button>
        </div>
        {penaltyAppeal && <PenaltyAppealBanner appeal={penaltyAppeal} />}
      </div>
    );
  }

  return (
    <InfoQueryHero
      eyebrow="Synapse Support"
      title="支持中心"
      description={`提交技术支持、功能反馈或投诉建议，所有工单都会经过 AI 审计并由人工跟进；可实时查看客服回复并进行双向沟通，${
        isAdmin ? '管理全局工单并追踪处理进度' : '管理个人工单历史并追踪处理进度'
      }。`}
      icon={FiMessageSquare}
      tone="sky"
      meta={
        <>
          {unreadCount > 0 ? <InfoBadge tone="sky">{unreadCount} 条未读</InfoBadge> : null}
          {penaltyAppeal ? <PenaltyAppealBanner appeal={penaltyAppeal} /> : null}
        </>
      }
      actions={
        <button
          type="button"
          onClick={onToggleFocusMode}
          aria-pressed={false}
          className={cn(
            studioGhostButtonClassName,
            'min-h-11 gap-1 px-2.5 py-1.5 text-[11px] normal-case tracking-normal md:min-h-0',
          )}
          title="收起顶部说明区，给列表让出更多空间"
        >
          <FiMinimize2 size={13} /> 专注模式
        </button>
      }
    />
  );
};

export default TicketHeroBody;
