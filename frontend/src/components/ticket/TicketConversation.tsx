import React, { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import {
  FiCheck,
  FiCheckCircle,
  FiCopy,
  FiCpu,
  FiEdit2,
  FiLoader,
  FiLock,
  FiTrash2,
  FiUser,
} from 'react-icons/fi';
import type { ITicket } from '../../api/ticketApi';
import { cn } from '../../utils/cn';
import MarkdownRenderer, {
  copyTextToClipboard,
  type MarkdownReaderControls,
} from '../MarkdownRenderer';
import { AiErrorDetailsPanel } from '../AiErrorDetailsPanel';
import { MAX_TICKET_REPLY_LEN, formatTicketTime } from './ticketConstants';
import { studioEyebrowClassName, studioPillClassName } from '../studioTheme';

/**
 * 工单会话区（消息列表 + 日期分隔 + 新消息提示 + 管理员过滤 + 编辑/删除/复制）。
 *
 * 为什么自己持有滚动容器：
 * - 原实现由父组件在消息数变化时无条件 `scrollTo`，用户向上翻记录时会被硬拽回底部；
 * - 现在只有「距底部 < 120px」才自动跟到底，否则显示「有新消息 · 回到底部」浮钮；
 * - 切换工单时仍然立即滚到底，保证打开深链就能看到最新一条。
 *
 * 消息过滤只影响展示：编辑/删除仍用原始 `messages` 下标，避免管理员在「公开」视图里
 * 编辑到错误的备注（这是后端按索引寻址的既有契约）。
 */

export interface TicketConversationProps {
  ticket: ITicket;
  currentUserId?: string;
  isAdmin: boolean;
  /** superadmin：可编辑/删除消息。 */
  canWrite: boolean;
  streamingAiResponse: { ticketId: string; content: string } | null;
  editingIdx: number | null;
  editValue: string;
  isUpdating: boolean;
  onStartEdit: (index: number, content: string) => void;
  onCancelEdit: () => void;
  onEditValueChange: (value: string) => void;
  onSaveEdit: (index: number) => void;
  onDeleteMessage: (index: number) => void;
  onCopyMarkdown: (success: boolean, whole?: boolean) => void;
}

type MessageFilter = 'all' | 'public' | 'internal';

const CHAT_MARKDOWN_CONTROLS: MarkdownReaderControls = {
  showCopy: true,
  showSourceToggle: true,
  showExpandToggle: true,
  defaultExpanded: true,
  collapsedHeight: 420,
};

const NEAR_BOTTOM_PX = 120;

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function dayKey(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

/** 日期分隔文案：今天 / 昨天 / YYYY年M月D日（按本地自然日）。 */
function formatDayLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const diffDays = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86_400_000);
  if (diffDays === 0) return '今天';
  if (diffDays === 1) return '昨天';
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

function fullTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function isInternalMessage(message: { visibility?: string }): boolean {
  return message.visibility === 'internal';
}

const TicketConversation: React.FC<TicketConversationProps> = ({
  ticket,
  currentUserId,
  isAdmin,
  canWrite,
  streamingAiResponse,
  editingIdx,
  editValue,
  isUpdating,
  onStartEdit,
  onCancelEdit,
  onEditValueChange,
  onSaveEdit,
  onDeleteMessage,
  onCopyMarkdown,
}) => {
  const prefersReducedMotion = useReducedMotion();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const nearBottomRef = useRef(true);
  const lastMessageKeyRef = useRef('');
  const [showJump, setShowJump] = useState(false);
  const [messageFilter, setMessageFilter] = useState<MessageFilter>('all');
  const [announcement, setAnnouncement] = useState('');

  const messageCount = ticket.messages?.length ?? 0;
  const streamingContent =
    streamingAiResponse && streamingAiResponse.ticketId === ticket._id
      ? streamingAiResponse.content
      : '';

  const scrollToBottom = (behavior: ScrollBehavior) => {
    const box = scrollRef.current;
    if (!box) return;
    if (typeof box.scrollTo === 'function') {
      box.scrollTo({ top: box.scrollHeight, behavior });
    } else {
      box.scrollTop = box.scrollHeight;
    }
    nearBottomRef.current = true;
    setShowJump(false);
  };

  const handleScroll = () => {
    const box = scrollRef.current;
    if (!box) return;
    const distance = box.scrollHeight - box.scrollTop - box.clientHeight;
    const nearBottom = distance < NEAR_BOTTOM_PX;
    nearBottomRef.current = nearBottom;
    if (nearBottom) setShowJump(false);
  };

  // 切换工单：立即到底；同一工单消息增加：接近底部才平滑跟随，否则只提示。
  useEffect(() => {
    const key = `${ticket._id}:${messageCount}`;
    const previous = lastMessageKeyRef.current;
    lastMessageKeyRef.current = key;

    if (!previous) {
      const timer = window.setTimeout(() => scrollToBottom('auto'), 0);
      return () => window.clearTimeout(timer);
    }

    const [previousId = '', previousCount = '0'] = previous.split(':');
    if (previousId !== ticket._id) {
      nearBottomRef.current = true;
      setShowJump(false);
      const timer = window.setTimeout(() => scrollToBottom('auto'), 0);
      return () => window.clearTimeout(timer);
    }

    if (messageCount > Number(previousCount)) {
      if (nearBottomRef.current) {
        const timer = window.setTimeout(() => scrollToBottom('smooth'), 60);
        return () => window.clearTimeout(timer);
      }
      setShowJump(true);
      setAnnouncement(`收到 ${messageCount - Number(previousCount)} 条新消息`);
    }
    return undefined;
    // scrollToBottom 每次渲染重建，但只依赖工单与消息数触发；不需要把它放进依赖。
  }, [ticket._id, messageCount]);

  // AI 流式回复是最常见的「新消息」形态：接近底部时跟随，翻旧记录时不打扰。
  useEffect(() => {
    if (!streamingContent) return;
    if (nearBottomRef.current) {
      scrollToBottom('auto');
    } else {
      setShowJump(true);
    }
    // 只在流式内容增长时触发。
  }, [streamingContent]);

  const handleCopy = async (content: string) => {
    const success = await copyTextToClipboard(content);
    onCopyMarkdown(success, true);
  };

  const visibleMessages = (ticket.messages ?? [])
    .map((message, index) => ({ message, index }))
    .filter(({ message }) => {
      if (!isAdmin || messageFilter === 'all') return true;
      const internal = isInternalMessage(message as { visibility?: string });
      return messageFilter === 'internal' ? internal : !internal;
    });

  return (
    // 手机端整页滚动（详情面板不定高）：flex-1 + min-h-0 在 auto 高度容器里会把会话压成 0，
    // 所以弹性与内层滚动只在 md 起生效。
    <div className="relative flex flex-col bg-white md:min-h-0 md:flex-1">
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>

      {isAdmin ? (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-200/80 bg-slate-50/60 px-4 py-2 sm:px-6">
          <span className={cn(studioEyebrowClassName, 'mr-1 shrink-0 text-[10px]')}>消息范围</span>
          {([
            { value: 'all', label: '全部' },
            { value: 'public', label: '公开' },
            { value: 'internal', label: '内部备注' },
          ] as const).map((option) => {
            const active = messageFilter === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => setMessageFilter(option.value)}
                aria-pressed={active}
                className={cn(
                  studioPillClassName(active, 'blue'),
                  'inline-flex items-center normal-case tracking-normal',
                )}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      ) : null}

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="space-y-4 bg-white p-4 hover-scrollbar sm:space-y-6 sm:p-6 md:min-h-0 md:flex-1 md:overflow-y-auto 2xl:p-8"
      >
        {visibleMessages.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-slate-400">
            {(ticket.messages?.length ?? 0) === 0 ? '暂无消息' : '没有符合条件的消息'}
          </div>
        ) : null}

        {visibleMessages.map(({ message, index }, position) => {
          const previous = position > 0 ? visibleMessages[position - 1] : null;
          const showDaySeparator = !previous || dayKey(previous.message.createdAt) !== dayKey(message.createdAt);
          const isAi = message.senderRole === 'ai' || message.isAi;
          const isMe = message.senderId === currentUserId;
          const isAdminMsg = message.senderRole === 'admin';
          const isInternal = isInternalMessage(message as { visibility?: string });
          // 纯文本消息原样展示（保留换行与空格）；缺字段的老消息按 Markdown 渲染。
          const isPlain = message.format === 'plain';
          const senderLabel = isAi ? '智能助手' : isAdminMsg ? '客服' : '用户';
          const isEditing = editingIdx === index;
          const actionTone = isMe
            ? 'text-white/70 hover:text-white focus-visible:ring-white/70'
            : 'text-slate-400 hover:text-slate-700 focus-visible:ring-slate-400';
          const deleteTone = isMe
            ? 'text-white/70 hover:text-rose-300 focus-visible:ring-white/70'
            : 'text-slate-400 hover:text-rose-500 focus-visible:ring-slate-400';

          return (
            <React.Fragment key={`${ticket._id}-${index}`}>
              {showDaySeparator ? (
                <div
                  role="separator"
                  aria-label={formatDayLabel(message.createdAt)}
                  className="flex items-center gap-3 px-1"
                >
                  <span className="h-px flex-1 bg-slate-200" aria-hidden />
                  <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                    {formatDayLabel(message.createdAt)}
                  </span>
                  <span className="h-px flex-1 bg-slate-200" aria-hidden />
                </div>
              ) : null}

              <motion.div
                className={cn('group flex', isMe ? 'justify-end' : 'justify-start')}
                initial={prefersReducedMotion ? false : { opacity: 0, x: -16 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.3 }}
              >
                {/* 气泡宽度按视口放宽：手机 92% 够用，2xl 收到 70% 避免一行读太长。 */}
                <div
                  className={cn(
                    'relative max-w-[92%] sm:max-w-[85%] lg:max-w-[78%] 2xl:max-w-[70%]',
                    isMe ? 'order-1' : 'order-2',
                  )}
                >
                  <div
                    className={cn(
                      'mb-1 flex items-center gap-2 text-[10px] text-slate-400',
                      isMe ? 'justify-end' : 'justify-start',
                    )}
                  >
                    {!isMe && !isInternal ? (
                      <span className={cn('font-semibold', isAdminMsg ? 'text-slate-700' : 'text-slate-500')}>
                        {isAi ? (
                          <>
                            <FiCpu className="inline" size={11} aria-hidden /> {senderLabel}
                          </>
                        ) : isAdminMsg ? (
                          senderLabel
                        ) : (
                          <>
                            <FiUser className="inline" size={11} aria-hidden /> {senderLabel}
                          </>
                        )}
                      </span>
                    ) : null}
                    <time dateTime={message.createdAt} title={fullTimestamp(message.createdAt)}>
                      {formatTicketTime(message.createdAt)}
                    </time>
                    {isPlain ? (
                      <span
                        className="shrink-0 rounded-full border border-slate-200 px-1.5 py-0.5 text-[9px] font-semibold text-slate-400"
                        title="这条消息按纯文本原样展示"
                      >
                        纯文本
                      </span>
                    ) : null}
                  </div>

                  <div
                    className={cn(
                      'relative rounded-2xl p-3.5 transition-shadow sm:p-4',
                      isMe
                        ? 'bg-slate-900 text-white shadow-sm'
                        : isInternal
                          ? 'border border-violet-200 bg-violet-50 text-slate-900'
                          : isAi
                            ? 'border border-slate-200 bg-white text-slate-900 shadow-sm'
                            : 'border border-slate-200 bg-slate-50 text-slate-900',
                    )}
                  >
                    {isInternal ? (
                      <div
                        className={cn(
                          studioEyebrowClassName,
                          'mb-1 flex items-center gap-1 text-[10px] tracking-[0.22em] text-violet-600',
                        )}
                      >
                        <FiLock size={10} aria-hidden /> 内部备注（用户不可见）
                      </div>
                    ) : null}
                    {isAdminMsg && !isInternal ? (
                      <div
                        className={cn(
                          studioEyebrowClassName,
                          'mb-1 flex items-center gap-1 text-[10px] tracking-[0.22em]',
                        )}
                      >
                        <FiCheckCircle size={10} aria-hidden /> 客服回复
                      </div>
                    ) : null}

                    {isEditing ? (
                      <div className="space-y-2">
                        <textarea
                          // 固定白底深色字：浅色气泡与深色气泡上都必须可读（原实现白字浅底）。
                          className="min-h-[100px] w-full rounded-2xl border border-slate-300 bg-white p-2 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-slate-400 focus:ring-2 focus:ring-slate-300"
                          value={editValue}
                          maxLength={MAX_TICKET_REPLY_LEN}
                          onChange={(event) => onEditValueChange(event.target.value)}
                          autoFocus
                          aria-label="编辑消息内容"
                        />
                        <div className="flex justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => onSaveEdit(index)}
                            disabled={isUpdating}
                            className="inline-flex items-center gap-1 rounded-full bg-emerald-600 px-3 py-1 text-xs font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
                          >
                            {isUpdating ? <FiLoader className="animate-spin" aria-hidden /> : <FiCheck aria-hidden />}
                            保存
                          </button>
                          <button
                            type="button"
                            onClick={onCancelEdit}
                            className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-600 transition hover:border-slate-400 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    ) : isPlain ? (
                      // 纯文本：换行与空格按原样保留，不解析任何 Markdown（贴日志/堆栈时尤其重要）。
                      // 颜色继承气泡文字色，深色（我方）与浅色（对方）气泡都能直接读。
                      <div className="whitespace-pre-wrap break-words text-sm leading-6">
                        {message.content}
                      </div>
                    ) : (
                      <MarkdownRenderer
                        content={message.content}
                        density="compact"
                        controls={CHAT_MARKDOWN_CONTROLS}
                        onContentCopy={(success) => onCopyMarkdown(success, true)}
                        onCodeCopy={(success) => onCopyMarkdown(success)}
                        invert={isMe}
                      />
                    )}

                    {isAdmin && isAi && message.aiErrorDetails ? (
                      <AiErrorDetailsPanel diagnostics={message.aiErrorDetails} />
                    ) : null}

                    {!isEditing ? (
                      <div
                        className={cn(
                          // 触屏没有 hover：手机常显，桌面 hover/focus 才出现，避免气泡长期被按钮挤占。
                          'mt-1.5 flex items-center gap-1 opacity-100 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:focus-within:opacity-100',
                          isMe ? 'justify-end' : 'justify-start',
                        )}
                      >
                        <button
                          type="button"
                          onClick={() => void handleCopy(message.content)}
                          aria-label={`复制第 ${index + 1} 条消息`}
                          title="复制消息"
                          className={cn(
                            'rounded-full p-1.5 transition focus-visible:outline-none focus-visible:ring-2',
                            actionTone,
                          )}
                        >
                          <FiCopy size={12} aria-hidden />
                        </button>
                        {canWrite ? (
                          <>
                            <button
                              type="button"
                              onClick={() => onStartEdit(index, message.content)}
                              aria-label={`编辑第 ${index + 1} 条消息`}
                              title="编辑消息"
                              className={cn(
                                'rounded-full p-1.5 transition focus-visible:outline-none focus-visible:ring-2',
                                actionTone,
                              )}
                            >
                              <FiEdit2 size={12} aria-hidden />
                            </button>
                            <button
                              type="button"
                              onClick={() => onDeleteMessage(index)}
                              aria-label={`删除第 ${index + 1} 条消息`}
                              title="删除消息"
                              className={cn(
                                'rounded-full p-1.5 transition focus-visible:outline-none focus-visible:ring-2',
                                deleteTone,
                              )}
                            >
                              <FiTrash2 size={12} aria-hidden />
                            </button>
                          </>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>
              </motion.div>
            </React.Fragment>
          );
        })}

        {streamingContent ? (
          <motion.div
            initial={prefersReducedMotion ? false : { opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex justify-start"
          >
            <div className="relative order-2 max-w-[92%] sm:max-w-[85%] lg:max-w-[78%] 2xl:max-w-[70%]">
              <div className="mb-1 flex items-center gap-2 text-[10px] text-slate-400">
                <span className="inline-flex items-center gap-1 font-semibold text-slate-500">
                  <FiCpu size={11} aria-hidden /> 智能助手（正在输入…）
                </span>
              </div>
              <div className="relative rounded-2xl border border-slate-200 bg-white p-3.5 text-slate-900 shadow-sm sm:p-4">
                <MarkdownRenderer content={streamingContent} density="compact" />
                <span className="ml-1 inline-block h-4 w-1.5 animate-pulse bg-slate-700 align-middle" aria-hidden />
              </div>
            </div>
          </motion.div>
        ) : null}
      </div>

      {showJump ? (
        <button
          type="button"
          onClick={() => scrollToBottom('smooth')}
          className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-full border border-slate-200 bg-white/95 px-4 py-2 text-xs font-semibold text-slate-700 shadow-sm backdrop-blur transition hover:border-slate-300 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
        >
          有新消息 · 回到底部
        </button>
      ) : null}
    </div>
  );
};

export default TicketConversation;
