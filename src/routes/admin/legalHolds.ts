import express from "express";
import { authenticateAdmin, authenticateSuperAdmin } from "../../middleware/auth";
import {
  LegalHoldAdminController,
  requireHumanSuperAdmin,
  requireSecuritySession,
} from "../../controllers/admin/legalHoldController";

/**
 * 法律保留与取证管理端（RC-22 / RC-35 / RC-58）。
 *
 * 挂载点（由协调者应用，因 `routes/admin/index.ts` 是共享注册文件）：
 *   router.use("/legal-holds", legalHoldsRouter);
 * 即最终路径 `/api/admin/legal-holds/*`，页面 key `/admin/legal-holds`。
 *
 * 读接口：`admin` + 页面授权（adminPages 登记 `/api/admin/legal-holds`）。
 * 写接口：`superadmin` + 安全会话 + 拒绝 API Key（D10：导出不支持 API Key 触发）。
 */
const router = express.Router();

// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.get("/", authenticateAdmin, LegalHoldAdminController.list);

// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.post(
  "/",
  authenticateSuperAdmin,
  requireHumanSuperAdmin,
  requireSecuritySession,
  LegalHoldAdminController.create,
);

// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.post(
  "/cleanup/run",
  authenticateSuperAdmin,
  requireHumanSuperAdmin,
  requireSecuritySession,
  LegalHoldAdminController.runCleanup,
);

// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.post(
  "/:holdId/release",
  authenticateSuperAdmin,
  requireHumanSuperAdmin,
  requireSecuritySession,
  LegalHoldAdminController.release,
);

// 取证审计与导出：只读审计也要超管 + 安全会话（审计里带 subjectValue 与案件编号）。
// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.get(
  "/forensic-audit",
  authenticateSuperAdmin,
  requireHumanSuperAdmin,
  requireSecuritySession,
  LegalHoldAdminController.listForensicAudit,
);

// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.post(
  "/forensic-exports",
  authenticateSuperAdmin,
  requireHumanSuperAdmin,
  requireSecuritySession,
  LegalHoldAdminController.createExport,
);

// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.post(
  "/forensic-exports/:requestId/approve",
  authenticateSuperAdmin,
  requireHumanSuperAdmin,
  requireSecuritySession,
  LegalHoldAdminController.approveExport,
);

// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.get(
  "/forensic-exports/:requestId/download",
  authenticateSuperAdmin,
  requireHumanSuperAdmin,
  requireSecuritySession,
  LegalHoldAdminController.downloadExport,
);

export default router;
