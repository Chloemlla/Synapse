import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { FiAlertCircle, FiCheckCircle, FiCpu, FiSearch, FiTerminal, FiX } from 'react-icons/fi';
import { cn } from '../../utils/cn';
import { studioEyebrowClassName } from '../studioTheme';

export type TicketProcessStep =
  | 'audit_start'
  | 'audit_passed'
  | 'ai_start'
  | 'ai_complete'
  | 'saving'
  | 'audit_failed'
  | 'error';

function isFailureStep(step: TicketProcessStep): boolean {
  return step === 'audit_failed' || step === 'error';
}

interface TicketProcessingToastProps {
  step: TicketProcessStep | null;
  onDismiss: () => void;
}

/**
 * 处理进度浮窗（创建/回复期间的 AI 审查与生成状态）。
 *
 * 原实现把同一份「步骤 → 文案」映射在页面里写了两遍（消息区内联一份 + 底部浮窗一份），
 * 两处文案要各改一次。这里收敛成一份，并补上 `aria-live`：读屏用户此前完全不知道
 * 后台正在审查/生成。
 */
const TicketProcessingToast: React.FC<TicketProcessingToastProps> = ({ step, onDismiss }) => (
  <AnimatePresence>
    {step && (
      <motion.div
        role="status"
        aria-live="polite"
        initial={{ opacity: 0, y: 50, scale: 0.9 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 20, scale: 0.9, transition: { duration: 0.2 } }}
        className="pointer-events-none fixed bottom-20 left-1/2 z-[60] w-[90%] max-w-md -translate-x-1/2"
      >
        <div
          className={cn(
            'pointer-events-auto flex items-center gap-4 rounded-2xl border bg-white/95 p-4 shadow-sm backdrop-blur-md transition-colors',
            isFailureStep(step) ? 'border-rose-200' : 'border-slate-200',
          )}
        >
          <div className="flex items-center gap-1">
            {isFailureStep(step) ? (
              <FiAlertCircle className="animate-pulse text-rose-500" size={18} />
            ) : (
              <>
                <span className="h-2 w-2 animate-bounce rounded-full bg-slate-700" />
                <span className="h-2 w-2 animate-bounce rounded-full bg-slate-700 delay-75" />
                <span className="h-2 w-2 animate-bounce rounded-full bg-slate-700 delay-150" />
              </>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className={cn(studioEyebrowClassName, 'mb-0.5', isFailureStep(step) ? 'text-rose-400' : 'text-slate-400')}>
              {isFailureStep(step) ? 'Failed' : 'Processing'}
            </div>
            <div
              className={cn(
                'flex items-center gap-2 truncate text-sm font-semibold',
                isFailureStep(step) ? 'text-rose-700' : 'text-slate-800',
              )}
            >
              {step === 'audit_start' && (
                <><FiSearch className="shrink-0 animate-pulse" /> AI 正在进行安全与合规性审查...</>
              )}
              {step === 'audit_passed' && (
                <><FiCheckCircle className="shrink-0 text-emerald-500" /> 审查通过，正在准备数据...</>
              )}
              {step === 'ai_start' && (
                <><FiCpu className="shrink-0 animate-spin" /> 智能助手正在为您分析并生成方案...</>
              )}
              {step === 'ai_complete' && (
                <><FiCheckCircle className="shrink-0 text-emerald-500" /> 方案生成完毕，正在最后同步...</>
              )}
              {step === 'saving' && (
                <><FiTerminal className="shrink-0 text-slate-500" /> 正在同步至云端存储...</>
              )}
              {step === 'audit_failed' && (
                <><FiX className="shrink-0 text-rose-500" /> 内容未通过 AI 审查</>
              )}
              {step === 'error' && (
                <><FiAlertCircle className="shrink-0 text-rose-500" /> 处理过程中发生错误</>
              )}
            </div>
            {isFailureStep(step) && (
              // F5-31：失败态不再自动消失，这里直接说明下一步该做什么
              <div className="mt-1 text-xs leading-5 text-rose-700/90">
                本次没有提交成功。可在下方会话里查看审查说明，修改内容后重新提交；仍不通过可联系管理员申诉。
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onDismiss}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-500 transition-all hover:bg-slate-50 hover:text-slate-700"
            aria-label="关闭进度浮窗"
          >
            <FiX size={14} />
          </button>
        </div>
      </motion.div>
    )}
  </AnimatePresence>
);

export default TicketProcessingToast;
