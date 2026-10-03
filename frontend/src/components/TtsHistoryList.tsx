import React, { useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  FaHistory,
  FaRedo,
  FaPlay,
  FaPause,
  FaDownload,
  FaCommentDots,
  FaTools,
  FaPen,
  FaTrash,
  FaStickyNote,
} from "react-icons/fa";
import { cn } from "../utils/cn";
import type {
  TtsHistoryRecord,
  TtsHistoryReviewStatus,
  TtsHistoryUserUpdatePayload,
} from "../types/tts";
import {
  TTS_HISTORY_PRESET_TAGS,
  TTS_HISTORY_TITLE_MAX_LENGTH,
  TTS_HISTORY_NOTE_MAX_LENGTH,
} from "../utils/ttsHistoryTags";
import {
  studioEyebrowClassName,
  studioStrongBadgeClassName,
  studioGhostButtonClassName,
  studioPrimaryButtonClassName,
  studioMainSurfaceClassName,
} from "./studioTheme";

const getAudioMimeType = (outputFormat?: string) => {
  switch (outputFormat) {
    case "aac":
      return "audio/aac";
    case "flac":
      return "audio/flac";
    case "opus":
      return "audio/ogg; codecs=opus";
    case "mp3":
    default:
      return "audio/mpeg";
  }
};

const reviewStatusLabels: Record<TtsHistoryReviewStatus, string> = {
  none: "未标记",
  needs_review: "待人工审核",
  in_review: "审核中",
  fixed: "已修复",
  dismissed: "已关闭",
};

const reviewStatusClassNames: Record<TtsHistoryReviewStatus, string> = {
  none: "border-slate-200 bg-slate-50 text-slate-600",
  needs_review: "border-amber-200 bg-amber-50 text-amber-700",
  in_review: "border-sky-200 bg-sky-50 text-sky-700",
  fixed: "border-emerald-200 bg-emerald-50 text-emerald-700",
  dismissed: "border-slate-200 bg-white text-slate-500",
};

const formatHistoryTime = (value?: string) => {
  if (!value) return "未知时间";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
};

const formatAudioSize = (value?: number) => {
  if (!value || value <= 0) return "未知大小";
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
};

interface TtsHistoryListProps {
  history: TtsHistoryRecord[];
  historyLoading: boolean;
  historyError: string | null;
  activeHistoryId: string | null;
  audioElement: HTMLAudioElement | null;
  historyAudioElement: HTMLAudioElement | null;
  onRefresh: () => void;
  onTogglePlayback: (record: TtsHistoryRecord) => void;
  onDownload: (record: TtsHistoryRecord) => void;
  onHistoryPlay: () => void;
  setActiveHistoryId: (id: string | null) => void;
  onUpdateRecord: (recordId: string, patch: TtsHistoryUserUpdatePayload) => Promise<void>;
  onDeleteRecord: (recordId: string) => Promise<void>;
}

const ALL_TAGS_FILTER = "全部";

type HistoryDraft = {
  userTitle: string;
  userNote: string;
  userTags: string[];
};

const buildDraft = (record: TtsHistoryRecord): HistoryDraft => ({
  userTitle: record.userTitle || "",
  userNote: record.userNote || "",
  userTags: [...(record.userTags || [])],
});

const mergeTags = (extra?: string[]) =>
  Array.from(new Set([...TTS_HISTORY_PRESET_TAGS, ...(extra || [])]));

const draftInputClassName =
  "mt-1 w-full min-w-0 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-slate-400 focus:outline-none";

const TtsHistoryListInner: React.FC<TtsHistoryListProps> = ({
  history,
  historyLoading,
  historyError,
  activeHistoryId,
  audioElement,
  historyAudioElement,
  onRefresh,
  onTogglePlayback,
  onDownload,
  onHistoryPlay,
  setActiveHistoryId,
  onUpdateRecord,
  onDeleteRecord,
}) => {
  const [tagFilter, setTagFilter] = useState<string>(ALL_TAGS_FILTER);
  const [editor, setEditor] = useState<{ id: string; draft: HistoryDraft } | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);

  const filterTags = useMemo(() => mergeTags(history.flatMap((record) => record.userTags || [])), [history]);

  const visibleHistory =
    tagFilter === ALL_TAGS_FILTER
      ? history
      : history.filter((record) => record.userTags?.includes(tagFilter));

  const closeEditor = () => {
    setEditor(null);
    setEditorError(null);
    setConfirmingDelete(false);
  };

  const toggleEditor = (record: TtsHistoryRecord) => {
    if (editor?.id === record.id) {
      closeEditor();
      return;
    }
    setEditor({ id: record.id, draft: buildDraft(record) });
    setEditorError(null);
    setConfirmingDelete(false);
  };

  const setDraftText = (field: "userTitle" | "userNote", value: string) => {
    setEditor((current) =>
      current ? { ...current, draft: { ...current.draft, [field]: value } } : current,
    );
  };

  const toggleDraftTag = (tag: string) => {
    setEditor((current) => {
      if (!current) return current;
      const selected = current.draft.userTags.includes(tag);
      return {
        ...current,
        draft: {
          ...current.draft,
          userTags: selected
            ? current.draft.userTags.filter((item) => item !== tag)
            : [...current.draft.userTags, tag],
        },
      };
    });
  };

  const handleSave = async (record: TtsHistoryRecord) => {
    setSaving(true);
    setEditorError(null);
    try {
      await onUpdateRecord(record.id, {
        userTitle: editor?.draft.userTitle.trim() ?? "",
        userNote: editor?.draft.userNote.trim() ?? "",
        userTags: editor?.draft.userTags ?? [],
      });
      closeEditor();
    } catch (saveError) {
      setEditorError(saveError instanceof Error ? saveError.message : "保存记录失败");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (record: TtsHistoryRecord) => {
    setDeleting(true);
    setEditorError(null);
    try {
      await onDeleteRecord(record.id);
      closeEditor();
    } catch (deleteError) {
      setEditorError(deleteError instanceof Error ? deleteError.message : "删除记录失败");
    } finally {
      setDeleting(false);
      setConfirmingDelete(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay: 0.1 }}
      className={studioMainSurfaceClassName}
    >
      <div className="rounded-2xl border border-slate-200 bg-white/82 p-4 sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className={studioStrongBadgeClassName}>
              <FaHistory className="text-slate-600" />
            </div>
            <div>
              <div className={studioEyebrowClassName}>Generation History</div>
              <h2 className="mt-1 text-xl font-semibold text-slate-900">我的生成记录</h2>
            </div>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            disabled={historyLoading}
            className={cn(
              studioGhostButtonClassName,
              historyLoading ? "cursor-not-allowed opacity-60" : "",
            )}
          >
            <FaRedo className={historyLoading ? "animate-spin" : ""} />
            刷新
          </button>
        </div>

        {history.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {filterTags.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => setTagFilter(tag)}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-[11px] font-semibold transition",
                  tagFilter === tag
                    ? "border-slate-900 bg-slate-900 text-white"
                    : "border-slate-200 bg-white text-slate-600 hover:border-slate-300",
                )}
              >
                {tag}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setTagFilter(ALL_TAGS_FILTER)}
              className={cn(
                "rounded-full border px-2.5 py-1 text-[11px] font-semibold transition",
                tagFilter === ALL_TAGS_FILTER
                  ? "border-slate-900 bg-slate-900 text-white"
                  : "border-slate-200 bg-white text-slate-600 hover:border-slate-300",
              )}
            >
              {ALL_TAGS_FILTER}
            </button>
          </div>
        )}

        {historyError && (
          <div
            role="alert"
            className="mt-4 min-w-0 max-w-full break-words rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-800"
          >
            {historyError}
          </div>
        )}

        {historyLoading && !history.length ? (
          <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
            正在加载历史记录...
          </div>
        ) : history.length === 0 ? (
          <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
            暂无生成记录
          </div>
        ) : visibleHistory.length === 0 ? (
          <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-8 text-center text-sm text-slate-500">
            「{tagFilter}」标签下暂无记录
          </div>
        ) : (
          <div className="mt-5 grid gap-3 lg:grid-cols-2">
            {visibleHistory.map((record) => {
              const reviewStatus = (record.reviewStatus || "none") as TtsHistoryReviewStatus;
              const isHistoryPlaying = activeHistoryId === record.id;
              const isEditing = editor?.id === record.id;
              const panelTags = isEditing ? mergeTags(record.userTags) : [];

              return (
                <div
                  key={record.id}
                  className="min-w-0 rounded-2xl border border-slate-200 bg-slate-50/70 p-4 sm:rounded-2xl"
                >
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 w-full flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="min-w-0 max-w-full break-words rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-600">
                          {record.voice}
                        </span>
                        <span className="min-w-0 max-w-full break-words rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-600">
                          {record.model}
                        </span>
                        <span className="min-w-0 max-w-full break-words rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-600">
                          {record.outputFormat?.toUpperCase() || "AUDIO"}
                        </span>
                        <span
                          className={cn(
                            "min-w-0 max-w-full break-words rounded-full border px-2.5 py-1 text-[11px] font-semibold",
                            reviewStatusClassNames[reviewStatus],
                          )}
                        >
                          {reviewStatusLabels[reviewStatus]}
                        </span>
                      </div>
                      <div className="mt-3 break-words text-sm font-semibold text-slate-900">
                        {record.userTitle?.trim() || record.fileName || "语音文件"}
                      </div>
                      {record.userTitle?.trim() ? (
                        <div className="mt-1 break-words text-xs text-slate-500">
                          文件：{record.fileName}
                        </div>
                      ) : null}
                      {record.userTags?.length ? (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {record.userTags.map((tag) => (
                            <span
                              key={tag}
                              className="min-w-0 max-w-full break-words rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-600"
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      ) : null}
                      {record.userNote?.trim() ? (
                        <div className="mt-2 flex gap-2 rounded-2xl border border-sky-200 bg-sky-50/60 px-3 py-2 text-xs leading-5 text-slate-600">
                          <FaStickyNote className="mt-0.5 shrink-0 text-sky-500" />
                          <span className="min-w-0 break-words">
                            <span className="font-semibold text-sky-800">我的备注：</span>
                            {record.userNote}
                          </span>
                        </div>
                      ) : null}
                      <div className="mt-1 break-words text-xs text-slate-500">
                        {formatHistoryTime(record.createdAt)} · {record.speed}x · {record.provider}
                      </div>
                      <div className="mt-1 break-words text-xs text-slate-500">
                        {record.audioStorage === "mongo" ? "MongoDB 音频" : "文件缓存"} ·{" "}
                        {record.audioMimeType || getAudioMimeType(record.outputFormat)} ·{" "}
                        {formatAudioSize(record.audioSize)}
                        {record.audioFileId ? ` · ${record.audioFileId}` : ""}
                      </div>
                      <div className="mt-2 max-w-full min-w-0 break-words rounded-xl border border-slate-200 bg-white/70 px-3 py-2 text-xs leading-5 text-slate-500">
                        {record.text || "[redacted]"}
                      </div>
                    </div>
                  </div>

                  {record.audioUrl && (
                    <div className="mt-4 rounded-2xl border border-slate-200 bg-white p-3">
                      <audio
                        controls
                        preload="none"
                        className="w-full"
                        onPlay={onHistoryPlay}
                      >
                        <source src={record.audioUrl} type={record.audioMimeType || getAudioMimeType(record.outputFormat)} />
                        您的浏览器不支持音频播放
                      </audio>
                    </div>
                  )}

                  <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                    <button
                      type="button"
                      onClick={() => onTogglePlayback(record)}
                      disabled={!record.audioUrl}
                      className={cn(
                        studioPrimaryButtonClassName,
                        "w-full sm:w-auto",
                        !record.audioUrl ? "cursor-not-allowed opacity-60" : "",
                      )}
                    >
                      {isHistoryPlaying ? <FaPause /> : <FaPlay />}
                      {isHistoryPlaying ? "暂停" : "播放"}
                    </button>
                    <button
                      type="button"
                      onClick={() => onDownload(record)}
                      disabled={!record.audioUrl || record.permissions?.canDownload === false}
                      className={cn(
                        studioGhostButtonClassName,
                        "w-full sm:w-auto",
                        !record.audioUrl || record.permissions?.canDownload === false
                          ? "cursor-not-allowed opacity-60"
                          : "",
                      )}
                    >
                      <FaDownload />
                      下载
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleEditor(record)}
                      disabled={saving || deleting}
                      className={cn(
                        studioGhostButtonClassName,
                        "w-full sm:w-auto",
                        saving || deleting ? "cursor-not-allowed opacity-60" : "",
                      )}
                    >
                      <FaPen />
                      {isEditing ? "收起管理" : "管理"}
                    </button>
                  </div>

                  {isEditing && editor ? (
                    <div className="mt-4 space-y-3 rounded-2xl border border-slate-200 bg-white/80 p-3">
                      <label className="block text-xs font-semibold text-slate-600">
                        标题
                        <input
                          type="text"
                          value={editor.draft.userTitle}
                          onChange={(event) => setDraftText("userTitle", event.target.value)}
                          maxLength={TTS_HISTORY_TITLE_MAX_LENGTH}
                          placeholder="留空则显示文件名"
                          className={draftInputClassName}
                        />
                      </label>
                      <label className="block text-xs font-semibold text-slate-600">
                        备注
                        <textarea
                          rows={3}
                          value={editor.draft.userNote}
                          onChange={(event) => setDraftText("userNote", event.target.value)}
                          maxLength={TTS_HISTORY_NOTE_MAX_LENGTH}
                          placeholder="写下这条记录的用途、待办或备注"
                          className={draftInputClassName}
                        />
                      </label>
                      <div>
                        <div className="text-xs font-semibold text-slate-600">标签</div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {panelTags.map((tag) => {
                            const selected = editor.draft.userTags.includes(tag);
                            return (
                              <button
                                key={tag}
                                type="button"
                                onClick={() => toggleDraftTag(tag)}
                                className={cn(
                                  "rounded-full border px-2.5 py-1 text-[11px] font-semibold transition",
                                  selected
                                    ? "border-slate-900 bg-slate-900 text-white"
                                    : "border-slate-200 bg-white text-slate-600 hover:border-slate-300",
                                )}
                              >
                                {tag}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => void handleSave(record)}
                          disabled={saving || deleting}
                          className={cn(
                            studioPrimaryButtonClassName,
                            saving || deleting ? "cursor-not-allowed opacity-60" : "",
                          )}
                        >
                          {saving ? "保存中…" : "保存"}
                        </button>
                        <button
                          type="button"
                          onClick={closeEditor}
                          disabled={saving || deleting}
                          className={cn(
                            studioGhostButtonClassName,
                            saving || deleting ? "cursor-not-allowed opacity-60" : "",
                          )}
                        >
                          取消
                        </button>
                      </div>
                      {confirmingDelete ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-xs font-semibold text-rose-700">
                            删除后不可恢复，确认删除？
                          </span>
                          <button
                            type="button"
                            onClick={() => void handleDelete(record)}
                            disabled={saving || deleting}
                            className={cn(
                              "rounded-full border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 transition hover:bg-rose-100",
                              saving || deleting ? "cursor-not-allowed opacity-60" : "",
                            )}
                          >
                            {deleting ? "删除中…" : "确认删除"}
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmingDelete(false)}
                            disabled={saving || deleting}
                            className={cn(
                              studioGhostButtonClassName,
                              "px-3 py-1.5 text-xs",
                              saving || deleting ? "cursor-not-allowed opacity-60" : "",
                            )}
                          >
                            取消
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmingDelete(true)}
                          disabled={saving || deleting}
                          className={cn(
                            "flex items-center gap-2 rounded-full border border-rose-200 bg-white px-3 py-1.5 text-xs font-semibold text-rose-600 transition hover:bg-rose-50",
                            saving || deleting ? "cursor-not-allowed opacity-60" : "",
                          )}
                        >
                          <FaTrash />
                          删除记录
                        </button>
                      )}
                      {editorError && (
                        <div className="rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                          {editorError}
                        </div>
                      )}
                    </div>
                  ) : null}

                  {(record.adminNote || record.adminSuggestion || reviewStatus !== "none") && (
                    <div className="mt-4 space-y-2 rounded-2xl border border-slate-200 bg-white/80 p-3">
                      {record.adminNote && (
                        <div className="flex gap-2 text-xs leading-5 text-slate-600">
                          <FaCommentDots className="mt-0.5 shrink-0 text-slate-400" />
                          <span className="min-w-0 break-words">
                            <span className="font-semibold text-slate-800">管理员留言：</span>
                            {record.adminNote}
                          </span>
                        </div>
                      )}
                      {record.adminSuggestion && (
                        <div className="flex gap-2 text-xs leading-5 text-slate-600">
                          <FaTools className="mt-0.5 shrink-0 text-slate-400" />
                          <span className="min-w-0 break-words">
                            <span className="font-semibold text-slate-800">调整建议：</span>
                            {record.adminSuggestion}
                          </span>
                        </div>
                      )}
                      {reviewStatus !== "none" && (
                        <div className="break-words text-xs leading-5 text-slate-500">
                          人工审核：{reviewStatusLabels[reviewStatus]}
                          {record.reviewedAt ? ` · ${formatHistoryTime(record.reviewedAt)}` : ""}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </motion.div>
  );
};

export const TtsHistoryList = React.memo(TtsHistoryListInner);
