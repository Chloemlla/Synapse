import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FiEye, FiEyeOff, FiLock, FiSend, FiZap } from 'react-icons/fi';
import { cn } from '../../utils/cn';
import { studioEyebrowClassName, studioPrimaryButtonClassName } from '../studioTheme';
import { MAX_TICKET_REPLY_LEN, QUICK_REPLIES } from './ticketConstants';

interface TicketComposerProps {
  /** 切换工单时用于区分草稿；空字符串表示不持久化草稿。 */
  draftKey: string;
  disabled?: boolean;
  disabledReason?: string;
  isAdmin: boolean;
  /** 是否显示「内部备注」开关（仅 superadmin）。 */
  canWriteInternal: boolean;
  placeholder?: string;
  /** 返回 true 表示发送成功（成功后才清空草稿）。 */
  onSend: (content: string, internal: boolean) => Promise<boolean>;
}

const DRAFT_PREFIX = 'synapse:ticket-draft:';
const AUTO_GROW_MAX_PX = 220;

function readDraft(key: string): { content: string; internal: boolean } {
  if (!key || typeof window === 'undefined') return { content: '', internal: false };
  try {
    const raw = window.localStorage.getItem(`${DRAFT_PREFIX}${key}`);
    if (!raw) return { content: '', internal: false };
    const parsed = JSON.parse(raw) as { content?: unknown; internal?: unknown };
    return {
      content: typeof parsed.content === 'string' ? parsed.content : '',
      internal: parsed.internal === true,
    };
  } catch {
    return { content: '', internal: false };
  }
}

function writeDraft(key: string, content: string, internal: boolean): void {
  if (!key || typeof window === 'undefined') return;
  try {
    if (!content.trim()) {
      window.localStorage.removeItem(`${DRAFT_PREFIX}${key}`);
      return;
    }
    window.localStorage.setItem(`${DRAFT_PREFIX}${key}`, JSON.stringify({ content, internal }));
  } catch {
    /* 隐私模式下 localStorage 不可用：草稿是尽力而为，不应影响发送 */
  }
}

/**
 * 回复输入区。
 *
 * 关键改动（原实现是单行 `<input>`）：
 *  - 自适应高度 textarea：新行不再提交，`Ctrl/Cmd + Enter` 才发送；
 *  - 按工单保存草稿（localStorage）：切走再回来不丢长回复；
 *  - 客服快捷回复一键插入；superadmin 可切「内部备注」；
 *  - 字数计数与超长提示。
 */
const TicketComposer: React.FC<TicketComposerProps> = ({
  draftKey,
  disabled = false,
  disabledReason,
  isAdmin,
  canWriteInternal,
  placeholder,
  onSend,
}) => {
  const [content, setContent] = useState('');
  const [internal, setInternal] = useState(false);
  const [sending, setSending] = useState(false);
  const [showQuick, setShowQuick] = useState(false);
  const [restoredDraft, setRestoredDraft] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // 切换工单：载入该工单的草稿（没有则清空），并聚焦输入框
  useEffect(() => {
    const draft = readDraft(draftKey);
    setContent(draft.content);
    setInternal(draft.internal && canWriteInternal);
    setRestoredDraft(Boolean(draft.content));
    setShowQuick(false);
    if (draft.content) {
      window.setTimeout(() => resize(), 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey, canWriteInternal]);

  const resize = useCallback(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, AUTO_GROW_MAX_PX)}px`;
  }, []);

  // 草稿落盘（轻量防抖）
  useEffect(() => {
    if (!draftKey) return undefined;
    const timer = window.setTimeout(() => writeDraft(draftKey, content, internal), 400);
    return () => window.clearTimeout(timer);
  }, [content, internal, draftKey]);

  const submit = useCallback(async () => {
    const trimmed = content.trim();
    if (!trimmed || sending || disabled) return;
    if (trimmed.length > MAX_TICKET_REPLY_LEN) return;
    setSending(true);
    try {
      const ok = await onSend(trimmed, internal && canWriteInternal);
      if (ok) {
        setContent('');
        setRestoredDraft(false);
        writeDraft(draftKey, '', false);
        if (textareaRef.current) textareaRef.current.style.height = 'auto';
      }
    } finally {
      setSending(false);
    }
  }, [canWriteInternal, content, disabled, draftKey, internal, onSend, sending]);

  const insertQuickReply = (text: string) => {
    setContent((current) => (current.trim() ? `${current.replace(/\s+$/, '')}\n\n${text}` : text));
    setShowQuick(false);
    window.setTimeout(() => {
      resize();
      textareaRef.current?.focus();
    }, 0);
  };

  const overLength = content.trim().length > MAX_TICKET_REPLY_LEN;

  return (
    <div className="border-t border-slate-200/80 bg-slate-50/40 p-3 sm:p-4">
      {restoredDraft && content.trim() ? (
        <div className={cn(studioEyebrowClassName, 'mb-2 flex items-center justify-between text-[10px] text-slate-400')}>
          <span>已恢复上次未发送的草稿</span>
          <button
            type="button"
            onClick={() => {
              setContent('');
              setRestoredDraft(false);
              writeDraft(draftKey, '', false);
            }}
            className="font-semibold text-slate-500 underline decoration-slate-300 underline-offset-2 hover:text-slate-800"
          >
            丢弃草稿
          </button>
        </div>
      ) : null}

      {showQuick && (
        <div className="mb-2 max-h-56 overflow-y-auto rounded-2xl border border-slate-200 bg-white p-1.5 shadow-sm hover-scrollbar">
          {QUICK_REPLIES.map((reply) => (
            <button
              key={reply.label}
              type="button"
              onClick={() => insertQuickReply(reply.content)}
              className="block w-full rounded-xl px-3 py-2 text-left text-xs text-slate-700 transition hover:bg-slate-50"
            >
              <span className="font-semibold text-slate-900">{reply.label}</span>
              <span className="mt-0.5 block truncate text-[11px] text-slate-500">{reply.content}</span>
            </button>
          ))}
        </div>
      )}

      {disabled ? (
        <p className="py-2 text-center text-xs font-medium text-slate-500 sm:text-sm">{disabledReason}</p>
      ) : (
        <>
          {internal && (
            <div className="mb-2 flex items-center gap-2 rounded-xl border border-violet-200 bg-violet-50 px-3 py-2 text-[11px] font-medium text-violet-700">
              <FiLock size={12} /> 内部备注：只有客服可见，用户端不会收到这条内容
            </div>
          )}
          <div
            className={cn(
              'rounded-2xl border bg-white p-1.5 shadow-[0_6px_18px_rgba(15,23,42,0.04)] transition',
              internal ? 'border-violet-300' : 'border-slate-200 focus-within:border-slate-300',
            )}
          >
            <textarea
              ref={textareaRef}
              rows={1}
              value={content}
              maxLength={MAX_TICKET_REPLY_LEN + 200}
              disabled={sending}
              aria-label={internal ? '内部备注内容' : '回复内容'}
              placeholder={placeholder || (isAdmin ? '在此输入回复内容…（Ctrl/⌘ + Enter 发送）' : '补充更多详情…（Ctrl/⌘ + Enter 发送）')}
              onChange={(event) => {
                setContent(event.target.value);
                resize();
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  void submit();
                }
              }}
              className="block w-full resize-none bg-transparent px-3 py-2 text-xs leading-6 outline-none placeholder:text-slate-400 sm:text-sm hover-scrollbar"
              style={{ maxHeight: AUTO_GROW_MAX_PX }}
            />
            <div className="flex items-center gap-1.5 px-1.5 pb-0.5 pt-1">
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => setShowQuick((current) => !current)}
                  aria-expanded={showQuick}
                  className="inline-flex items-center gap-1 rounded-full border border-slate-200 px-2.5 py-1 text-[11px] font-semibold text-slate-600 transition hover:border-slate-300 hover:text-slate-900"
                >
                  <FiZap size={11} /> 快捷回复
                </button>
              )}
              {canWriteInternal && (
                <button
                  type="button"
                  onClick={() => setInternal((current) => !current)}
                  aria-pressed={internal}
                  title="内部备注只有客服可见"
                  className={cn(
                    'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition',
                    internal
                      ? 'border-violet-300 bg-violet-50 text-violet-700'
                      : 'border-slate-200 text-slate-600 hover:border-slate-300 hover:text-slate-900',
                  )}
                >
                  {internal ? <FiEyeOff size={11} /> : <FiEye size={11} />} 内部备注
                </button>
              )}
              {content.trim() ? (
                <span
                  className={cn(
                    'ml-auto text-[10px] font-medium',
                    overLength ? 'text-rose-500' : 'text-slate-400',
                  )}
                >
                  {content.trim().length}/{MAX_TICKET_REPLY_LEN}
                </span>
              ) : null}
              <button
                type="button"
                onClick={() => void submit()}
                disabled={!content.trim() || sending || overLength}
                aria-label="发送回复"
                className={cn(
                  studioPrimaryButtonClassName,
                  'ml-auto h-9 w-9 shrink-0 p-0 sm:h-10 sm:w-10 disabled:opacity-50',
                  content.trim() && !overLength ? '' : 'ml-auto',
                )}
              >
                <FiSend size={14} />
              </button>
            </div>
          </div>
          {overLength ? (
            <p className="mt-1.5 pr-1 text-right text-[11px] font-medium text-rose-500">
              已超过 {MAX_TICKET_REPLY_LEN} 字，请缩短后再发送
            </p>
          ) : null}
        </>
      )}
    </div>
  );
};

export default TicketComposer;
