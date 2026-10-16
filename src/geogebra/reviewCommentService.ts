import crypto from "node:crypto";
import GeoGebraReviewCommentModel, { type IGeoGebraReviewComment } from "../models/geogebraReviewCommentModel";
import GeoGebraProjectVersionModel from "../models/geogebraProjectVersionModel";
import { getAccessibleGeoGebraProject, GeoGebraDomainError } from "./projectService";

function commentView(comment: IGeoGebraReviewComment | Record<string, unknown>) {
  const value = comment as IGeoGebraReviewComment;
  return {
    commentId: value.commentId,
    projectId: value.projectId,
    versionId: value.versionId ?? null,
    objectName: value.objectName ?? null,
    body: value.body,
    status: value.status,
    canResolve: true,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export async function listGeoGebraComments(userId: string, projectId: string) {
  await getAccessibleGeoGebraProject(userId, projectId, "read");
  const comments = await GeoGebraReviewCommentModel.find({ projectId, subjectDeletedAt: 0 })
    .sort({ createdAt: 1 }).limit(500).lean();
  return comments.map((comment) => commentView(comment as unknown as IGeoGebraReviewComment));
}

export async function createGeoGebraComment(userId: string, input: {
  projectId: unknown;
  versionId?: unknown;
  objectName?: unknown;
  body: unknown;
}) {
  const projectId = typeof input.projectId === "string" ? input.projectId.trim() : "";
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (!projectId || body.length === 0 || body.length > 4_000) {
    throw new GeoGebraDomainError("请填写有效的评论内容。", 400, "GEOGEBRA_COMMENT_INVALID");
  }
  const project = await getAccessibleGeoGebraProject(userId, projectId, "comment");
  const versionId = typeof input.versionId === "string" && input.versionId.trim()
    ? input.versionId.trim().slice(0, 80)
    : null;
  if (versionId) {
    const exists = await GeoGebraProjectVersionModel.exists({ versionId, projectId, subjectDeletedAt: 0 });
    if (!exists) throw new GeoGebraDomainError("项目版本不存在。", 404, "GEOGEBRA_VERSION_NOT_FOUND");
  }
  const objectName = typeof input.objectName === "string" && input.objectName.trim()
    ? input.objectName.trim().slice(0, 100)
    : null;
  const comment = await GeoGebraReviewCommentModel.create({
    commentId: `comment_${crypto.randomUUID().replace(/-/g, "")}`,
    projectId,
    versionId,
    workspaceId: project.workspaceId ?? null,
    authorUserId: userId,
    objectName,
    body,
    status: "open",
    subjectDeletedAt: 0,
  });
  return commentView(comment as unknown as IGeoGebraReviewComment);
}

export async function resolveGeoGebraComment(userId: string, commentId: string) {
  const comment = await GeoGebraReviewCommentModel.findOne({ commentId, subjectDeletedAt: 0 }).lean();
  if (!comment) throw new GeoGebraDomainError("评论不存在。", 404, "GEOGEBRA_COMMENT_NOT_FOUND");
  await getAccessibleGeoGebraProject(userId, comment.projectId, "read");
  const updated = await GeoGebraReviewCommentModel.findOneAndUpdate(
    { commentId, subjectDeletedAt: 0 },
    { $set: { status: "resolved", updatedAt: new Date() } },
    { returnDocument: "after", runValidators: true },
  ).lean();
  if (!updated) throw new GeoGebraDomainError("评论不存在。", 404, "GEOGEBRA_COMMENT_NOT_FOUND");
  return commentView(updated as unknown as IGeoGebraReviewComment);
}
