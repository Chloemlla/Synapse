import crypto from "node:crypto";
import GeoGebraProjectModel, { type IGeoGebraProject } from "../models/geogebraProjectModel";
import GeoGebraProjectVersionModel, { type IGeoGebraProjectVersion } from "../models/geogebraProjectVersionModel";
import GeoGebraReviewCommentModel from "../models/geogebraReviewCommentModel";
import GeoGebraShareModel from "../models/geogebraShareModel";
import { workspaceService } from "./workspaceService";
import { deleteGeoGebraShareCover } from "./shareAssetStorage";
import { validateGeoGebraProjectCode } from "./scriptValidation";
import type { GeoGebraMode } from "../models/geogebraProjectModel";

export class GeoGebraDomainError extends Error {
  constructor(message: string, public readonly status: number, public readonly code: string) {
    super(message);
    this.name = "GeoGebraDomainError";
  }
}

export type GeoGebraProjectInput = {
  projectId?: unknown;
  workspaceId?: unknown;
  title?: unknown;
  folder?: unknown;
  tags?: unknown;
  isFavorite?: unknown;
  canvasMode?: unknown;
  code?: unknown;
};

const MODES = new Set<GeoGebraMode>(["geometry", "3d", "graphing", "classic"]);
const PROJECT_ID = /^[A-Za-z0-9_-]{8,80}$/;

function normalizeText(value: unknown, fallback: string, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) || fallback : fallback;
}

function normalizeMode(value: unknown): GeoGebraMode {
  return typeof value === "string" && MODES.has(value as GeoGebraMode) ? value as GeoGebraMode : "geometry";
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((tag): tag is string => typeof tag === "string")
    .map((tag) => tag.trim().slice(0, 40)).filter(Boolean))].slice(0, 20);
}

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

function projectView(project: IGeoGebraProject | Record<string, unknown>, viewerId: string) {
  const value = project as IGeoGebraProject;
  return {
    projectId: value.projectId,
    isOwner: value.ownerUserId === viewerId,
    workspaceId: value.workspaceId ?? null,
    title: value.title,
    folder: value.folder,
    tags: value.tags ?? [],
    isFavorite: Boolean(value.isFavorite),
    canvasMode: value.canvasMode,
    code: value.code,
    revision: value.revision ?? 1,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    lastOpenedAt: value.lastOpenedAt ?? value.updatedAt,
  };
}

function versionView(version: IGeoGebraProjectVersion | Record<string, unknown>) {
  const value = version as IGeoGebraProjectVersion;
  return {
    versionId: value.versionId,
    projectId: value.projectId,
    label: value.label,
    code: value.code,
    canvasMode: value.canvasMode,
    trigger: value.trigger,
    createdAt: value.createdAt,
  };
}

async function workspaceRole(workspaceId: string | null | undefined, userId: string) {
  if (!workspaceId) return null;
  return workspaceService.getMemberRole(workspaceId, userId);
}

export async function getAccessibleGeoGebraProject(
  userId: string,
  projectId: string,
  permission: "read" | "write" | "comment" = "read",
): Promise<IGeoGebraProject> {
  const project = await GeoGebraProjectModel.findOne({ projectId, subjectDeletedAt: 0 }).lean();
  if (!project) throw new GeoGebraDomainError("项目不存在。", 404, "GEOGEBRA_PROJECT_NOT_FOUND");
  if (project.ownerUserId === userId) return project as unknown as IGeoGebraProject;

  const role = await workspaceRole(project.workspaceId, userId);
  const allowed = permission === "read"
    ? role !== null
    : permission === "write"
      ? role === "admin" || role === "editor"
      : role === "admin" || role === "editor" || role === "reviewer";
  if (!allowed) throw new GeoGebraDomainError("项目不存在。", 404, "GEOGEBRA_PROJECT_NOT_FOUND");
  return project as unknown as IGeoGebraProject;
}

export async function listGeoGebraProjects(userId: string) {
  const workspaces = await workspaceService.getUserWorkspaces(userId);
  const workspaceIds = workspaces.map((workspace) => workspace.id);
  const visibility = workspaceIds.length > 0
    ? { $or: [{ ownerUserId: userId }, { workspaceId: { $in: workspaceIds } }] }
    : { ownerUserId: userId };
  const projects = await GeoGebraProjectModel.find({ ...visibility, subjectDeletedAt: 0 })
    .sort({ isFavorite: -1, lastOpenedAt: -1 })
    .limit(100)
    .lean();
  return projects.map((project) => projectView(project as unknown as IGeoGebraProject, userId));
}

export async function createGeoGebraProject(userId: string, input: GeoGebraProjectInput) {
  const workspaceId = typeof input.workspaceId === "string" && input.workspaceId.trim()
    ? input.workspaceId.trim().slice(0, 100)
    : null;
  if (workspaceId) {
    const role = await workspaceRole(workspaceId, userId);
    if (role !== "admin" && role !== "editor") {
      throw new GeoGebraDomainError("你没有权限在该团队中创建项目。", 403, "GEOGEBRA_WORKSPACE_FORBIDDEN");
    }
  }
  const requestedId = typeof input.projectId === "string" && PROJECT_ID.test(input.projectId)
    ? input.projectId
    : newId("proj");
  const code = validateGeoGebraProjectCode(typeof input.code === "string" ? input.code : "");
  const mode = normalizeMode(input.canvasMode);
  const now = new Date();
  try {
    const project = await GeoGebraProjectModel.create({
      projectId: requestedId,
      ownerUserId: userId,
      workspaceId,
      title: normalizeText(input.title, "未命名项目", 120),
      folder: normalizeText(input.folder, "个人空间", 80),
      tags: normalizeTags(input.tags),
      isFavorite: input.isFavorite === true,
      canvasMode: mode,
      code,
      revision: 1,
      lastOpenedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    return projectView(project as unknown as IGeoGebraProject, userId);
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      throw new GeoGebraDomainError("项目标识已存在，请重试。", 409, "GEOGEBRA_PROJECT_CONFLICT");
    }
    throw error;
  }
}

export async function updateGeoGebraProject(userId: string, projectId: string, input: GeoGebraProjectInput & { revision?: unknown }) {
  const current = await getAccessibleGeoGebraProject(userId, projectId, "write");
  const revision = Number(input.revision);
  if (!Number.isInteger(revision) || revision !== current.revision) {
    throw new GeoGebraDomainError("项目已在其他位置更新，请重新载入后再保存。", 409, "GEOGEBRA_PROJECT_REVISION_CONFLICT");
  }

  let workspaceId = current.workspaceId ?? null;
  if (input.workspaceId !== undefined) {
    workspaceId = typeof input.workspaceId === "string" && input.workspaceId.trim()
      ? input.workspaceId.trim().slice(0, 100)
      : null;
    if (current.ownerUserId !== userId && workspaceId !== current.workspaceId) {
      throw new GeoGebraDomainError("只有项目所有者可以更改团队归属。", 403, "GEOGEBRA_PROJECT_FORBIDDEN");
    }
    if (workspaceId) {
      const role = await workspaceRole(workspaceId, userId);
      if (role !== "admin" && role !== "editor") {
        throw new GeoGebraDomainError("你没有权限使用该团队空间。", 403, "GEOGEBRA_WORKSPACE_FORBIDDEN");
      }
    }
  }

  const updates: Record<string, unknown> = { workspaceId, updatedAt: new Date() };
  if (input.title !== undefined) updates.title = normalizeText(input.title, current.title, 120);
  if (input.folder !== undefined) updates.folder = normalizeText(input.folder, "个人空间", 80);
  if (input.tags !== undefined) updates.tags = normalizeTags(input.tags);
  if (input.isFavorite !== undefined) updates.isFavorite = input.isFavorite === true;
  if (input.canvasMode !== undefined) updates.canvasMode = normalizeMode(input.canvasMode);
  if (input.code !== undefined) updates.code = validateGeoGebraProjectCode(input.code);

  const updated = await GeoGebraProjectModel.findOneAndUpdate(
    { projectId, revision, subjectDeletedAt: 0 },
    { $set: updates, $inc: { revision: 1 } },
    { returnDocument: "after", runValidators: true },
  ).lean();
  if (!updated) {
    throw new GeoGebraDomainError("项目已在其他位置更新，请重新载入后再保存。", 409, "GEOGEBRA_PROJECT_REVISION_CONFLICT");
  }
  return projectView(updated as unknown as IGeoGebraProject, userId);
}

export async function touchGeoGebraProject(userId: string, projectId: string) {
  const project = await getAccessibleGeoGebraProject(userId, projectId, "read");
  await GeoGebraProjectModel.updateOne({ projectId }, { $set: { lastOpenedAt: new Date() } });
  return projectView(project, userId);
}

export async function deleteGeoGebraProject(userId: string, projectId: string): Promise<void> {
  const project = await getAccessibleGeoGebraProject(userId, projectId, "read");
  const role = await workspaceRole(project.workspaceId, userId);
  if (project.ownerUserId !== userId && role !== "admin") {
    throw new GeoGebraDomainError("只有项目所有者或团队管理员可以删除项目。", 403, "GEOGEBRA_PROJECT_FORBIDDEN");
  }
  await GeoGebraProjectModel.deleteOne({ projectId, subjectDeletedAt: 0 });
  await GeoGebraProjectVersionModel.deleteMany({ projectId });
  await GeoGebraReviewCommentModel.deleteMany({ projectId });
  const shares = await GeoGebraShareModel.find({ projectId }).select("shareId").lean();
  await GeoGebraShareModel.updateMany({ projectId }, { $set: { revokedAt: new Date() } });
  await Promise.all(shares.map((share) => deleteGeoGebraShareCover(share.shareId)));
}

export async function listGeoGebraVersions(userId: string, projectId: string) {
  await getAccessibleGeoGebraProject(userId, projectId, "read");
  const versions = await GeoGebraProjectVersionModel.find({ projectId, subjectDeletedAt: 0 })
    .sort({ createdAt: -1 }).limit(100).lean();
  return versions.map((version) => versionView(version as unknown as IGeoGebraProjectVersion));
}

export async function createGeoGebraVersion(userId: string, projectId: string, input: {
  label?: unknown;
  code?: unknown;
  canvasMode?: unknown;
  trigger?: unknown;
}) {
  const project = await getAccessibleGeoGebraProject(userId, projectId, "write");
  const code = validateGeoGebraProjectCode(input.code);
  const version = await GeoGebraProjectVersionModel.create({
    versionId: newId("ver"),
    projectId,
    ownerUserId: project.ownerUserId,
    workspaceId: project.workspaceId,
    label: normalizeText(input.label, "手动快照", 120),
    code,
    canvasMode: normalizeMode(input.canvasMode ?? project.canvasMode),
    trigger: normalizeText(input.trigger, "manual", 40),
    createdAt: new Date(),
  });
  return versionView(version as unknown as IGeoGebraProjectVersion);
}

export async function exportUserGeoGebraData(userId: string) {
  const [projects, comments, shares] = await Promise.all([
    GeoGebraProjectModel.find({ ownerUserId: userId, subjectDeletedAt: 0 }).sort({ createdAt: 1 }).lean(),
    GeoGebraReviewCommentModel.find({ authorUserId: userId, subjectDeletedAt: 0 }).sort({ createdAt: 1 }).lean(),
    GeoGebraShareModel.find({ ownerUserId: userId, subjectDeletedAt: 0 }).sort({ createdAt: 1 }).lean(),
  ]);
  const projectIds = projects.map((project) => project.projectId);
  const versions = projectIds.length
    ? await GeoGebraProjectVersionModel.find({ projectId: { $in: projectIds }, subjectDeletedAt: 0 }).sort({ createdAt: 1 }).lean()
    : [];
  return {
    exportedAt: new Date().toISOString(),
    projects: projects.map((project) => projectView(project as unknown as IGeoGebraProject, userId)),
    versions: versions.map((version) => versionView(version as unknown as IGeoGebraProjectVersion)),
    comments: comments.map((comment) => ({
      commentId: comment.commentId,
      projectId: comment.projectId,
      versionId: comment.versionId,
      objectName: comment.objectName,
      body: comment.body,
      status: comment.status,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
    })),
    shares: shares.map((share) => ({
      shareId: share.shareId,
      slug: share.slug,
      title: share.title,
      canvasMode: share.canvasMode,
      commands: share.commands,
      allowFork: share.allowFork,
      createdAt: share.createdAt,
      revokedAt: share.revokedAt,
    })),
  };
}

export async function markUserGeoGebraDataDeleted(userId: string, deletedAt: number, reason: string): Promise<void> {
  await Promise.all([
    GeoGebraProjectModel.updateMany({ ownerUserId: userId, subjectDeletedAt: 0 }, {
      $set: { subjectDeletedAt: deletedAt, deletedBy: "account-deletion", deleteReason: reason },
    }),
    GeoGebraProjectVersionModel.updateMany({ ownerUserId: userId, subjectDeletedAt: 0 }, { $set: { subjectDeletedAt: deletedAt } }),
    GeoGebraReviewCommentModel.updateMany({ authorUserId: userId, subjectDeletedAt: 0 }, { $set: { subjectDeletedAt: deletedAt } }),
    GeoGebraShareModel.updateMany({ ownerUserId: userId, subjectDeletedAt: 0 }, {
      $set: { subjectDeletedAt: deletedAt, revokedAt: new Date(deletedAt) },
    }),
  ]);
}
