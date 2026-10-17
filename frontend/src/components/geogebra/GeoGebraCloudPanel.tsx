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
  studioTileClassName,
} from "../studioTheme";
import { StudioEmptyState, StudioErrorNote, StudioLoadingState, StudioSuccessNote } from "../studioFeedback";
import {
  createGeoGebraProject,
  createGeoGebraVersion,
  createUserWorkspace,
  deleteGeoGebraProject,
  exportGeoGebraData,
  getGeoGebraProject,
  inviteWorkspaceMember,
  listGeoGebraProjects,
  listGeoGebraVersions,
  listUserWorkspaces,
  listWorkspaceMembers,
  removeWorkspaceMember,
  updateGeoGebraProject,
  updateWorkspaceMemberRole,
} from "../../api/geogebra";
import { summarizeGeoGebraDiff } from "./script";
import type { GeoGebraLocalProject, GeoGebraMode, GeoGebraProject, GeoGebraVersion, WorkspaceSummary } from "../../types/geogebra";

const AUTO_SYNC_KEY = "synapse-geogebra-cloud-sync-enabled";
const AUTO_SYNC_INTERVAL_MS = 5 * 60_000;
const ROLE_LABELS: Record<string, string> = { admin: "管理员", editor: "编辑者", reviewer: "审阅者", viewer: "查看者" };

type Props = {
  project: GeoGebraLocalProject | null;
  onProjectSynced: (projectId: string, revision: number, workspaceId: string | null) => void;
  onOpenProject: (project: GeoGebraProject) => void;
  onProjectDeleted: (projectId: string) => void;
  onWorkspaceChange: (workspaceId: string | null) => void;
  onApplyVersion: (code: string, canvasMode: GeoGebraMode) => void;
};

export default function GeoGebraCloudPanel({ project, onProjectSynced, onOpenProject, onProjectDeleted, onWorkspaceChange, onApplyVersion }: Props) {
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
  const [members, setMembers] = useState<WorkspaceSummary["members"]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersError, setMembersError] = useState("");
  const [cloudVersions, setCloudVersions] = useState<GeoGebraVersion[]>([]);
  const [versionsError, setVersionsError] = useState("");
  // 冲突不只是一个 409：本地稿、云端稿与共同基线三者的先后关系决定该保留哪一份，
  // 所以这里把云端稿与逐行差异一起摊开，由用户显式选。
  const [conflict, setConflict] = useState<{ cloud: GeoGebraProject; diff: ReturnType<typeof summarizeGeoGebraDiff> } | null>(null);
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

  useEffect(() => {
    const workspaceId = project?.workspaceId;
    if (!user || !workspaceId) {
      setMembers([]);
      setMembersError("");
      return undefined;
    }
    let active = true;
    setMembersLoading(true);
    setMembersError("");
    void listWorkspaceMembers(workspaceId)
      .then((items) => { if (active) setMembers(items); })
      .catch(() => {
        if (!active) return;
        setMembers([]);
        setMembersError("成员名单暂时无法载入，请稍后重试。");
      })
      .finally(() => { if (active) setMembersLoading(false); });
    return () => { active = false; };
  }, [project?.workspaceId, user]);

  useEffect(() => {
    if (!user || !project?.cloudRevision) {
      setCloudVersions([]);
      setVersionsError("");
      return undefined;
    }
    let active = true;
    setVersionsError("");
    void listGeoGebraVersions(project.projectId)
      .then((items) => { if (active) setCloudVersions(items); })
      .catch(() => {
        if (!active) return;
        setCloudVersions([]);
        setVersionsError("云端历史版本暂时无法载入，请稍后重试。");
      });
    return () => { active = false; };
  }, [project?.cloudRevision, project?.projectId, user]);

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
        const cloud = await getGeoGebraProject(project.projectId).catch(() => null);
        if (cloud) {
          setConflict({ cloud, diff: summarizeGeoGebraDiff(project.code, cloud.code) });
          setError("");
          setStatus("云端已有更新的版本，请选择保留哪一份。");
          return;
        }
        setError("云端已有较新的项目版本。重新打开云端项目后再保存，可避免覆盖他人修改。");
      } else {
        setError("项目保存失败，请检查网络后重试。");
        setStatus("");
      }
    } finally {
      setBusy(false);
    }
  }, [busy, onProjectSynced, project, projectConsentReady, projects, refresh, user]);
  syncRef.current = syncNow;

  const keepLocalOnConflict = useCallback(async () => {
    if (!conflict || !project || busy) return;
    setBusy(true);
    setError("");
    try {
      // 用云端已确认的 revision 作为前提提交，才能把“本机覆盖”与“又被人改过”区分开：
      // 如果再被并发修改，服务端会再返回 409，而不是静默丢弃别人的改动。
      const saved = await updateGeoGebraProject(project.projectId, {
        title: project.title,
        folder: project.folder,
        tags: project.tags,
        isFavorite: project.isFavorite,
        canvasMode: project.canvasMode,
        code: project.code,
        workspaceId: project.workspaceId,
        revision: conflict.cloud.revision,
      });
      onProjectSynced(saved.projectId, saved.revision, saved.workspaceId);
      setProjects((items) => [saved, ...items.filter((item) => item.projectId !== saved.projectId)]);
      setConflict(null);
      setStatus("已用本机版本覆盖云端。");
    } catch {
      setError("保存失败，请稍后重试。");
    } finally {
      setBusy(false);
    }
  }, [busy, conflict, onProjectSynced, project]);

  const openCloudOnConflict = useCallback(() => {
    if (!conflict) return;
    onOpenProject(conflict.cloud);
    setConflict(null);
    setStatus("已打开云端版本，本机草稿仍保留在浏览器中。");
  }, [conflict, onOpenProject]);

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

  const handleRoleChange = async (userId: string, role: "admin" | "editor" | "reviewer" | "viewer") => {
    const workspaceId = project?.workspaceId;
    if (!workspaceId || teamBusy) return;
    setTeamBusy(true);
    setError("");
    try {
      await updateWorkspaceMemberRole(workspaceId, userId, role);
      setMembers((items) => items.map((item) => item.userId === userId ? { ...item, role } : item));
      setStatus("成员角色已更新。");
    } catch {
      setError("成员角色暂时无法更新；工作空间至少需要保留一名管理员。");
    } finally {
      setTeamBusy(false);
    }
  };

  const handleRemoveMember = async (userId: string) => {
    const workspaceId = project?.workspaceId;
    if (!workspaceId || teamBusy) return;
    const approved = await confirm({
      title: "移除团队成员",
      description: "被移除的成员将不再能看到该团队空间下的 GeoGebra 项目。",
      confirmLabel: "移除成员",
      tone: "danger",
    });
    if (!approved) return;
    setTeamBusy(true);
    try {
      await removeWorkspaceMember(workspaceId, userId);
      setMembers((items) => items.filter((item) => item.userId !== userId));
      setStatus("成员已移除。");
    } catch {
      setError("成员暂时无法移除。");
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

        {error && <StudioErrorNote className="mb-3">{error}</StudioErrorNote>}
        {status && !error && <StudioSuccessNote className="mb-3">{status}</StudioSuccessNote>}

        {conflict && (
          <section className={cn(studioSubPanelClassName, "mb-3 border-amber-200 bg-amber-50/60")} aria-labelledby="geogebra-conflict-heading">
            <h3 id="geogebra-conflict-heading" className="text-sm font-semibold text-slate-900">云端与本期本机都有改动</h3>
            <p className="mt-1 text-xs text-slate-600">
              云端版本：{conflict.cloud.title}（更新于 {new Date(conflict.cloud.updatedAt).toLocaleString("zh-CN")}）。
              与本机脚本相比：改动 {conflict.diff.changedLines} 行、新增 {conflict.diff.addedLines} 行、删除 {conflict.diff.removedLines} 行。
            </p>
            {conflict.diff.samples.length > 0 && (
              <ul className="mt-2 space-y-1">
                {conflict.diff.samples.map((sample) => (
                  <li key={sample.lineNumber} className={cn(studioTileClassName, "border-amber-200 bg-white/80 px-3 py-1.5 text-[11px] text-slate-600")}>
                    <span className="font-semibold text-slate-700">第 {sample.lineNumber} 行</span>
                    <span className="mt-1 block font-mono text-slate-500">云端：{sample.after ?? "（无）"}</span>
                    <span className="mt-1 block font-mono text-sky-700">本机：{sample.before ?? "（无）"}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" onClick={() => void openCloudOnConflict()} className={studioPrimaryButtonClassName}>打开云端版本</button>
              <button type="button" onClick={() => void keepLocalOnConflict()} disabled={busy} className={studioGhostButtonClassName}>{busy ? "保存中…" : "用本机版本覆盖云端"}</button>
              <button type="button" onClick={() => setConflict(null)} className={studioGhostButtonClassName}>稍后处理</button>
            </div>
            <p className="mt-2 text-xs text-slate-500">覆盖云端会替换别人刚保存的内容，建议先打开云端版本确认差异。</p>
          </section>
        )}

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
              {project?.workspaceId && (
                <div className="mt-4">
                  <h4 className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">成员</h4>
                  {membersLoading ? (
                    <StudioLoadingState text="加载成员..." minHeightClassName="min-h-[140px]" />
                  ) : membersError ? (
                    <StudioErrorNote className="mt-2">{membersError}</StudioErrorNote>
                  ) : members.length ? (
                    <ul className="mt-2 space-y-2">
                      {members.map((member) => (
                        <li key={member.userId} className={cn(studioTileClassName, "flex flex-wrap items-center justify-between gap-2 px-3 py-2")}>
                          <span className="min-w-0 text-sm text-slate-700">{member.userId === user.id ? "我" : `${member.userId.slice(0, 10)}…`}</span>
                          <span className="flex items-center gap-2">
                            <select
                              className={cn(studioFieldClassName, "w-28")}
                              value={member.role}
                              onChange={(event) => void handleRoleChange(member.userId, event.target.value as "admin" | "editor" | "reviewer" | "viewer")}
                              aria-label={`成员 ${member.userId} 的角色`}
                            >
                              {Object.entries(ROLE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                            </select>
                            <button type="button" onClick={() => void handleRemoveMember(member.userId)} className={cn(studioGhostButtonClassName, "text-rose-700 hover:border-rose-200 hover:bg-rose-50")}>移除</button>
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <StudioEmptyState className="mt-2 px-4 py-8" message="还没有其他成员。在上面输入成员邮箱邀请他们加入这个团队空间。" />
                  )}
                  <p className="mt-2 text-xs text-slate-500">创建者不可被移除，团队至少保留一名管理员。</p>
                </div>
              )}
            </div>
          </div>

          <div className={studioSubPanelClassName}>
            <div className="mb-3 flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-900">可访问的云端项目</h3>
              <span className="text-xs text-slate-500">{projects.length} 个项目</span>
            </div>
            {loading ? (
              <StudioLoadingState text="正在载入云端项目..." minHeightClassName="min-h-[220px]" />
            ) : projects.length ? (
              <div className="space-y-2">
                {projects.map((item) => {
                  const memberRole = workspaces.find((workspace) => workspace.id === item.workspaceId)?.members.find((member) => member.userId === user.id)?.role;
                  const canDelete = item.isOwner || memberRole === "admin";
                  return (
                    <div key={item.projectId} className="flex items-center gap-2">
                      <button type="button" onClick={() => onOpenProject(item)} className={cn(studioTileClassName, "min-h-14 min-w-0 flex-1 px-3 py-2 text-left transition hover:border-slate-300 hover:shadow-sm")}>
                        <span className="block truncate text-sm font-semibold text-slate-800">{item.title}</span>
                        <span className="mt-1 block truncate text-xs text-slate-500">{item.folder} · {item.tags.join(", ") || "无标签"} · {new Date(item.updatedAt).toLocaleDateString("zh-CN")}</span>
                      </button>
                      {canDelete && <button type="button" onClick={() => void handleDeleteCloudProject(item)} aria-label={`删除项目 ${item.title}`} title="删除项目" className={cn(studioGhostButtonClassName, "text-rose-700 hover:border-rose-200 hover:bg-rose-50")}><FaTrash /></button>}
                    </div>
                  );
                })}
              </div>
            ) : (
              <StudioEmptyState
                className="px-4 py-10"
                message="还没有云端项目。打开一个本地项目并保存到云端后，就能在任何设备继续编辑。"
              />
            )}

            {versionsError && <StudioErrorNote className="mt-4">{versionsError}</StudioErrorNote>}
            {project?.cloudRevision && cloudVersions.length > 0 && (
              <div className="mt-4 border-t border-slate-200 pt-4">
                <h3 className="text-sm font-semibold text-slate-900">云端历史版本</h3>
                <p className="mt-1 text-xs text-slate-500">先看与当前脚本的差异，再决定是否应用。</p>
                <div className="mt-3 space-y-2">
                  {cloudVersions.slice(0, 6).map((version) => {
                    const diff = summarizeGeoGebraDiff(project.code, version.code);
                    return (
                      <div key={version.versionId} className={cn(studioTileClassName, "px-3 py-2")}>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-sm font-semibold text-slate-700">{version.label}</span>
                          <span className="text-xs text-slate-500">{new Date(version.createdAt).toLocaleString("zh-CN")}</span>
                        </div>
                        <p className="mt-1 text-xs text-slate-500">与当前脚本相比：改动 {diff.changedLines} 行、新增 {diff.addedLines} 行、删除 {diff.removedLines} 行</p>
                        {diff.samples.length > 0 && (
                          <ul className="mt-1 space-y-1">
                            {diff.samples.slice(0, 3).map((sample) => (
                              <li key={sample.lineNumber} className="rounded-xl bg-slate-50 px-2 py-1 font-mono text-[11px] text-slate-500">
                                第 {sample.lineNumber} 行：{sample.before ?? "（空）"} → {sample.after ?? "（删除）"}
                              </li>
                            ))}
                          </ul>
                        )}
                        <button type="button" onClick={() => onApplyVersion(version.code, version.canvasMode)} className={cn(studioGhostButtonClassName, "mt-2")}>应用该版本</button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      </section>
  );
}
