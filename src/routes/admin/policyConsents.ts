import express from "express";
import { PolicyConsentLogController } from "../../controllers/admin/policyConsentLogController";
import { authenticateSuperAdmin } from "../../middleware/auth";

/**
 * 隐私政策同意记录只读面板（超级管理员专用）。
 *
 * 挂载点：/api/admin（src/routes/admin/index.ts）。两个端点全是 GET，只读不写。
 * 记录里含设备指纹、原始 IP 与 User-Agent，因此要求 superadmin，与同目录
 * proxycheck / mobile-token 面板同级，而不是普通 admin。
 */
const router = express.Router();

// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.get("/policy-consents/overview", authenticateSuperAdmin, PolicyConsentLogController.getOverview);
// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.get("/policy-consents", authenticateSuperAdmin, PolicyConsentLogController.listConsents);

export default router;
