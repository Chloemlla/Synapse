import React, { useState } from 'react';
import {
  FiCheckCircle, FiCheckSquare, FiLoader, FiRotateCcw, FiUserMinus, FiUserPlus, FiX, FiXCircle,
} from 'react-icons/fi';
import { cn } from '../../utils/cn';
import { studioFieldClassName } from '../studioTheme';
import {
  TICKET_CATEGORY_META,
  TICKET_CATEGORY_ORDER,
  TICKET_PRIORITY_META,
  TICKET_STATUS_META,
} from './ticketConstants';

/** 批量操作只提交这些字段；服务端按白名单逐条写入，未提供的字段保持不变。 */
export interface TicketBulkPatch {
  status?: string;
  priority?: string;
  category?: string;
  assignee?: string;
}

interface TicketBulkBarProps {
  checkedCount: number;
  totalShown: number;
  busy: boolean;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onExit: () => void;
  onBulk: (patch: TicketBulkPatch) => void;
}

const ACTION_BUTTON_CLASS =
  'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition ' +
  'disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 ' +
  'focus-visible:ring-slate-400';

/** 优先级下拉按「低 → 紧急」的直觉顺序排；常量表本身是展示优先级顺序，不能改。 */
const PRIORITY_ORDER = ['low', 'medium', 'high'] as const;

/**
 * 管理端批量操作条。
 *
 * 只有勾选后才由父组件挂载；写操作在 0 选中或 busy 时全部禁用（包括下拉），
 * 避免一次点击被重复提交。选择类动作（全选/清除/退出）不写数据，但在 busy 时也禁用，
 * 因为此时列表可能正在按旧选择刷新。
 */
const TicketBulkBar: React.FC<TicketBulkBarProps> = ({
  checkedCount,
  totalShown,
  busy,
  onSelectAll,
  onClearSelection,
  onExit,
  onBulk,
}) => {
  const [priority, setPriority] = useState('');
  const [category, setCategory] = useState('');

  const noSelection = checkedCount === 0;
  const writeDisabled = noSelection || busy;

  const applyBulk = (patch: TicketBulkPatch) => {
    if (writeDisabled) return;
    onBulk(patch);
  };

  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-slate-200/80 bg-white px-3 py-2"
      role="group"
      aria-label="工单批量操作"
    >
      <span className="shrink-0 text-[11px] font-semibold text-slate-700">
        已选 {checkedCount}
        <span className="font-normal text-slate-400"> / 本页 {totalShown}</span>
      </span>
      {busy ? (
        <span className="inline-flex shrink-0 items-center gap-1 text-[10px] text-slate-400">
          <FiLoader className="animate-spin" size={11} aria-hidden /> 处理中
        </span>
      ) : null}

      <button
        type="button"
        onClick={() => applyBulk({ assignee: 'me' })}
        disabled={writeDisabled}
        aria-label="把选中的工单认领给我"
        className={cn(ACTION_BUTTON_CLASS, 'border-sky-200 bg-sky-50 text-sky-700 hover:bg-sky-100')}
      >
        <FiUserPlus size={11} aria-hidden /> 认领给我
      </button>
      <button
        type="button"
        onClick={() => applyBulk({ assignee: 'none' })}
        disabled={writeDisabled}
        aria-label="取消选中工单的受理人"
        className={cn(ACTION_BUTTON_CLASS, 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900')}
      >
        <FiUserMinus size={11} aria-hidden /> 取消分配
      </button>
      <button
        type="button"
        onClick={() => applyBulk({ status: 'resolved' })}
        disabled={writeDisabled}
        aria-label={`批量标记为${TICKET_STATUS_META.resolved.label}`}
        className={cn(ACTION_BUTTON_CLASS, 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100')}
      >
        <FiCheckCircle size={11} aria-hidden /> 标记{TICKET_STATUS_META.resolved.label}
      </button>
      <button
        type="button"
        onClick={() => applyBulk({ status: 'closed' })}
        disabled={writeDisabled}
        aria-label="批量关闭选中的工单"
        className={cn(ACTION_BUTTON_CLASS, 'border-slate-200 bg-slate-50 text-slate-600 hover:bg-slate-100')}
      >
        <FiXCircle size={11} aria-hidden /> 关闭
      </button>
      <button
        type="button"
        onClick={() => applyBulk({ status: 'open' })}
        disabled={writeDisabled}
        aria-label={`批量重新打开（${TICKET_STATUS_META.open.label}）`}
        className={cn(ACTION_BUTTON_CLASS, 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100')}
      >
        <FiRotateCcw size={11} aria-hidden /> 重新打开
      </button>

      <div className="flex min-w-0 flex-wrap items-center gap-2 sm:ml-auto">
        <select
          aria-label="批量修改优先级"
          value={priority}
          disabled={writeDisabled}
          onChange={(event) => {
            const next = event.target.value;
            if (!next) return;
            // 立即应用后回到占位：批量条反映的是「刚做过的动作」，不是待提交的表单状态。
            applyBulk({ priority: next });
            setPriority('');
          }}
          className={cn(studioFieldClassName, 'h-8 w-auto min-w-0 py-0 text-xs')}
        >
          <option value="">修改优先级…</option>
          {PRIORITY_ORDER.map((key) => (
            <option key={key} value={key}>{TICKET_PRIORITY_META[key].label}</option>
          ))}
        </select>
        <select
          aria-label="批量修改分类"
          value={category}
          disabled={writeDisabled}
          onChange={(event) => {
            const next = event.target.value;
            if (!next) return;
            applyBulk({ category: next });
            setCategory('');
          }}
          className={cn(studioFieldClassName, 'h-8 w-auto min-w-0 py-0 text-xs')}
        >
          <option value="">修改分类…</option>
          {TICKET_CATEGORY_ORDER.map((key) => (
            <option key={key} value={key}>{TICKET_CATEGORY_META[key].label}</option>
          ))}
        </select>

        <button
          type="button"
          onClick={onSelectAll}
          disabled={busy || totalShown === 0}
          className={cn(ACTION_BUTTON_CLASS, 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900')}
        >
          <FiCheckSquare size={11} aria-hidden /> 全选本页
        </button>
        <button
          type="button"
          onClick={onClearSelection}
          disabled={busy || noSelection}
          className={cn(ACTION_BUTTON_CLASS, 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900')}
        >
          <FiX size={11} aria-hidden /> 清除选择
        </button>
        <button
          type="button"
          onClick={onExit}
          disabled={busy}
          className={cn(ACTION_BUTTON_CLASS, 'border-slate-200 bg-slate-50 text-slate-500 hover:bg-slate-100 hover:text-slate-800')}
          title="退出批量模式并清空选择"
        >
          退出
        </button>
      </div>
    </div>
  );
};

export default TicketBulkBar;
