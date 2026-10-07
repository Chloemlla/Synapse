import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { FaExclamationTriangle, FaInfoCircle } from 'react-icons/fa';

import { ModalPortal } from '../ModalPortal';
import { cn } from '../../utils/cn';
import { studioSecondaryButtonClassName, studioSurfaceClassName } from '../studioTheme';

/**
 * 全站二次确认的统一入口。
 *
 * 为什么要有它：同一套后台里混着 40 多处 `window.confirm`，问题不只是"样式不一致"：
 *  - 在部分嵌入式 WebView / 桌面壳里 `window.confirm` 会被直接屏蔽并**静默返回 false**，
 *    表现成"点了删除没反应"，还不报错；
 *  - 危险操作（清空全部、批量删除）没有任何视觉分级，和普通询问长得一样；
 *  - 文案只能是一整行，长说明在移动端会被截断。
 *
 * 用法：
 *   const confirm = useConfirm();
 *   if (!(await confirm({ title: '删除该用户？', description: '…', tone: 'danger' }))) return;
 *
 * 未包 `ConfirmDialogProvider` 的渲染分支会自动退回原生 `window.confirm`，
 * 因此调用点不需要关心自己在哪棵树里（`App.tsx` 有多处提前 return 的渲染树）。
 */

export interface ConfirmOptions {
  /** 主标题，同时作为对话框的 aria-labelledby 文本。 */
  title: string;
  /** 补充说明（后果、是否可撤销、影响范围）。 */
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** danger 用于不可撤销的破坏性操作：红色确认按钮 + 警示图标。 */
  tone?: 'default' | 'danger';
}

export type ConfirmFn = (options: ConfirmOptions | string) => Promise<boolean>;

function normalize(input: ConfirmOptions | string): ConfirmOptions {
  return typeof input === 'string' ? { title: input } : input;
}

/** 无 Provider 时的兜底：把标题与说明拼成原生确认框文本。 */
const fallbackConfirm: ConfirmFn = (input) => {
  const { title, description } = normalize(input);
  const text = description ? `${title}\n\n${description}` : title;
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') return Promise.resolve(false);
  return Promise.resolve(window.confirm(text));
};

const ConfirmContext = createContext<ConfirmFn | null>(null);

export const ConfirmDialogProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [options, setOptions] = useState<ConfirmOptions | null>(null);
  // 未决的 resolver 放在 ref 里（而不是 state 更新函数里调用），避免在 StrictMode
  // 的双调用下重复结算。
  const pendingRef = useRef<((value: boolean) => void) | null>(null);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  const confirm = useCallback<ConfirmFn>((input) => {
    return new Promise<boolean>((resolve) => {
      // 上一个请求还没结算就又来一个（例如连点两次）：先把旧的按"取消"了结，
      // 否则它的 Promise 会永远挂着。
      pendingRef.current?.(false);
      pendingRef.current = resolve;
      setOptions(normalize(input));
    });
  }, []);

  const settle = useCallback((value: boolean) => {
    const resolve = pendingRef.current;
    pendingRef.current = null;
    setOptions(null);
    resolve?.(value);
  }, []);

  const open = options !== null;

  useEffect(() => {
    if (!open) return undefined;
    previouslyFocusedRef.current = (document.activeElement as HTMLElement | null) ?? null;
    // 默认焦点落在"取消"上：回车/空格不会误触发破坏性操作。
    const timer = setTimeout(() => cancelButtonRef.current?.focus(), 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        settle(false);
      } else if (event.key === 'Tab') {
        const buttons = dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
        if (!buttons?.length) return;
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (!dialogRef.current?.contains(document.activeElement) ||
            (event.shiftKey && document.activeElement === first) ||
            (!event.shiftKey && document.activeElement === last)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      }
    };
    const containFocus = (event: FocusEvent) => {
      if (!dialogRef.current?.contains(event.target as Node)) cancelButtonRef.current?.focus();
    };
    document.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('focusin', containFocus);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('focusin', containFocus);
      previouslyFocusedRef.current?.focus?.();
    };
  }, [open, settle]);

  const tone = options?.tone === 'danger' ? 'danger' : 'default';

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <ModalPortal>
        <AnimatePresence>
          {options ? (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="fixed inset-0 z-[10000] flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-sm"
              onClick={() => settle(false)}
            >
              <motion.div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="global-confirm-title"
                aria-describedby={options.description ? 'global-confirm-description' : undefined}
                initial={{ opacity: 0, scale: 0.96, y: 12 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.96, y: 12 }}
                transition={{ duration: 0.18 }}
                onClick={(event) => event.stopPropagation()}
                className={cn(studioSurfaceClassName, 'w-full max-w-md p-5')}
              >
                <div className="flex items-start gap-3">
                  <span
                    className={cn(
                      'flex size-10 shrink-0 items-center justify-center rounded-2xl',
                      tone === 'danger' ? 'bg-rose-100 text-rose-600' : 'bg-slate-100 text-slate-500',
                    )}
                    aria-hidden="true"
                  >
                    {tone === 'danger' ? <FaExclamationTriangle className="size-4" /> : <FaInfoCircle className="size-4" />}
                  </span>
                  <div className="min-w-0">
                    <h2 id="global-confirm-title" className="text-base font-semibold text-slate-900">
                      {options.title}
                    </h2>
                    {options.description ? (
                      <p id="global-confirm-description" className="mt-1.5 text-sm leading-6 whitespace-pre-line text-slate-600">
                        {options.description}
                      </p>
                    ) : null}
                  </div>
                </div>

                <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                  <button
                    ref={cancelButtonRef}
                    type="button"
                    onClick={() => settle(false)}
                    className={studioSecondaryButtonClassName}
                  >
                    {options.cancelLabel || '取消'}
                  </button>
                  <button
                    type="button"
                    onClick={() => settle(true)}
                    className={cn(
                      studioSecondaryButtonClassName,
                      tone === 'danger'
                        ? 'border-rose-200 bg-rose-600 text-white hover:bg-rose-700'
                        : 'border-slate-900 bg-slate-900 text-white hover:bg-slate-800',
                    )}
                  >
                    {options.confirmLabel || '确认执行'}
                  </button>
                </div>
              </motion.div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </ModalPortal>
    </ConfirmContext.Provider>
  );
};

export function useConfirm(): ConfirmFn {
  return useContext(ConfirmContext) ?? fallbackConfirm;
}

export default ConfirmDialogProvider;
