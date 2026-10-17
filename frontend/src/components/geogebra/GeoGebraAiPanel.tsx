import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FaComment, FaMagic } from "react-icons/fa";
import { cn } from "../../utils/cn";
import { useConfirm } from "../confirm/ConfirmDialogProvider";
import FeatureConsentGate from "../FeatureConsentGate";
import useFeatureConsent from "../../hooks/useFeatureConsent";
import {
  studioFieldClassName,
  studioGhostButtonClassName,
  studioPanelClassName,
  studioPillClassName,
  studioPrimaryButtonClassName,
  studioSubPanelClassName,
} from "../studioTheme";
import { StudioEmptyState, StudioErrorNote, StudioLoadingState, StudioSuccessNote } from "../studioFeedback";
import {
  cancelGeoGebraJob,
  createGeoGebraAiJob,
  createGeoGebraComment,
  deleteGeoGebraAsset,
  getGeoGebraJob,
  uploadGeoGebraReferenceImage,
} from "../../api/geogebra";
import { buildGeoGebraDependencyTree, formatGeoGebraDependencyTree } from "./dependency";
import type { GeoGebraAiKind, GeoGebraJob, GeoGebraLocalProject } from "../../types/geogebra";

// GeoGebra AI 面板（GEO-15 / GEO-16）。
//
// 交互上的三条硬约束：
//  1) AI 结果永远先「预览 + 人工确认」再进编辑器；这里不自作主张执行脚本。
//  2) 参考图上传与 AI 调用分别对应各自的同意门禁（geogebra-assets / geogebra-ai）。
//  3) 轮询只在未终态时进行，终态 / 卸载 / 切项目都会停掉定时器。
const POLL_INTERVAL_MS = 3_000;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "expired"]);
const MAX_REFERENCE_BYTES = 4 * 1024 * 1024;
const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp"];

const AI_ACTIONS: Array<{ kind: GeoGebraAiKind; label: string; hint: string; needsPrompt: boolean }> = [
  { kind: "ai-drawing", label: "按描述生成脚本", hint: "描述你想要的图形，或上传一张参考图。", needsPrompt: true },
  { kind: "ai-insight", label: "解读当前脚本", hint: "让 AI 概括脚本构造了什么、关键点在哪。", needsPrompt: false },
  { kind: "ai-annotation", label: "生成对象标注建议", hint: "为画布对象给出可写回的标注指令。", needsPrompt: false },
  { kind: "ai-explanation", label: "解释对象依赖", hint: "说明指定对象依赖哪些对象。", needsPrompt: false },
];

type Props = {
  project: GeoGebraLocalProject | null;
  canvasMode: GeoGebraLocalProject["canvasMode"];
  code: string;
  objectNames: string[];
  onApplyCommands: (commands: string[], mode: "replace" | "append") => Promise<{ ok: boolean; message: string }>;
};

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("read-failed"));
    reader.onerror = () => reject(new Error("read-failed"));
    reader.readAsDataURL(file);
  });
}

export default function GeoGebraAiPanel({ project, canvasMode, code, objectNames, onApplyCommands }: Props) {
  const confirm = useConfirm();
  const { ready: aiConsentReady } = useFeatureConsent("geogebra-ai");
  const [kind, setKind] = useState<GeoGebraAiKind>("ai-insight");
  const [prompt, setPrompt] = useState("");
  const [focusObject, setFocusObject] = useState("");
  const [referenceAssetId, setReferenceAssetId] = useState<string | null>(null);
  const [attachmentName, setAttachmentName] = useState("");
  const [uploadBusy, setUploadBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<GeoGebraJob | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [applying, setApplying] = useState(false);
  const [commentBusy, setCommentBusy] = useState(false);
  const [commentStatus, setCommentStatus] = useState("");
  // GEO-16：对象标注要求「勾选要写回的项」。null = 全选（尚未手动调整过）。
  const [selectedCommandIndexes, setSelectedCommandIndexes] = useState<number[] | null>(null);
  const pollRef = useRef<number | null>(null);

  const activeAction = useMemo(() => AI_ACTIONS.find((action) => action.kind === kind) ?? AI_ACTIONS[0], [kind]);
  // 依赖树是本地推导的确定性结果（与 AI 解释并列展示），AI 不可用时也能看。
  const dependencyTree = useMemo(
    () => focusObject ? buildGeoGebraDependencyTree(code, focusObject) : null,
    [code, focusObject],
  );
  const running = job !== null && !TERMINAL_STATUSES.has(job.status);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  // 切项目时丢弃上一个项目的任务视图，避免把别的项目的结果应用到当前脚本。
  useEffect(() => {
    stopPolling();
    setJob(null);
    setError("");
    setNotice("");
    setCommentStatus("");
    setSelectedCommandIndexes(null);
  }, [project?.projectId, stopPolling]);

  useEffect(() => {
    if (!job || TERMINAL_STATUSES.has(job.status)) {
      stopPolling();
      return undefined;
    }
    if (pollRef.current !== null) return undefined;
    pollRef.current = window.setInterval(() => {
      void getGeoGebraJob(job.jobId)
        .then((next) => setJob(next))
        .catch(() => {
          stopPolling();
          setError("任务状态暂时无法刷新，请稍后重试。");
        });
    }, POLL_INTERVAL_MS);
    return () => stopPolling();
  }, [job, stopPolling]);

  const handleFile = async (file: File | null) => {
    if (!file) return;
    setError("");
    if (!ACCEPTED_TYPES.includes(file.type)) {
      setError("参考图仅支持 PNG、JPEG 或 WebP。");
      return;
    }
    if (file.size > MAX_REFERENCE_BYTES) {
      setError("参考图超过 4 MB，请压缩后再上传。");
      return;
    }
    setUploadBusy(true);
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const asset = await uploadGeoGebraReferenceImage(dataUrl);
      if (referenceAssetId) await deleteGeoGebraAsset(referenceAssetId).catch(() => undefined);
      setReferenceAssetId(asset.assetId);
      setAttachmentName(file.name);
      setKind("ai-drawing");
      setNotice("参考图已就绪，生成后会自动清理。");
    } catch {
      setError("参考图上传失败，请重试。");
    } finally {
      setUploadBusy(false);
    }
  };

  const handleRemoveReference = async () => {
    const assetId = referenceAssetId;
    setReferenceAssetId(null);
    setAttachmentName("");
    if (assetId) await deleteGeoGebraAsset(assetId).catch(() => undefined);
  };

  const handleRun = async () => {
    if (busy || running) return;
    if (activeAction.needsPrompt && !prompt.trim() && !referenceAssetId) {
      setError("请先描述想要的图形，或上传一张参考图。");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    setCommentStatus("");
    try {
      const created = await createGeoGebraAiJob({
        kind,
        projectId: project?.projectId ?? null,
        canvasMode,
        code,
        prompt: prompt.trim() || undefined,
        objectNames: objectNames.slice(0, 200),
        focusObject: focusObject || null,
        referenceAssetId,
      });
      setJob(created);
      setSelectedCommandIndexes(null);
      // 上传的参考图已交给任务，面板不再持有它。
      setReferenceAssetId(null);
      setAttachmentName("");
      setNotice("已提交，正在生成建议。");
    } catch (caught) {
      const status = (caught as { response?: { status?: number } })?.response?.status;
      setError(status === 503
        ? "AI 能力当前不可用，请稍后再试。"
        : status === 429
          ? "同时进行的任务过多，请等前一个完成。"
          : "暂时无法提交，请稍后重试。");
    } finally {
      setBusy(false);
    }
  };

  const handleCancel = async () => {
    if (!job) return;
    try {
      setJob(await cancelGeoGebraJob(job.jobId));
      setNotice("已取消。");
    } catch {
      setError("取消失败，请稍后重试。");
    }
  };

  // 只把勾选中的指令交给写回流程；未手动调整过时等同全选。
  const applyCommands = (): string[] => {
    const commands = job?.result?.commands ?? [];
    if (!selectedCommandIndexes) return commands;
    const chosen = new Set(selectedCommandIndexes);
    return commands.filter((_, index) => chosen.has(index));
  };

  const handleApply = async (mode: "replace" | "append") => {
    const commands = applyCommands();
    if (!commands.length || applying) return;
    if (mode === "replace") {
      const approved = await confirm({
        title: "用 AI 结果替换脚本",
        description: "当前编辑器内容会被替换；替换前仍会做一次语法预检。",
        confirmLabel: "替换脚本",
      });
      if (!approved) return;
    }
    setApplying(true);
    setError("");
    try {
      const outcome = await onApplyCommands(commands, mode);
      if (outcome.ok) setNotice(outcome.message);
      else setError(outcome.message);
    } finally {
      setApplying(false);
    }
  };

  const result = job?.result ?? null;

  /**
   * GEO-16：把 AI 概要写入项目评论。
   * 必须是用户显式点击：这里没有任何 effect 会自动调用；写入失败保留可见错误态。
   * 只有已同步到云端的项目才有服务端评论可写（本地草稿的 projectId 在服务端不存在）。
   */
  const handleWriteSummaryComment = async () => {
    const summary = typeof result?.summary === "string" ? result.summary.trim() : "";
    if (!summary || commentBusy) return;
    if (!project?.cloudRevision) {
      setError("请先把项目保存到云端，再把概要写入评论。");
      return;
    }
    setCommentBusy(true);
    setError("");
    setCommentStatus("");
    try {
      await createGeoGebraComment({
        projectId: project.projectId,
        body: summary.slice(0, 4_000),
      });
      setCommentStatus("概要已写入项目评论。");
    } catch {
      setError("概要写入评论失败，请确认项目权限后重试。");
    } finally {
      setCommentBusy(false);
    }
  };

  return (
    <section className={studioPanelClassName} aria-labelledby="geogebra-ai-heading">
      <div className="mb-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">AI Assist</p>
        <h2 id="geogebra-ai-heading" className="mt-1 text-lg font-semibold text-slate-900">AI 辅助</h2>
        <p className="mt-1 text-sm text-slate-500">让 AI 起草构造脚本或解读当前画布；生成结果需要你确认后才会写入编辑器。</p>
      </div>

      <FeatureConsentGate feature="geogebra-ai">
        <div className="flex flex-wrap gap-2">
          {AI_ACTIONS.map((action) => (
            <button
              key={action.kind}
              type="button"
              onClick={() => { setKind(action.kind); setError(""); }}
              className={cn(studioPillClassName(kind === action.kind), "min-h-10")}
              aria-pressed={kind === action.kind}
            >
              {action.label}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-slate-500">{activeAction.hint}</p>

        {activeAction.needsPrompt && (
          <div className="mt-3 space-y-3">
            <FeatureConsentGate feature="geogebra-assets">
              <div className={studioSubPanelClassName}>
                <label className="block text-xs font-semibold text-slate-600">
                  参考图（可选）
                  <input
                    type="file"
                    accept={ACCEPTED_TYPES.join(",")}
                    disabled={uploadBusy}
                    onChange={(event) => { void handleFile(event.target.files?.[0] ?? null); event.target.value = ""; }}
                    className="mt-1 block w-full text-sm text-slate-600 file:mr-3 file:min-h-11 file:rounded-2xl file:border file:border-slate-200 file:bg-white file:px-3 file:text-sm file:text-slate-700"
                  />
                </label>
                {attachmentName && (
                  <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-1">{attachmentName}</span>
                    <button type="button" onClick={() => void handleRemoveReference()} className="text-rose-700 underline-offset-2 hover:underline">移除</button>
                  </p>
                )}
                <p className="mt-2 text-xs text-slate-500">参考图只用于这一次生成，任务结束后立即删除。</p>
              </div>
            </FeatureConsentGate>
            <textarea
              className={cn(studioFieldClassName, "min-h-24")}
              value={prompt}
              maxLength={2000}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="例如：画一个以 A 为圆心、半径 2 的圆，并标注圆心与半径"
            />
          </div>
        )}

        {kind === "ai-explanation" && objectNames.length > 0 && (
          <label className="mt-3 block text-xs font-semibold text-slate-600">
            关注对象
            <select className={cn(studioFieldClassName, "mt-1")} value={focusObject} onChange={(event) => setFocusObject(event.target.value)}>
              <option value="">请选择</option>
              {objectNames.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
          </label>
        )}

        {kind === "ai-explanation" && dependencyTree && (
          <div className={cn(studioSubPanelClassName, "mt-3")}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-semibold text-slate-800">本地依赖关系</span>
              <button
                type="button"
                onClick={() => { void navigator.clipboard.writeText(formatGeoGebraDependencyTree(dependencyTree)).then(() => setNotice("依赖关系已复制。")).catch(() => setError("无法复制依赖关系。")); }}
                className="text-xs font-semibold text-slate-600 underline decoration-slate-300 underline-offset-4 hover:text-slate-900"
              >
                复制
              </button>
            </div>
            {dependencyTree.children.length ? (
              <ul className="mt-2 space-y-1 font-mono text-[11px] text-slate-600">
                <li className="font-semibold text-slate-800">{dependencyTree.root.name}{dependencyTree.root.lineNumber ? `（第 ${dependencyTree.root.lineNumber} 行）` : "（脚本里没有定义）"}</li>
                {dependencyTree.children.map((entry) => (
                  <li key={`${entry.depth}-${entry.node.name}`} style={{ paddingLeft: `${entry.depth * 14}px` }} className="min-w-0 truncate">
                    - {entry.node.name}（第 {entry.node.lineNumber} 行）{entry.circular && <span className="ml-1 text-amber-700">已在上层出现</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-xs text-slate-500">{dependencyTree.root.defined ? "这个对象不依赖脚本里的其它对象。" : "这个对象不在当前脚本的顶层定义里，可能由 GeoGebra 自动命名。"}</p>
            )}
          </div>
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" onClick={() => void handleRun()} disabled={busy || running} className={studioPrimaryButtonClassName}>
            <FaMagic /> {busy ? "提交中…" : running ? "生成中…" : "生成建议"}
          </button>
          {running && <button type="button" onClick={() => void handleCancel()} className={studioGhostButtonClassName}>取消</button>}
        </div>

        {!aiConsentReady && <p className="mt-2 text-xs text-slate-500">同意相关条款后即可使用 AI 辅助。</p>}
        {error && <StudioErrorNote className="mt-3">{error}</StudioErrorNote>}
        {notice && !error && <StudioSuccessNote className="mt-3">{notice}</StudioSuccessNote>}

        {running ? (
          <StudioLoadingState text="正在生成建议..." minHeightClassName="min-h-[160px]" />
        ) : job ? (
          <div className={cn(studioSubPanelClassName, "mt-3")}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-semibold text-slate-800">{activeAction.label}</span>
              <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-600">
                {job.status === "queued" ? "排队中" : job.status === "running" ? "生成中" : job.status === "completed" ? "已完成" : job.status === "cancelled" ? "已取消" : job.status === "expired" ? "已过期" : "未完成"}
              </span>
            </div>
            {job.status === "failed" && <StudioErrorNote className="mt-2">{job.errorMessage ?? "这次没有生成可用的建议，请重试。"}</StudioErrorNote>}
            {result?.summary && <p className="mt-2 text-sm leading-6 text-slate-700">{result.summary}</p>}
            {result?.summary && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleWriteSummaryComment()}
                  disabled={commentBusy || !project?.cloudRevision}
                  className={studioGhostButtonClassName}
                  title={project?.cloudRevision ? "把这段概要写入项目评论" : "保存到云端后可写入评论"}
                >
                  <FaComment /> {commentBusy ? "写入中…" : "写入评论"}
                </button>
                {!project?.cloudRevision && <span className="text-xs text-slate-500">保存到云端后可把概要写入评论。</span>}
                {commentStatus && <span role="status" className="text-xs text-emerald-700">{commentStatus}</span>}
              </div>
            )}
            {typeof result?.confidence === "number" && (
              <p className="mt-1 text-xs text-slate-500">模型自评把握度约 {Math.round(result.confidence * 100)}%，请以预检与实际运行为准。</p>
            )}
            {result?.notes?.length ? (
              <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-slate-600">
                {result.notes.map((note) => <li key={note}>{note}</li>)}
              </ul>
            ) : null}
            {result?.commands?.length ? (
              <div className="mt-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-semibold text-slate-600">待写入指令（{applyCommands().length}/{result.commands.length} 条）</p>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={() => setSelectedCommandIndexes(null)} className="text-xs font-semibold text-slate-600 underline decoration-slate-300 underline-offset-4 hover:text-slate-900">全选</button>
                    <button type="button" onClick={() => setSelectedCommandIndexes([])} className="text-xs font-semibold text-slate-600 underline decoration-slate-300 underline-offset-4 hover:text-slate-900">全不选</button>
                  </div>
                </div>
                <ul className="mt-1 max-h-48 space-y-1 overflow-auto rounded-2xl border border-slate-200 bg-slate-50 p-2">
                  {result.commands.map((command, index) => {
                    const checked = selectedCommandIndexes === null || selectedCommandIndexes.includes(index);
                    return (
                      <li key={`${index}-${command}`}>
                        <label className="flex min-w-0 items-start gap-2 rounded-xl px-1 py-1 text-[11px] leading-5 text-slate-700 hover:bg-white/70">
                          <input
                            type="checkbox"
                            className="mt-0.5 shrink-0"
                            checked={checked}
                            onChange={() => {
                              const current = selectedCommandIndexes ?? result.commands.map((_, item) => item);
                              const next = checked ? current.filter((item) => item !== index) : [...current, index].sort((a, b) => a - b);
                              setSelectedCommandIndexes(next);
                            }}
                            aria-label={`第 ${index + 1} 条：${command}`}
                          />
                          <code className="min-w-0 break-all font-mono">{command}</code>
                        </label>
                      </li>
                    );
                  })}
                </ul>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button type="button" onClick={() => void handleApply("replace")} disabled={applying || applyCommands().length === 0} className={studioPrimaryButtonClassName}>替换脚本</button>
                  <button type="button" onClick={() => void handleApply("append")} disabled={applying || applyCommands().length === 0} className={studioGhostButtonClassName}>追加到脚本</button>
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <StudioEmptyState className="mt-3 px-4 py-10" message="还没有生成建议。选择上面的操作、填好描述后点「生成建议」。" />
        )}
      </FeatureConsentGate>
    </section>
  );
}
