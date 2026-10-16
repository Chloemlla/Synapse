import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FaInfoCircle, FaShieldAlt } from "react-icons/fa";
import { useAuth } from "../../hooks/useAuth";
import { cn } from "../../utils/cn";
import { useConfirm } from "../confirm/ConfirmDialogProvider";
import {
  describePixelFailure,
  cancelPixelQueuedAccount,
  exportPixelTask,
  exportPixelTasksByCard,
  exportPixelUserData,
  getPixelSettings,
  getPixelTask,
  listPixelTasksByCard,
  submitPixelTask,
  verifyPixelCard,
} from "../../api/pixel";
import {
  studioAccentBlobBlueClassName,
  studioAccentBlobSkyClassName,
  studioGhostButtonClassName,
  studioHeroCardClassName,
  studioPageClassName,
  studioPanelClassName,
} from "../studioTheme";
import { PIXEL_TERMINAL_TASK_STATUSES, type PixelCardQuota, type PixelServiceType, type PixelSettings, type PixelTaskDetail, type PixelTaskSummary } from "../../types/pixel";
import PixelCardPanel from "./PixelCardPanel";
import PixelHistoryPanel from "./PixelHistoryPanel";
import PixelNoticeDialog from "./PixelNoticeDialog";
import PixelSubmitPanel from "./PixelSubmitPanel";
import PixelTaskPanel from "./PixelTaskPanel";
import { hasAcknowledgedPixelNoticeToday, newPixelIdempotencyKey } from "./pixelPreferences";

// Pixel 用户工作台（PIX-01…PIX-09）。
//
// 这一层只做编排：数据获取、轮询、幂等键、把失败翻译成「下一步该做什么」。
// 卡密与账号文本**只在内存**：不进 localStorage、不进 URL、不进 console。
const POLL_INTERVAL_MS = 5_000;
// 本地去重指纹：只用于「同一份文本复用同一个幂等键」，不含明文，也不离开浏览器。
function fingerprintOf(card: string, serviceType: string, accountsText: string): string {
  let hash = 5381;
  for (let index = 0; index < accountsText.length; index += 1) {
    hash = ((hash << 5) + hash + accountsText.charCodeAt(index)) | 0;
  }
  return `${card.length}:${serviceType}:${accountsText.length}:${hash}`;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export default function PixelWorkbenchPage() {
  const { user } = useAuth();
  const confirm = useConfirm();

  const [noticeOpen, setNoticeOpen] = useState(() => !hasAcknowledgedPixelNoticeToday());
  const [noticeAcknowledged, setNoticeAcknowledged] = useState(false);

  const [settings, setSettings] = useState<PixelSettings | null>(null);
  const [settingsError, setSettingsError] = useState("");
  const [card, setCard] = useState("");
  const [quota, setQuota] = useState<PixelCardQuota | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [serviceType, setServiceType] = useState<PixelServiceType>("link_only");

  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [submitNotice, setSubmitNotice] = useState("");
  const [submitUncertain, setSubmitUncertain] = useState(false);
  const [submitResetSignal, setSubmitResetSignal] = useState(0);

  const [task, setTask] = useState<PixelTaskDetail | null>(null);
  const [taskLoading, setTaskLoading] = useState(false);
  const [taskError, setTaskError] = useState("");
  const [cancelBusyId, setCancelBusyId] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);

  const [history, setHistory] = useState<PixelTaskSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [historyQueried, setHistoryQueried] = useState(false);
  const [query, setQuery] = useState("");

  const pendingSubmitRef = useRef<{ fingerprint: string; idempotencyKey: string } | null>(null);

  const services = settings?.services ?? [];
  const selectedOption = useMemo(() => services.find((item) => item.type === serviceType) ?? null, [serviceType, services]);
  const cardReady = Boolean(quota?.valid) || Boolean(quota?.historyAvailable);

  const loadSettings = useCallback(async () => {
    setSettingsError("");
    try {
      const next = await getPixelSettings();
      setSettings(next);
      // 后台关掉的能力要立刻在前端回退，而不是等提交时才报错。
      const preferred = next.services.find((item) => item.type === "link_and_bind" && item.enabled)
        ?? next.services.find((item) => item.enabled);
      if (preferred) setServiceType((current) => next.services.find((item) => item.type === current && item.enabled) ? current : preferred.type);
    } catch (error) {
      const failure = describePixelFailure(error);
      setSettings(null);
      setSettingsError(failure.kind === "unavailable"
        ? "该服务当前不可用，请联系管理员。"
        : "暂时读不到服务配置，请稍后重试。");
    }
  }, []);

  useEffect(() => { void loadSettings(); }, [loadSettings]);

  const refreshTask = useCallback(async (taskId?: string) => {
    const target = taskId ?? task?.taskId;
    if (!target) return;
    setTaskLoading(true);
    setTaskError("");
    try {
      setTask(await getPixelTask(target));
    } catch (error) {
      setTaskError(describePixelFailure(error).message);
    } finally {
      setTaskLoading(false);
    }
  }, [task?.taskId]);

  // PIX-05：只在非终态时轮询；终态、切任务或卸载都会停掉。
  useEffect(() => {
    if (!task || PIXEL_TERMINAL_TASK_STATUSES.has(task.status)) return undefined;
    const timer = window.setInterval(() => { void refreshTask(task.taskId); }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refreshTask, task]);

  const refreshQuota = useCallback(async () => {
    if (!card.trim()) return;
    try {
      setQuota(await verifyPixelCard(card));
    } catch {
      // 配额刷新失败不打断主流程：下一次验证会重新拉。
    }
  }, [card]);

  const handleVerify = async () => {
    if (!card.trim() || verifying) return;
    setVerifying(true);
    setSubmitError("");
    setSubmitNotice("");
    try {
      const next = await verifyPixelCard(card.trim());
      setQuota(next);
      if (!next.valid && next.historyAvailable) setSubmitNotice("这张卡密暂时不能用于新任务，但可以查看历史任务。");
    } catch (error) {
      setQuota(null);
      setSubmitError(describePixelFailure(error).message);
    } finally {
      setVerifying(false);
    }
  };

  const handleSubmit = async (accountsText: string) => {
    if (submitting) return;
    const trimmedCard = card.trim();
    const fingerprint = fingerprintOf(trimmedCard, serviceType, accountsText);
    // 同一份内容复用同一个幂等键；内容变了才换键（否则重试会被服务端当成同一次提交）。
    const idempotencyKey = pendingSubmitRef.current?.fingerprint === fingerprint
      ? pendingSubmitRef.current.idempotencyKey
      : newPixelIdempotencyKey();
    pendingSubmitRef.current = { fingerprint, idempotencyKey };

    setSubmitting(true);
    setSubmitError("");
    setSubmitNotice("");
    setSubmitUncertain(false);
    try {
      const result = await submitPixelTask({ card: trimmedCard, serviceType, accountsText, idempotencyKey });
      pendingSubmitRef.current = null;
      setSubmitNotice(result.message || `已提交 ${result.totalAccounts} 个账号。`);
      setSubmitResetSignal((value) => value + 1);
      setTask({ taskId: result.taskId, status: result.status, totalAccounts: result.totalAccounts, cancelledCount: 0, accounts: [] });
      await refreshTask(result.taskId);
      void refreshQuota();
    } catch (error) {
      const failure = describePixelFailure(error);
      if (failure.kind === "uncertain") {
        // 结果不确定时绝不自动重试：保留幂等键，并明确让用户去历史确认。
        setSubmitUncertain(true);
      } else if (failure.kind !== "conflict") {
        pendingSubmitRef.current = null;
      }
      setSubmitError(failure.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleSearchHistory = useCallback(async () => {
    if (!card.trim()) return;
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const items = await listPixelTasksByCard({ card: card.trim(), accountQuery: query.trim() || undefined });
      setHistory(items);
      setHistoryQueried(true);
    } catch (error) {
      setHistory([]);
      setHistoryQueried(true);
      setHistoryError(describePixelFailure(error).message);
    } finally {
      setHistoryLoading(false);
    }
  }, [card, query]);

  const handleOpenTask = async (taskId: string) => {
    setSubmitError("");
    await refreshTask(taskId);
  };

  const handleCancelAccount = async (accountId: number) => {
    if (!task) return;
    const approved = await confirm({
      title: "取消排队账号",
      description: "取消后该账号不会再被处理；已开始处理的账号无法取消。",
      confirmLabel: "取消排队",
      tone: "danger",
    });
    if (!approved) return;
    setCancelBusyId(accountId);
    setTaskError("");
    try {
      await cancelPixelQueuedAccount(task.taskId, accountId);
      await refreshTask(task.taskId);
      await refreshQuota();
      if (historyQueried) await handleSearchHistory();
    } catch (error) {
      setTaskError(describePixelFailure(error).message);
    } finally {
      setCancelBusyId(null);
    }
  };

  const handleExportTask = async () => {
    if (!task || exporting) return;
    setExporting(true);
    setTaskError("");
    try {
      downloadBlob(await exportPixelTask(task.taskId), `pixel-task-${task.taskId.slice(0, 8)}.txt`);
    } catch (error) {
      setTaskError(describePixelFailure(error).message);
    } finally {
      setExporting(false);
    }
  };

  const handleExportByCard = async () => {
    if (!card.trim() || exporting) return;
    setExporting(true);
    setHistoryError("");
    try {
      downloadBlob(await exportPixelTasksByCard({ card: card.trim(), accountQuery: query.trim() || undefined }), `pixel-tasks-${Date.now()}.txt`);
    } catch (error) {
      setHistoryError(describePixelFailure(error).message);
    } finally {
      setExporting(false);
    }
  };

  const handleExportUserData = async () => {
    try {
      downloadBlob(await exportPixelUserData(), "pixel-data.json");
    } catch (error) {
      setHistoryError(describePixelFailure(error).message);
    }
  };

  if (!user) {
    return (
      <div className={studioPageClassName}>
        <section className={studioPanelClassName}>
          <h1 className="text-lg font-semibold text-slate-900">Pixel 自助折扣链接</h1>
          <p className="mt-2 text-sm text-slate-600">登录后可以使用该功能；任务与额度都绑定在你的账号上。</p>
          <a href="/login" className={cn(studioGhostButtonClassName, "mt-4")}>去登录</a>
        </section>
      </div>
    );
  }

  return (
    <div className={studioPageClassName}>
      <div className="relative mx-auto max-w-7xl px-4 py-8">
        <div className={studioAccentBlobBlueClassName} aria-hidden="true" />
        <div className={studioAccentBlobSkyClassName} aria-hidden="true" />

        <header className={studioHeroCardClassName}>
          <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-500">Pixel</p>
          <h1 className="mt-2 text-2xl font-semibold text-slate-900">自助折扣链接任务</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            用卡密提交账号，由外部折扣链接服务完成提取链接与可选绑卡。账号信息只在本次提交时使用，不会保存在 Synapse。
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" onClick={() => setNoticeOpen(true)} className={studioGhostButtonClassName}>
              <FaInfoCircle /> 操作说明与风险提示
            </button>
            <button type="button" onClick={() => void handleExportUserData()} className={studioGhostButtonClassName}>
              <FaShieldAlt /> 导出我的任务数据
            </button>
          </div>
        </header>

        {submitUncertain && (
          <section className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800" role="alert">
            <p className="font-semibold">这次提交的结果不确定</p>
            <p className="mt-1">请先到「历史任务」里确认是否已经提交成功，**不要**直接重复提交，以免重复扣额。改动账号内容后才能再次提交。</p>
            <button type="button" onClick={() => { void handleSearchHistory(); }} className={cn(studioGhostButtonClassName, "mt-2")}>去历史任务确认</button>
          </section>
        )}

        {submitError && !submitUncertain && <p role="alert" className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{submitError}</p>}
        {submitNotice && <p role="status" aria-live="polite" className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{submitNotice}</p>}

        <div className="mt-6 grid min-w-0 gap-4 xl:grid-cols-2">
          <PixelCardPanel
            card={card}
            onCardChange={(value) => { setCard(value); pendingSubmitRef.current = null; setSubmitUncertain(false); }}
            onVerify={() => void handleVerify()}
            verifying={verifying}
            quota={quota}
            settings={settings}
            settingsError={settingsError}
            serviceType={serviceType}
            onServiceTypeChange={setServiceType}
            onOpenHistory={() => { void handleSearchHistory(); }}
          />
          <PixelSubmitPanel
            serviceType={serviceType}
            serviceOption={selectedOption}
            cardReady={cardReady}
            submitting={submitting}
            consentReady={noticeAcknowledged || hasAcknowledgedPixelNoticeToday()}
            resetSignal={submitResetSignal}
            blockedReason={submitUncertain ? "上次提交结果不确定，请先确认历史任务；改动账号内容后可再次提交。" : ""}
            onSubmit={handleSubmit}
            onOpenNotice={() => setNoticeOpen(true)}
          />
          <PixelTaskPanel
            task={task}
            loading={taskLoading}
            error={taskError}
            cancelBusyId={cancelBusyId}
            exporting={exporting}
            onRefresh={() => void refreshTask()}
            onCancelAccount={(accountId) => void handleCancelAccount(accountId)}
            onExport={() => void handleExportTask()}
          />
          <PixelHistoryPanel
            history={history}
            loading={historyLoading}
            error={historyError}
            empty={historyQueried && !historyLoading && history.length === 0}
            query={query}
            onQueryChange={setQuery}
            onSearch={() => void handleSearchHistory()}
            onOpenTask={(taskId) => void handleOpenTask(taskId)}
            onExportAll={() => void handleExportByCard()}
            exporting={exporting}
            canQuery={Boolean(card.trim())}
          />
        </div>
      </div>

      <PixelNoticeDialog
        open={noticeOpen}
        onClose={() => { setNoticeOpen(false); setNoticeAcknowledged(true); }}
        onAcknowledge={() => { setNoticeOpen(false); setNoticeAcknowledged(true); }}
      />
    </div>
  );
}
