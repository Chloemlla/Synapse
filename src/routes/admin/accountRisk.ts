import express from "express";
import { AccountRiskAdminController } from "../../controllers/accountRiskAdminController";

/**
 * 账户风险与自动化信号只读面板（页面 `/admin/account-risk`）。
 *
 * 挂载点：`/api/admin`（`src/routes/admin/index.ts`），与本目录其它子路由一样，
 * **角色判定交给挂载层的 `authMiddleware` + `adminAuthMiddleware`（含 `requireAdminScope`）**：
 * 默认授权集合不含 `account-risk` 页面，因此默认只有超管能看到；
 * 需要下放给普通管理员时，超管在 `/admin/admin-scope` 里勾选页面即可，不必改路由。
 *
 * 全部端点只读。账户处置仍走用户管理页已有的批量动作（`POST /api/admin/users/bulk-action`），
 * 由 `applyAccountRiskAction` 这一个出口写库与审计；本面板不提供第二条写路径。
 */
const router = express.Router();

// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.get("/account-risk/overview", AccountRiskAdminController.getOverview);
// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.get("/account-risk/accounts", AccountRiskAdminController.listAccounts);
// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.get("/account-risk/accounts/:id", AccountRiskAdminController.getAccountDetail);
// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.get("/account-risk/signals", AccountRiskAdminController.listSignals);
// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.get("/account-risk/ip-facts", AccountRiskAdminController.listIpFacts);
// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.get("/account-risk/actions", AccountRiskAdminController.listActions);
// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.get("/account-risk/config", AccountRiskAdminController.getConfig);

export default router;
