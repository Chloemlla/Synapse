import { FaDownload, FaSync, FaTimes } from "react-icons/fa";
import { cn } from "../../utils/cn";
import { studioGhostButtonClassName, studioPanelClassName, studioPillClassName, studioSubPanelClassName } from "../studioTheme";
import {
  PIXEL_ACCOUNT_STATUS_LABELS,
  PIXEL_TERMINAL_TASK_STATUSES,
  PIXEL_TASK_STATUS_LABELS,
  type PixelTaskDetail,
} from "../../types/pixel";

// PIX-05 任务状态（轮询由页面负责）+ PIX-07 单任务导出 + PIX-08 取消排队账号。
type Props = {
  task: PixelTaskDetail | null;
  loading: boolean;
  error: string;
  cancelBusyId: number | null;
  exporting: boolean;
  onRefresh: () => void;
  onCancelAccount: (accountId: number) => void;
  onExport: () => void;
};

function statusTone(status: string): string {
  if (status === "success" || status === "bind_success") return "text-emerald-700";
  if (status === "failed" || status === "bind_failed") return "text-rose-700";
  if (status === "cancelled") return "text-slate-500";
  return "text-slate-700";
}

export default function PixelTaskPanel({ task, loading, error, cancelBusyId, exporting, onRefresh, onCancelAccount, onExport }: Props) {
  const done = task ? task.accounts.filter((account) => ["success", "failed", "cancelled", "bind_success", "bind_failed"].includes(account.status)).length : 0;
  const exportable = task ? task.accounts.some((account) => account.resultLink && account.status !== "cancelled") : false;
  const terminal = task ? PIXEL_TERMINAL_TASK_STATUSES.has(task.status) : false;

  return (
    <section className={studioPanelClassName} aria-labelledby="pixel-task-heading">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">Task</p>
          <h2 id="pixel-task-heading" className="mt-1 text-lg font-semibold text-slate-900">任务进度</h2>
          <p className="mt-1 text-sm text-slate-500">处理中会每 5 秒自动刷新，完成后停止。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={onRefresh} disabled={loading} className={studioGhostButtonClassName}>
            <FaSync className={loading ? "animate-spin" : undefined} /> 刷新
          </button>
          {task && exportable && (
            <button type="button" onClick={onExport} disabled={exporting} className={studioGhostButtonClassName}>
              <FaDownload /> {exporting ? "导出中…" : "导出结果"}
            </button>
          )}
        </div>
      </div>

      {error && <p role="alert" className="mb-3 rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}

      {!task ? (
        <p className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/80 px-4 py-8 text-center text-sm text-slate-500">
          提交任务后，这里会显示每个账号的处理状态。
        </p>
      ) : (
        <div className={studioSubPanelClassName}>
          <div className="flex flex-wrap items-center gap-2">
            <span className={studioPillClassName(task.status === "completed")}>{PIXEL_TASK_STATUS_LABELS[task.status] ?? task.status}</span>
            <span className="text-sm text-slate-700">完成 {done} / {task.totalAccounts}</span>
            {task.cancelledCount > 0 && <span className="text-xs text-slate-500">已取消 {task.cancelledCount}</span>}
            {!terminal && <span className="text-xs text-slate-500">正在自动刷新</span>}
          </div>
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-slate-100">
            <div className="h-full rounded-full bg-slate-900 transition-all" style={{ width: `${task.totalAccounts ? Math.round((done / task.totalAccounts) * 100) : 0}%` }} />
          </div>

          <ul className="mt-3 space-y-2">
            {task.accounts.map((account) => (
              <li key={account.id} className="flex flex-wrap items-start justify-between gap-2 rounded-2xl border border-slate-200 bg-white/80 px-3 py-2">
                <span className="min-w-0">
                  <span className="block truncate text-sm text-slate-700">{account.email || `第 ${account.lineNumber} 行账号`}</span>
                  <span className={cn("mt-0.5 block text-xs", statusTone(account.status))}>
                    {PIXEL_ACCOUNT_STATUS_LABELS[account.status] ?? account.status}
                    {account.queuePosition !== null ? ` · 排队第 ${account.queuePosition} 位` : ""}
                    {account.message ? ` · ${account.message}` : ""}
                  </span>
                  {account.resultLink && (
                    <a href={account.resultLink} target="_blank" rel="noreferrer noopener" className="mt-0.5 block truncate text-xs text-sky-700 underline-offset-2 hover:underline">
                      查看结果链接
                    </a>
                  )}
                </span>
                {account.status === "pending" && (
                  <button type="button" onClick={() => onCancelAccount(account.id)} disabled={cancelBusyId === account.id} className={cn(studioGhostButtonClassName, "text-rose-700 hover:border-rose-200 hover:bg-rose-50")}>
                    <FaTimes /> {cancelBusyId === account.id ? "取消中…" : "取消排队"}
                  </button>
                )}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-slate-500">只有仍在排队的账号可以取消；开始处理后的账号无法撤销。</p>
        </div>
      )}
    </section>
  );
}
