import { useMemo, useState } from "react";
import { FaDownload, FaSearch } from "react-icons/fa";
import { cn } from "../../utils/cn";
import { studioFieldClassName, studioGhostButtonClassName, studioPanelClassName, studioPillClassName, studioSubPanelClassName } from "../studioTheme";
import { PIXEL_TASK_STATUS_LABELS, type PixelTaskSummary } from "../../types/pixel";

// PIX-06 历史任务：按卡密 + 可选账号关键字查询，每页 10 条；导出「按卡密全部任务」。
type Props = {
  history: PixelTaskSummary[];
  loading: boolean;
  error: string;
  empty: boolean;
  query: string;
  onQueryChange: (value: string) => void;
  onSearch: () => void;
  onOpenTask: (taskId: string) => void;
  onExportAll: () => void;
  exporting: boolean;
  canQuery: boolean;
};

const PAGE_SIZE = 10;

export default function PixelHistoryPanel({
  history,
  loading,
  error,
  empty,
  query,
  onQueryChange,
  onSearch,
  onOpenTask,
  onExportAll,
  exporting,
  canQuery,
}: Props) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(history.length / PAGE_SIZE));
  const current = Math.min(page, pageCount - 1);
  const rows = useMemo(() => history.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE), [current, history]);
  const exportable = history.some((item) => item.success > 0 || item.status === "completed");

  return (
    <section className={studioPanelClassName} aria-labelledby="pixel-history-heading">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">History</p>
          <h2 id="pixel-history-heading" className="mt-1 text-lg font-semibold text-slate-900">历史任务</h2>
          <p className="mt-1 text-sm text-slate-500">按卡密查询你提交过的任务；可以按账号关键字缩小范围。</p>
        </div>
        {canQuery && (
          <button type="button" onClick={onExportAll} disabled={exporting || !exportable} className={studioGhostButtonClassName}>
            <FaDownload /> {exporting ? "导出中…" : "导出全部结果"}
          </button>
        )}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          className={studioFieldClassName}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") { setPage(0); onSearch(); } }}
          placeholder="账号关键字（可选）"
          aria-label="账号关键字"
        />
        <button type="button" onClick={() => { setPage(0); onSearch(); }} disabled={loading || !canQuery} className={studioGhostButtonClassName}>
          <FaSearch /> 查询
        </button>
      </div>
      {!canQuery && <p className="mt-2 text-xs text-slate-500">请先验证卡密，验证通过后即可按卡密查询历史。</p>}

      {error && <p role="alert" className="mt-3 rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
      {loading && <p role="status" className="mt-3 text-sm text-slate-500">正在查询…</p>}

      {!loading && empty && (
        <p className="mt-3 rounded-2xl border border-dashed border-slate-200 bg-slate-50/80 px-4 py-6 text-center text-sm text-slate-500">
          没有查到任务{query ? "，可以换个关键字试试" : "。提交过的任务会显示在这里"}。
        </p>
      )}

      {rows.length > 0 && (
        <div className={cn(studioSubPanelClassName, "mt-3")}>
          <ul className="space-y-2">
            {rows.map((item) => (
              <li key={item.taskId} className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-slate-200 bg-white/80 px-3 py-2">
                <button type="button" onClick={() => onOpenTask(item.taskId)} className="min-w-0 flex-1 text-left">
                  <span className="block text-sm font-semibold text-slate-800">任务 {item.taskId.slice(0, 10)}…</span>
                  <span className="mt-1 block text-xs text-slate-500">
                    共 {item.totalAccounts} 个账号 · 成功 {item.success} · 未成功 {item.failed} · 已取消 {item.cancelled} · {new Date(item.createdAt).toLocaleString("zh-CN")}
                  </span>
                </button>
                <span className={studioPillClassName(item.status === "completed")}>{PIXEL_TASK_STATUS_LABELS[item.status] ?? item.status}</span>
              </li>
            ))}
          </ul>
          {pageCount > 1 && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-slate-600">
              <span>第 {current + 1} / {pageCount} 页</span>
              <div className="flex gap-2">
                <button type="button" onClick={() => setPage(0)} disabled={current === 0} className={studioGhostButtonClassName}>首页</button>
                <button type="button" onClick={() => setPage((value) => Math.max(0, value - 1))} disabled={current === 0} className={studioGhostButtonClassName}>上一页</button>
                <button type="button" onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))} disabled={current >= pageCount - 1} className={studioGhostButtonClassName}>下一页</button>
                <button type="button" onClick={() => setPage(pageCount - 1)} disabled={current >= pageCount - 1} className={studioGhostButtonClassName}>末页</button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
