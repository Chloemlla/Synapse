import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  FaBan,
  FaClipboardList,
  FaCloudUploadAlt,
  FaDownload,
  FaExclamationTriangle,
  FaFile,
  FaFolderOpen,
  FaHistory,
  FaList,
  FaPlus,
  FaRedo,
  FaSave,
  FaServer,
  FaShieldAlt,
  FaTerminal,
  FaTrash,
  FaUndo,
} from "react-icons/fa";
import type { IconType } from "react-icons";
import api from "../api/api";
import { useAuth } from "../hooks/useAuth";
import { isSuperAdmin } from "../utils/rbac";
import { useNotification } from "./Notification";
import { useConfirm } from './confirm/ConfirmDialogProvider';
import {
  InfoBadge,
  InfoMetricCard,
  InfoPanel,
  InfoQueryHero,
  InfoSectionTitle,
  studioFieldClassName,
  studioTileClassName,
} from './studioTheme';

/* ─────────── Types ─────────── */

interface OpsInstance {
  instanceId: string;
  installationId: string;
  status: "online" | "offline" | "registered";
  version: string;
  platform: string;
  minecraftVersion: string;
  serverName: string;
  lastSeenAt: string;
  registeredAt: string;
  policyVersion: string;
  capabilities: {
    fileOps: boolean;
    backupArchive: boolean;
    redactedExport: boolean;
    supportedMethods: string[];
  };
}

interface OpsJob {
  jobId: string;
  instanceId: string;
  method: string;
  commandId: string;
  status: "queued" | "dispatched" | "acknowledged" | "running" | "succeeded" | "failed" | "canceled" | "expired";
  requestId: string;
  createdAt: string;
  acceptedAt: string;
  completedAt: string;
  result: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
}

interface OpsCommandPolicy {
  commandId: string;
  description: string;
  riskLevel: "low" | "medium" | "high";
  allowedRoles: string[];
  timeoutSeconds: number;
  maxOutputBytes: number;
  requiresApproval: boolean;
  minecraftConsoleTemplate: string;
  isActive: boolean;
  argumentSchema: Record<string, unknown>;
}

interface OpsAuditLog {
  auditId: string;
  instanceId: string;
  action: string;
  actorType: string;
  targetType: string;
  targetId: string;
  result: "success" | "failure";
  message: string;
  createdAt: string;
}

/* ─────────── Constants & Helpers ─────────── */

const API_BASE = "/api/ecoenchants/v1";

const labelClass = "text-xs font-semibold uppercase tracking-[0.18em] text-slate-500";
const inputClass = `${studioFieldClassName} py-2.5`;

const statusBadgeTone = (status: string): "emerald" | "amber" | "slate" | "rose" => {
  switch (status) {
    case "online":
    case "succeeded":
    case "active":
      return "emerald";
    case "running":
    case "acknowledged":
    case "dispatched":
      return "amber";
    case "offline":
    case "queued":
      return "slate";
    case "failed":
    case "canceled":
    case "expired":
    case "suspended":
      return "rose";
    default:
      return "slate";
  }
};

const getErrorMessage = (error: unknown, fallback: string): string => {
  const anyError = error as any;
  return (
    anyError?.response?.data?.error?.message ||
    anyError?.response?.data?.message ||
    anyError?.message ||
    fallback
  );
};

/* ─────────── Sub-components ─────────── */

const Field: React.FC<{
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: string;
  required?: boolean;
}> = ({ label, value, onChange, placeholder, type = "text", required }) => (
  <label className="block space-y-2">
    <span className={labelClass}>{label}</span>
    <input
      className={inputClass}
      type={type}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      required={required}
    />
  </label>
);

const TextAreaField: React.FC<{
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
}> = ({ label, value, onChange, placeholder, rows = 3 }) => (
  <label className="block space-y-2">
    <span className={labelClass}>{label}</span>
    <textarea
      className={inputClass}
      rows={rows}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
    />
  </label>
);

const SelectField: React.FC<{
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ label: string; value: string }>;
  disabled?: boolean;
}> = ({ label, value, onChange, options, disabled }) => (
  <label className="block space-y-2">
    <span className={labelClass}>{label}</span>
    <select
      className={`${inputClass} disabled:opacity-50 disabled:cursor-not-allowed`}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      disabled={disabled}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  </label>
);

const SectionShell: React.FC<{
  title: string;
  description: string;
  icon: IconType;
  children: React.ReactNode;
  action?: React.ReactNode;
}> = ({ title, description, icon, children, action }) => (
  <InfoPanel>
    <InfoSectionTitle
      title={title}
      description={description}
      icon={icon}
      action={action}
    />
    {children}
  </InfoPanel>
);

/* ─────────── Ops Instances ─────────── */

function OpsInstancesSection({
  instances,
  loading,
  onRefresh,
  onSelect,
}: {
  instances: OpsInstance[];
  loading: boolean;
  onRefresh: () => void;
  onSelect: (id: string) => void;
}) {
  return (
    <SectionShell
      title="远程运维实例"
      description="已注册的 Minecraft 服务器实例，显示其在线状态和能力"
      icon={FaServer}
      action={
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-2xl bg-slate-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
        >
          <FaRedo className={loading ? "animate-spin" : ""} />
          刷新
        </button>
      }
    >
      {instances.length === 0 && !loading && (
        <div className="rounded-2xl border border-dashed border-slate-200 py-10 text-center text-sm text-slate-500">
          暂无已注册的运维实例
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {instances.map((inst) => (
          <button
            key={inst.instanceId}
            type="button"
            onClick={() => onSelect(inst.instanceId)}
            className={`${studioTileClassName} w-full p-4 text-left transition hover:shadow-md`}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold text-slate-900">
                    {inst.serverName || inst.instanceId.slice(0, 12)}
                  </span>
                  <InfoBadge tone={statusBadgeTone(inst.status)}>
                    {inst.status}
                  </InfoBadge>
                </div>
                <p className="mt-0.5 text-xs text-slate-500">
                  {inst.platform} {inst.minecraftVersion}
                </p>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
                v{inst.version}
              </span>
              <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
                {inst.installationId.slice(0, 12)}...
              </span>
              {inst.lastSeenAt && (
                <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
                  {new Date(inst.lastSeenAt).toLocaleDateString()}
                </span>
              )}
            </div>
            {inst.capabilities && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {inst.capabilities.fileOps && (
                  <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                    文件操作
                  </span>
                )}
                {inst.capabilities.backupArchive && (
                  <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600">
                    备份
                  </span>
                )}
              </div>
            )}
          </button>
        ))}
      </div>
    </SectionShell>
  );
}

/* ─────────── Instance Detail ─────────── */

function InstanceDetailSection({
  instanceId,
  onBack,
}: {
  instanceId: string;
  onBack: () => void;
}) {
  const { setNotification } = useNotification();
  const confirm = useConfirm();
  const { user } = useAuth();
  const canWrite = isSuperAdmin(user?.role);
  const [instance, setInstance] = useState<OpsInstance | null>(null);
  const [jobs, setJobs] = useState<OpsJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<"jobs" | "files" | "backups">("jobs");

  /* File ops state */
  const [fileReadPath, setFileReadPath] = useState("");
  const [fileWritePath, setFileWritePath] = useState("");
  const [fileWriteContent, setFileWriteContent] = useState("");
  const [fileDeletePath, setFileDeletePath] = useState("");
  const [fileOpsLoading, setFileOpsLoading] = useState(false);
  const [fileResult, setFileResult] = useState<string | null>(null);

  /* Backups state */
  const [backups, setBackups] = useState<
    { backupId: string; sizeBytes: number; createdAt: string; status: string }[]
  >([]);
  const [backupsLoading, setBackupsLoading] = useState(false);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  /* Create job */
  const [createJobMethod, setCreateJobMethod] = useState("ops.command.runManaged");
  const [createJobCommandId, setCreateJobCommandId] = useState("ecoenchants.reload");
  const [creatingJob, setCreatingJob] = useState(false);
  const [operationBusy, setOperationBusy] = useState(false);
  const [operationReason, setOperationReason] = useState('');
  const [fileMount, setFileMount] = useState('plugin-data');
  const [backupPaths, setBackupPaths] = useState('config.yml');
  const operationControllerRef = useRef(new AbortController());
  const operationBusyRef = useRef(false);
  const pendingOperationsRef = useRef(new Map<string, { key: string; jobId?: string }>());

  useEffect(() => {
    const controller = new AbortController();
    operationControllerRef.current = controller;
    return () => { controller.abort(); };
  }, [instanceId]);

  const runJob = useCallback(async (endpoint: string, body: Record<string, unknown>): Promise<OpsJob | null> => {
    if (operationBusyRef.current) return null;
    const signal = operationControllerRef.current.signal;
    signal.throwIfAborted();
    const signature = JSON.stringify([instanceId, endpoint, body]);
    const pending: { key: string; jobId?: string } = pendingOperationsRef.current.get(signature) || { key: crypto.randomUUID() };
    pendingOperationsRef.current.set(signature, pending);
    operationBusyRef.current = true;
    setOperationBusy(true);
    try {
      if (!pending.jobId) {
        // 网络结果不明确时保留本次操作的键，重试不会创建第二个写入任务。
        const response = await api.post(`${API_BASE}/ops/instances/${instanceId}${endpoint}`, body, {
          headers: { 'Idempotency-Key': pending.key }, signal,
        });
        signal.throwIfAborted();
        if (typeof response.data?.jobId !== 'string') throw new Error('未收到任务编号，请重试查询');
        pending.jobId = response.data.jobId;
        setNotification({ message: '任务已受理，正在等待执行结果', type: 'info' });
      }
      for (let attempt = 0; attempt < 60; attempt++) {
        const response = await api.get<OpsJob>(`${API_BASE}/ops/jobs/${pending.jobId}`, { signal });
        signal.throwIfAborted();
        const job = response.data;
        setJobs(previous => [job, ...previous.filter(item => item.jobId !== job.jobId)]);
        if (job.status === 'succeeded') {
          pendingOperationsRef.current.delete(signature);
          return job;
        }
        if (['failed', 'canceled', 'expired'].includes(job.status)) {
          pendingOperationsRef.current.delete(signature);
          throw new Error(job.error?.message || '任务未完成，请查看任务记录');
        }
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => { window.clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
          const timer = window.setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, 2000);
          signal.addEventListener('abort', onAbort, { once: true });
        });
      }
      setNotification({ message: '任务仍在执行，可稍后重试查询或查看任务记录', type: 'info' });
      return null;
    } finally {
      operationBusyRef.current = false;
      if (!signal.aborted) setOperationBusy(false);
    }
  }, [instanceId, setNotification]);

  const notifyOperationError = useCallback((error: unknown, message: string) => {
    if (!operationControllerRef.current.signal.aborted) {
      setNotification({ message: getErrorMessage(error, message), type: 'error' });
    }
  }, [setNotification]);

  const fetchInstance = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get(`${API_BASE}/ops/instances/${instanceId}`);
      setInstance(res.data.instance);
    } catch (e) {
      setNotification({ message: getErrorMessage(e, "获取实例详情失败"), type: "error" });
    } finally {
      setLoading(false);
    }
  }, [instanceId, setNotification]);

  const fetchJobs = useCallback(async () => {
    setJobsLoading(true);
    try {
      const res = await api.get(`${API_BASE}/ops/instances/${instanceId}/jobs`);
      setJobs(res.data.jobs || []);
    } catch (e) {
      setNotification({ message: getErrorMessage(e, "获取任务列表失败"), type: "error" });
    } finally {
      setJobsLoading(false);
    }
  }, [instanceId, setNotification]);

  const fetchBackups = useCallback(async () => {
    setBackupsLoading(true);
    try {
      const res = await api.get(`${API_BASE}/ops/instances/${instanceId}/backups`);
      setBackups(res.data.backups || []);
    } catch (e) {
      setNotification({ message: getErrorMessage(e, "获取备份列表失败"), type: "error" });
    } finally {
      setBackupsLoading(false);
    }
  }, [instanceId, setNotification]);

  useEffect(() => {
    fetchInstance();
    fetchJobs();
  }, [fetchInstance, fetchJobs]);

  /* All six operations return a job; only a succeeded job is a completed action. */
  const handleFileRead = async () => {
    if (!canWrite || !fileReadPath.trim()) return;
    setFileOpsLoading(true);
    setFileResult(null);
    try {
      const job = await runJob('/files/read', { mount: fileMount, path: fileReadPath.trim() });
      if (!job) return;
      const result = job.result || {};
      const content = typeof result.content === 'string' ? result.content
        : typeof result.contentBase64 === 'string'
          ? new TextDecoder().decode(Uint8Array.from(atob(result.contentBase64), character => character.charCodeAt(0)))
          : JSON.stringify(result, null, 2);
      setFileResult(content);
    } catch (error) {
      notifyOperationError(error, '文件读取失败');
    } finally { setFileOpsLoading(false); }
  };

  const handleFileWrite = async () => {
    if (!canWrite || !fileWritePath.trim() || !operationReason.trim()) return;
    const targetPath = fileWritePath.trim();
    const ok = await confirm({
      title: '确认覆盖远程文件？',
      description: `将覆盖实例「${instanceId}」目录「${fileMount}」中的「${targetPath}」，写入后不可撤销。`,
      tone: 'danger', confirmLabel: '覆盖写入',
    });
    if (!ok) return;
    setFileOpsLoading(true);
    try {
      const bytes = new TextEncoder().encode(fileWriteContent);
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const contentSha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      const contentBase64 = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
      const job = await runJob('/files/write', {
        mount: fileMount, path: targetPath, contentBase64, contentSha256,
        reason: operationReason.trim(), confirmRisk: true, mode: 'overwrite',
      });
      if (!job) return;
      setNotification({ message: '文件写入成功', type: 'success' });
      setFileWritePath('');
      setFileWriteContent('');
    } catch (error) {
      notifyOperationError(error, '文件写入失败');
    } finally { setFileOpsLoading(false); }
  };

  const handleFileDelete = async () => {
    if (!canWrite || !fileDeletePath.trim() || !operationReason.trim()) return;
    const ok = await confirm({
      title: `移除远程文件「${fileDeletePath}」？`,
      description: `将把目录「${fileMount}」中的该文件移入隔离区。`,
      tone: 'danger', confirmLabel: '移除文件',
    });
    if (!ok) return;
    setFileOpsLoading(true);
    try {
      const job = await runJob('/files/delete', {
        mount: fileMount, path: fileDeletePath.trim(), mode: 'quarantine',
        reason: operationReason.trim(), confirmRisk: true,
      });
      if (!job) return;
      setNotification({ message: '文件已移入隔离区', type: 'success' });
      setFileDeletePath('');
    } catch (error) {
      notifyOperationError(error, '文件移除失败');
    } finally { setFileOpsLoading(false); }
  };

  const handleCreateBackup = async () => {
    if (!canWrite || !operationReason.trim() || !backupPaths.trim()) return;
    try {
      const job = await runJob('/backups', {
        scope: { mounts: [fileMount], paths: backupPaths.split(',').map(path => path.trim()).filter(Boolean) },
        reason: operationReason.trim(),
      });
      if (!job) return;
      setNotification({ message: '备份创建成功', type: 'success' });
      await fetchBackups();
    } catch (error) { notifyOperationError(error, '创建备份失败'); }
  };

  const handleRestoreBackup = async (backupId: string) => {
    if (!canWrite || !operationReason.trim() || !backupPaths.trim()) return;
    const restorePaths = backupPaths.split(',').map(path => path.trim()).filter(Boolean);
    const ok = await confirm({
      title: `恢复备份「${backupId.slice(0, 16)}…」？`,
      description: `将从备份恢复以下路径：${restorePaths.join('、')}。恢复前会创建备份，操作可能中断服务。`,
      tone: 'danger', confirmLabel: '恢复备份',
    });
    if (!ok) return;
    setRestoringId(backupId);
    try {
      const job = await runJob(`/backups/${backupId}/restore`, {
        restorePaths, mode: 'staged', preRestoreBackup: true,
        reason: operationReason.trim(), confirmRisk: true,
      });
      if (job) setNotification({ message: '备份恢复成功', type: 'success' });
    } catch (error) {
      notifyOperationError(error, '恢复备份失败');
    } finally { setRestoringId(null); }
  };

  const handleCreateJob = async () => {
    if (!canWrite || !operationReason.trim()) return;
    const ok = await confirm({
      title: '执行远程任务？', description: `将在实例「${instanceId}」上执行当前选择的任务。`,
      confirmLabel: '执行', tone: 'danger',
    });
    if (!ok) return;
    setCreatingJob(true);
    try {
      const job = await runJob('/jobs', {
        method: createJobMethod,
        params: createJobMethod === 'ops.command.runManaged' ? { commandId: createJobCommandId, arguments: {} } : {},
        reason: operationReason.trim(), confirmRisk: true,
      });
      if (job) setNotification({ message: '任务执行成功', type: 'success' });
    } catch (error) {
      notifyOperationError(error, '执行任务失败');
    } finally { setCreatingJob(false); }
  };

  if (loading && !instance) {
    return (
      <SectionShell title="实例详情" description={`ID: ${instanceId}`} icon={FaServer}>
        <div className="py-8 text-center text-sm text-slate-500">加载中...</div>
      </SectionShell>
    );
  }

  return (
    <div className="space-y-6">
      {/* Back button + header */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-2 rounded-2xl bg-slate-100 px-3 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-200"
        >
          ← 返回列表
        </button>
        <h3 className="text-lg font-semibold text-slate-800">
          实例 {instance?.serverName || instanceId.slice(0, 12)}
        </h3>
        {instance && <InfoBadge tone={statusBadgeTone(instance.status)}>{instance.status}</InfoBadge>}
      </div>

      {/* Instance metrics */}
      {instance && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <InfoMetricCard label="平台" value={`${instance.platform} ${instance.minecraftVersion}`} icon={FaServer} />
          <InfoMetricCard label="版本" value={instance.version} icon={FaHistory} />
          <InfoMetricCard
            label="最后在线"
            value={instance.lastSeenAt ? new Date(instance.lastSeenAt).toLocaleString() : "-"}
            icon={FaHistory}
          />
          <InfoMetricCard label="策略版本" value={instance.policyVersion || "-"} icon={FaShieldAlt} />
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 rounded-2xl bg-slate-100 p-1">
        {([
          { key: "jobs" as const, label: "任务", icon: FaClipboardList },
          { key: "files" as const, label: "文件操作", icon: FaFolderOpen },
          { key: "backups" as const, label: "备份", icon: FaCloudUploadAlt },
        ] as const).map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => {
              setActiveTab(tab.key);
              if (tab.key === "backups") fetchBackups();
            }}
            className={`flex flex-1 items-center justify-center gap-2 rounded-2xl px-3 py-2 text-sm font-medium transition ${
              activeTab === tab.key
                ? "bg-white/80 backdrop-blur-xl text-slate-900 shadow-sm"
                : "text-slate-500 hover:text-slate-700"
            }`}
          >
            <tab.icon className="h-4 w-4" />
            {tab.label}
          </button>
        ))}
      </div>

      <fieldset disabled={operationBusy} className="space-y-4 disabled:opacity-70">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="操作原因（写入、任务与备份必填）" value={operationReason} onChange={setOperationReason} />
          {activeTab !== 'jobs' && <SelectField label="文件目录" value={fileMount} onChange={setFileMount} options={[
            { label: '插件数据', value: 'plugin-data' }, { label: '服务器目录', value: 'server-root' },
            { label: '配置', value: 'config' }, { label: '日志', value: 'logs' }, { label: '备份', value: 'backups' },
          ]} />}
          {activeTab === 'backups' && <Field label="备份 / 恢复相对路径（逗号分隔）" value={backupPaths} onChange={setBackupPaths} />}
        </div>
        {operationBusy && <p role="status" className="text-sm text-slate-600">任务处理中，正在等待执行结果…</p>}
      {/* Jobs Tab */}
      {activeTab === "jobs" && (
        <div className="space-y-4">
          {/* Create job */}
          <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-5">
            <span className={labelClass}>创建新任务</span>
            <div className="mt-4 grid gap-4 sm:grid-cols-3">
              <SelectField
                label="任务类型"
                value={createJobMethod}
                onChange={setCreateJobMethod}
                disabled={!canWrite}
                options={[
                  { label: "ops.command.runManaged", value: "ops.command.runManaged" },
                  { label: "ops.diagnostics.snapshot", value: "ops.diagnostics.snapshot" },
                ]}
              />
              <SelectField
                label="托管命令"
                value={createJobCommandId}
                onChange={setCreateJobCommandId}
                disabled={!canWrite}
                options={[
                  { label: "ecoenchants.reload", value: "ecoenchants.reload" },
                  { label: "ecoenchants.services.status", value: "ecoenchants.services.status" },
                ]}
              />
              <div className="flex items-end">
                <button
                  type="button"
                  onClick={handleCreateJob}
                  disabled={creatingJob || !canWrite || !operationReason.trim()}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  <FaPlus />
                  {creatingJob ? "创建中..." : "创建任务"}
                </button>
              </div>
            </div>
          </div>

          {/* Job list */}
          {jobsLoading ? (
            <div className="py-4 text-center text-sm text-slate-500">加载中...</div>
          ) : jobs.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-200 py-8 text-center text-sm text-slate-500">
              暂无任务记录
            </div>
          ) : (
            <div className="space-y-2">
              {jobs.map((job) => (
                <div key={job.jobId} className={`${studioTileClassName} p-4`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <InfoBadge tone={statusBadgeTone(job.status)}>{job.status}</InfoBadge>
                    <span className="font-mono text-xs text-slate-400">{job.jobId.slice(0, 16)}...</span>
                    <span className="text-sm font-medium text-slate-700">{job.method}</span>
                    {job.commandId && (
                      <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
                        {job.commandId}
                      </span>
                    )}
                  </div>
                  <div className="mt-1.5 text-xs text-slate-500">
                    {job.createdAt && <span>创建于 {new Date(job.createdAt).toLocaleString()}</span>}
                    {job.completedAt && (
                      <span className="ml-3">完成于 {new Date(job.completedAt).toLocaleString()}</span>
                    )}
                  </div>
                  {job.result && <details className="mt-2 text-xs"><summary>执行结果</summary><pre className="overflow-auto whitespace-pre-wrap">{JSON.stringify(job.result, null, 2)}</pre></details>}
                  {job.error && (
                    <div className="mt-2 rounded-2xl border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                      [{job.error.code}] {job.error.message}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Files Tab */}
      {activeTab === "files" && (
        <div className="space-y-4">
          <div className="rounded-2xl border border-slate-200 bg-white/80 backdrop-blur-xl p-5">
            <span className={labelClass}>读取文件</span>
            <div className="mt-3 flex flex-col sm:flex-row gap-2">
              <input
                type="text"
                value={fileReadPath}
                onChange={(e) => setFileReadPath(e.target.value)}
                placeholder="相对所选目录的路径，如 config.yml"
                disabled={!canWrite}
                className={`${inputClass} disabled:opacity-50 disabled:cursor-not-allowed`}
              />
              <button
                type="button"
                onClick={handleFileRead}
                disabled={fileOpsLoading || !fileReadPath.trim() || !canWrite}
                className="inline-flex shrink-0 items-center gap-2 rounded-2xl bg-slate-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-700 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <FaDownload />
                读取
              </button>
            </div>
            {fileResult && (
              <pre className="mt-3 max-h-64 overflow-auto rounded-2xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
                {fileResult}
              </pre>
            )}
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white/80 backdrop-blur-xl p-5">
            <span className={labelClass}>写入文件</span>
            <div className="mt-3 space-y-3">
              <input
                type="text"
                value={fileWritePath}
                onChange={(e) => setFileWritePath(e.target.value)}
                placeholder="相对所选目录的路径"
                disabled={!canWrite}
                className={`${inputClass} disabled:opacity-50 disabled:cursor-not-allowed`}
              />
              <textarea
                value={fileWriteContent}
                onChange={(e) => setFileWriteContent(e.target.value)}
                rows={4}
                placeholder="文件内容..."
                disabled={!canWrite}
                className={`${inputClass} font-mono disabled:opacity-50 disabled:cursor-not-allowed`}
              />
              <button
                type="button"
                onClick={handleFileWrite}
                disabled={fileOpsLoading || !fileWritePath.trim() || !operationReason.trim() || !canWrite}
                className="inline-flex items-center gap-2 rounded-2xl bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-emerald-700 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <FaSave />
                写入
              </button>
            </div>
          </div>

          <div className="rounded-2xl border border-red-200 bg-white/80 backdrop-blur-xl p-5">
            <span className={`${labelClass} text-red-600`}>删除文件</span>
            <div className="mt-3 flex flex-col sm:flex-row gap-2">
              <input
                type="text"
                value={fileDeletePath}
                onChange={(e) => setFileDeletePath(e.target.value)}
                placeholder="相对所选目录的路径"
                disabled={!canWrite}
                className={`${inputClass} disabled:opacity-50 disabled:cursor-not-allowed`}
              />
              <button
                type="button"
                onClick={handleFileDelete}
                disabled={fileOpsLoading || !fileDeletePath.trim() || !operationReason.trim() || !canWrite}
                className="inline-flex shrink-0 items-center gap-2 rounded-2xl bg-red-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-red-700 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <FaTrash />
                删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Backups Tab */}
      {activeTab === "backups" && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button
              type="button"
              onClick={handleCreateBackup}
              disabled={!canWrite || !operationReason.trim() || !backupPaths.trim()}
              className="inline-flex items-center gap-2 rounded-2xl bg-indigo-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-indigo-700 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <FaPlus />
              创建备份
            </button>
          </div>

          {backupsLoading ? (
            <div className="py-4 text-center text-sm text-slate-500">加载中...</div>
          ) : backups.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-200 py-8 text-center text-sm text-slate-500">
              暂无备份
            </div>
          ) : (
            <div className="space-y-2">
              {backups.map((bk) => (
                <div key={bk.backupId} className={`${studioTileClassName} flex items-center justify-between p-4`}>
                  <div>
                    <div className="font-mono text-sm text-slate-700">{bk.backupId.slice(0, 20)}...</div>
                    <div className="mt-1 text-xs text-slate-500">
                      {bk.status} · {bk.createdAt ? new Date(bk.createdAt).toLocaleString() : "-"}
                      {bk.sizeBytes > 0 && ` · ${(bk.sizeBytes / 1024 / 1024).toFixed(2)} MB`}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRestoreBackup(bk.backupId)}
                    disabled={restoringId === bk.backupId || bk.status !== "available" || !canWrite || !operationReason.trim() || !backupPaths.trim()}
                    className="inline-flex items-center gap-2 rounded-2xl bg-amber-600 px-3 py-2 text-sm font-medium text-white transition hover:bg-amber-700 disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    <FaUndo />
                    {restoringId === bk.backupId ? "恢复中..." : "恢复"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      </fieldset>
    </div>
  );
}

/* ─────────── Audit Logs ─────────── */

function OpsAuditLogsSection({
  logs,
  loading,
  onRefresh,
}: {
  logs: OpsAuditLog[];
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <SectionShell
      title="运维审计日志"
      description="远程操作审计记录，包括文件操作、命令执行和备份恢复"
      icon={FaHistory}
      action={
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-2xl bg-slate-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-60"
        >
          <FaRedo className={loading ? "animate-spin" : ""} />
          刷新
        </button>
      }
    >
      {logs.length === 0 && !loading && (
        <div className="rounded-2xl border border-dashed border-slate-200 py-10 text-center text-sm text-slate-500">
          暂无审计记录
        </div>
      )}
      <div className="space-y-2">
        {logs.map((log) => (
          <div key={log.auditId} className={`${studioTileClassName} p-4`}>
            <div className="flex flex-wrap items-center gap-2">
              <InfoBadge tone={log.result === "success" ? "emerald" : "rose"}>{log.result}</InfoBadge>
              <span className="font-medium text-slate-900">{log.action}</span>
              <span className="text-xs text-slate-500">
                {log.actorType}
              </span>
              {log.instanceId && (
                <span className="font-mono text-xs text-slate-400">{log.instanceId.slice(0, 12)}...</span>
              )}
            </div>
            <div className="mt-1.5 text-xs text-slate-500">
              {log.createdAt ? new Date(log.createdAt).toLocaleString() : "-"}
              {log.message && <span className="ml-2">· {log.message}</span>}
            </div>
          </div>
        ))}
      </div>
    </SectionShell>
  );
}

/* ─────────── Command Policies ─────────── */

function OpsCommandPoliciesSection({
  policies,
  loading,
  onRefresh,
}: {
  policies: OpsCommandPolicy[];
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <SectionShell
      title="命令策略"
      description="配置远程可执行的命令及其安全策略"
      icon={FaShieldAlt}
      action={
        <button
          type="button"
          onClick={onRefresh}
          disabled={loading}
          className="inline-flex items-center gap-2 rounded-2xl bg-slate-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-slate-800 disabled:opacity-60"
        >
          <FaRedo className={loading ? "animate-spin" : ""} />
          刷新
        </button>
      }
    >
      {policies.length === 0 && !loading && (
        <div className="rounded-2xl border border-dashed border-slate-200 py-10 text-center text-sm text-slate-500">
          暂无命令策略配置
        </div>
      )}
      <div className="space-y-3">
        {policies.map((p) => (
          <div key={p.commandId} className={`${studioTileClassName} p-4`}>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono font-semibold text-slate-900">{p.commandId}</span>
              <InfoBadge
                tone={p.riskLevel === "high" ? "rose" : p.riskLevel === "medium" ? "amber" : "emerald"}
              >
                {p.riskLevel}
              </InfoBadge>
              <InfoBadge tone={p.isActive ? "emerald" : "slate"}>{p.isActive ? "启用" : "停用"}</InfoBadge>
            </div>
            <p className="mt-2 text-sm text-slate-600">{p.description}</p>
            <div className="mt-2 flex flex-wrap gap-2 text-xs text-slate-500">
              <span>超时: {p.timeoutSeconds}s</span>
              <span>
                最大输出: {p.maxOutputBytes > 1024 ? `${(p.maxOutputBytes / 1024).toFixed(0)}KB` : `${p.maxOutputBytes}B`}
              </span>
              <span>角色: {p.allowedRoles.join(", ") || "无限制"}</span>
              {p.requiresApproval && <span className="text-amber-600">需要审批</span>}
            </div>
          </div>
        ))}
      </div>
    </SectionShell>
  );
}

/* ─────────── Main Panel ─────────── */

export function EcoEnchantsOpsPanel() {
  const { setNotification } = useNotification();
  const [instances, setInstances] = useState<OpsInstance[]>([]);
  const [instancesLoading, setInstancesLoading] = useState(false);
  const [auditLogs, setAuditLogs] = useState<OpsAuditLog[]>([]);
  const [auditLogsLoading, setAuditLogsLoading] = useState(false);
  const [policies, setPolicies] = useState<OpsCommandPolicy[]>([]);
  const [policiesLoading, setPoliciesLoading] = useState(false);
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);

  const fetchInstances = useCallback(async () => {
    setInstancesLoading(true);
    try {
      const res = await api.get(`${API_BASE}/ops/instances`);
      setInstances(res.data.instances || []);
    } catch (e) {
      setNotification({ message: getErrorMessage(e, "获取实例列表失败"), type: "error" });
    } finally {
      setInstancesLoading(false);
    }
  }, [setNotification]);

  const fetchAuditLogs = useCallback(async () => {
    setAuditLogsLoading(true);
    try {
      const res = await api.get(`${API_BASE}/ops/audit-logs?page=1&pageSize=20`);
      setAuditLogs(res.data.logs || []);
    } catch (e) {
      setNotification({ message: getErrorMessage(e, "获取审计日志失败"), type: "error" });
    } finally {
      setAuditLogsLoading(false);
    }
  }, [setNotification]);

  const fetchPolicies = useCallback(async () => {
    setPoliciesLoading(true);
    try {
      const res = await api.get(`${API_BASE}/ops/policies/commands`);
      setPolicies(res.data.policies || []);
    } catch (e) {
      setNotification({ message: getErrorMessage(e, "获取命令策略失败"), type: "error" });
    } finally {
      setPoliciesLoading(false);
    }
  }, [setNotification]);

  useEffect(() => {
    fetchInstances();
    fetchAuditLogs();
    fetchPolicies();
  }, [fetchInstances, fetchAuditLogs, fetchPolicies]);

  return (
    <div className="space-y-6">
      <InfoQueryHero
        eyebrow="EcoEnchants"
        title="EcoEnchants 远程运维"
        description="管理已注册的 Minecraft 服务器实例，执行远程命令、文件操作和备份恢复。"
        icon={FaTerminal}
      />

      {selectedInstanceId ? (
        <InstanceDetailSection
          key={selectedInstanceId}
          instanceId={selectedInstanceId}
          onBack={() => setSelectedInstanceId(null)}
        />
      ) : (
        <OpsInstancesSection
          instances={instances}
          loading={instancesLoading}
          onRefresh={fetchInstances}
          onSelect={setSelectedInstanceId}
        />
      )}

      <OpsAuditLogsSection
        logs={auditLogs}
        loading={auditLogsLoading}
        onRefresh={fetchAuditLogs}
      />

      <OpsCommandPoliciesSection
        policies={policies}
        loading={policiesLoading}
        onRefresh={fetchPolicies}
      />
    </div>
  );
}

export default EcoEnchantsOpsPanel;