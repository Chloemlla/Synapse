import express from "express";
import { IpRiskLogController } from "../../controllers/ipRiskLogController";
import { authenticateSuperAdmin } from "../../middleware/auth";

/**
 * proxycheck.io 集成只读面板（超级管理员专用）。
 *
 * 挂载点：/api/admin（src/routes/admin/index.ts）。端点全部要求 superadmin
 * （与同目录 /proxycheck/setting 的写操作同级），而不是普通 admin：
 * 数据里含原始 IP、内部判据、密钥哈希与上游响应原文。
 *
 * 唯一一个 POST（/upstream-diagnostics/:id/verify-signature）**不改任何数据**：
 * 它只是拿调用方给的候选密钥，在已存的响应体上重算一次 HMAC，回答「这把密钥对不对得上
 * 上游回签值」。候选密钥不落库、不写日志；已存密钥的明文任何端点都不会回显。
 */
const router = express.Router();

// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.get("/proxycheck/overview", authenticateSuperAdmin, IpRiskLogController.getOverview);
// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.get("/proxycheck/lookups", authenticateSuperAdmin, IpRiskLogController.listLookups);
// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.get("/proxycheck/risk-cache", authenticateSuperAdmin, IpRiskLogController.listRiskCache);
// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.get("/proxycheck/quotas", authenticateSuperAdmin, IpRiskLogController.listQuotas);
// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.get(
  "/proxycheck/probe-reports",
  authenticateSuperAdmin,
  IpRiskLogController.listProbeReports,
);
// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.get(
  "/proxycheck/upstream-diagnostics",
  authenticateSuperAdmin,
  IpRiskLogController.listUpstreamDiagnostics,
);
// 只读语义的 POST（重算验签，不写库）：用 POST 是因为候选密钥不能进 URL / 访问日志。
// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.post(
  "/proxycheck/upstream-diagnostics/:id/verify-signature",
  authenticateSuperAdmin,
  IpRiskLogController.verifyDiagnosticSignature,
);

export default router;
