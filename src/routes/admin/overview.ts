import express from "express";
import { authenticateAdmin } from "../../middleware/auth";
import { requireAdminScope } from "../../middleware/adminScope";
import { adminOverviewService } from "../../services/adminOverviewService";
import logger from "../../utils/logger";

/**
 * `GET /api/admin/overview` —— 管理总览的跨集合汇总。
 *
 * 权限：`authenticateAdmin` + `requireAdminScope`，与同目录其它管理端读接口同口径。
 * 页面登记见 `src/config/adminPages.ts` 的 `overview`（`apiPrefixes: ["/api/admin/overview"]`）——
 * 它**不在**默认普通管理员页面集合里，所以默认只有超管能拿到数据；需要放开时由超管在
 * 页面授权里单独勾选，而不是靠这段代码放宽判定。
 *
 * 不挂 `auditLog`：仪表盘会周期刷新，逐次留痕只会把审计日志变成噪音；这里没有任何写操作。
 */
const router = express.Router();

// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.get("/overview", authenticateAdmin, requireAdminScope, async (_req, res) => {
  try {
    const snapshot = await adminOverviewService.build();
    return res.json({ success: true, overview: snapshot });
  } catch (error) {
    logger.error("[AdminOverview] 生成概览失败", { error });
    return res.status(500).json({ success: false, error: "获取系统概览失败" });
  }
});

export default router;
