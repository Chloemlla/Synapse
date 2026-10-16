import React, { useId } from 'react';
import { FaCheck, FaExclamationTriangle, FaInfoCircle, FaTimes } from 'react-icons/fa';
import { StudioModal } from './studioFeedback';

interface AlertModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  message: string;
  type?: 'warning' | 'danger' | 'info' | 'success';
}

// 弹窗外壳（覆盖层层级、Escape、Tab 循环、关闭后恢复焦点）统一由 StudioModal 提供，
// 这里只保留「单按钮告知」的内容与语义色。
const ALERT_TONE = {
  danger: {
    icon: <FaExclamationTriangle className="h-8 w-8 text-rose-500" aria-hidden="true" />,
    button: 'bg-rose-500 hover:bg-rose-600',
  },
  success: {
    // 成功用对勾，叉号只用于「出错 / 危险」的语义。
    icon: <FaCheck className="h-8 w-8 text-emerald-500" aria-hidden="true" />,
    button: 'bg-emerald-500 hover:bg-emerald-600',
  },
  info: {
    icon: <FaInfoCircle className="h-8 w-8 text-sky-500" aria-hidden="true" />,
    button: 'bg-sky-500 hover:bg-sky-600',
  },
  warning: {
    icon: <FaExclamationTriangle className="h-8 w-8 text-amber-500" aria-hidden="true" />,
    button: 'bg-amber-500 hover:bg-amber-600',
  },
} as const;

const AlertModal: React.FC<AlertModalProps> = ({ open, onClose, title, message, type = 'warning' }) => {
  const titleId = useId();
  const tone = ALERT_TONE[type] ?? ALERT_TONE.warning;

  return (
    <StudioModal open={open} onClose={onClose} titleId={titleId} maxWidthClassName="max-w-md">
      <div className="mb-4 flex items-center justify-center">{tone.icon}</div>
      <h2 id={titleId} className="mb-3 text-center text-lg font-semibold text-slate-900">
        {title || '温馨提示'}
      </h2>
      <p className="mb-6 whitespace-pre-line text-center leading-relaxed text-slate-700">{message}</p>
      <div className="flex justify-center">
        <button
          type="button"
          onClick={onClose}
          className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-2xl px-5 py-3.5 text-sm font-semibold text-white transition ${tone.button}`}
        >
          <FaTimes className="h-4 w-4" aria-hidden="true" />
          知道了
        </button>
      </div>
    </StudioModal>
  );
};

export default AlertModal;
