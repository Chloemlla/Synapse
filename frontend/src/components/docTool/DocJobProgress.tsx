// 当前批量任务的进度与结果：进度条、成功/跳过/失败计数、当前阶段、
// 逐文件状态行、失败明细折叠区，以及「只重试失败项 / 报告 / 打包下载」这组动作。

import React from 'react';
import type { IconType } from 'react-icons';
import {
  FaCheckCircle,
  FaCopy,
  FaDownload,
  FaFileArchive,
  FaMinusCircle,
  FaRedo,
  FaStop,
  FaTimesCircle,
} from 'react-icons/fa';
import type { DocItemStatus, DocJobItem, DocJobRecord, DocJobStatus } from '../../api/docTool';
import { fmtBytes } from '../admin/media-tool/ui';
import {
  studioBadgeClassName,
  studioDangerButtonClassName,
  studioSecondaryButtonClassName,
  studioSurfaceClassName,
} from '../studioTheme';

const STATUS_VIEW: Record<DocJobStatus, { label: string; tone: 'blue' | 'yellow' | 'green' | 'slate' | 'rose' }> = {
  queued: { label: '排队中', tone: 'slate' },
  running: { label: '转换中', tone: 'blue' },
  succeeded: { label: '已完成', tone: 'green' },
  partial: { label: '部分完成', tone: 'yellow' },
  failed: { label: '失败', tone: 'rose' },
  cancelled: { label: '已取消', tone: 'slate' },
};

const ITEM_VIEW: Record<DocItemStatus, { label: string; Icon: IconType; className: string }> = {
  ok: { label: '成功', Icon: FaCheckCircle, className: 'text-emerald-500' },
  skipped: { label: '跳过', Icon: FaMinusCircle, className: 'text-amber-500' },
  failed: { label: '失败', Icon: FaTimesCircle, className: 'text-rose-500' },
};

const baseName = (rel: string): string => rel.replace(/\\/g, '/').split('/').pop() || rel;

const progressTone = (status: DocJobStatus): string => {
  if (status === 'failed') return 'bg-rose-500';
  if (status === 'partial') return 'bg-amber-500';
  if (status === 'succeeded') return 'bg-emerald-500';
  return 'bg-sky-500';
};

export interface DocJobProgressProps {
  job: DocJobRecord;
  /** 有其它请求在飞时禁用动作，避免连点重复提交。 */
  busy: boolean;
  onCancel: () => void;
  onRetryFailed: () => void;
  onDownloadReport: () => void;
  onCopyReport: () => void;
  onDownloadBundle: () => void;
  onDownloadFile: (rel: string) => void;
}

const ResultRow: React.FC<{ item: DocJobItem; onDownloadFile: (rel: string) => void }> = ({
  item,
  onDownloadFile,
}) => {
  const view = ITEM_VIEW[item.status] ?? ITEM_VIEW.failed;
  const ItemIcon = view.Icon;

  return (
    <div className="flex items-start gap-2 border-b border-slate-50 px-3 py-2 last:border-b-0">
      <ItemIcon className={`mt-0.5 shrink-0 text-xs ${view.className}`} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="truncate font-mono text-xs text-slate-700" title={item.rel}>
            {item.rel}
          </span>
          {item.renamed ? (
            <span className={studioBadgeClassName('violet')}>{`另存为 ${baseName(item.destRel)}`}</span>
          ) : null}
          {item.status === 'skipped' ? (
            <span className="text-[11px] text-amber-600">目标已存在，按策略跳过</span>
          ) : null}
        </div>
        {item.error ? <div className="mt-0.5 text-[11px] leading-4 text-rose-600">{item.error}</div> : null}
      </div>
      <div className="shrink-0 text-right text-[11px] text-slate-400">
        {item.sizeBytes ? <div>{fmtBytes(item.sizeBytes)}</div> : null}
        {item.ms ? <div>{`${(item.ms / 1000).toFixed(1)}s`}</div> : null}
        {item.status === 'ok' ? (
          <button
            type="button"
            onClick={() => onDownloadFile(item.destRel)}
            className="mt-0.5 text-slate-400 transition hover:text-slate-700"
            title="下载该文件"
            aria-label={`下载 ${baseName(item.destRel)}`}
          >
            <FaDownload className="text-[11px]" />
          </button>
        ) : null}
      </div>
    </div>
  );
};

const DocJobProgress: React.FC<DocJobProgressProps> = ({
  job,
  busy,
  onCancel,
  onRetryFailed,
  onDownloadReport,
  onCopyReport,
  onDownloadBundle,
  onDownloadFile,
}) => {
  const active = job.status === 'queued' || job.status === 'running';
  const failedItems = job.items.filter((item) => item.status === 'failed');
  const percent = Math.max(0, Math.min(100, Math.round(job.progress)));
  const status = STATUS_VIEW[job.status] ?? { label: job.status, tone: 'slate' as const };

  return (
    <section className={`${studioSurfaceClassName} space-y-4 p-4 sm:p-5`} aria-label="批量转换进度">
      <div className="flex flex-wrap items-center gap-2">
        <span className={studioBadgeClassName(status.tone)}>{status.label}</span>
        <span className="truncate font-mono text-[10px] text-slate-400">{job.id}</span>
        {/* stage 是后端给的一行中文短句；转换中时它带上当前文件名。 */}
        <span className="min-w-0 flex-1 truncate text-xs text-slate-600">{job.stage || '等待开始'}</span>
      </div>

      <div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
          <div
            className={`h-full rounded-full transition-all duration-300 ${progressTone(job.status)}`}
            style={{ width: `${percent}%` }}
          />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-500">
          <span>{`进度 ${job.done}/${job.total}`}</span>
          <span className="text-emerald-600">{`成功 ${job.ok}`}</span>
          <span className="text-amber-600">{`跳过 ${job.skipped}`}</span>
          <span className={job.failed > 0 ? 'text-rose-600' : undefined}>{`失败 ${job.failed}`}</span>
          <span>{`${percent}%`}</span>
        </div>
      </div>

      {job.error ? (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">{job.error}</div>
      ) : null}

      {failedItems.length > 0 ? (
        <details className="rounded-xl border border-rose-100 bg-rose-50/70 px-3 py-2">
          <summary className="cursor-pointer text-xs font-semibold text-rose-700">
            {`失败明细（${failedItems.length}）`}
          </summary>
          <ul className="mt-2 space-y-1">
            {failedItems.map((item) => (
              <li key={item.rel} className="text-[11px] leading-5 text-rose-700">
                <span className="font-mono">{item.rel}</span>
                {`：${item.error || '未提供失败原因'}`}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {job.items.length > 0 ? (
        <div className="max-h-64 overflow-y-auto rounded-xl border border-slate-100 bg-white/70">
          {job.items.map((item) => (
            <ResultRow key={`${item.rel}|${item.destRel}`} item={item} onDownloadFile={onDownloadFile} />
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {active ? (
          <button
            type="button"
            onClick={onCancel}
            disabled={busy || job.cancelRequested}
            className={studioDangerButtonClassName}
          >
            <FaStop className="text-[11px]" />
            {job.cancelRequested ? '正在取消…' : '取消任务'}
          </button>
        ) : null}
        <button
          type="button"
          onClick={onRetryFailed}
          disabled={busy || failedItems.length === 0}
          className={studioSecondaryButtonClassName}
        >
          <FaRedo className="text-[11px]" />
          只重试失败项
        </button>
        <button type="button" onClick={onDownloadReport} disabled={busy} className={studioSecondaryButtonClassName}>
          <FaDownload className="text-[11px]" />
          下载报告
        </button>
        <button type="button" onClick={onCopyReport} disabled={busy} className={studioSecondaryButtonClassName}>
          <FaCopy className="text-[11px]" />
          复制报告
        </button>
        <button
          type="button"
          onClick={onDownloadBundle}
          disabled={busy || job.ok === 0}
          className={studioSecondaryButtonClassName}
        >
          <FaFileArchive className="text-[11px]" />
          打包下载 (ZIP)
        </button>
      </div>
    </section>
  );
};

export default DocJobProgress;
