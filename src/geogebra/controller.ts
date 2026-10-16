import type { Request, Response } from "express";
import { asAuthenticatedRequest } from "../types/authRequest";
import logger from "../utils/logger";
import { GeoGebraDomainError } from "./projectService";
import {
  createGeoGebraProject,
  createGeoGebraVersion,
  deleteGeoGebraProject,
  exportUserGeoGebraData,
  listGeoGebraProjects,
  listGeoGebraVersions,
  touchGeoGebraProject,
  updateGeoGebraProject,
} from "./projectService";
import {
  createGeoGebraComment,
  listGeoGebraComments,
  resolveGeoGebraComment,
} from "./reviewCommentService";
import {
  createGeoGebraShare,
  deleteGeoGebraShare,
  forkGeoGebraShare,
  getPublicGeoGebraShare,
  getPublicGeoGebraShareCover,
  listGeoGebraShares,
} from "./shareService";
import {
  createGeoGebraAssetFromDataUrl,
  deleteGeoGebraAsset,
  readGeoGebraAsset,
} from "./assetService";
import {
  cancelGeoGebraJob,
  createGeoGebraAiJob,
  createGeoGebraExportJob,
  getGeoGebraJob,
  listGeoGebraExportCapabilities,
  listGeoGebraJobs,
} from "./jobService";
import { GEOGEBRA_AI_KINDS, type GeoGebraAiKind } from "./aiService";

function currentUserId(req: Request): string | null {
  const userId = String(asAuthenticatedRequest(req).user?.id ?? "").trim();
  return userId || null;
}

function jsonBody(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
}

function sendError(res: Response, action: string, error: unknown): void {
  if (error instanceof GeoGebraDomainError) {
    res.status(error.status).json({ success: false, error: error.message, code: error.code });
    return;
  }
  logger.error("[GeoGebra] Request failed", {
    action,
    errorType: error instanceof Error ? error.name : "unknown",
  });
  res.status(500).json({ success: false, error: "请求暂时无法完成，请稍后重试。", code: "GEOGEBRA_INTERNAL_ERROR" });
}

function requireUser(res: Response, req: Request): string | null {
  const userId = currentUserId(req);
  if (!userId) res.status(401).json({ success: false, error: "请先登录。", code: "UNAUTHENTICATED" });
  return userId;
}

export const geoGebraController = {
  async listProjects(req: Request, res: Response): Promise<void> {
    const userId = requireUser(res, req);
    if (!userId) return;
    try {
      res.json({ success: true, data: { projects: await listGeoGebraProjects(userId) } });
    } catch (error) {
      sendError(res, "list-projects", error);
    }
  },

  async createProject(req: Request, res: Response): Promise<void> {
    const userId = requireUser(res, req);
    if (!userId) return;
    try {
      const project = await createGeoGebraProject(userId, jsonBody(req));
      res.status(201).json({ success: true, data: { project } });
    } catch (error) {
      sendError(res, "create-project", error);
    }
  },

  async getProject(req: Request, res: Response): Promise<void> {
    const userId = requireUser(res, req);
    if (!userId) return;
    try {
      const project = await touchGeoGebraProject(userId, String(req.params.projectId ?? ""));
      res.json({ success: true, data: { project } });
    } catch (error) {
      sendError(res, "get-project", error);
    }
  },

  async updateProject(req: Request, res: Response): Promise<void> {
    const userId = requireUser(res, req);
    if (!userId) return;
    try {
      const project = await updateGeoGebraProject(userId, String(req.params.projectId ?? ""), jsonBody(req));
      res.json({ success: true, data: { project } });
    } catch (error) {
      sendError(res, "update-project", error);
    }
  },

  async deleteProject(req: Request, res: Response): Promise<void> {
    const userId = requireUser(res, req);
    if (!userId) return;
    try {
      await deleteGeoGebraProject(userId, String(req.params.projectId ?? ""));
      res.json({ success: true, data: { deleted: true } });
    } catch (error) {
      sendError(res, "delete-project", error);
    }
  },

  async listVersions(req: Request, res: Response): Promise<void> {
    const userId = requireUser(res, req);
    if (!userId) return;
    try {
      const versions = await listGeoGebraVersions(userId, String(req.params.projectId ?? ""));
      res.json({ success: true, data: { versions } });
    } catch (error) {
      sendError(res, "list-versions", error);
    }
  },

  async createVersion(req: Request, res: Response): Promise<void> {
    const userId = requireUser(res, req);
    if (!userId) return;
    try {
      const version = await createGeoGebraVersion(userId, String(req.params.projectId ?? ""), jsonBody(req));
      res.status(201).json({ success: true, data: { version } });
    } catch (error) {
      sendError(res, "create-version", error);
    }
  },

  async listComments(req: Request, res: Response): Promise<void> {
    const userId = requireUser(res, req);
    if (!userId) return;
    try {
      const projectId = typeof req.query.projectId === "string" ? req.query.projectId : "";
      const comments = await listGeoGebraComments(userId, projectId);
      res.json({ success: true, data: { comments } });
    } catch (error) {
      sendError(res, "list-comments", error);
    }
  },

  async createComment(req: Request, res: Response): Promise<void> {
    const userId = requireUser(res, req);
    if (!userId) return;
    try {
      const comment = await createGeoGebraComment(userId, jsonBody(req) as { projectId: unknown; versionId?: unknown; objectName?: unknown; body: unknown });
      res.status(201).json({ success: true, data: { comment } });
    } catch (error) {
      sendError(res, "create-comment", error);
    }
  },

  async resolveComment(req: Request, res: Response): Promise<void> {
    const userId = requireUser(res, req);
    if (!userId) return;
    try {
      const comment = await resolveGeoGebraComment(userId, String(req.params.commentId ?? ""));
      res.json({ success: true, data: { comment } });
    } catch (error) {
      sendError(res, "resolve-comment", error);
    }
  },

  async createShare(req: Request, res: Response): Promise<void> {
    const userId = requireUser(res, req);
    if (!userId) return;
    try {
      const share = await createGeoGebraShare(userId, jsonBody(req) as {
        projectId?: unknown; title?: unknown; canvasMode?: unknown; commands?: unknown; coverDataUrl?: unknown; allowFork?: unknown;
      });
      res.status(201).json({ success: true, data: { share } });
    } catch (error) {
      sendError(res, "create-share", error);
    }
  },

  async listShares(req: Request, res: Response): Promise<void> {
    const userId = requireUser(res, req);
    if (!userId) return;
    try {
      const shares = await listGeoGebraShares(userId);
      res.json({ success: true, data: { shares } });
    } catch (error) {
      sendError(res, "list-shares", error);
    }
  },

  async getShare(req: Request, res: Response): Promise<void> {
    try {
      const share = await getPublicGeoGebraShare(String(req.params.slug ?? ""));
      res.json({ success: true, data: { share } });
    } catch (error) {
      sendError(res, "get-share", error);
    }
  },

  async getShareCover(req: Request, res: Response): Promise<void> {
    try {
      const cover = await getPublicGeoGebraShareCover(String(req.params.slug ?? ""));
      res.setHeader("Content-Type", "image/png");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.setHeader("Cache-Control", "public, max-age=300, must-revalidate");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.status(200).send(cover);
    } catch (error) {
      sendError(res, "get-share-cover", error);
    }
  },

  async forkShare(req: Request, res: Response): Promise<void> {
    const userId = requireUser(res, req);
    if (!userId) return;
    try {
      const project = await forkGeoGebraShare(userId, String(req.params.slug ?? ""));
      res.status(201).json({ success: true, data: { project } });
    } catch (error) {
      sendError(res, "fork-share", error);
    }
  },

  async deleteShare(req: Request, res: Response): Promise<void> {
    const userId = requireUser(res, req);
    if (!userId) return;
    try {
      await deleteGeoGebraShare(userId, String(req.params.shareId ?? ""));
      res.json({ success: true, data: { deleted: true } });
    } catch (error) {
      sendError(res, "delete-share", error);
    }
  },

  async exportUserData(req: Request, res: Response): Promise<void> {
    const userId = requireUser(res, req);
    if (!userId) return;
    try {
      const exported = await exportUserGeoGebraData(userId);
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Content-Disposition", "attachment; filename=geogebra-data.json");
      res.json(exported);
    } catch (error) {
      sendError(res, "export-user-data", error);
    }
  },

  async createAsset(req: Request, res: Response): Promise<void> {
    const userId = requireUser(res, req);
    if (!userId) return;
    try {
      const asset = await createGeoGebraAssetFromDataUrl(userId, "ai-reference", jsonBody(req).dataUrl);
      res.status(201).json({ success: true, data: { asset } });
    } catch (error) {
      sendError(res, "create-asset", error);
    }
  },

  async getAsset(req: Request, res: Response): Promise<void> {
    const userId = requireUser(res, req);
    if (!userId) return;
    try {
      const asset = await readGeoGebraAsset(userId, String(req.params.assetId ?? ""));
      res.setHeader("Content-Type", asset.mimeType);
      res.setHeader("Content-Length", String(asset.byteSize));
      res.setHeader("Cache-Control", "private, no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.status(200).send(asset.bytes);
    } catch (error) {
      sendError(res, "get-asset", error);
    }
  },

  async deleteAsset(req: Request, res: Response): Promise<void> {
    const userId = requireUser(res, req);
    if (!userId) return;
    try {
      await deleteGeoGebraAsset(userId, String(req.params.assetId ?? ""));
      res.json({ success: true, data: { deleted: true } });
    } catch (error) {
      sendError(res, "delete-asset", error);
    }
  },

  async listJobs(req: Request, res: Response): Promise<void> {
    const userId = requireUser(res, req);
    if (!userId) return;
    try {
      const limit = Number(req.query.limit ?? 20);
      const jobs = await listGeoGebraJobs(userId, Number.isFinite(limit) ? limit : 20);
      res.json({ success: true, data: { jobs } });
    } catch (error) {
      sendError(res, "list-jobs", error);
    }
  },

  async getJob(req: Request, res: Response): Promise<void> {
    const userId = requireUser(res, req);
    if (!userId) return;
    try {
      const job = await getGeoGebraJob(userId, String(req.params.jobId ?? ""));
      res.json({ success: true, data: { job } });
    } catch (error) {
      sendError(res, "get-job", error);
    }
  },

  async cancelJob(req: Request, res: Response): Promise<void> {
    const userId = requireUser(res, req);
    if (!userId) return;
    try {
      const job = await cancelGeoGebraJob(userId, String(req.params.jobId ?? ""));
      res.json({ success: true, data: { job } });
    } catch (error) {
      sendError(res, "cancel-job", error);
    }
  },

  async createAiJob(req: Request, res: Response): Promise<void> {
    const userId = requireUser(res, req);
    if (!userId) return;
    try {
      const body = jsonBody(req);
      const kind = typeof body.kind === "string" ? body.kind : "";
      if (!(GEOGEBRA_AI_KINDS as readonly string[]).includes(kind)) {
        res.status(400).json({ success: false, error: "该 AI 能力暂不支持。", code: "GEOGEBRA_AI_KIND_UNKNOWN" });
        return;
      }
      const job = await createGeoGebraAiJob({
        userId,
        kind: kind as GeoGebraAiKind,
        projectId: body.projectId,
        canvasMode: body.canvasMode,
        code: body.code,
        prompt: body.prompt,
        objectNames: body.objectNames,
        focusObject: body.focusObject,
        referenceAssetId: body.referenceAssetId,
      });
      res.status(202).json({ success: true, data: { job } });
    } catch (error) {
      sendError(res, "create-ai-job", error);
    }
  },

  async listExportCapabilities(_req: Request, res: Response): Promise<void> {
    res.json({ success: true, data: { formats: listGeoGebraExportCapabilities() } });
  },

  async createExportJob(req: Request, res: Response): Promise<void> {
    const userId = requireUser(res, req);
    if (!userId) return;
    try {
      const body = jsonBody(req);
      const job = await createGeoGebraExportJob({ userId, projectId: body.projectId, format: body.format });
      res.status(202).json({ success: true, data: { job } });
    } catch (error) {
      sendError(res, "create-export-job", error);
    }
  },
};
