import React, { useEffect, useId, useRef, useState } from 'react';
import { FaEdit, FaCheck, FaTimes, FaCopy, FaExpand, FaCompress } from 'react-icons/fa';
import {
  studioFieldClassName,
  studioModalCloseButtonClassName,
  studioPrimaryButtonClassName,
  studioSecondaryButtonClassName,
  studioTextareaClassName,
} from './studioTheme';
import { StudioErrorNote, StudioModal } from './studioFeedback';
import { cn } from '../utils/cn';

interface PromptModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: (value: string) => void;
  title?: string;
  message?: string;
  placeholder?: string;
  defaultValue?: string;
  confirmText?: string;
  cancelText?: string;
  multiline?: boolean;
  maxLength?: number;
  codeEditor?: boolean;
  language?: string;
}

const MONO_FONT = 'ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace';

const PromptModal: React.FC<PromptModalProps> = ({
  open,
  onClose,
  onConfirm,
  title,
  message,
  placeholder = '请输入内容',
  defaultValue = '',
  confirmText = '确定',
  cancelText = '取消',
  multiline = false,
  maxLength,
  codeEditor = false,
}) => {
  const [value, setValue] = useState(defaultValue);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'failed'>('idle');

  const titleId = useId();
  const fieldRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  // 屏幕尺寸只用于一件事：移动端输入框用 16px 字号，否则 iOS Safari 聚焦时会自动放大页面。
  useEffect(() => {
    const checkSize = () => setIsMobile(window.innerWidth <= 768);
    checkSize();
    window.addEventListener('resize', checkSize);
    return () => window.removeEventListener('resize', checkSize);
  }, []);

  useEffect(() => {
    if (open) {
      setValue(defaultValue);
      setCopyStatus('idle');
      setIsExpanded(false);
    }
  }, [open, defaultValue]);

  // 初始焦点落在输入框：StudioModal 打开时把焦点交给卡内第一个可聚焦元素（头部按钮），
  // 而这个弹窗打开就是为了打字，移动端也靠这次聚焦唤起键盘。StudioModal 是子组件、副作用先执行，
  // 它的 0ms 聚焦先入队，本组件的随后执行，最终焦点停在输入框。
  useEffect(() => {
    if (!open) return undefined;
    const timer = window.setTimeout(() => fieldRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  // 移动端锁住页面滚动，避免手势穿透到弹窗背后的内容（StudioModal 只约束卡内滚动）。
  useEffect(() => {
    if (!open || !isMobile) return undefined;
    const previous = {
      overflow: document.body.style.overflow,
      position: document.body.style.position,
      width: document.body.style.width,
    };
    document.body.style.overflow = 'hidden';
    document.body.style.position = 'fixed';
    document.body.style.width = '100%';
    return () => {
      document.body.style.overflow = previous.overflow;
      document.body.style.position = previous.position;
      document.body.style.width = previous.width;
    };
  }, [open, isMobile]);

  const handleConfirm = () => {
    if (value.trim()) {
      onConfirm(value); // 不做 trim，保留换行与缩进
      onClose();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !multiline && !codeEditor) {
      e.preventDefault();
      handleConfirm();
    }
  };

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopyStatus('copied');
    } catch {
      // 剪贴板 API 在非安全上下文 / 部分桌面壳里会被拒；退回 execCommand，仍失败则给出可见提示。
      const textArea = document.createElement('textarea');
      textArea.value = value;
      document.body.appendChild(textArea);
      textArea.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(textArea);
      setCopyStatus(ok ? 'copied' : 'failed');
    }
  };

  const fieldTextStyle = {
    fontSize: isMobile ? '16px' : '14px',
    lineHeight: '1.5',
    fontFamily: MONO_FONT,
    WebkitAppearance: 'none' as const,
  };

  return (
    <StudioModal
      open={open}
      onClose={onClose}
      titleId={titleId}
      maxWidthClassName={isExpanded ? 'max-w-5xl' : 'max-w-2xl'}
      className={isExpanded ? 'flex h-[85vh] flex-col' : undefined}
    >
      <div className="mb-4 flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <FaEdit className="h-5 w-5 shrink-0 text-slate-500" aria-hidden="true" />
          <h2 id={titleId} className="truncate text-lg font-semibold text-slate-900">
            {title || '输入内容'}
          </h2>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {codeEditor ? (
            <>
              <button
                type="button"
                onClick={() => void copyToClipboard()}
                aria-label="复制内容"
                className={cn(studioModalCloseButtonClassName, 'h-11 w-11')}
              >
                <FaCopy className="h-4 w-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => setIsExpanded((previous) => !previous)}
                aria-label={isExpanded ? '收起输入框' : '放大输入框'}
                className={cn(studioModalCloseButtonClassName, 'h-11 w-11')}
              >
                {isExpanded ? (
                  <FaCompress className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <FaExpand className="h-4 w-4" aria-hidden="true" />
                )}
              </button>
            </>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className={cn(studioModalCloseButtonClassName, 'h-11 w-11')}
          >
            <FaTimes className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>

      {message ? <p className="mb-4 leading-relaxed text-slate-700">{message}</p> : null}

      {copyStatus === 'copied' ? (
        <p role="status" aria-live="polite" className="mb-2 text-xs text-slate-500">
          内容已复制
        </p>
      ) : null}
      {copyStatus === 'failed' ? (
        <StudioErrorNote className="mb-2">复制失败，请手动选中内容后复制。</StudioErrorNote>
      ) : null}

      <div className={cn('mb-6', isExpanded && 'flex min-h-0 flex-1 flex-col')}>
        {codeEditor || multiline ? (
          <textarea
            ref={(element) => {
              fieldRef.current = element;
            }}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            maxLength={maxLength}
            rows={codeEditor ? undefined : 4}
            wrap={codeEditor ? 'off' : undefined}
            spellCheck={false}
            className={cn(
              studioTextareaClassName,
              'font-mono',
              codeEditor ? (isExpanded ? 'min-h-0 flex-1' : 'max-h-96 min-h-[200px]') : 'min-h-[120px]',
            )}
            style={fieldTextStyle}
          />
        ) : (
          <input
            ref={(element) => {
              fieldRef.current = element;
            }}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            maxLength={maxLength}
            className={cn(studioFieldClassName, 'font-mono')}
            style={fieldTextStyle}
          />
        )}

        {maxLength ? (
          <div className="mt-2 text-right text-xs text-slate-400">
            {value.length}/{maxLength}
          </div>
        ) : null}
      </div>

      <div className="flex justify-center gap-2 sm:gap-3">
        <button type="button" onClick={onClose} className={cn(studioSecondaryButtonClassName, 'min-h-11')}>
          <FaTimes className="h-4 w-4" aria-hidden="true" />
          {cancelText}
        </button>
        <button
          type="button"
          onClick={handleConfirm}
          disabled={!value.trim()}
          className={studioPrimaryButtonClassName}
        >
          <FaCheck className="h-4 w-4" aria-hidden="true" />
          {confirmText}
        </button>
      </div>
    </StudioModal>
  );
};

export default PromptModal;
