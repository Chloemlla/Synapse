import type { GeoGebraLocalProject, GeoGebraLocalVersion } from "../../types/geogebra";

export const GEOGEBRA_STORAGE_KEY = "synapse-geogebra-studio-v1";
const MAX_LOCAL_PROJECTS = 40;
const MAX_LOCAL_VERSIONS = 24;
const DEFAULT_CODE = "// 在这里输入 GeoGebra 指令\nA = (0, 0)\nB = (3, 0)\nsegment = Segment(A, B)\n";

function safeId(prefix: string): string {
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID().replace(/-/g, "")
    : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}_${random}`;
}

export function createLocalGeoGebraProject(overrides: Partial<GeoGebraLocalProject> = {}): GeoGebraLocalProject {
  const now = new Date().toISOString();
  return {
    projectId: safeId("proj"),
    title: "未命名项目",
    folder: "个人空间",
    tags: [],
    isFavorite: false,
    workspaceId: null,
    canvasMode: "geometry",
    code: DEFAULT_CODE,
    createdAt: now,
    updatedAt: now,
    lastOpenedAt: now,
    versions: [],
    ...overrides,
  };
}

export function createLocalGeoGebraVersion(
  project: Pick<GeoGebraLocalProject, "code" | "canvasMode">,
  label = "手动快照",
  trigger = "manual",
): GeoGebraLocalVersion {
  return {
    versionId: safeId("ver"),
    label: label.trim().slice(0, 120) || "手动快照",
    code: project.code.slice(0, 50_000),
    canvasMode: project.canvasMode,
    trigger: trigger.slice(0, 40),
    createdAt: new Date().toISOString(),
  };
}

function validMode(value: unknown): value is GeoGebraLocalProject["canvasMode"] {
  return value === "geometry" || value === "3d" || value === "graphing" || value === "classic";
}

function normalizeProject(value: unknown): GeoGebraLocalProject | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<GeoGebraLocalProject>;
  if (typeof item.projectId !== "string" || typeof item.code !== "string" || !validMode(item.canvasMode)) return null;
  const now = new Date().toISOString();
  const versions = Array.isArray(item.versions)
    ? item.versions.filter((version): version is GeoGebraLocalVersion => Boolean(version)
      && typeof version.versionId === "string"
      && typeof version.code === "string"
      && validMode(version.canvasMode))
      .slice(0, MAX_LOCAL_VERSIONS)
    : [];
  return {
    projectId: item.projectId.slice(0, 80),
    title: typeof item.title === "string" ? item.title.slice(0, 120) : "未命名项目",
    folder: typeof item.folder === "string" ? item.folder.slice(0, 80) : "个人空间",
    tags: Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 20) : [],
    isFavorite: Boolean(item.isFavorite),
    workspaceId: typeof item.workspaceId === "string" ? item.workspaceId.slice(0, 100) : null,
    ...(Number.isInteger(item.cloudRevision) && Number(item.cloudRevision) > 0 ? { cloudRevision: Number(item.cloudRevision) } : {}),
    canvasMode: item.canvasMode,
    code: item.code.slice(0, 50_000),
    createdAt: typeof item.createdAt === "string" ? item.createdAt : now,
    updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : now,
    lastOpenedAt: typeof item.lastOpenedAt === "string" ? item.lastOpenedAt : now,
    versions,
  };
}

export function readLocalGeoGebraProjects(): GeoGebraLocalProject[] {
  try {
    const raw = window.localStorage.getItem(GEOGEBRA_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeProject).filter((project): project is GeoGebraLocalProject => project !== null)
      .slice(0, MAX_LOCAL_PROJECTS);
  } catch {
    return [];
  }
}

export function writeLocalGeoGebraProjects(projects: GeoGebraLocalProject[]): boolean {
  try {
    const safe = projects.slice(0, MAX_LOCAL_PROJECTS).map((project) => ({
      ...project,
      code: project.code.slice(0, 50_000),
      tags: project.tags.slice(0, 20),
      versions: project.versions.slice(0, MAX_LOCAL_VERSIONS),
    }));
    window.localStorage.setItem(GEOGEBRA_STORAGE_KEY, JSON.stringify(safe));
    return true;
  } catch {
    return false;
  }
}

export function upsertLocalGeoGebraProject(
  projects: GeoGebraLocalProject[],
  project: GeoGebraLocalProject,
): GeoGebraLocalProject[] {
  const next = [project, ...projects.filter((item) => item.projectId !== project.projectId)];
  return next.sort((left, right) => Number(right.isFavorite) - Number(left.isFavorite)
    || Date.parse(right.lastOpenedAt) - Date.parse(left.lastOpenedAt)).slice(0, MAX_LOCAL_PROJECTS);
}

export function summarizeLocalGeoGebraDiff(before: string, after: string) {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  let changedLines = 0;
  let addedLines = 0;
  let removedLines = 0;
  for (let index = 0; index < Math.max(beforeLines.length, afterLines.length); index += 1) {
    if (beforeLines[index] === afterLines[index]) continue;
    if (beforeLines[index] === undefined) addedLines += 1;
    else if (afterLines[index] === undefined) removedLines += 1;
    else changedLines += 1;
  }
  return { changedLines, addedLines, removedLines };
}
