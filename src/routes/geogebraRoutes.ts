import express from "express";
import { authenticateToken } from "../middleware/authenticateToken";
import { requireFeatureConsent } from "../middleware/featureConsent";
import { geoGebraController } from "../geogebra/controller";

const router = express.Router();

/**
 * @openapi
 * /geogebra/projects:
 *   get:
 *     summary: List the current user's GeoGebra projects
 *     responses:
 *       200:
 *         description: Project list
 *   post:
 *     summary: Create a GeoGebra project
 *     responses:
 *       201:
 *         description: Project created
 */
router.get("/projects", authenticateToken, geoGebraController.listProjects);
router.post("/projects", authenticateToken, requireFeatureConsent("geogebra-projects"), geoGebraController.createProject);

/**
 * @openapi
 * /geogebra/projects/{projectId}:
 *   get:
 *     summary: Read a project the current user can access
 *     parameters:
 *       - in: path
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Project
 *       404:
 *         description: Project unavailable
 *   patch:
 *     summary: Update a project using optimistic revision control
 *     responses:
 *       200:
 *         description: Project updated
 *       409:
 *         description: Revision conflict
 *   delete:
 *     summary: Delete an owned project and its private history
 *     responses:
 *       200:
 *         description: Project deleted
 */
router.get("/projects/:projectId", authenticateToken, geoGebraController.getProject);
router.patch("/projects/:projectId", authenticateToken, requireFeatureConsent("geogebra-projects"), geoGebraController.updateProject);
router.delete("/projects/:projectId", authenticateToken, geoGebraController.deleteProject);

/**
 * @openapi
 * /geogebra/projects/{projectId}/versions:
 *   get:
 *     summary: List project versions
 *     responses:
 *       200:
 *         description: Version list
 *   post:
 *     summary: Create a project snapshot
 *     responses:
 *       201:
 *         description: Snapshot created
 */
router.get("/projects/:projectId/versions", authenticateToken, geoGebraController.listVersions);
router.post("/projects/:projectId/versions", authenticateToken, requireFeatureConsent("geogebra-projects"), geoGebraController.createVersion);

/**
 * @openapi
 * /geogebra/review-comments:
 *   get:
 *     summary: List comments for an accessible project
 *     parameters:
 *       - in: query
 *         name: projectId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Comment list
 *   post:
 *     summary: Create a project review comment
 *     responses:
 *       201:
 *         description: Comment created
 */
router.get("/review-comments", authenticateToken, geoGebraController.listComments);
router.post("/review-comments", authenticateToken, requireFeatureConsent("geogebra-projects"), geoGebraController.createComment);

/**
 * @openapi
 * /geogebra/review-comments/{commentId}:
 *   patch:
 *     summary: Resolve a comment the current user can manage
 *     responses:
 *       200:
 *         description: Comment resolved
 */
router.patch("/review-comments/:commentId", authenticateToken, geoGebraController.resolveComment);

/**
 * @openapi
 * /geogebra/shares:
 *   get:
 *     summary: List the current user's published shares
 *     responses:
 *       200:
 *         description: Share list
 *   post:
 *     summary: Publish a public GeoGebra share
 *     responses:
 *       201:
 *         description: Share published
 */
router.post(
  "/shares",
  authenticateToken,
  requireFeatureConsent("geogebra-projects"),
  requireFeatureConsent("geogebra-share"),
  geoGebraController.createShare,
);
router.get("/shares", authenticateToken, geoGebraController.listShares);

/**
 * @openapi
 * /geogebra/shares/{slug}:
 *   get:
 *     summary: Read a public GeoGebra share
 *     responses:
 *       200:
 *         description: Public share snapshot
 *       404:
 *         description: Share unavailable
 */
router.get("/shares/:slug", geoGebraController.getShare);

/**
 * @openapi
 * /geogebra/shares/{slug}/cover:
 *   get:
 *     summary: Read a public share cover image
 *     responses:
 *       200:
 *         description: PNG cover image
 *         content:
 *           image/png:
 *             schema:
 *               type: string
 *               format: binary
 */
router.get("/shares/:slug/cover", geoGebraController.getShareCover);

/**
 * @openapi
 * /geogebra/shares/{slug}/fork:
 *   post:
 *     summary: Fork a public share into the current user's projects
 *     responses:
 *       201:
 *         description: Project copy created
 */
router.post(
  "/shares/:slug/fork",
  authenticateToken,
  requireFeatureConsent("geogebra-projects"),
  geoGebraController.forkShare,
);

/**
 * @openapi
 * /geogebra/shares/{shareId}:
 *   delete:
 *     summary: Revoke an owned public share
 *     responses:
 *       200:
 *         description: Share revoked
 */
router.delete(
  "/shares/:shareId",
  authenticateToken,
  geoGebraController.deleteShare,
);

/**
 * @openapi
 * /geogebra/export:
 *   get:
 *     summary: Export the current user's GeoGebra data
 *     responses:
 *       200:
 *         description: User-owned projects, versions, comments, and shares
 */
router.get("/export", authenticateToken, geoGebraController.exportUserData);

/**
 * @openapi
 * /geogebra/assets:
 *   post:
 *     summary: Upload a reference image for AI-assisted script generation
 *     responses:
 *       201:
 *         description: Asset accepted (purpose-scoped, expires automatically)
 *       400:
 *         description: Unsupported type or mismatched content
 *       413:
 *         description: Too large
 */
router.post("/assets", authenticateToken, requireFeatureConsent("geogebra-assets"), geoGebraController.createAsset);

/**
 * @openapi
 * /geogebra/assets/{assetId}:
 *   get:
 *     summary: Download an owned asset
 *     responses:
 *       200:
 *         description: Asset bytes
 *       404:
 *         description: Asset unavailable
 *   delete:
 *     summary: Delete an owned asset immediately
 *     responses:
 *       200:
 *         description: Asset deleted
 */
router.get("/assets/:assetId", authenticateToken, geoGebraController.getAsset);
router.delete("/assets/:assetId", authenticateToken, geoGebraController.deleteAsset);

/**
 * @openapi
 * /geogebra/jobs:
 *   get:
 *     summary: List the current user's asynchronous GeoGebra jobs
 *     responses:
 *       200:
 *         description: Job list
 */
router.get("/jobs", authenticateToken, geoGebraController.listJobs);

/**
 * @openapi
 * /geogebra/jobs/{jobId}:
 *   get:
 *     summary: Read one owned job
 *     responses:
 *       200:
 *         description: Job state and result
 *       404:
 *         description: Job unavailable
 */
router.get("/jobs/:jobId", authenticateToken, geoGebraController.getJob);

/**
 * @openapi
 * /geogebra/jobs/{jobId}/cancel:
 *   post:
 *     summary: Cancel a queued or running job owned by the caller
 *     responses:
 *       200:
 *         description: Job cancelled (idempotent)
 */
router.post("/jobs/:jobId/cancel", authenticateToken, geoGebraController.cancelJob);

/**
 * @openapi
 * /geogebra/ai/jobs:
 *   post:
 *     summary: Create an AI drawing/insight/annotation/explanation job
 *     responses:
 *       202:
 *         description: Job queued
 *       429:
 *         description: Too many concurrent jobs
 *       503:
 *         description: AI provider not configured
 */
router.post("/ai/jobs", authenticateToken, requireFeatureConsent("geogebra-ai"), geoGebraController.createAiJob);

/**
 * @openapi
 * /geogebra/exports/capabilities:
 *   get:
 *     summary: Report which export formats the server can actually produce
 *     responses:
 *       200:
 *         description: Format capability list (server-side vs canvas-side)
 */
router.get("/exports/capabilities", authenticateToken, geoGebraController.listExportCapabilities);

/**
 * @openapi
 * /geogebra/exports:
 *   post:
 *     summary: Create an export job for a format the server supports
 *     responses:
 *       202:
 *         description: Export job queued
 *       409:
 *         description: Format is canvas-side only
 */
router.post("/exports", authenticateToken, requireFeatureConsent("geogebra-projects"), geoGebraController.createExportJob);

/**
 * @openapi
 * /geogebra/exports/{jobId}:
 *   get:
 *     summary: Read an export job owned by the caller
 *     responses:
 *       200:
 *         description: Export job state and download asset
 */
router.get("/exports/:jobId", authenticateToken, geoGebraController.getJob);

export default router;
