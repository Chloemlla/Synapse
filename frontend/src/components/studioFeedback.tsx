import React, { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { FaExclamationTriangle, FaSync } from 'react-icons/fa';
import { cn } from '../utils/cn';
import { useReducedMotion } from '../hooks/useReducedMotion';
import { UnifiedLoadingSpinner } from './LoadingSpinner';
import {
  studioGhostButtonClassName,
  studioModalCardClassName,
  studioModalCloseButtonClassName,
  studioModalOverlayClassName,
  studioPrimaryButtonClassName,
} from './studioTheme';

/**
 * 共享状态/弹窗原语。
 *
 * 视觉基准：frontend/src/components/ResourceStoreList.tsx（四态与弹窗的实参）。
 * 一切结构串都取自 studioTheme 的 studio* constant，本文件不再手写新的 Tailwind 串
 * （唯一例外是四态区块的布局 class，它们与 ResourceStoreList 逐字一致，改动时两边同步）。
 *
 * 对应清单：docs/audit/audit-2026-10-16-frontend-design-language.md
 *   FD-056 错误被吞（不允许 console-only）
 *   FD-057 局部 loading
 *   FD-059 空态给出下一步
 *   FD-060 错误态样式统一
 *   FD-061 成功态 role="status" + aria-live
 *   FD-062 列表分页
 *   FD-070 弹窗 Escape / focus trap / 恢复焦点
 */

// ---------------------------------------------------------------------------
// 四态
// ---------------------------------------------------------------------------

/** 错误块（内联）：与 ResourceStoreList 的 error 块同款。 */
export const StudioErrorNote: React.FC<{
  children: ReactNode;
  className?: string;
}> = ({ children, className }) => (
  <div
    role="alert"
    className={cn(
      'rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700',
      className,
    )}
  >
    {children}
  </div>
);

/** 成功块（内联）：与 ResourceStoreList 的 success 块同款。 */
export const StudioSuccessNote: React.FC<{
  children: ReactNode;
  className?: string;
}> = ({ children, className }) => (
  <div
    role="status"
    aria-live="polite"
    className={cn(
      'rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700',
      className,
    )}
  >
    {children}
  </div>
);

/**
 * 错误态（区域级）：带重试入口。**请求失败必须用它，不要渲染成空态**
 * ——把接口失败画成「什么都没有」会让用户以为数据真的不存在，从而放弃重试。
 */
export const StudioErrorState: React.FC<{
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}> = ({ message, onRetry, retryLabel = '重试', className }) => (
  <div
    role="alert"
    className={cn(
      'flex flex-col items-center gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-6 py-10 text-center text-sm text-rose-700',
      className,
    )}
  >
    <span className="flex items-center gap-2">
      <FaExclamationTriangle className="shrink-0" aria-hidden />
      {message}
    </span>
    {onRetry ? (
      <button type="button" onClick={onRetry} className={studioGhostButtonClassName}>
        <FaSync aria-hidden />
        {retryLabel}
      </button>
    ) : null}
  </div>
);

/** 空态（区域级）：必须给下一步动作，不要只写「暂无数据」。 */
export const StudioEmptyState: React.FC<{
  message: ReactNode;
  action?: ReactNode;
  className?: string;
}> = ({ message, action, className }) => (
  <div
    className={cn(
      'rounded-2xl border border-dashed border-slate-200 bg-slate-50/80 px-6 py-14 text-center text-slate-400',
      className,
    )}
  >
    <div>{message}</div>
    {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
  </div>
);

/** 局部 loading（面板/列表级）：避免切 tab 时整页白屏。 */
export const StudioLoadingState: React.FC<{
  text?: string;
  minHeightClassName?: string;
  className?: string;
}> = ({ text = '加载中...', minHeightClassName = 'min-h-[380px]', className }) => (
  <div className={cn('flex items-center justify-center', minHeightClassName, className)}>
    <UnifiedLoadingSpinner size="lg" text={text} />
  </div>
);

// ---------------------------------------------------------------------------
// 分页
// ---------------------------------------------------------------------------

/** 列表分页：与 ResourceStoreList 的 nav 同款（aria-label + ghost 按钮）。 */
export const StudioPager: React.FC<{
  page: number;
  pageSize: number;
  total: number;
  loading?: boolean;
  onPageChange: (page: number) => void;
  label?: string;
  className?: string;
}> = ({ page, pageSize, total, loading = false, onPageChange, label = '分页', className }) => {
  const pageCount = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  if (total <= pageSize) return null;

  return (
    <nav
      aria-label={label}
      className={cn('mt-4 flex flex-wrap items-center justify-center gap-4 text-sm text-slate-600', className)}
    >
      <button
        type="button"
        disabled={loading || page <= 1}
        onClick={() => onPageChange(page - 1)}
        className={studioGhostButtonClassName}
      >
        上一页
      </button>
      <span>
        第 {page} / {pageCount} 页 · 共 {total} 项
      </span>
      <button
        type="button"
        disabled={loading || page * pageSize >= total}
        onClick={() => onPageChange(page + 1)}
        className={studioGhostButtonClassName}
      >
        下一页
      </button>
    </nav>
  );
};

// ---------------------------------------------------------------------------
// 弹窗
// ---------------------------------------------------------------------------

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * 统一弹窗：studioModalOverlayClassName + studioModalCardClassName，
 * 内置 Escape 关闭、Tab 循环（focus trap）、关闭后恢复原焦点（对照 ResourceStoreList L296-330）。
 * 层级由 token 保证压过 MobileNav（z-[9998]）。
 */
export const StudioModal: React.FC<{
  open: boolean;
  onClose: () => void;
  titleId?: string;
  labelledBy?: string;
  children: ReactNode;
  footer?: ReactNode;
  maxWidthClassName?: string;
  closeLabel?: string;
  className?: string;
}> = ({
  open,
  onClose,
  titleId,
  labelledBy,
  children,
  footer,
  maxWidthClassName = 'max-w-lg',
  closeLabel = '关闭',
  className,
}) => {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (!open) return undefined;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const timer = window.setTimeout(() => {
      const first = cardRef.current?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (first ?? cardRef.current)?.focus();
    }, 0);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('keydown', handleKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [open, onClose]);

  const handleTrapKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const focusables = event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  const labelledByProps = labelledBy
    ? { 'aria-labelledby': labelledBy }
    : titleId
      ? { 'aria-labelledby': titleId }
      : {};

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className={studioModalOverlayClassName}
          onClick={onClose}
        >
          <motion.div
            ref={cardRef}
            role="dialog"
            aria-modal="true"
            {...labelledByProps}
            tabIndex={-1}
            onKeyDown={handleTrapKeyDown}
            initial={reducedMotion ? false : { opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.95, y: 20 }}
            className={cn(
              studioModalCardClassName,
              maxWidthClassName,
              'max-h-[90vh] overflow-y-auto overscroll-contain',
              className,
            )}
            onClick={(event) => event.stopPropagation()}
          >
            {children}
            {footer ? <div className="mt-6 flex flex-col gap-2 sm:flex-row">{footer}</div> : null}
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
};

/** 弹窗头部：标题 + 图标 + 关闭按钮（关闭按钮复用 studioModalCloseButtonClassName）。 */
export const StudioModalHeader: React.FC<{
  title: string;
  titleId?: string;
  description?: ReactNode;
  icon?: ReactNode;
  iconClassName?: string;
  onClose: () => void;
  closeLabel?: string;
}> = ({
  title,
  titleId,
  description,
  icon,
  iconClassName = 'bg-slate-900 text-white',
  onClose,
  closeLabel = '关闭',
}) => (
  <div className="flex items-start justify-between gap-4">
    <div className="flex min-w-0 items-start gap-3">
      {icon ? (
        <div
          className={cn(
            'flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl',
            iconClassName,
          )}
          aria-hidden
        >
          {icon}
        </div>
      ) : null}
      <div className="min-w-0">
        <h3 id={titleId} className="text-xl font-semibold text-slate-900">
          {title}
        </h3>
        {description ? (
          <p className="mt-2 text-sm leading-7 text-slate-500">{description}</p>
        ) : null}
      </div>
    </div>
    <button
      type="button"
      onClick={onClose}
      aria-label={closeLabel}
      className={studioModalCloseButtonClassName}
    >
      <svg viewBox="0 0 20 20" aria-hidden className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M5 5l10 10M15 5L5 15" strokeLinecap="round" />
      </svg>
    </button>
  </div>
);

/** 弹窗底部危险操作按钮（rose 语义色，与 studioDangerButtonClassName 同族）。 */
export const StudioModalDangerButton: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement>
> = ({ className, children, ...props }) => (
  <button
    type="button"
    {...props}
    className={cn(
      'inline-flex items-center justify-center gap-2 rounded-2xl border-2 border-rose-200 bg-rose-50/80 px-4 py-3.5 text-sm font-semibold text-rose-700 transition hover:border-rose-300 hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-300 focus-visible:ring-offset-2',
      className,
    )}
  >
    {children}
  </button>
);

/** 弹窗确认主按钮（复用 studioPrimaryButtonClassName）。 */
export const StudioModalPrimaryButton: React.FC<
  React.ButtonHTMLAttributes<HTMLButtonElement>
> = ({ className, children, ...props }) => (
  <button type="button" {...props} className={cn(studioPrimaryButtonClassName, className)}>
    {children}
  </button>
);
