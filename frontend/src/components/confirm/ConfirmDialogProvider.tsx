import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { FaExclamationTriangle, FaInfoCircle } from 'react-icons/fa';

import { ModalPortal } from '../ModalPortal';
import { cn } from '../../utils/cn';
import { studioPrimaryButtonClassName, studioSecondaryButtonClassName } from '../studioTheme';
import { StudioModal, StudioModalDangerButton } from '../studioFeedback';

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
 *
 * 弹窗外壳（层级压过 MobileNav、Escape 关闭、Tab 循环、关闭后恢复焦点）由 StudioModal 提供；
 * 「取消」在 DOM 里排在确认之前，因此打开时焦点自然落在取消上，回车不会误执行破坏性操作。
 */

export interface ConfirmOptions {
  /** 主标题，同时作为对话框的 aria-labelledby 文本。 */
  title: string;
  /** 补充说明（后果、是否可撤销、影响范围）。 */
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** danger 用于不可撤销的破坏性操作：rose 确认按钮 + 警示图标。 */
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

  const tone = options?.tone === 'danger' ? 'danger' : 'default';

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <ModalPortal>
        <StudioModal
          open={options !== null}
          onClose={() => settle(false)}
          labelledBy="global-confirm-title"
          maxWidthClassName="max-w-md"
          closeLabel="取消"
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
                {options?.title}
              </h2>
              {options?.description ? (
                <p id="global-confirm-description" className="mt-1.5 text-sm leading-6 whitespace-pre-line text-slate-600">
                  {options.description}
                </p>
              ) : null}
            </div>
          </div>

          <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <button
              type="button"
              onClick={() => settle(false)}
              className={cn(studioSecondaryButtonClassName, 'min-h-11')}
            >
              {options?.cancelLabel || '取消'}
            </button>
            {tone === 'danger' ? (
              <StudioModalDangerButton onClick={() => settle(true)} className="min-h-11">
                {options?.confirmLabel || '确认执行'}
              </StudioModalDangerButton>
            ) : (
              <button
                type="button"
                onClick={() => settle(true)}
                className={studioPrimaryButtonClassName}
              >
                {options?.confirmLabel || '确认执行'}
              </button>
            )}
          </div>
        </StudioModal>
      </ModalPortal>
    </ConfirmContext.Provider>
  );
};

export function useConfirm(): ConfirmFn {
  return useContext(ConfirmContext) ?? fallbackConfirm;
}

export default ConfirmDialogProvider;
