import React, { useEffect, useId, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { FaCheck, FaExclamationTriangle, FaInfoCircle, FaTimes } from 'react-icons/fa';
import { studioModalCardClassName, studioModalOverlayClassName } from './studioTheme';

interface AlertModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  message: string;
  type?: 'warning' | 'danger' | 'info' | 'success';
}

const AlertModal: React.FC<AlertModalProps> = ({ open, onClose, title, message, type = 'warning' }) => {
  const titleId = useId();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const confirmButtonRef = useRef<HTMLButtonElement | null>(null);
  // 打开弹窗前焦点所在的元素：关闭后把焦点还回去，键盘用户不会掉回页面顶部。
  const triggerRef = useRef<HTMLElement | null>(null);
  // 用 ref 持有最新的 onClose，键盘副作用只随 open 重跑，调用方每渲染换新函数时不会反复挪动焦点。
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return undefined;

    // 本组件没有 autoFocus，此刻焦点仍在触发元素上，先记下来再移入弹窗。
    triggerRef.current = (document.activeElement as HTMLElement | null) ?? null;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      // 原生焦点陷阱：Tab / Shift+Tab 在弹窗内循环，不引入第三方依赖。
      const focusables = cardRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    confirmButtonRef.current?.focus();

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      triggerRef.current?.focus?.();
      triggerRef.current = null;
    };
  }, [open]);

  const getIcon = () => {
    switch (type) {
      case 'danger':
        return <FaExclamationTriangle className="w-8 h-8 text-rose-500" aria-hidden="true" />;
      case 'success':
        // 成功用对勾，叉号只用于「出错 / 危险」的语义。
        return <FaCheck className="w-8 h-8 text-emerald-500" aria-hidden="true" />;
      case 'info':
        return <FaInfoCircle className="w-8 h-8 text-sky-500" aria-hidden="true" />;
      default:
        return <FaExclamationTriangle className="w-8 h-8 text-amber-500" aria-hidden="true" />;
    }
  };

  const getButtonClass = () => {
    switch (type) {
      case 'danger':
        return 'bg-rose-500 hover:bg-rose-600';
      case 'success':
        return 'bg-emerald-500 hover:bg-emerald-600';
      case 'info':
        return 'bg-sky-500 hover:bg-sky-600';
      default:
        return 'bg-amber-500 hover:bg-amber-600';
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className={studioModalOverlayClassName}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
      onClick={onClose}
    >
          <motion.div
            ref={cardRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className={`${studioModalCardClassName} max-w-md mx-4 relative max-h-[90vh] overflow-y-auto`}
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ duration: 0.2 }}
        onClick={e => e.stopPropagation()}
      >
            <div className="flex items-center justify-center mb-4">
              {getIcon()}
            </div>
            <h2 id={titleId} className="text-lg font-semibold text-slate-800 mb-3 text-center">
              {title || '温馨提示'}
            </h2>
            <div className="text-slate-700 mb-6 text-center leading-relaxed">
              {message}
        </div>
            <div className="flex justify-center">
              <motion.button
          ref={confirmButtonRef}
          type="button"
          onClick={onClose}
                className={`inline-flex items-center justify-center gap-2 rounded-2xl px-5 py-3.5 text-sm font-semibold text-white transition ${getButtonClass()}`}
                whileTap={{ scale: 0.95 }}
        >
                <FaTimes className="w-4 h-4" aria-hidden="true" />
          知道了
              </motion.button>
      </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default AlertModal; 