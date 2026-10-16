import React, { useId } from 'react';
import { FaExclamationTriangle, FaCheck, FaTimes } from 'react-icons/fa';
import { StudioModal } from './studioFeedback';
import { studioSecondaryButtonClassName } from './studioTheme';
import { cn } from '../utils/cn';

interface ConfirmModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  type?: 'warning' | 'danger' | 'info';
}

// 弹窗外壳统一由 StudioModal 提供；「取消」在 DOM 里排在确认之前，
// 于是 StudioModal 的初始焦点自然落在取消上（破坏性操作不该被回车直接执行）。
const CONFIRM_TONE = {
  danger: {
    icon: <FaExclamationTriangle className="h-8 w-8 text-rose-500" aria-hidden="true" />,
    button: 'bg-rose-500 hover:bg-rose-600',
  },
  info: {
    icon: <FaExclamationTriangle className="h-8 w-8 text-emerald-500" aria-hidden="true" />,
    button: 'bg-emerald-500 hover:bg-emerald-600',
  },
  warning: {
    icon: <FaExclamationTriangle className="h-8 w-8 text-amber-500" aria-hidden="true" />,
    button: 'bg-amber-500 hover:bg-amber-600',
  },
} as const;

const ConfirmModal: React.FC<ConfirmModalProps> = ({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmText = '确定',
  cancelText = '取消',
  type = 'warning',
}) => {
  const titleId = useId();
  const tone = CONFIRM_TONE[type] ?? CONFIRM_TONE.warning;

  return (
    <StudioModal open={open} onClose={onClose} titleId={titleId} maxWidthClassName="max-w-md">
      <div className="mb-4 flex items-center justify-center">{tone.icon}</div>
      <h2 id={titleId} className="mb-3 text-center text-lg font-semibold text-slate-900">
        {title || '确认操作'}
      </h2>
      <p className="mb-6 whitespace-pre-line text-center leading-relaxed text-slate-700">{message}</p>
      <div className="flex flex-col justify-center gap-3 sm:flex-row">
        <button type="button" onClick={onClose} className={cn(studioSecondaryButtonClassName, 'min-h-11')}>
          <FaTimes className="h-4 w-4" aria-hidden="true" />
          {cancelText}
        </button>
        <button
          type="button"
          onClick={() => {
            onConfirm();
            onClose();
          }}
          className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-2xl px-5 py-3.5 text-sm font-semibold text-white transition ${tone.button}`}
        >
          <FaCheck className="h-4 w-4" aria-hidden="true" />
          {confirmText}
        </button>
      </div>
    </StudioModal>
  );
};

export default ConfirmModal;
