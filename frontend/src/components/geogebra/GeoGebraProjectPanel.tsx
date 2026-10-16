import { useEffect, useMemo, useState } from "react";
import { FaFileAlt, FaFolderOpen, FaHistory, FaPlus, FaSave, FaStar, FaTrash } from "react-icons/fa";
import { cn } from "../../utils/cn";
import {
  studioFieldClassName,
  studioGhostButtonClassName,
  studioPanelClassName,
  studioPrimaryButtonClassName,
  studioPillClassName,
  studioSubPanelClassName,
} from "../studioTheme";
import type { GeoGebraLocalProject, GeoGebraLocalVersion } from "../../types/geogebra";
import { summarizeLocalGeoGebraDiff } from "./localProjects";

const MAX_VISIBLE_VERSIONS = 6;

type Props = {
  projects: GeoGebraLocalProject[];
  currentProject: GeoGebraLocalProject | null;
  currentCode: string;
  onCreate: () => void;
  onUpdateMetadata: (patch: Partial<Pick<GeoGebraLocalProject, "title" | "folder" | "tags" | "isFavorite">>) => void;
  onSave: () => void;
  onSnapshot: () => void;
  onOpen: (project: GeoGebraLocalProject) => void;
  onRestoreVersion: (version: GeoGebraLocalVersion) => void;
  onUndoVersion: () => void;
  onRedoVersion: () => void;
  versionCursor: number;
  onExport: () => void;
  onExportProject: () => void;
  onDelete: (projectId: string) => void;
};

export default function GeoGebraProjectPanel({
  projects,
  currentProject,
  currentCode,
  onCreate,
  onUpdateMetadata,
  onSave,
  onSnapshot,
  onOpen,
  onRestoreVersion,
  onUndoVersion,
  onRedoVersion,
  versionCursor,
  onExport,
  onExportProject,
  onDelete,
}: Props) {
  const [tagsText, setTagsText] = useState(currentProject?.tags.join(", ") ?? "");
  const [comparison, setComparison] = useState<GeoGebraLocalVersion | null>(null);
  useEffect(() => {
    setTagsText(currentProject?.tags.join(", ") ?? "");
    setComparison(null);
  }, [currentProject?.projectId]);
  const comparisonSummary = comparison ? summarizeLocalGeoGebraDiff(comparison.code, currentCode) : null;
  const recentProjects = useMemo(() => [...projects]
    .sort((left, right) => Number(right.isFavorite) - Number(left.isFavorite)
      || Date.parse(right.lastOpenedAt) - Date.parse(left.lastOpenedAt))
    .slice(0, 6), [projects]);
  const versions = currentProject?.versions ?? [];

  return (
    <section className={studioPanelClassName} aria-labelledby="geogebra-project-heading">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">Project Space</p>
          <h2 id="geogebra-project-heading" className="mt-1 text-lg font-semibold text-slate-900">项目与版本</h2>
          <p className="mt-1 text-sm text-slate-500">管理本机项目、收藏和历史快照。</p>
        </div>
        <span className={studioPillClassName(false)}><FaFolderOpen /> {projects.length} 个本地项目</span>
      </div>

      {currentProject ? (
        <div className="grid min-w-0 gap-4 xl:grid-cols-2">
          <div className={studioSubPanelClassName}>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block min-w-0 text-xs font-semibold text-slate-600">
                项目名称
                <input
                  className={cn(studioFieldClassName, "mt-1")}
                  value={currentProject.title}
                  maxLength={120}
                  onChange={(event) => onUpdateMetadata({ title: event.target.value })}
                />
              </label>
              <label className="block min-w-0 text-xs font-semibold text-slate-600">
                文件夹
                <input
                  className={cn(studioFieldClassName, "mt-1")}
                  value={currentProject.folder}
                  maxLength={80}
                  onChange={(event) => onUpdateMetadata({ folder: event.target.value })}
                />
              </label>
            </div>
            <label className="mt-3 block text-xs font-semibold text-slate-600">
              标签（逗号分隔）
              <input
                className={cn(studioFieldClassName, "mt-1")}
                value={tagsText}
                maxLength={400}
                onChange={(event) => {
                  const next = event.target.value;
                  setTagsText(next);
                  onUpdateMetadata({ tags: [...new Set(next.split(/[,，]/).map((item) => item.trim()).filter(Boolean))].slice(0, 20) });
                }}
              />
            </label>
            <label className="mt-3 flex min-h-11 items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={currentProject.isFavorite} onChange={(event) => onUpdateMetadata({ isFavorite: event.target.checked })} />
              <FaStar className="text-amber-500" aria-hidden="true" />
              收藏并优先显示
            </label>
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" onClick={onCreate} className={studioGhostButtonClassName}><FaPlus /> 新项目</button>
              <button type="button" onClick={onSave} className={studioPrimaryButtonClassName}><FaSave /> 保存项目</button>
              <button type="button" onClick={onSnapshot} className={studioGhostButtonClassName}><FaHistory /> 保存快照</button>
              <button type="button" onClick={onExport} className={studioGhostButtonClassName}><FaFileAlt /> 导出脚本</button>
              <button type="button" onClick={onExportProject} className={studioGhostButtonClassName}><FaFileAlt /> 导出项目数据</button>
            </div>
            <div className="mt-4 space-y-2">
              <h3 className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">最近项目</h3>
              <div className="grid gap-2 sm:grid-cols-2">
                {recentProjects.map((project) => (
                  <div key={project.projectId} className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => onOpen(project)}
                      aria-current={project.projectId === currentProject.projectId ? "true" : undefined}
                      className={cn("min-h-16 min-w-0 flex-1 rounded-2xl border px-3 py-2 text-left transition", project.projectId === currentProject.projectId ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white/80 text-slate-700 hover:border-slate-300")}
                    >
                      <span className="block truncate text-sm font-semibold">{project.title || "未命名项目"}</span>
                      <span className={cn("mt-1 block truncate text-xs", project.projectId === currentProject.projectId ? "text-slate-300" : "text-slate-500")}>
                        {project.folder} · {project.tags.join(", ") || "无标签"}
                      </span>
                    </button>
                    <button type="button" onClick={() => onDelete(project.projectId)} aria-label={`删除本地项目 ${project.title}`} title="删除本地项目" className={cn(studioGhostButtonClassName, "text-rose-700 hover:border-rose-200 hover:bg-rose-50")}><FaTrash /></button>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className={studioSubPanelClassName}>
            <div className="mb-3 flex items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">历史快照</h3>
                <p className="mt-1 text-xs text-slate-500">最近 {MAX_VISIBLE_VERSIONS} 个快照 · 共 {versions.length}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" onClick={onUndoVersion} disabled={!versions.length || versionCursor >= versions.length - 1} className={studioGhostButtonClassName}>撤销快照</button>
                <button type="button" onClick={onRedoVersion} disabled={versionCursor < 0} className={studioGhostButtonClassName}>重做快照</button>
                <span className={studioPillClassName(false)}><FaHistory /> 本地</span>
              </div>
            </div>
            {versions.length ? (
              <div className="space-y-2">
                {versions.slice(0, MAX_VISIBLE_VERSIONS).map((version, index) => (
                  <article key={version.versionId} className={cn("rounded-2xl border p-3", versionCursor === index ? "border-slate-400 bg-slate-50" : "border-slate-200 bg-white/80")}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="min-w-0">
                        <strong className="block truncate text-sm text-slate-800">{version.label}</strong>
                        <time className="mt-1 block text-xs text-slate-500" dateTime={version.createdAt}>{new Date(version.createdAt).toLocaleString("zh-CN")}</time>
                      </div>
                      <button type="button" onClick={() => onRestoreVersion(version)} className={studioGhostButtonClassName}>恢复</button>
                    </div>
                    {comparison?.versionId === version.versionId && (
                      <p className="mt-2 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600">已选择此快照用于与当前脚本比较。</p>
                    )}
                    <button type="button" onClick={() => setComparison(version)} className="mt-2 text-xs font-semibold text-slate-600 underline decoration-slate-300 underline-offset-4 hover:text-slate-900">查看此版本</button>
                  </article>
                ))}
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/80 px-4 py-8 text-center text-sm text-slate-500">保存快照后会显示在这里。</div>
            )}
            {comparison && (
              <div className="mt-3 rounded-2xl border border-slate-200 bg-white/80 p-3">
                <p className="text-xs font-semibold text-slate-700">{comparison.label} 与当前脚本</p>
                <p className="mt-1 text-xs text-slate-600">修改 {comparisonSummary?.changedLines ?? 0} 行，新增 {comparisonSummary?.addedLines ?? 0} 行，删除 {comparisonSummary?.removedLines ?? 0} 行。</p>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-xl bg-slate-50 p-3 font-mono text-xs text-slate-600">{comparison.code}</pre>
                  <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-xl bg-slate-50 p-3 font-mono text-xs text-slate-600">{currentCode}</pre>
                </div>
                <button type="button" onClick={() => setComparison(null)} className="mt-2 text-xs font-semibold text-slate-500 underline">关闭预览</button>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/80 p-6 text-center">
          <p className="text-sm text-slate-600">还没有本地项目。</p>
          <button type="button" onClick={onCreate} className={cn(studioPrimaryButtonClassName, "mt-3")}><FaPlus /> 新建项目</button>
        </div>
      )}
    </section>
  );
}
