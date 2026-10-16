import express from "express";
import { authenticateAdmin, authenticateSuperAdmin } from "../../middleware/auth";
import { getGeoGebraDiagnostics } from "../../geogebra/adminDiagnosticsService";
import { cleanupExpiredGeoGebraAssets } from "../../geogebra/assetService";
import { expireGeoGebraJobs } from "../../geogebra/jobService";
import logger from "../../utils/logger";

/**
 * GeoGebra 管理诊断（GEO-22 / GEO-24）。
 *
 * 挂载点：/api/admin（src/routes/admin/index.ts），页面前缀 /admin/geogebra。
 * 读接口要求 admin 角色 + adminScope 页面授权（页面 key 登记在 src/config/adminPages.ts）；
 * 维护写操作要求 superadmin，与同目录其它系统级写操作同级。
 *
 * Scamalytics/IP 风险查询（GEO-23）不在这里重复实现：仓库已有
 * src/services/ipVerificationService.ts + src/utils/scamalytics.ts 与 /admin/config 的
 * ipqs.scamalyticsUser 配置，语义相同即复用，避免第二套判定口径。
 */
const router = express.Router();

// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter); in-router copy would split quota
router.get("/geogebra/overview", authenticateAdmin, async (_req, res) => {
  try {
    res.json({ success: true, data: await getGeoGebraDiagnostics() });
  } catch (error) {
    logger.error("[GeoGebraAdmin] Failed to build diagnostics", {
      errorType: error instanceof Error ? error.name : "unknown",
    });
    res.status(500).json({ success: false, error: "暂时无法读取运行概览。", code: "GEOGEBRA_ADMIN_OVERVIEW_FAILED" });
  }
});

// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter); in-router copy would split quota
router.post("/geogebra/maintenance", authenticateSuperAdmin, async (_req, res) => {
  try {
    const [assets, jobs] = await Promise.all([cleanupExpiredGeoGebraAssets(), expireGeoGebraJobs()]);
    logger.info("[GeoGebraAdmin] Maintenance sweep done", { removedAssets: assets.removed, expiredJobs: jobs.expired });
    res.json({ success: true, data: { removedAssets: assets.removed, expiredJobs: jobs.expired } });
  } catch (error) {
    logger.error("[GeoGebraAdmin] Maintenance sweep failed", {
      errorType: error instanceof Error ? error.name : "unknown",
    });
    res.status(500).json({ success: false, error: "清理暂时无法完成，请稍后重试。", code: "GEOGEBRA_ADMIN_MAINTENANCE_FAILED" });
  }
});

export default router;
