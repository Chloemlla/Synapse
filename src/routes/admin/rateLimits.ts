import express from "express";
import { RateLimitAdminController } from "../../controllers/rateLimitAdminController";

/**
 * 限流、配额与资源闸门只读面板（页面 `/admin/rate-limits`）。
 *
 * 挂载点：`/api/admin`，角色判定交给挂载层（`authMiddleware` + `adminAuthMiddleware`
 * 含 `requireAdminScope`）。页面 key `rate-limits` 默认不在授予集合里，因此默认仅超管可见；
 * 需要下放时由超管在 `/admin/admin-scope` 勾选，不必改路由。
 *
 * 全部只读：所有阈值仍由 env / 运行时配置决定，页面不提供在线修改（阈值改全站行为，
 * 必须走 `/admin/env` 那条带审计与安全会话的链路）。
 */
const router = express.Router();

// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.get("/rate-limits/overview", RateLimitAdminController.getOverview);
// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.get("/rate-limits/burst", RateLimitAdminController.getBurst);
// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.get("/rate-limits/quota-events", RateLimitAdminController.listQuotaEvents);
// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.get("/rate-limits/ladders", RateLimitAdminController.listLadders);
// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.get("/rate-limits/tts-occupancy", RateLimitAdminController.getTtsOccupancy);
// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.get("/rate-limits/tts-jobs", RateLimitAdminController.listTtsJobs);
// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.get("/rate-limits/resources", RateLimitAdminController.getResources);
// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.get("/rate-limits/limiters", RateLimitAdminController.listLimiters);

export default router;
