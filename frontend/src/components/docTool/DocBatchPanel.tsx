// Markdown → Word 批量转换面板。
//
// 职责：来源上传、选项（冲突策略/输出位置/参考样式）、提交任务、轮询进度，
// 具体列表与进度/结果渲染分别交给 DocFileList / DocJobProgress。
//
// 本文件只在懒加载路径里被引用（App.tsx 与 MarkdownExportPage.tsx 都走 React.lazy），
// 不要从首屏静态 import —— 首屏静态闭包有 800 KiB gzip 预算。

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { FaExclamationTriangle, FaFileWord, FaFolderOpen, FaPlusCircle, FaUpload } from 'react-icons/fa';
import {
  CONFLICT_MODES,
  DEFAULT_DOC_PREFS,
  OUT_MODES,
  docToolApi,
} from '../../api/docTool';
import type {
  ConflictMode,
  DocFileEntry,
  DocJobRecord,
  DocJobStatus,
  DocPrefs,
  DocSettingsView,
  OutMode,
} from '../../api/docTool';
import { fmtBytes } from '../admin/media-tool/ui';
import { SimpleLoadingSpinner } from '../LoadingSpinner';
import {
  InfoSectionTitle,
  studioBadgeClassName,
  studioFieldClassName,
  studioPrimaryButtonClassName,
  studioSecondaryButtonClassName,
  studioSurfaceClassName,
} from '../studioTheme';
import DocFileList from './DocFileList';
import DocJobProgress from './DocJobProgress';

const POLL_INTERVAL_MS = 1000;

const CONFLICT_LABEL: Record<ConflictMode, string> = {
  skip: '跳过',
  rename: '自动重命名',
  overwrite: '覆盖',
};

const OUT_MODE_LABEL: Record<OutMode, string> = {
  alongside: '与源文件同目录',
  custom: '指定文件夹',
};

// 文件夹选择靠非标准的 webkitdirectory；React 的类型里没有这个属性，只能展开注入。
const DIRECTORY_INPUT_PROPS = { webkitdirectory: 'true' } as unknown as React.InputHTMLAttributes<HTMLInputElement>;

const segClass = (active: boolean): string =>
  `rounded-xl px-3.5 py-2 text-xs font-semibold transition ${
    active ? 'bg-slate-900 text-white shadow-sm' : 'text-slate-500 hover:bg-slate-100 hover:text-slate-700'
  }`;

const isJobActive = (status: DocJobStatus): boolean => status === 'queued' || status === 'running';

/** 选文件夹时浏览器给出「目录/子目录/文件」形式的 webkitRelativePath；选文件时只有文件名。 */
const relativePathOf = (file: File): string => {
  const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return relative && relative.trim() ? relative : file.name;
};

const describeError = (err: unknown, fallback: string): string => {
  const status = (err as { response?: { status?: number } } | undefined)?.response?.status;
  if (status === 401) return '请先登录后再使用批量转换。';
  if (status === 413) return '文件超过上传大小上限，请分批上传。';
  if (status === 429) return '操作过于频繁，请稍后再试。';
  return fallback;
};

const DocBatchPanel: React.FC = () => {
  const [settings, setSettings] = useState<DocSettingsView | null>(null);
  const [files, setFiles] = useState<DocFileEntry[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [conflict, setConflict] = useState<ConflictMode>(DEFAULT_DOC_PREFS.conflict);
  const [outMode, setOutMode] = useState<OutMode>(DEFAULT_DOC_PREFS.outMode);
  const [outDir, setOutDir] = useState(DEFAULT_DOC_PREFS.outDir);
  const [referenceDoc, setReferenceDoc] = useState(DEFAULT_DOC_PREFS.referenceDoc);
  const [recursive, setRecursive] = useState(DEFAULT_DOC_PREFS.recursive);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [rejected, setRejected] = useState<string[]>([]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<DocJobRecord | null>(null);
  const [visibilityTick, setVisibilityTick] = useState(0);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const dirInputRef = useRef<HTMLInputElement>(null);
  /**
   * 输出位置（模式 + 目录）用 ref 追一份当前值：listFiles 是空依赖的 useCallback，
   * 直接闭包会拿到旧 state；把这两个值随每次渲染同步进 ref，列文件时读 ref 就不会预告错目标名。
   */
  const outRef = useRef({ outMode, outDir });
  useEffect(() => {
    outRef.current = { outMode, outDir };
  }, [outMode, outDir]);
  /** 记录已经触发过「完成后刷新列表」的任务，避免轮询把它变成对 /files 的连续请求。 */
  const refreshedJobRef = useRef<string | null>(null);

  const loadFiles = useCallback(
    async (mode: ConflictMode, recursiveMode: boolean, select: 'all' | 'needed') => {
      setLoadingFiles(true);
      try {
        const res = await docToolApi.listFiles({
          recursive: recursiveMode,
          conflict: mode,
          outMode: outRef.current.outMode,
          outDir: outRef.current.outDir,
        });
        setFiles(res.files);
        setSelected(
          res.files.filter((entry) => (select === 'all' ? true : entry.status !== 'fresh')).map((entry) => entry.rel),
        );
      } catch (err) {
        setError(describeError(err, '读取文件列表失败，请稍后重试。'));
        console.error('doc-tool 读取文件列表失败:', err);
      } finally {
        setLoadingFiles(false);
      }
    },
    [],
  );

  // 首次打开：拉偏好与引擎状态，然后按这套偏好列一次文件。
  useEffect(() => {
    let alive = true;
    void (async () => {
      let prefs: DocPrefs = DEFAULT_DOC_PREFS;
      try {
        const view = await docToolApi.getSettings();
        if (!alive) return;
        setSettings(view);
        prefs = view.prefs ?? DEFAULT_DOC_PREFS;
        setConflict(prefs.conflict);
        setOutMode(prefs.outMode);
        setOutDir(prefs.outDir ?? DEFAULT_DOC_PREFS.outDir);
        setReferenceDoc(prefs.referenceDoc ?? '');
        setRecursive(prefs.recursive);
      } catch (err) {
        if (!alive) return;
        setError(describeError(err, '读取转换设置失败，已按默认选项显示。'));
        console.error('doc-tool 读取设置失败:', err);
      }
      if (!alive) return;
      await loadFiles(prefs.conflict, prefs.recursive, 'all');
    })();
    return () => {
      alive = false;
    };
  }, [loadFiles]);

  // 轮询：1s 一次，任务进终态就停；页面切到后台也停表，切回来立刻续上。
  useEffect(() => {
    const onVisibilityChange = () => setVisibilityTick((tick) => tick + 1);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  useEffect(() => {
    if (!jobId) return;
    if (job && !isJobActive(job.status)) return;
    if (document.hidden) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void docToolApi
        .getJob(jobId)
        .then((next) => {
          if (!cancelled && next) setJob(next);
        })
        .catch((err) => {
          if (!cancelled) console.error('doc-tool 轮询任务失败:', err);
        });
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [jobId, job, visibilityTick]);

  // 任务结束后刷新列表：徽章要从「待生成」变成「已是最新」，并默认只勾选还需要生成的项。
  useEffect(() => {
    if (!jobId || !job || isJobActive(job.status)) return;
    if (refreshedJobRef.current === jobId) return;
    refreshedJobRef.current = jobId;
    void loadFiles(conflict, recursive, 'needed');
  }, [job, jobId, conflict, recursive, loadFiles]);

  const changeConflict = (mode: ConflictMode) => {
    if (mode === conflict) return;
    setConflict(mode);
    // destRel / willRename 都随策略变化，必须带着新 conflict 重新列一次。
    void loadFiles(mode, recursive, 'all');
  };

  const changeRecursive = (next: boolean) => {
    setRecursive(next);
    void loadFiles(conflict, next, 'all');
  };

  const pickFiles = async (picked: FileList | null) => {
    const picks = Array.from(picked ?? [])
      .filter((file) => /\.(md|markdown)$/i.test(file.name))
      .map((file) => ({ file, relPath: relativePathOf(file) }));
    if (picks.length === 0) {
      setError('只支持 .md / .markdown 文件。');
      return;
    }
    setUploading(true);
    setError(null);
    setNotice(null);
    setRejected([]);
    try {
      const res = await docToolApi.uploadFiles(picks);
      setRejected(res.rejected.map((item) => (item.reason ? `${item.name}：${item.reason}` : item.name)));
      setNotice(`已上传 ${res.files.length > 0 ? res.files.length : picks.length} 个文件。`);
      await loadFiles(conflict, recursive, 'all');
    } catch (err) {
      setError(describeError(err, '上传失败，请检查网络后重试。'));
      console.error('doc-tool 上传失败:', err);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
      if (dirInputRef.current) dirInputRef.current.value = '';
    }
  };

  const startJob = async (targetFiles: string[]) => {
    if (targetFiles.length === 0) {
      setError('请先勾选要转换的文件。');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    setJob(null);
    setJobId(null);
    try {
      const prefs: DocPrefs = { conflict, outMode, outDir, recursive, referenceDoc };
      // 偏好先落服务端：下次打开面板时能带出同一套选项。
      await docToolApi.updateSettings(prefs);
      const created = await docToolApi.createJob({ files: targetFiles, outMode, outDir, conflict, referenceDoc });
      refreshedJobRef.current = null;
      setJobId(created);
      setNotice(`已提交 ${targetFiles.length} 个文件。`);
    } catch (err) {
      setError(describeError(err, '提交转换任务失败，请稍后重试。'));
      console.error('doc-tool 创建任务失败:', err);
    } finally {
      setBusy(false);
    }
  };

  const retryFailed = () => {
    const failedFiles = (job?.items ?? [])
      .filter((item) => item.status === 'failed')
      .map((item) => item.rel);
    void startJob(failedFiles);
  };

  const cancelJob = () => {
    if (!jobId) return;
    setBusy(true);
    void docToolApi
      .cancelJob(jobId)
      .catch((err) => {
        setError(describeError(err, '取消任务失败，请稍后重试。'));
        console.error('doc-tool 取消任务失败:', err);
      })
      .finally(() => setBusy(false));
  };

  const downloadReport = () => {
    if (!jobId) return;
    void docToolApi.downloadReport(jobId).catch((err) => {
      setError(describeError(err, '下载报告失败，请稍后重试。'));
      console.error('doc-tool 下载报告失败:', err);
    });
  };

  const copyReport = async () => {
    if (!jobId) return;
    try {
      const text = await docToolApi.fetchReport(jobId);
      await navigator.clipboard.writeText(text);
      setNotice('报告已复制到剪贴板。');
    } catch (err) {
      setError('复制报告失败，请改用「下载报告」。');
      console.error('doc-tool 复制报告失败:', err);
    }
  };

  const downloadBundle = () => {
    if (!jobId) return;
    void docToolApi.downloadBundle(jobId).catch((err) => {
      setError(describeError(err, '打包下载失败，请稍后重试。'));
      console.error('doc-tool 打包下载失败:', err);
    });
  };

  const downloadArtifact = (rel: string) => {
    void docToolApi.downloadFile(rel).catch((err) => {
      setError(describeError(err, `下载 ${rel} 失败。`));
      console.error('doc-tool 下载产物失败:', err);
    });
  };

  const generateTemplate = async () => {
    setGenerating(true);
    setError(null);
    setNotice(null);
    try {
      await docToolApi.createTemplate();
      const view = await docToolApi.getSettings();
      setSettings(view);
      setNotice(`已生成默认样式模板，共 ${view.templates.length} 个可选。`);
    } catch (err) {
      setError(describeError(err, '生成默认样式模板失败，请稍后重试。'));
      console.error('doc-tool 生成模板失败:', err);
    } finally {
      setGenerating(false);
    }
  };

  const toggleSelected = (rel: string) => {
    setSelected((prev) => (prev.includes(rel) ? prev.filter((item) => item !== rel) : [...prev, rel]));
  };

  const pandoc = settings?.pandoc;
  const limits = settings?.limits;
  const templates = settings?.templates ?? [];
  const engineUnavailable = pandoc ? !pandoc.available : false;
  const pandocLabel = pandoc
    ? pandoc.available
      ? pandoc.version || '转换引擎就绪'
      : '转换引擎不可用'
    : '正在检测转换引擎…';

  return (
    <div className="space-y-4">
      <InfoSectionTitle
        title="批量转换"
        description="上传 Markdown 文件，一次转换成 Word。可以保留子目录结构、按策略处理已存在的产物，并只重试失败项。"
        icon={FaFileWord}
        tone="slate"
        action={<span className={studioBadgeClassName(pandoc?.available ? 'green' : 'rose')}>{pandocLabel}</span>}
      />

      {error ? (
        <div className="flex items-center gap-2 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          <FaExclamationTriangle className="shrink-0 text-rose-500" />
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {notice}
        </div>
      ) : null}

      {pandoc && !pandoc.available ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <div className="font-semibold">转换引擎当前不可用</div>
          <p className="mt-1 text-xs leading-5">批量转换依赖服务端的 pandoc。引擎恢复后本页即可正常提交。</p>
          {pandoc.error ? (
            <details className="mt-2">
              <summary className="cursor-pointer text-[11px] font-semibold">详情</summary>
              <p className="mt-1 break-all font-mono text-[11px] text-amber-700">{pandoc.error}</p>
            </details>
          ) : null}
        </div>
      ) : null}

      <section className={`${studioSurfaceClassName} space-y-3 p-4 sm:p-5`}>
        <div className="text-sm font-semibold text-slate-700">来源文件</div>
        <p className="text-xs leading-5 text-slate-500">
          选择 .md 文件，或直接选择整个文件夹（保留子目录结构）。上传后的文件一直留在下面的列表里。
        </p>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          multiple
          accept=".md,.markdown,text/markdown"
          aria-label="选择 Markdown 文件"
          onChange={(event) => void pickFiles(event.target.files)}
        />
        <input
          ref={dirInputRef}
          type="file"
          className="hidden"
          multiple
          aria-label="选择 Markdown 文件夹"
          {...DIRECTORY_INPUT_PROPS}
          onChange={(event) => void pickFiles(event.target.files)}
        />
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className={studioSecondaryButtonClassName}
          >
            <FaUpload className="text-[11px]" />
            选择文件
          </button>
          <button
            type="button"
            onClick={() => dirInputRef.current?.click()}
            disabled={uploading}
            className={studioSecondaryButtonClassName}
          >
            <FaFolderOpen className="text-[11px]" />
            选择文件夹
          </button>
          {uploading ? (
            <span className="inline-flex items-center gap-2 text-xs text-slate-500">
              <SimpleLoadingSpinner size={0.7} />
              上传中…
            </span>
          ) : null}
          {limits ? (
            <span className="text-[11px] text-slate-400">
              {`单文件 ${fmtBytes(limits.maxFileBytes)} 以内，单次最多 ${limits.maxFilesPerJob} 个，产物保留 ${limits.retentionDays} 天`}
            </span>
          ) : null}
        </div>
        {rejected.length > 0 ? (
          <details className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
            <summary className="cursor-pointer text-[11px] font-semibold text-amber-800">
              {`有 ${rejected.length} 个文件未接收`}
            </summary>
            <ul className="mt-1.5 space-y-0.5">
              {rejected.map((line) => (
                <li key={line} className="text-[11px] text-amber-700">
                  {line}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>

      <DocFileList
        files={files}
        selected={selected}
        loading={loadingFiles}
        onToggle={toggleSelected}
        onSelectAll={() => setSelected(files.map((entry) => entry.rel))}
        onSelectNone={() => setSelected([])}
        onSelectNeeded={() => setSelected(files.filter((entry) => entry.status !== 'fresh').map((entry) => entry.rel))}
      />

      <section className={`${studioSurfaceClassName} space-y-4 p-4 sm:p-5`}>
        <div className="text-sm font-semibold text-slate-700">转换选项</div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <div className="mb-2 text-xs font-semibold text-slate-700">目标 .docx 已存在时</div>
            <div className="inline-flex flex-wrap rounded-2xl border border-slate-200 bg-slate-50 p-1" role="group">
              {CONFLICT_MODES.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={conflict === mode}
                  onClick={() => changeConflict(mode)}
                  className={segClass(conflict === mode)}
                >
                  {CONFLICT_LABEL[mode]}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-2 text-xs font-semibold text-slate-700">输出位置</div>
            <div className="inline-flex flex-wrap rounded-2xl border border-slate-200 bg-slate-50 p-1" role="group">
              {OUT_MODES.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={outMode === mode}
                  onClick={() => {
                    setOutMode(mode);
                    // 目标名随输出位置变：改了就重列，免得列表还写着上一个落点
                    if (files.length) void loadFiles(conflict, recursive, 'all');
                  }}
                  className={segClass(outMode === mode)}
                >
                  {OUT_MODE_LABEL[mode]}
                </button>
              ))}
            </div>
            {outMode === 'custom' ? (
              <label className="mt-2 block">
                <span className="mb-1 block text-[11px] font-semibold text-slate-500">输出文件夹</span>
                <input
                  className={`${studioFieldClassName} py-2 text-xs`}
                  value={outDir}
                  onChange={(event) => setOutDir(event.target.value)}
                  // 失去焦点时才重列：边敲边列会把列表刷成半截目录
                  onBlur={() => {
                    if (files.length) void loadFiles(conflict, recursive, 'all');
                  }}
                  placeholder="out"
                  aria-label="输出文件夹"
                />
              </label>
            ) : null}
          </div>
        </div>

        <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
          <input
            type="checkbox"
            className="size-4"
            checked={recursive}
            onChange={(event) => changeRecursive(event.target.checked)}
          />
          列表包含子目录里的 .md
        </label>

        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-[200px] flex-1">
            <span className="mb-1 block text-[11px] font-semibold text-slate-500">参考样式文档</span>
            <select
              className={`${studioFieldClassName} py-2 text-xs`}
              value={referenceDoc}
              onChange={(event) => setReferenceDoc(event.target.value)}
              aria-label="参考样式文档"
            >
              <option value="">不使用（用 pandoc 默认样式）</option>
              {templates.map((template) => (
                <option key={template.rel} value={template.rel}>
                  {template.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            onClick={() => void generateTemplate()}
            disabled={generating || busy}
            className={studioSecondaryButtonClassName}
          >
            {generating ? <SimpleLoadingSpinner size={0.7} /> : <FaPlusCircle className="text-[11px]" />}
            生成默认样式模板
          </button>
        </div>
        <p className="text-[11px] leading-5 text-slate-400">
          参考样式决定正文中英文字体与标题层级样式；生成后可在 Word 里改好再替换。
        </p>
      </section>

      {jobId ? (
        job ? (
          <DocJobProgress
            job={job}
            busy={busy}
            onCancel={cancelJob}
            onRetryFailed={retryFailed}
            onDownloadReport={downloadReport}
            onCopyReport={() => void copyReport()}
            onDownloadBundle={downloadBundle}
            onDownloadFile={downloadArtifact}
          />
        ) : (
          <div className={`${studioSurfaceClassName} px-4 py-8 text-center text-sm text-slate-400`}>
            任务已提交，正在读取进度…
          </div>
        )
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-xs text-slate-500">{`已勾选 ${selected.length} 个文件`}</span>
        <button
          type="button"
          onClick={() => void startJob(selected)}
          disabled={busy || selected.length === 0 || engineUnavailable}
          className={studioPrimaryButtonClassName}
        >
          {busy ? <SimpleLoadingSpinner size={0.7} /> : <FaFileWord className="text-xs" />}
          {busy ? '提交中…' : `开始转换（${selected.length}）`}
        </button>
      </div>
    </div>
  );
};

export default DocBatchPanel;
