import { useCallback, useEffect, useRef, useState } from "react";
import { FaCloud, FaSync, FaTrash, FaUsers } from "react-icons/fa";
import { useAuth } from "../../hooks/useAuth";
import { useConfirm } from "../confirm/ConfirmDialogProvider";
import useFeatureConsent from "../../hooks/useFeatureConsent";
import { cn } from "../../utils/cn";
import FeatureConsentGate from "../FeatureConsentGate";
import {
  studioFieldClassName,
  studioGhostButtonClassName,
  studioPanelClassName,
  studioPrimaryButtonClassName,
  studioPillClassName,
  studioSubPanelClassName,
} from "../studioTheme";
import {
  createGeoGebraProject,
  createGeoGebraVersion,
  createUserWorkspace,
  deleteGeoGebraProject,
  exportGeoGebraData,
  inviteWorkspaceMember,
  listGeoGebraProjects,
  listUserWorkspaces,
  updateGeoGebraProject,
} from "../../api/geogebra";
import type { GeoGebraLocalProject, GeoGebraProject, WorkspaceSummary } from "./types";

const AUTO_SYNC_KEY = "synapse-geogebra-cloud-sync-enabled";
const AUTO_SYNC_INTERVAL_MS = 5 * 60_000;

type Props = {
  project: GeoGebraLocalProject | null;
  onProjectSynced: (projectId: string, revision: number, workspaceId: string | null) => void;
  onOpenProject: (project: GeoGebraProject) => void;
  onProjectDeleted: (projectId: string) => void;
  onWorkspaceChange: (workspaceId: string | null) => void;
};

export default function GeoGebraCloudPanel({ project, onProjectSynced, onOpenProject, onProjectDeleted, onWorkspaceChange }: Props) {
  const { user } = useAuth();
  const confirm = useConfirm();
  const { ready: projectConsentReady } = useFeatureConsent("geogebra-projects");
  const [projects, setProjects] = useState<GeoGebraProject[]>([]);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [autoSync, setAutoSync] = useState(() => {
    try { return window.localStorage.getItem(AUTO_SYNC_KEY) === "true"; } catch { return false; }
  });
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"editor" | "reviewer" | "viewer">("reviewer");
  const [teamBusy, setTeamBusy] = useState(false);
  const syncRef = useRef<((createSnapshot: boolean) => Promise<void>) | null>(null);

  const refresh = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError("");
    try {
      const [nextProjects, nextWorkspaces] = await Promise.all([listGeoGebraProjects(), listUserWorkspaces()]);
      setProjects(nextProjects);
      setWorkspaces(nextWorkspaces);
    } catch {
      setError("云端项目暂时无法载入，请稍后重试。");
    } finally {
      setLoading(false);
    }
  }, [projectConsentReady, user]);

  useEffect(() => { void refresh(); }, [refresh]);

  const syncNow = useCallback(async (createSnapshot: boolean) => {
    if (!project || !user || !projectConsentReady || busy) return;
    setBusy(true);
    setError("");
    setStatus("正在保存项目…");
    try {
      const current = projects.find((item) => item.projectId === project.projectId);
      const payload = {
        projectId: project.projectId,
        title: project.title,
        folder: project.folder,
        tags: project.tags,
        isFavorite: project.isFavorite,
        canvasMode: project.canvasMode,
        code: project.code,
        workspaceId: project.workspaceId,
      };
      const saved = current
        ? await updateGeoGebraProject(project.projectId, { ...payload, revision: project.cloudRevision ?? current.revision })
        : await createGeoGebraProject(payload);
      if (createSnapshot) {
        await createGeoGebraVersion(saved.projectId, {
          label: "手动同步快照",
          code: project.code,
          canvasMode: project.canvasMode,
          trigger: "manual_sync",
        });
      }
      onProjectSynced(saved.projectId, saved.revision, saved.workspaceId);
      setProjects((items) => [saved, ...items.filter((item) => item.projectId !== saved.projectId)]);
      setStatus("项目已保存。");
    } catch (caught) {
      const statusCode = (caught as { response?: { status?: number } })?.response?.status;
      if (statusCode === 409) {
        setError("云端已有较新的项目版本。重新打开云端项目后再保存，可避免覆盖他人修改。");
        void refresh();
      } else {
        setError("项目保存失败，请检查网络后重试。");
      }
      setStatus("");
    } finally {
      setBusy(false);
    }
  }, [busy, onProjectSynced, project, projectConsentReady, projects, refresh, user]);
  syncRef.current = syncNow;

  useEffect(() => {
    if (!autoSync || !user || !projectConsentReady || !project) return undefined;
    const timer = window.setInterval(() => { void syncRef.current?.(false); }, AUTO_SYNC_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [autoSync, project?.projectId, projectConsentReady, user]);

  const handleAutoSync = (enabled: boolean) => {
    setAutoSync(enabled);
    try { window.localStorage.setItem(AUTO_SYNC_KEY, String(enabled)); } catch { /* local preference only */ }
  };

  const handleCreateWorkspace = async () => {
    if (!workspaceName.trim() || teamBusy) return;
    setTeamBusy(true);
    setError("");
    try {
      const workspace = await createUserWorkspace({ name: workspaceName.trim() });
      setWorkspaces((items) => [workspace, ...items]);
      setWorkspaceName("");
      onWorkspaceChange(workspace.id);
      setStatus("团队空间已创建。");
    } catch {
      setError("团队空间暂时无法创建，请重试。");
    } finally {
      setTeamBusy(false);
    }
  };

  const handleInvite = async () => {
    if (!project?.workspaceId || !inviteEmail.trim() || teamBusy) return;
    setTeamBusy(true);
    setError("");
    try {
      await inviteWorkspaceMember(project.workspaceId, { email: inviteEmail.trim(), role: inviteRole });
      setInviteEmail("");
      setStatus("邀请已发送。");
    } catch {
      setError("邀请暂时无法发送，请确认邮箱并重试。");
    } finally {
      setTeamBusy(false);
    }
  };

  const handleExportData = async () => {
    try {
      const file = await exportGeoGebraData();
      const url = URL.createObjectURL(file);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "geogebra-data.json";
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setStatus("项目数据已导出。");
    } catch {
      setError("项目数据暂时无法导出，请重试。");
    }
  };

  const handleDeleteCloudProject = async (target: GeoGebraProject) => {
    const approved = await confirm({
      title: "删除云端项目",
      description: "项目、快照和评论将被删除，关联的公开分享会同时撤销。",
      confirmLabel: "删除项目",
      tone: "danger",
    });
    if (!approved) return;
    try {
      await deleteGeoGebraProject(target.projectId);
      setProjects((items) => items.filter((item) => item.projectId !== target.projectId));
      onProjectDeleted(target.projectId);
      setStatus("云端项目已删除。");
    } catch {
      setError("项目暂时无法删除，请重试。");
    }
  };

  if (!user) {
    return (
      <section className={studioPanelClassName}>
        <h2 className="text-lg font-semibold text-slate-900">云端项目与团队</h2>
        <p className="mt-2 text-sm text-slate-600">登录后可在自己的账号下保存项目、同步设备并邀请团队成员。</p>
        <a href="/login" className={cn(studioPrimaryButtonClassName, "mt-4")}>登录后继续</a>
      </section>
    );
  }

  return (
      <section className={studioPanelClassName} aria-labelledby="geogebra-cloud-heading">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">Cloud Workspace</p>
            <h2 id="geogebra-cloud-heading" className="mt-1 text-lg font-semibold text-slate-900">云端项目与团队</h2>
            <p className="mt-1 text-sm text-slate-500">在登录账号下保存项目，并邀请团队成员共同审阅。</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => void refresh()} disabled={loading} className={studioGhostButtonClassName}>
              <FaSync className={loading ? "animate-spin" : undefined} /> 刷新
            </button>
            <button type="button" onClick={() => void handleExportData()} className={studioGhostButtonClassName}>导出我的项目</button>
          </div>
        </div>

        {error && <p role="alert" className="mb-3 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</p>}
        {status && <p role="status" aria-live="polite" className="mb-3 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{status}</p>}

        <div className="grid min-w-0 gap-4 xl:grid-cols-2">
          <div className={studioSubPanelClassName}>
            <div className="mb-3 flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-900">当前项目</h3>
              <span className={studioPillClassName(Boolean(project?.cloudRevision))}><FaCloud /> {project?.cloudRevision ? "已同步" : "本地草稿"}</span>
            </div>
            {project ? (
              <>
                <p className="truncate text-sm font-semibold text-slate-800">{project.title}</p>
                <p className="mt-1 text-xs text-slate-500">{project.folder} · {project.tags.join(", ") || "无标签"}</p>
                <FeatureConsentGate feature="geogebra-projects">
                  <div className="space-y-3">
                    <label className="mt-4 block text-xs font-semibold text-slate-600">
                      团队空间
                      <select
                        className={cn(studioFieldClassName, "mt-1")}
                        value={project.workspaceId ?? ""}
                        onChange={(event) => onWorkspaceChange(event.target.value || null)}
                      >
                        <option value="">个人空间</option>
                        {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
                      </select>
                    </label>
                    <div className="flex flex-wrap items-center gap-3">
                      <label className="flex min-h-11 items-center gap-2 text-sm text-slate-700">
                        <input type="checkbox" checked={autoSync} onChange={(event) => handleAutoSync(event.target.checked)} />
                        每 5 分钟自动保存
                      </label>
                      <button type="button" onClick={() => void syncNow(true)} disabled={busy} className={studioPrimaryButtonClassName}>
                        <FaCloud /> {busy ? "保存中…" : "立即保存到云端"}
                      </button>
                    </div>
                  </div>
                </FeatureConsentGate>
              </>
            ) : <p className="text-sm text-slate-500">先创建一个本地项目。</p>}

            <div className="mt-5 border-t border-slate-200 pt-4">
              <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-900"><FaUsers /> 团队空间</h3>
              <div className="mt-3 flex gap-2">
                <input className={studioFieldClassName} value={workspaceName} maxLength={100} onChange={(event) => setWorkspaceName(event.target.value)} placeholder="新团队名称" />
                <button type="button" onClick={() => void handleCreateWorkspace()} disabled={teamBusy || !workspaceName.trim()} className={studioGhostButtonClassName}>创建</button>
              </div>
              {project?.workspaceId && (
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <input className={studioFieldClassName} value={inviteEmail} type="email" onChange={(event) => setInviteEmail(event.target.value)} placeholder="成员邮箱" />
                  <select className={studioFieldClassName} value={inviteRole} onChange={(event) => setInviteRole(event.target.value as typeof inviteRole)}>
                    <option value="editor">编辑者</option>
                    <option value="reviewer">审阅者</option>
                    <option value="viewer">查看者</option>
                  </select>
                  <button type="button" onClick={() => void handleInvite()} disabled={teamBusy || !inviteEmail.trim()} className={studioGhostButtonClassName}>邀请</button>
                </div>
              )}
            </div>
          </div>

          <div className={studioSubPanelClassName}>
            <div className="mb-3 flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-900">可访问的云端项目</h3>
              <span className="text-xs text-slate-500">{projects.length} 个项目</span>
            </div>
            {loading ? <p role="status" className="text-sm text-slate-500">正在载入云端项目…</p> : projects.length ? (
              <div className="space-y-2">
                {projects.map((item) => {
                  const memberRole = workspaces.find((workspace) => workspace.id === item.workspaceId)?.members.find((member) => member.userId === user.id)?.role;
                  const canDelete = item.isOwner || memberRole === "admin";
                  return (
                    <div key={item.projectId} className="flex items-center gap-2">
                      <button type="button" onClick={() => onOpenProject(item)} className="min-h-14 min-w-0 flex-1 rounded-2xl border border-slate-200 bg-white/80 px-3 py-2 text-left transition hover:border-slate-300 hover:shadow-sm">
                        <span className="block truncate text-sm font-semibold text-slate-800">{item.title}</span>
                        <span className="mt-1 block truncate text-xs text-slate-500">{item.folder} · {item.tags.join(", ") || "无标签"} · {new Date(item.updatedAt).toLocaleDateString("zh-CN")}</span>
                      </button>
                      {canDelete && <button type="button" onClick={() => void handleDeleteCloudProject(item)} aria-label={`删除项目 ${item.title}`} title="删除项目" className={cn(studioGhostButtonClassName, "text-rose-700 hover:border-rose-200 hover:bg-rose-50")}><FaTrash /></button>}
                    </div>
                  );
                })}
              </div>
            ) : <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/80 px-4 py-8 text-center text-sm text-slate-500">保存项目后，可在这里从任意设备继续。</div>}
          </div>
        </div>
      </section>
  );
}
