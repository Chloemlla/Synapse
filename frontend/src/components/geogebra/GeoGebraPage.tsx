import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { FaCheck, FaDownload, FaLock, FaPlay, FaRedo, FaUnlock } from "react-icons/fa";
import { useAuth } from "../../hooks/useAuth";
import { cn } from "../../utils/cn";
import {
  studioAccentBlobBlueClassName,
  studioAccentBlobSkyClassName,
  studioGhostButtonClassName,
  studioHeroCardClassName,
  studioPageClassName,
  studioPanelClassName,
  studioPrimaryButtonClassName,
  studioSubPanelClassName,
} from "../studioTheme";
import { getGeoGebraProject, listGeoGebraVersions } from "../../api/geogebra";
import GeoGebraApplet, { type GeoGebraHandle, type GeoGebraRunStep } from "./GeoGebraApplet";
import GeoGebraAiPanel from "./GeoGebraAiPanel";
import GeoGebraExportPanel from "./GeoGebraExportPanel";
import GeoGebraCloudPanel from "./GeoGebraCloudPanel";
import GeoGebraCommentsPanel from "./GeoGebraCommentsPanel";
import GeoGebraEditor from "./GeoGebraEditor";
import GeoGebraProjectPanel from "./GeoGebraProjectPanel";
import GeoGebraSharePanel from "./GeoGebraSharePanel";
import {
  createLocalGeoGebraProject,
  createLocalGeoGebraVersion,
  readLocalGeoGebraProjects,
  upsertLocalGeoGebraProject,
  writeLocalGeoGebraProjects,
} from "./localProjects";
import {
  analyzeGeoGebraVariables,
  describeGeoGebraPointChanges,
  extractGeoGebraControls,
  mergeFreePointStates,
  prepareGeoGebraScript,
  replaceGeoGebraAssignment,
  summarizeGeoGebraDiff,
  type GeoGebraMode,
  type GeoGebraPointState,
  type GeoGebraScalar,
} from "./script";
import type { GeoGebraLocalProject, GeoGebraLocalVersion, GeoGebraProject } from "../../types/geogebra";

type LogEntry = { id: string; message: string; tone: "info" | "success" | "warning" | "error"; at: string };
type ConfirmAction = { title: string; message: string; action: () => void } | null;

const STARTER_SNIPPETS = [
  { title: "矩形与圆", mode: "geometry" as GeoGebraMode, code: "A = (0, 0)\nB = (3, 0)\nC = (3, 4)\nD = (0, 4)\npoly = Polygon(A, B, C, D)\ncircle = Circle(A, 2)\nlabel = Text(\"矩形与圆\", (0, 5))\n" },
  { title: "三角形中线", mode: "geometry" as GeoGebraMode, code: "A = (-3, 0)\nB = (3, 0)\nC = (1, 4)\ntriangle = Polygon(A, B, C)\nM = Midpoint(B, C)\nmedian = Segment(A, M)\n" },
  { title: "函数与切线", mode: "graphing" as GeoGebraMode, code: "f(x) = 0.2x^3 - x\nA = (1.5, f(1.5))\ntangent = Tangent(A, f)\npoint = Point(f)\n" },
  { title: "平移与旋转", mode: "geometry" as GeoGebraMode, code: "A = (0, 0)\nB = (2, 1)\nC = (1, 3)\npoly = Polygon(A, B, C)\nshifted = Translate(poly, (3, 1))\nrotated = Rotate(poly, 45°, A)\n" },
];
const CANVAS_MODES: Array<{ id: GeoGebraMode; label: string; description: string }> = [
  { id: "geometry", label: "平面几何", description: "适合点、线、多边形和圆的构造。" },
  { id: "3d", label: "立体几何", description: "适合空间关系与三维图形观察。" },
  { id: "graphing", label: "函数图形", description: "适合函数、曲线和参数变化。" },
  { id: "classic", label: "综合工作台", description: "适合混合几何与函数探索。" },
];
const DEFAULT_CODE = STARTER_SNIPPETS[0].code;

export default function GeoGebraPage() {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const requestedProjectId = searchParams.get("projectId");
  const [initialProjects] = useState(() => {
    const saved = readLocalGeoGebraProjects();
    return saved.length ? saved : [createLocalGeoGebraProject({ code: DEFAULT_CODE, title: "几何草稿", tags: ["示例"] })];
  });
  const [projects, setProjects] = useState<GeoGebraLocalProject[]>(initialProjects);
  const [currentProjectId, setCurrentProjectId] = useState(() => initialProjects[0]?.projectId ?? "");
  const currentProject = useMemo(() => projects.find((item) => item.projectId === currentProjectId) ?? projects[0] ?? null, [currentProjectId, projects]);
  const appletRef = useRef<GeoGebraHandle | null>(null);
  const cancelConfirmRef = useRef<HTMLButtonElement | null>(null);
  const proceedConfirmRef = useRef<HTMLButtonElement | null>(null);
  const runHandlerRef = useRef<((ignoreDrift?: boolean, codeOverride?: string) => Promise<void>) | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [runReport, setRunReport] = useState<{ success: boolean; successCount: number; errorCount: number; duration: number; steps: GeoGebraRunStep[] } | null>(null);
  const [canvasObjects, setCanvasObjects] = useState<string[]>([]);
  const [canvasMovedNames, setCanvasMovedNames] = useState<string[]>([]);
  const [selectedMovedNames, setSelectedMovedNames] = useState<string[]>([]);
  const driftBaselineRef = useRef<string | null>(null);
  const [locked, setLocked] = useState(() => typeof window !== "undefined" && window.innerWidth <= 480);
  const [compact, setCompact] = useState(() => typeof window !== "undefined" && window.innerWidth <= 1024);
  const [phone, setPhone] = useState(() => typeof window !== "undefined" && window.innerWidth <= 480);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction>(null);
  const [versionCursor, setVersionCursor] = useState(-1);
  const versionDraftRef = useRef<{ code: string; canvasMode: GeoGebraMode } | null>(null);
  const [selectedStyleNames, setSelectedStyleNames] = useState<string[]>([]);
  const [parameterValues, setParameterValues] = useState<Record<string, GeoGebraScalar>>({});
  const [lectureCommands, setLectureCommands] = useState<string[]>([]);
  const [lectureStep, setLectureStep] = useState(0);
  const [lecturePlaying, setLecturePlaying] = useState(false);
  const lectureTokenRef = useRef(0);
  const [presentationMode, setPresentationMode] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const currentCode = currentProject?.code ?? DEFAULT_CODE;
  const prepared = useMemo(() => prepareGeoGebraScript(currentCode), [currentCode]);
  const controls = useMemo(() => extractGeoGebraControls(currentCode), [currentCode]);
  const variableReport = useMemo(() => analyzeGeoGebraVariables(currentCode), [currentCode]);
  const [movedPointStates, setMovedPointStates] = useState<GeoGebraPointState[]>([]);
  // before 从当前脚本现算（脚本可能又改过），不缓存历史文本；只缓存本次拖动的画布坐标。
  const movedPointChanges = useMemo(
    () => describeGeoGebraPointChanges(currentCode, movedPointStates.filter((point) => canvasMovedNames.includes(point.name))),
    [canvasMovedNames, currentCode, movedPointStates],
  );
  const canvasDrift = canvasMovedNames.length > 0;
  const driftConflict = canvasDrift && driftBaselineRef.current !== null && driftBaselineRef.current !== currentCode;

  useEffect(() => {
    if (!confirmAction) return undefined;
    const previousFocus = document.activeElement as HTMLElement | null;
    const timer = window.setTimeout(() => cancelConfirmRef.current?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setConfirmAction(null);
        return;
      }
      if (event.key !== "Tab") return;
      if (event.shiftKey && document.activeElement === cancelConfirmRef.current) {
        event.preventDefault();
        proceedConfirmRef.current?.focus();
      } else if (!event.shiftKey && document.activeElement === proceedConfirmRef.current) {
        event.preventDefault();
        cancelConfirmRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus?.();
    };
  }, [confirmAction]);

  const pushLog = useCallback((message: string, tone: LogEntry["tone"] = "info") => {
    setLogs((items) => [{ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, message, tone, at: new Date().toISOString() }, ...items].slice(0, 100));
  }, []);

  const updateProject = useCallback((transform: (project: GeoGebraLocalProject) => GeoGebraLocalProject) => {
    setProjects((items) => items.map((item) => item.projectId === currentProjectId ? transform(item) : item));
  }, [currentProjectId]);

  const updateCode = useCallback((code: string) => {
    versionDraftRef.current = null;
    setVersionCursor(-1);
    updateProject((project) => ({ ...project, code: code.slice(0, 50_000), updatedAt: new Date().toISOString() }));
  }, [updateProject]);

  const appendSnapshot = useCallback((label: string, trigger: string, codeOverride?: string, modeOverride?: GeoGebraMode) => {
    if (!currentProject) return;
    const snapshot = { ...currentProject, code: codeOverride ?? currentProject.code, canvasMode: modeOverride ?? currentProject.canvasMode };
    const version = createLocalGeoGebraVersion(snapshot, label, trigger);
    versionDraftRef.current = null;
    setVersionCursor(-1);
    updateProject((project) => ({ ...project, versions: [version, ...project.versions].slice(0, 24), updatedAt: new Date().toISOString() }));
  }, [currentProject, updateProject]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!writeLocalGeoGebraProjects(projects)) setNotice("本地存储空间不足，请导出重要项目后清理浏览器空间。");
    }, 250);
    return () => window.clearTimeout(timer);
  }, [projects]);

  useEffect(() => {
    const onResize = () => {
      setCompact(window.innerWidth <= 1024);
      setPhone(window.innerWidth <= 480);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    setParameterValues({});
    setCanvasObjects([]);
    setRunReport(null);
    setVersionCursor(-1);
    versionDraftRef.current = null;
  }, [currentProjectId]);

  const openCloudProject = useCallback(async (project: GeoGebraProject) => {
    const localVersions = await listGeoGebraVersions(project.projectId).catch(() => []);
    const local: GeoGebraLocalProject = {
      projectId: project.projectId,
      title: project.title,
      folder: project.folder,
      tags: project.tags,
      isFavorite: project.isFavorite,
      workspaceId: project.workspaceId,
      cloudRevision: project.revision,
      canvasMode: project.canvasMode,
      code: project.code,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      lastOpenedAt: new Date().toISOString(),
      versions: localVersions.map(({ versionId, label, code, canvasMode, trigger, createdAt }) => ({ versionId, label, code, canvasMode, trigger, createdAt })),
    };
    setProjects((items) => upsertLocalGeoGebraProject(items, local));
    setCurrentProjectId(project.projectId);
    setError("");
    setNotice("云端项目已打开。");
  }, []);

  useEffect(() => {
    if (!requestedProjectId || !user?.id) return;
    let active = true;
    void getGeoGebraProject(requestedProjectId).then(async (project) => {
      if (active) await openCloudProject(project);
    }).catch(() => {
      if (active) setError("云端项目暂时无法打开。");
    });
    return () => { active = false; };
  }, [openCloudProject, requestedProjectId, user?.id]);

  const handleRun = useCallback(async (ignoreDrift = false, codeOverride?: string) => {
    if (running) return;
    if (canvasDrift && !ignoreDrift) {
      setConfirmAction({ title: "重新运行脚本", message: "画布上的点位有尚未保存的调整。重新运行后将按脚本重新绘制。", action: () => { void runHandlerRef.current?.(true, codeOverride); } });
      return;
    }
    const source = codeOverride ?? currentCode;
    const runPrepared = prepareGeoGebraScript(source);
    if (runPrepared.errors.length) {
      setError(runPrepared.errors.map((item) => `第 ${item.lineNumber} 行：${item.message}`).join("\n"));
      setRunReport({ success: false, successCount: 0, errorCount: runPrepared.errors.length, duration: 0, steps: [] });
      return;
    }
    if (!runPrepared.commands.length) {
      setError("请先输入脚本内容。");
      return;
    }
    setError("");
    setNotice("");
    setRunning(true);
    setProgress(0);
    const started = Date.now();
    try {
      const report = await appletRef.current?.run(runPrepared.commands, (current, total) => setProgress(total ? Math.round(current / total * 100) : 0));
      if (!report) throw new Error("画布暂时无法运行。");
      setRunReport({ success: report.success, successCount: report.successCount, errorCount: report.errorCount, duration: report.executionTime, steps: report.steps });
      if (report.success) {
        setError("");
        setNotice(`运行完成：${report.successCount} 条指令。`);
        setCanvasObjects(appletRef.current?.getObjectNames() ?? []);
        appendSnapshot("运行脚本", "execution", source, currentProject?.canvasMode);
        pushLog("脚本运行完成。", "success");
      } else {
        const message = `第 ${report.error?.lineNumber ?? 1} 行暂时无法运行，请检查该行内容。`;
        setError(message);
        pushLog(message, "error");
      }
    } catch {
      setError("画布暂时无法运行，请重试。");
      setRunReport({ success: false, successCount: 0, errorCount: 1, duration: Date.now() - started, steps: [] });
    } finally {
      setRunning(false);
      setProgress(100);
      setCanvasMovedNames([]);
      setSelectedMovedNames([]);
      driftBaselineRef.current = null;
    }
  }, [appendSnapshot, canvasDrift, currentCode, currentProject?.canvasMode, pushLog, running]);
  runHandlerRef.current = handleRun;

  const handlePointsMoved = useCallback((names: string[]) => {
    driftBaselineRef.current ??= currentCode;
    setCanvasMovedNames((previous) => [...new Set([...previous, ...names])]);
    setSelectedMovedNames((previous) => [...new Set([...previous, ...names])]);
    const points = appletRef.current?.readFreePoints(names) ?? [];
    if (points.length) {
      setMovedPointStates((previous) => {
        const merged = new Map(previous.map((point) => [point.name, point]));
        for (const point of points) merged.set(point.name, point);
        return [...merged.values()];
      });
    }
    setNotice("画布上的点位已调整，可选择要保留的变化。");
  }, [currentCode]);

  const handleModeChange = (mode: GeoGebraMode) => {
    if (mode === currentProject?.canvasMode) return;
    const change = () => {
      if (currentProject) updateProject((project) => ({ ...project, canvasMode: mode, updatedAt: new Date().toISOString() }));
      setCanvasMovedNames([]);
      setSelectedMovedNames([]);
      driftBaselineRef.current = null;
      setRunReport(null);
    };
    if (canvasDrift) setConfirmAction({ title: "切换画布类型", message: "未保存的拖动调整将会清除。是否继续？", action: change });
    else change();
  };

  const handleSyncMovedPoints = () => {
    if (!appletRef.current || selectedMovedNames.length === 0) {
      setError("请选择要保留的点位。");
      return;
    }
    const sync = () => {
      try {
        const points = appletRef.current?.readFreePoints(selectedMovedNames) ?? [];
        if (!points.length) {
          setError("所选点位暂时无法读取。");
          return;
        }
        const nextCode = mergeFreePointStates(currentCode, points);
        updateCode(nextCode);
        setCanvasMovedNames((items) => items.filter((name) => !selectedMovedNames.includes(name)));
        setSelectedMovedNames([]);
        driftBaselineRef.current = null;
        appendSnapshot("同步自由点", "canvas_sync", nextCode);
        setNotice("所选点位已保存到脚本。");
        setError("");
      } catch {
        setError("点位暂时无法同步，请重试。");
      }
    };
    if (driftConflict) {
      const pending = appletRef.current.readFreePoints(selectedMovedNames);
      const diff = summarizeGeoGebraDiff(currentCode, mergeFreePointStates(currentCode, pending));
      const sample = diff.samples.slice(0, 3).map((item) => `第 ${item.lineNumber} 行：${item.before ?? "（空）"} → ${item.after ?? "（删除）"}`).join("；");
      setConfirmAction({
        title: "同步点位",
        message: `你在拖动点位后也修改了脚本。保存会调整 ${diff.changedLines + diff.addedLines + diff.removedLines} 行${sample ? `：${sample}` : ""}。`,
        action: sync,
      });
    } else sync();
  };

  const handleNewProject = () => {
    const next = createLocalGeoGebraProject();
    setProjects((items) => upsertLocalGeoGebraProject(items, next));
    setCurrentProjectId(next.projectId);
    setCanvasMovedNames([]);
    setSelectedMovedNames([]);
    driftBaselineRef.current = null;
    versionDraftRef.current = null;
    setVersionCursor(-1);
    setError("");
    setNotice("新项目已创建。");
  };

  const handleDeleteLocalProject = (projectId: string) => {
    const target = projects.find((item) => item.projectId === projectId);
    if (!target) return;
    const nextProjects = projects.filter((item) => item.projectId !== projectId);
    const fallback = nextProjects[0] ?? createLocalGeoGebraProject({ code: DEFAULT_CODE, title: "几何草稿", tags: ["示例"] });
    setConfirmAction({
      title: "删除本地项目",
      message: "此浏览器中的项目和快照将被移除；已保存的云端项目不会受到影响。",
      action: () => {
        setProjects(nextProjects.length ? nextProjects : [fallback]);
        if (currentProjectId === projectId) setCurrentProjectId(fallback.projectId);
        setNotice("本地项目已删除。");
      },
    });
  };

  const applySnippet = (snippet: (typeof STARTER_SNIPPETS)[number]) => {
    if (!currentProject) return;
    updateProject((project) => ({ ...project, code: snippet.code, canvasMode: snippet.mode, updatedAt: new Date().toISOString() }));
    setCanvasMovedNames([]);
    setSelectedMovedNames([]);
    driftBaselineRef.current = null;
    versionDraftRef.current = null;
    setVersionCursor(-1);
    setRunReport(null);
    setError("");
    setNotice(`已载入示例：${snippet.title}`);
  };

  const handleLoadSnippet = (snippet: (typeof STARTER_SNIPPETS)[number]) => {
    if (!currentProject || !currentProject.code.trim() || currentProject.code === snippet.code) {
      applySnippet(snippet);
      return;
    }
    setConfirmAction({ title: "载入示例", message: "当前脚本会被示例替换。", action: () => applySnippet(snippet) });
  };

  const handleResetWorkbench = () => {
    setConfirmAction({
      title: "重置工作台",
      message: "当前画布和脚本将恢复为初始示例，项目资料仍会保留。",
      action: () => {
        if (currentProject) updateProject((project) => ({ ...project, code: DEFAULT_CODE, canvasMode: "geometry", updatedAt: new Date().toISOString() }));
        appletRef.current?.reset();
        setRunReport(null);
        setCanvasObjects([]);
        setCanvasMovedNames([]);
        setSelectedMovedNames([]);
        driftBaselineRef.current = null;
        versionDraftRef.current = null;
        setVersionCursor(-1);
        setLectureCommands([]);
        setLectureStep(0);
        setNotice("工作台已重置。");
        setError("");
      },
    });
  };

  const handleOpenLocalProject = (project: GeoGebraLocalProject) => {
    setCurrentProjectId(project.projectId);
    setProjects((items) => items.map((item) => item.projectId === project.projectId ? { ...item, lastOpenedAt: new Date().toISOString() } : item));
    setCanvasMovedNames([]);
    setSelectedMovedNames([]);
    driftBaselineRef.current = null;
    setError("");
    setNotice("项目已打开。");
  };

  const handleSaveLocal = () => {
    if (!currentProject) return;
    updateProject((project) => ({ ...project, updatedAt: new Date().toISOString() }));
    setNotice("项目已保存在此浏览器。");
  };

  const handleSnapshot = () => {
    appendSnapshot("手动快照", "manual");
    setNotice("快照已保存。");
  };

  const applyVersion = (version: GeoGebraLocalVersion, cursor: number) => {
    if (!currentProject) return;
    versionDraftRef.current ??= { code: currentProject.code, canvasMode: currentProject.canvasMode };
    updateProject((project) => ({ ...project, code: version.code, canvasMode: version.canvasMode, updatedAt: new Date().toISOString() }));
    setVersionCursor(cursor);
    setCanvasMovedNames([]);
    setSelectedMovedNames([]);
    driftBaselineRef.current = null;
    setNotice(`已恢复到快照「${version.label}」。`);
  };

  const handleRestoreVersion = (version: GeoGebraLocalVersion) => {
    const index = currentProject?.versions.findIndex((item) => item.versionId === version.versionId) ?? -1;
    if (index < 0) return;
    setConfirmAction({ title: "恢复项目快照", message: "当前脚本会替换为所选快照。", action: () => applyVersion(version, index) });
  };

  const handleUndoVersion = () => {
    const versions = currentProject?.versions ?? [];
    const next = Math.min(versionCursor + 1, versions.length - 1);
    if (!versions[next] || next === versionCursor) return;
    applyVersion(versions[next], next);
  };

  const handleRedoVersion = () => {
    const versions = currentProject?.versions ?? [];
    if (versionCursor < 0) return;
    if (versionCursor === 0 && versionDraftRef.current) {
      const draft = versionDraftRef.current;
      versionDraftRef.current = null;
      setVersionCursor(-1);
      updateProject((project) => ({ ...project, code: draft.code, canvasMode: draft.canvasMode, updatedAt: new Date().toISOString() }));
      setNotice("已恢复到当前编辑内容。");
      return;
    }
    const next = versionCursor - 1;
    if (versions[next]) applyVersion(versions[next], next);
  };

  const handleOpenCloudProject = useCallback((project: GeoGebraProject) => {
    void openCloudProject(project).catch(() => setError("云端项目暂时无法打开。"));
  }, [openCloudProject]);

  const updateSyncedProject = useCallback((projectId: string, revision: number, workspaceId: string | null) => {
    setProjects((items) => items.map((item) => item.projectId === projectId ? { ...item, cloudRevision: revision, workspaceId, updatedAt: new Date().toISOString() } : item));
  }, []);

  const updateWorkspace = useCallback((workspaceId: string | null) => {
    if (currentProject) updateProject((project) => ({ ...project, workspaceId, updatedAt: new Date().toISOString() }));
  }, [currentProject, updateProject]);

  // 云端历史版本：应用前必须确认，因为它会直接覆盖编辑器里的当前脚本。
  const handleApplyCloudVersion = useCallback((code: string, canvasMode: GeoGebraMode) => {
    setConfirmAction({
      title: "应用云端版本",
      message: "当前脚本会被该版本替换，未保存的改动将丢失。",
      action: () => {
        updateProject((project) => ({ ...project, code, canvasMode, updatedAt: new Date().toISOString() }));
        appendSnapshot("应用云端版本", "cloud_restore", code, canvasMode);
        setNotice("已应用云端版本。");
        setError("");
      },
    });
  }, [appendSnapshot, updateProject]);

  // AI 写回：先预检，再落盘；预检不过就不写回也不执行（GEO-15/16）。
  const handleApplyAiCommands = useCallback(async (commands: string[], mode: "replace" | "append") => {
    if (!commands.length) return { ok: false, message: "没有可写入的指令。" };
    const body = commands.join("\n");
    const nextCode = mode === "replace"
      ? `${body}\n`
      : `${currentCode.trimEnd()}${currentCode.trim() ? "\n\n" : ""}// 来自 AI 的建议\n${body}\n`;
    const checked = prepareGeoGebraScript(nextCode);
    if (checked.errors.length) {
      return {
        ok: false,
        message: `生成结果未通过预检：${checked.errors.slice(0, 3).map((item) => `第 ${item.lineNumber} 行 ${item.message}`).join("；")}`,
      };
    }
    updateCode(nextCode);
    appendSnapshot(mode === "replace" ? "AI 替换脚本" : "AI 追加脚本", "ai_writeback", nextCode);
    return { ok: true, message: mode === "replace" ? "已替换编辑器内容，建议先运行确认。" : "已追加到脚本末尾，建议先运行确认。" };
  }, [appendSnapshot, currentCode, updateCode]);

  const handleParameterValueChange = (name: string, value: GeoGebraScalar) => setParameterValues((previous) => ({ ...previous, [name]: value }));
  const applyParameters = async (runAfter: boolean) => {
    if (!currentProject) return;
    let code = currentProject.code;
    for (const control of controls) {
      const value = parameterValues[control.name] ?? control.value;
      code = replaceGeoGebraAssignment(code, control.name, value);
    }
    updateCode(code);
    appendSnapshot("参数调节", "parameter_change", code);
    setNotice("参数已更新。");
    if (runAfter) await handleRun(true, code);
  };

  const [styleColor, setStyleColor] = useState("#2563eb");
  const [lineThickness, setLineThickness] = useState(3);
  const [pointSize, setPointSize] = useState(5);
  const [labelsVisible, setLabelsVisible] = useState(true);
  const [gridVisible, setGridVisible] = useState(false);
  const [axesVisible, setAxesVisible] = useState(true);
  const [styleScope, setStyleScope] = useState<"all" | "selected">("all");
  const applyStyles = () => {
    const names = styleScope === "all" ? canvasObjects : selectedStyleNames;
    if (!names.length || !appletRef.current) {
      setError("请先运行脚本并选择要设置的对象。");
      return;
    }
    const result = appletRef.current.applyStyles({ names, color: styleColor, lineThickness, pointSize, labelVisible: labelsVisible, showGrid: gridVisible, showAxes: axesVisible });
    setNotice(`已更新 ${result.changed.length} 个对象的显示效果。`);
    setError(result.skipped.length
      ? `有 ${result.skipped.length} 个对象没有生效：${result.skipped.slice(0, 3).map((item) => `${item.name}（${item.reason}）`).join("；")}${result.skipped.length > 3 ? " 等" : ""}`
      : "");
  };

  const runLectureStep = async (step: number, commands: string[]) => {
    if (!appletRef.current) return;
    if (step <= 0) {
      appletRef.current.clear();
      setLectureStep(0);
      return;
    }
    const report = await appletRef.current.run(commands.slice(0, step));
    if (report.success) setLectureStep(step);
    else setError(`第 ${report.error?.lineNumber ?? step} 步暂时无法展示。`);
  };
  const prepareLecture = () => {
    if (prepared.errors.length || prepared.commands.length === 0) {
      setError("请先准备一份可运行的脚本。");
      return;
    }
    lectureTokenRef.current += 1;
    setLectureCommands(prepared.commands);
    setLectureStep(0);
    setLecturePlaying(false);
    setNotice("讲解内容已准备好。");
  };
  const playLecture = async () => {
    const commands = lectureCommands.length ? lectureCommands : prepared.commands;
    if (!commands.length || prepared.errors.length) {
      setError("请先准备一份可运行的脚本。");
      return;
    }
    const token = ++lectureTokenRef.current;
    setLectureCommands(commands);
    setLecturePlaying(true);
    for (let step = lectureStep + 1; step <= commands.length; step += 1) {
      if (lectureTokenRef.current !== token) break;
      await runLectureStep(step, commands);
      await new Promise<void>((resolve) => window.setTimeout(resolve, 900));
    }
    if (lectureTokenRef.current === token) setLecturePlaying(false);
  };
  const stopLecture = () => {
    lectureTokenRef.current += 1;
    setLecturePlaying(false);
  };
  const togglePresentation = async () => {
    const next = !presentationMode;
    setPresentationMode(next);
    try {
      if (next) await document.documentElement.requestFullscreen?.();
      else if (document.fullscreenElement) await document.exitFullscreen?.();
    } catch {
      setNotice(next ? "演示模式已开启。" : "已退出演示模式。");
    }
  };

  const exportData = async (dataUrl: string | null, filename: string) => {
    if (!dataUrl) {
      setError("导出暂时不可用，请先运行画布。");
      return;
    }
    const anchor = document.createElement("a");
    anchor.href = dataUrl;
    anchor.download = filename;
    anchor.click();
  };

  const exportScript = () => {
    if (!currentProject) return;
    const blob = new Blob([currentProject.code], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${currentProject.title.trim().replace(/\s+/g, "-") || "geogebra"}.ggs.txt`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const exportProjectJson = () => {
    if (!currentProject) return;
    downloadTextFile(`${currentProject.title.trim().replace(/\s+/g, "-") || "geogebra"}.json`, JSON.stringify(currentProject, null, 2));
  };

  const [mobileCodeTab, setMobileCodeTab] = useState(true);

  return (
    <div className={cn(studioPageClassName, "min-w-0 overflow-x-hidden")}>
      <div className="mx-auto w-full min-w-0 max-w-7xl space-y-4 sm:space-y-6">
        {!presentationMode && (
          <section className={cn("relative overflow-hidden", studioHeroCardClassName)}>
            <div className={cn(studioAccentBlobBlueClassName, "-right-12 top-0")} aria-hidden="true" />
            <div className={cn(studioAccentBlobSkyClassName, "-left-10 bottom-0")} aria-hidden="true" />
            <div className="relative flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-slate-500">GeoGebra Studio</p>
                <h1 className="mt-2 text-[2rem] font-semibold leading-tight text-slate-900 sm:text-4xl">几何脚本工作台</h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">编写脚本、调整画布并保存项目，逐步探索数学关系。</p>
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                <div className="rounded-2xl border border-slate-200 bg-slate-50/80 px-3 py-2"><span className="text-[10px] uppercase tracking-[0.2em] text-slate-400">画布</span><strong className="mt-1 block text-sm text-slate-800">{CANVAS_MODES.find((item) => item.id === currentProject?.canvasMode)?.label ?? "平面几何"}</strong></div>
                <div className="rounded-2xl border border-slate-200 bg-slate-50/80 px-3 py-2"><span className="text-[10px] uppercase tracking-[0.2em] text-slate-400">脚本行数</span><strong className="mt-1 block text-sm text-slate-800">{prepared.stats.commandLines}</strong></div>
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50/80 px-3 py-2"><span className="text-[10px] uppercase tracking-[0.2em] text-slate-400">运行状态</span><strong className="mt-1 block text-sm text-slate-800">{running ? `${progress}%` : runReport?.success ? "运行成功" : "等待运行"}</strong></div>
              </div>
            </div>
          </section>
        )}

        {!presentationMode && notice && <p role="status" aria-live="polite" className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</p>}
        {!presentationMode && error && <p role="alert" className="whitespace-pre-line rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</p>}

        {!presentationMode && (
          <section className={studioPanelClassName} aria-labelledby="geogebra-examples-heading">
            <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
              <div><p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">Starter Scenes</p><h2 id="geogebra-examples-heading" className="mt-1 text-lg font-semibold text-slate-900">示例模板</h2></div>
              <span className="text-xs text-slate-500">选择示例可载入一份可编辑脚本</span>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {STARTER_SNIPPETS.map((snippet) => (
                <button key={snippet.title} type="button" onClick={() => handleLoadSnippet(snippet)} className={cn(studioSubPanelClassName, "min-h-20 text-left transition hover:border-slate-300 hover:shadow-sm")}>
                  <span className="block text-sm font-semibold text-slate-800">{snippet.title}</span>
                  <span className="mt-1 block text-xs text-slate-500">{CANVAS_MODES.find((mode) => mode.id === snippet.mode)?.label}</span>
                </button>
              ))}
            </div>
          </section>
        )}

        {!presentationMode && (
          <>
            <GeoGebraProjectPanel
              projects={projects}
              currentProject={currentProject}
              currentCode={currentCode}
              onCreate={handleNewProject}
              onUpdateMetadata={(patch) => currentProject && updateProject((project) => ({ ...project, ...patch, updatedAt: new Date().toISOString() }))}
              onSave={handleSaveLocal}
              onSnapshot={handleSnapshot}
              onOpen={handleOpenLocalProject}
              onRestoreVersion={handleRestoreVersion}
              onUndoVersion={handleUndoVersion}
              onRedoVersion={handleRedoVersion}
              versionCursor={versionCursor}
              onExport={exportScript}
              onExportProject={exportProjectJson}
              onDelete={handleDeleteLocalProject}
            />
            <GeoGebraCloudPanel
              project={currentProject}
              onProjectSynced={updateSyncedProject}
              onOpenProject={handleOpenCloudProject}
              onProjectDeleted={(projectId) => setProjects((items) => items.map((item) => item.projectId === projectId ? { ...item, cloudRevision: undefined, workspaceId: null } : item))}
              onWorkspaceChange={updateWorkspace}
              onApplyVersion={handleApplyCloudVersion}
            />
            <GeoGebraCommentsPanel project={currentProject} objectNames={canvasObjects} />
            <GeoGebraSharePanel project={currentProject} onGetCover={() => appletRef.current?.exportPng() ?? null} />
          </>
        )}

        {compact && !presentationMode && (
          <div className="flex gap-2 rounded-2xl border border-slate-200 bg-white/80 p-2" role="tablist" aria-label="工作台面板">
            <button type="button" role="tab" aria-selected={mobileCodeTab} onClick={() => setMobileCodeTab(true)} className={cn(studioGhostButtonClassName, mobileCodeTab && "border-slate-900 bg-slate-900 text-white")}>脚本</button>
            <button type="button" role="tab" aria-selected={!mobileCodeTab} onClick={() => setMobileCodeTab(false)} className={cn(studioGhostButtonClassName, !mobileCodeTab && "border-slate-900 bg-slate-900 text-white")}>画布</button>
          </div>
        )}

        <div className={cn("grid min-w-0 gap-4 xl:grid-cols-2", presentationMode && "grid-cols-1")}>
          {!presentationMode && currentProject && (
            <section className={cn(studioPanelClassName, "min-w-0", compact && !mobileCodeTab && "hidden")}>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div><p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">Script Editor</p><h2 className="mt-1 text-lg font-semibold text-slate-900">{currentProject.title}</h2></div>
                <select className="min-h-11 rounded-2xl border border-slate-200 bg-white px-3 text-sm text-slate-700" value={currentProject.canvasMode} onChange={(event) => handleModeChange(event.target.value as GeoGebraMode)} aria-label="画布类型">
                  {CANVAS_MODES.map((mode) => <option key={mode.id} value={mode.id}>{mode.label}</option>)}
                </select>
              </div>
              <GeoGebraEditor value={currentProject.code} onChange={updateCode} onRun={() => void handleRun()} />
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" onClick={() => void handleRun()} disabled={running} className={studioPrimaryButtonClassName}><FaPlay /> {running ? `运行中 ${progress}%` : "运行脚本"}</button>
                <button type="button" onClick={() => setConfirmAction({ title: "清空画布", message: "当前图形将被移除，但脚本不会更改。", action: () => { appletRef.current?.clear(); setCanvasObjects([]); setNotice("画布已清空。"); } })} disabled={running} className={studioGhostButtonClassName}>清空画布</button>
                <button type="button" onClick={handleResetWorkbench} disabled={running} className={studioGhostButtonClassName}><FaRedo /> 重置工作台</button>
                <button type="button" onClick={() => void exportData(appletRef.current?.exportPng() ?? null, "geogebra.png")} disabled={running} className={studioGhostButtonClassName}><FaDownload /> PNG</button>
                <button type="button" onClick={() => void exportData(appletRef.current?.exportGgb() ?? null, "geogebra.ggb")} disabled={running} className={studioGhostButtonClassName}><FaDownload /> GGB</button>
                <button type="button" onClick={() => setLocked((value) => !value)} className={studioGhostButtonClassName}>{locked ? <FaLock /> : <FaUnlock />} {locked ? "解锁拖动" : "锁定拖动"}</button>
                <button type="button" onClick={() => void togglePresentation()} className={studioGhostButtonClassName}>演示模式</button>
              </div>
              {prepared.warnings.length > 0 && <p className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">部分脚本指令可能需要较长时间运行，请确认内容后再继续。</p>}
              {runReport && <p className={cn("mt-3 rounded-2xl border px-3 py-2 text-xs", runReport.success ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-rose-200 bg-rose-50 text-rose-700")}>{runReport.success ? `最近运行成功：${runReport.successCount} 条指令，${runReport.duration} ms。` : `最近运行未完成：${runReport.errorCount} 处需要检查。`}</p>}
            </section>
          )}

          <section className={cn("min-w-0 space-y-4", compact && mobileCodeTab && !presentationMode && "hidden")}>
              <GeoGebraApplet
                key={currentProject?.canvasMode ?? "geometry"}
                ref={appletRef}
                mode={currentProject?.canvasMode ?? "geometry"}
                height={phone ? 390 : 560}
                locked={locked}
                onReady={() => { setNotice("画布已准备好。"); setError(""); }}
                onError={setError}
                onPointsMoved={handlePointsMoved}
              />
              {!presentationMode && canvasDrift && (
                <section className={studioPanelClassName}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div><p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-amber-700">画布调整</p><h2 className="mt-1 text-sm font-semibold text-slate-900">选择要保存的点位</h2><p className="mt-1 text-xs text-slate-500">未保存的点位会在重新运行或切换画布时恢复到脚本中的位置。</p></div>
                    <div className="flex gap-2">
                      <button type="button" onClick={handleSyncMovedPoints} className={studioPrimaryButtonClassName}><FaCheck /> 保存所选点位</button>
                      <button type="button" onClick={() => { setCanvasMovedNames([]); setSelectedMovedNames([]); driftBaselineRef.current = null; setNotice("未保存的点位调整已忽略。"); }} className={studioGhostButtonClassName}>忽略调整</button>
                    </div>
                  </div>
                  {driftConflict && <p className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">脚本内容也有更新，保存点位前会再次确认。</p>}
                  {movedPointChanges.length > 0 && (
                    <ul className="mt-3 space-y-2">
                      {movedPointChanges.slice(0, 6).map((change) => (
                        <li key={change.name} className="rounded-2xl border border-slate-200 bg-white/80 px-3 py-2 text-xs text-slate-600">
                          <span className="font-semibold text-slate-700">{change.name}</span>
                          <span className="mt-1 block font-mono text-[11px] text-slate-500">{change.before ?? "脚本里还没有这条定义，保存后会新增。"}</span>
                          <span className="mt-1 block font-mono text-[11px] text-sky-700">保存后：{change.after}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {canvasMovedNames.map((name) => <label key={name} className="inline-flex min-h-10 items-center gap-2 rounded-full border border-slate-200 bg-white px-3 text-sm text-slate-700"><input type="checkbox" checked={selectedMovedNames.includes(name)} onChange={() => setSelectedMovedNames((items) => items.includes(name) ? items.filter((item) => item !== name) : [...items, name])} />{name}</label>)}
                  </div>
                </section>
              )}
            </section>
        </div>

        {!presentationMode && (
          <div className="grid min-w-0 gap-4 xl:grid-cols-2">
            <section className={studioPanelClassName}>
              <div className="mb-3"><p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">Parameters</p><h2 className="mt-1 text-lg font-semibold text-slate-900">参数调节</h2></div>
              {controls.length ? <div className="space-y-3">{controls.map((control) => (
                <label key={control.name} className="block rounded-2xl border border-slate-200 bg-white/80 p-3">
                  <span className="mb-2 flex justify-between text-xs font-semibold text-slate-600"><span>{control.name}</span><span>第 {control.lineNumber} 行</span></span>
                  {control.type === "number" ? <div className="flex items-center gap-3"><input className="min-w-0 flex-1 accent-slate-900" type="range" min={control.min} max={control.max} step={control.step} value={Number(parameterValues[control.name] ?? control.value)} onChange={(event) => handleParameterValueChange(control.name, Number(event.target.value))} /><input className="w-24 rounded-2xl border border-slate-200 px-2 py-2 text-sm" type="number" value={Number(parameterValues[control.name] ?? control.value)} onChange={(event) => handleParameterValueChange(control.name, Number(event.target.value))} /></div> : control.type === "boolean" ? <span className="flex min-h-10 items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={Boolean(parameterValues[control.name] ?? control.value)} onChange={(event) => handleParameterValueChange(control.name, event.target.checked)} />启用</span> : <input className="w-full rounded-2xl border border-slate-200 px-3 py-2 text-sm" value={String(parameterValues[control.name] ?? control.value)} onChange={(event) => handleParameterValueChange(control.name, event.target.value)} />}
                </label>
              ))}</div> : <p className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/80 px-4 py-6 text-sm text-slate-500">脚本中还没有可调节的简单参数。</p>}
              <div className="mt-3 flex flex-wrap gap-2"><button type="button" onClick={() => void applyParameters(false)} disabled={!controls.length} className={studioGhostButtonClassName}>应用参数</button><button type="button" onClick={() => void applyParameters(true)} disabled={!controls.length || running} className={studioPrimaryButtonClassName}>应用并运行</button></div>
            </section>

            <section className={studioPanelClassName}>
              <div className="mb-3"><p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">Script Structure</p><h2 className="mt-1 text-lg font-semibold text-slate-900">脚本结构</h2><p className="mt-1 text-sm text-slate-500">确认变量是否已定义、在哪里被用到。</p></div>
              <div className="flex flex-wrap gap-2 text-xs text-slate-600">
                <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1">定义 {variableReport.stats.definitions}</span>
                <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1">引用 {variableReport.stats.references}</span>
                <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1">未使用 {variableReport.stats.unused}</span>
                <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1">未定义 {variableReport.stats.undefined}</span>
              </div>
              {variableReport.undefinedNames.length > 0 && <p className="mt-3 rounded-2xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">这些名字在脚本里没有定义：{variableReport.undefinedNames.slice(0, 6).join("、")}。请检查拼写或补上定义行。</p>}
              {variableReport.duplicateNames.length > 0 && <p className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">这些名字定义了多次，后一次会覆盖前一次：{variableReport.duplicateNames.slice(0, 6).join("、")}。</p>}
              {variableReport.unusedNames.length > 0 && <p className="mt-3 rounded-2xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">这些定义暂时没有被引用：{variableReport.unusedNames.slice(0, 6).join("、")}。</p>}
              {variableReport.definitions.length
                ? <ul className="mt-3 space-y-2">{variableReport.definitions.slice(0, 8).map((item) => <li key={`${item.name}-${item.lineNumber}`} className="rounded-2xl border border-slate-200 bg-white/80 px-3 py-2 text-sm text-slate-600"><span className="font-semibold text-slate-700">{item.name}</span><span className="ml-2 text-xs text-slate-400">第 {item.lineNumber} 行 · {item.kind === "function" ? "函数" : "值"}</span><span className="mt-1 block text-xs text-slate-500">{item.usedAtLines.length ? `在第 ${item.usedAtLines.slice(0, 5).join("、")} 行被使用` : "暂时没有被引用"}</span></li>)}</ul>
                : <p className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/80 px-4 py-6 text-sm text-slate-500">脚本里还没有可分析的变量。</p>}
            </section>

            <section className={studioPanelClassName}>
              <div className="mb-3"><p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">Canvas Style</p><h2 className="mt-1 text-lg font-semibold text-slate-900">画布样式</h2></div>
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="text-xs font-semibold text-slate-600">颜色<input type="color" value={styleColor} onChange={(event) => setStyleColor(event.target.value)} className="mt-1 h-11 w-full rounded-2xl border border-slate-200 bg-white p-1" /></label>
                <label className="text-xs font-semibold text-slate-600">线宽<input type="number" min={1} max={13} value={lineThickness} onChange={(event) => setLineThickness(Math.max(1, Math.min(13, Number(event.target.value) || 1)))} className="mt-1 h-11 w-full rounded-2xl border border-slate-200 px-3" /></label>
                <label className="text-xs font-semibold text-slate-600">点大小<input type="number" min={1} max={12} value={pointSize} onChange={(event) => setPointSize(Math.max(1, Math.min(12, Number(event.target.value) || 1)))} className="mt-1 h-11 w-full rounded-2xl border border-slate-200 px-3" /></label>
              </div>
              <div className="mt-3 flex flex-wrap gap-4 text-sm text-slate-700">
                <label className="flex min-h-10 items-center gap-2"><input type="checkbox" checked={labelsVisible} onChange={(event) => setLabelsVisible(event.target.checked)} />显示标签</label>
                <label className="flex min-h-10 items-center gap-2"><input type="checkbox" checked={gridVisible} onChange={(event) => setGridVisible(event.target.checked)} />显示网格</label>
                <label className="flex min-h-10 items-center gap-2"><input type="checkbox" checked={axesVisible} onChange={(event) => setAxesVisible(event.target.checked)} />显示坐标轴</label>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" onClick={() => setStyleScope("all")} className={cn(studioGhostButtonClassName, styleScope === "all" && "border-slate-900 bg-slate-900 text-white")}>全部对象</button>
                <button type="button" onClick={() => setStyleScope("selected")} className={cn(studioGhostButtonClassName, styleScope === "selected" && "border-slate-900 bg-slate-900 text-white")}>选择对象</button>
              </div>
              {styleScope === "selected" && <div className="mt-3 flex flex-wrap gap-2">{canvasObjects.map((name) => <label key={name} className="inline-flex min-h-10 items-center gap-2 rounded-full border border-slate-200 bg-white px-3 text-sm text-slate-700"><input type="checkbox" checked={selectedStyleNames.includes(name)} onChange={() => setSelectedStyleNames((items) => items.includes(name) ? items.filter((item) => item !== name) : [...items, name])} />{name}</label>)}</div>}
              <button type="button" onClick={applyStyles} className={cn(studioPrimaryButtonClassName, "mt-3")}>应用样式</button>
            </section>

            <GeoGebraAiPanel
              project={currentProject}
              canvasMode={currentProject?.canvasMode ?? "geometry"}
              code={currentCode}
              objectNames={canvasObjects}
              onApplyCommands={handleApplyAiCommands}
            />

            <GeoGebraExportPanel project={currentProject} />

            <section className={studioPanelClassName}>
              <div className="mb-3"><p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">Lesson Mode</p><h2 className="mt-1 text-lg font-semibold text-slate-900">课堂讲解</h2><p className="mt-1 text-sm text-slate-500">逐步展示脚本如何组成图形。</p></div>
              <div className="flex flex-wrap gap-2 text-xs text-slate-600"><span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1">步骤 {lectureStep}/{lectureCommands.length}</span><span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1">{lecturePlaying ? "自动播放中" : "等待讲解"}</span></div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" onClick={prepareLecture} className={studioGhostButtonClassName}>准备讲解</button>
                <button type="button" onClick={() => void runLectureStep(Math.max(0, lectureStep - 1), lectureCommands)} disabled={!lectureCommands.length || lecturePlaying} className={studioGhostButtonClassName}>上一步</button>
                <button type="button" onClick={() => void runLectureStep(Math.min(lectureCommands.length, lectureStep + 1), lectureCommands)} disabled={!lectureCommands.length || lecturePlaying} className={studioGhostButtonClassName}>下一步</button>
                <button type="button" onClick={() => lecturePlaying ? stopLecture() : void playLecture()} className={studioPrimaryButtonClassName}>{lecturePlaying ? "停止" : "自动播放"}</button>
              </div>
            </section>

            <section className={studioPanelClassName}>
              <div className="mb-3"><p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-500">Run History</p><h2 className="mt-1 text-lg font-semibold text-slate-900">最近活动</h2></div>
              {runReport && runReport.steps.length > 0 && (
                <ul className="mb-3 max-h-56 space-y-1 overflow-y-auto">
                  {runReport.steps.slice(0, 40).map((step) => (
                    <li key={`${step.lineNumber}-${step.command}`} className={cn("rounded-2xl border px-3 py-1.5 text-xs", step.status === "ok" ? "border-slate-200 bg-white/80 text-slate-600" : "border-rose-200 bg-rose-50 text-rose-700")}>
                      <span className="font-semibold">第 {step.lineNumber} 行</span>
                      <span className="ml-2 font-mono text-[11px]">{step.command}</span>
                      <span className="ml-2 opacity-70">{step.durationMs} ms</span>
                      {step.message && <span className="mt-1 block">{step.message}</span>}
                    </li>
                  ))}
                </ul>
              )}
              {logs.length ? <ul className="space-y-2">{logs.slice(0, 12).map((entry) => <li key={entry.id} className={cn("rounded-2xl border px-3 py-2 text-sm", entry.tone === "error" ? "border-rose-200 bg-rose-50 text-rose-700" : entry.tone === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-700" : entry.tone === "warning" ? "border-amber-200 bg-amber-50 text-amber-700" : "border-slate-200 bg-white/80 text-slate-600")}><span>{entry.message}</span><time className="ml-2 text-xs opacity-70">{new Date(entry.at).toLocaleTimeString("zh-CN")}</time></li>)}</ul> : <p className="rounded-2xl border border-dashed border-slate-200 bg-slate-50/80 px-4 py-6 text-sm text-slate-500">运行后会显示最近结果。</p>}
            </section>
          </div>
        )}

        {presentationMode && <div className="fixed inset-x-0 top-0 z-50 flex items-center justify-between bg-white/90 px-4 py-3 shadow-sm backdrop-blur"><span className="text-sm font-semibold text-slate-700">演示模式</span><div className="flex gap-2"><button type="button" onClick={() => void handleRun(true)} className={studioGhostButtonClassName}>重新运行</button><button type="button" onClick={() => void exportData(appletRef.current?.exportPng() ?? null, "geogebra.png")} className={studioGhostButtonClassName}>导出 PNG</button><button type="button" onClick={() => void exportData(appletRef.current?.exportGgb() ?? null, "geogebra.ggb")} className={studioGhostButtonClassName}>导出 GGB</button><button type="button" onClick={() => void togglePresentation()} className={studioPrimaryButtonClassName}>退出演示</button></div></div>}

        {confirmAction && (
          <div className="fixed inset-0 z-[10050] grid place-items-center bg-slate-950/30 p-4 backdrop-blur-sm" role="presentation" onClick={() => setConfirmAction(null)}>
            <section role="dialog" aria-modal="true" aria-labelledby="geogebra-confirm-title" className="w-full max-w-md rounded-2xl border border-slate-200 bg-white/95 p-5 shadow-xl" onClick={(event) => event.stopPropagation()}>
              <h2 id="geogebra-confirm-title" className="text-lg font-semibold text-slate-900">{confirmAction.title}</h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">{confirmAction.message}</p>
              <div className="mt-5 flex justify-end gap-2"><button type="button" ref={cancelConfirmRef} onClick={() => setConfirmAction(null)} className={studioGhostButtonClassName}>取消</button><button type="button" ref={proceedConfirmRef} onClick={() => { const action = confirmAction.action; setConfirmAction(null); action(); }} className={studioPrimaryButtonClassName}>继续</button></div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

function downloadTextFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
