import express, { type Request, type Response } from "express";
import { auditLog } from "../../middleware/auditLog";
import { DocToolAdminService } from "../../docTool/admin/docToolAdminService";
import { requireSecuritySession } from "../../utils/securitySession";
import logger from "../../utils/logger";

/**
 * doc-tool 运维面板（页面 `/admin/doc-tool`）。
 *
 * 挂载点：`/api/admin/doc-tool`，角色判定交给挂载层（`authMiddleware` + `adminAuthMiddleware`
 * 含 `requireAdminScope`）与页面授权 `doc-tool`（默认不在授予集合里 → 默认仅超管）。
 *
 * 边界：
 *   - 只回元数据（引擎状态、任务状态、目录占用），**不提供跨用户文件下载**；
 *   - 清理写操作额外叠 `requireSecuritySession`（二次验证）与 `auditLog`，只记计数不记文件名；
 *   - 所有路径解析继续走 `docTool/runtime.ts` 的守界函数。
 */
const router = express.Router();

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.get("/overview", async (_req: Request, res: Response) => {
  try {
    const [engine, counts] = await Promise.all([
      Promise.resolve(DocToolAdminService.overview()),
      DocToolAdminService.overviewCounts(),
    ]);
    res.setHeader("Cache-Control", "no-store");
    res.json({ success: true, generatedAt: new Date().toISOString(), ...engine, counts });
  } catch (error) {
    logger.error("[DocToolAdmin] overview failed", {
      errorType: error instanceof Error ? error.name : "unknown",
    });
    res.status(500).json({ success: false, error: "暂时无法读取文档转换概览。", code: "DOC_TOOL_ADMIN_OVERVIEW_FAILED" });
  }
});

// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.get("/jobs", async (req: Request, res: Response) => {
  try {
    const q = req.query as Record<string, unknown>;
    res.setHeader("Cache-Control", "no-store");
    res.json({
      success: true,
      ...(await DocToolAdminService.listJobs({
        status: readString(q.status),
        userId: readString(q.userId),
        limit: Number(q.limit),
        offset: Number(q.offset),
      })),
    });
  } catch (error) {
    logger.error("[DocToolAdmin] list jobs failed", {
      errorType: error instanceof Error ? error.name : "unknown",
    });
    res.status(500).json({ success: false, error: "暂时无法读取任务列表。", code: "DOC_TOOL_ADMIN_JOBS_FAILED" });
  }
});

// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.get("/jobs/:id", async (req: Request, res: Response) => {
  try {
    const detail = await DocToolAdminService.getJob(String(req.params.id ?? ""));
    if (!detail) {
      res.status(404).json({ success: false, error: "任务不存在或已过期清理。", code: "DOC_TOOL_ADMIN_JOB_NOT_FOUND" });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({ success: true, job: detail });
  } catch (error) {
    logger.error("[DocToolAdmin] get job failed", {
      errorType: error instanceof Error ? error.name : "unknown",
    });
    res.status(500).json({ success: false, error: "暂时无法读取任务详情。", code: "DOC_TOOL_ADMIN_JOB_FAILED" });
  }
});

// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.get("/files", async (_req: Request, res: Response) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json({ success: true, ...(await DocToolAdminService.listStorage()) });
  } catch (error) {
    logger.error("[DocToolAdmin] list storage failed", {
      errorType: error instanceof Error ? error.name : "unknown",
    });
    res.status(500).json({ success: false, error: "暂时无法统计目录占用。", code: "DOC_TOOL_ADMIN_FILES_FAILED" });
  }
});

// 预演：只读（不改磁盘与数据库），因此不要求安全会话。
// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.post("/cleanup/preview", async (_req: Request, res: Response) => {
  try {
    res.json({ success: true, ...(await DocToolAdminService.runCleanup({ dryRun: true })) });
  } catch (error) {
    logger.error("[DocToolAdmin] cleanup preview failed", {
      errorType: error instanceof Error ? error.name : "unknown",
    });
    res.status(500).json({ success: false, error: "清理预演未完成，请稍后重试。", code: "DOC_TOOL_ADMIN_CLEANUP_PREVIEW_FAILED" });
  }
});

// 真实清理：页面授权 + 安全会话 + 审计（只记计数，不记文件名）。
router.post(
  "/cleanup/run",
  auditLog({ module: "system", action: "docTool.cleanup.run", captureBody: false }),
  requireSecuritySession,
  async (_req: Request, res: Response) => {
    try {
      const result = await DocToolAdminService.runCleanup({ dryRun: false });
      logger.info("[DocToolAdmin] cleanup done", {
        expiredJobs: result.expiredJobs,
        purgedFiles: result.purgedFiles,
        sweptFiles: result.sweptFiles,
      });
      res.json({ success: true, ...result });
    } catch (error) {
      logger.error("[DocToolAdmin] cleanup failed", {
        errorType: error instanceof Error ? error.name : "unknown",
      });
      res.status(500).json({ success: false, error: "清理未完成，请稍后重试。", code: "DOC_TOOL_ADMIN_CLEANUP_FAILED" });
    }
  },
);

export default router;
