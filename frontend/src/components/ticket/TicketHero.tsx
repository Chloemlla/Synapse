import React from 'react';
import { FiCheckCircle, FiChevronDown, FiInfo, FiMessageSquare, FiMinimize2 } from 'react-icons/fi';
import { cn } from '../../utils/cn';
import { PenaltyAppealActions } from '../PenaltyAppealActions';
import {
  studioDisplayFont,
  studioEyebrowAccentPillClassName,
  studioEyebrowClassName,
  studioGhostButtonClassName,
} from '../studioTheme';

/**
 * 支持中心顶部的说明区（含处罚申诉横幅）。
 *
 * 抽成独立组件是为了两件事：
 *  1. TicketSystem.tsx 已逼近 1500 行的源码体积闸门，把整块纯展示 JSX 搬出来；
 *  2. 说明区有「展开 / 专注模式」两种形态，把它收在一处，改动时不会误伤页面骨架。
 *
 * 注意：只渲染内部内容，外层的 motion.div / AnimatePresence 仍由父组件持有，
 * 这样移动端切换列表/详情时保留原有的进出场动画。
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

const TicketHeroBody: React.FC<TicketHeroBodyProps> = ({
  isAdmin,
  unreadCount,
  focusMode,
  onToggleFocusMode,
  penaltyAppeal,
}) => (
  <>
    {focusMode ? (
      <div className="relative flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
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
    ) : (
      <div className="relative flex min-w-0 flex-col gap-5 md:flex-row md:items-end md:justify-between">
        <div className="max-w-2xl min-w-0">
          <div className={studioEyebrowAccentPillClassName}>
            <FiMessageSquare />
            Synapse Support
          </div>
          <h1
            className="mt-4 text-[2rem] font-semibold leading-[1.05] text-slate-900 sm:text-5xl sm:leading-tight md:text-[2.5rem]"
            style={{ fontFamily: studioDisplayFont }}
          >
            支持中心
            {unreadCount > 0 && (
              <span className="ml-2 inline-flex items-center rounded-full bg-sky-100 px-2.5 py-1 align-middle text-xs font-semibold text-sky-700 sm:text-sm">
                {unreadCount} 条未读
              </span>
            )}
          </h1>
          <p className="mt-3 max-w-xl text-[13px] leading-6 text-slate-600 sm:text-base sm:leading-7">
            提交技术支持、功能反馈或投诉建议，所有工单都会经过 AI 审计并由人工跟进。
          </p>
        </div>
        <div className="hidden w-full md:flex md:w-auto md:max-w-sm md:flex-col md:items-end md:gap-2">
          <button
            type="button"
            onClick={onToggleFocusMode}
            aria-pressed={false}
            className={cn(
              studioGhostButtonClassName,
              'gap-1 px-2.5 py-1.5 text-[11px] normal-case tracking-normal',
            )}
            title="收起顶部说明区，给列表让出更多空间"
          >
            <FiMinimize2 size={13} /> 专注模式
          </button>
          <div className="w-full rounded-2xl border border-slate-200 bg-slate-50/80 p-4 sm:rounded-2xl">
            <div className={cn(studioEyebrowClassName, 'flex items-center gap-2')}>
              <FiInfo className="text-slate-500" />
              功能说明
            </div>
            <ul className="mt-3 space-y-2 text-[13px] leading-6 text-slate-600">
              <li className="flex items-start gap-2">
                <FiCheckCircle className="mt-1 shrink-0 text-emerald-500" />
                <span>提交技术支持、功能反馈或投诉建议</span>
              </li>
              <li className="flex items-start gap-2">
                <FiCheckCircle className="mt-1 shrink-0 text-emerald-500" />
                <span>实时查看客服回复并进行双向沟通</span>
              </li>
              <li className="flex items-start gap-2">
                <FiCheckCircle className="mt-1 shrink-0 text-emerald-500" />
                <span>{isAdmin ? '管理全局工单，支持状态过滤与更新' : '管理个人工单历史，追踪处理进度'}</span>
              </li>
            </ul>
          </div>
        </div>
      </div>
    )}

    {/* 处罚申诉横幅在两种形态下都要保留：它带着申诉入口，收起说明区不能顺带把它藏掉。 */}
    {penaltyAppeal && (
      <div className="relative mt-4 max-w-xl">
        <div className="mb-2 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900">
          <div className="font-semibold">{penaltyAppeal.title}</div>
          <div className="mt-1 leading-6">{penaltyAppeal.reason}</div>
          {penaltyAppeal.details && (
            <div className="mt-2 whitespace-pre-line text-xs leading-5 text-rose-800/90">{penaltyAppeal.details}</div>
          )}
        </div>
        <PenaltyAppealActions
          kind={penaltyAppeal.kind}
          reason={penaltyAppeal.reason}
          details={penaltyAppeal.details}
        />
      </div>
    )}
  </>
);

export default TicketHeroBody;
