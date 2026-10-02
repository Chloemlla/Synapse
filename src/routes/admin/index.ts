import express from "express";
import { adminController } from "../../controllers/adminController";
import {
  deleteBilibiliCookieReport,
  listReports as listBilibiliCookieReports,
  listAccountBindings as listBilibiliAccountBindings,
} from "../../controllers/bilibiliCookieReportController";
import { authMiddlewareV2 as authMiddleware, isAdminRole } from "../../middleware/auth";
import { auditLog } from "../../middleware/auditLog";
import { isAdminUserSelfServicePath, requireAdminScope } from "../../middleware/adminScope";
import { wsService } from "../../services/wsService";
import adminScopeRouter from "./adminScope";
import broadcastRouter from "./broadcast";
import configRouter from "./config";
import crashReportsRouter from "./crashReports";
import integrationsRouter from "./integrations";
import ipRiskLogsRouter from "./ipRiskLogs";
import mobileTokensRouter from "./mobileTokens";
import overviewRouter from "./overview";
import policyConsentsRouter from "./policyConsents";
import profileRouter from "./profile";
import qqGuardRouter from "./qqGuard";
import registrationInvitesRouter from "./registrationInvites";
import shortlinksRouter from "./shortlinks";
import usersRouter from "./users";

const router = express.Router();

// 管理员权限检查中间件
const adminAuthMiddleware = async (req: any, res: any, next: any) => {
  // 允许普通已登录用户访问的用户自助接口（在本路由前缀 /api/admin 下）
  // 注意：这里匹配的是路由内的路径（不含前缀），例如 '/user/profile'
  // 用前缀 startsWith 覆盖，避免新增自助端点时再次漏配。
  // 前缀定义与管理员范围守卫共用一处（middleware/adminScope.ts），不再各写一份。
  if (isAdminUserSelfServicePath(`/api/admin${req.path || ""}`)) {
    return next();
  }

  if (!req.user || !isAdminRole(req.user.role)) {
    return res.status(403).json({ error: "需要管理员权限" });
  }

  // 普通管理员的可用范围由运行时配置的页面授权决定（fail-closed）。
  await requireAdminScope(req, res, next);
};

// 公告读取接口移到最前面，不加任何中间件
router.get("/announcement", adminController.getAnnouncement);

// 其余路由依然加auth
// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.use(authMiddleware);
router.use(adminAuthMiddleware);

// 在所有已认证/管理员路由上，若用户被标记为需要上报指纹，则通知前端（带去重 hash）
// 复用 authMiddleware 已加载的 req.user，避免每个请求多打一次数据库
router.use(async (req: any, res: any, next: any) => {
  try {
    const current = req.user;
    if (current && (current as any).requireFingerprint) {
      // 生成去重 hash，前端收到后通过 WS 回传确认，避免与 WS 推送双重触发
      const hash = wsService.notifyFingerprintRequired(current.id, true);
      res.setHeader("X-Require-Fingerprint", "1");
      res.setHeader("X-Fingerprint-Hash", hash);
    }
  } catch (_e) {
    // 静默失败，不影响主流程
  }
  next();
});

// 子路由挂载（按业务领域拆分）
// 页面授权自身：GET /admin-scope/me 对任何管理员开放，其余走超管。
// 必须带 `/admin-scope` 前缀：router 内部只声明了 `/me`、`/setting`，
// 而守卫白名单（middleware/adminScope.ts 的 ADMIN_ANY_ROLE_PREFIXES）与前端调的都是
// `/api/admin/admin-scope/*`。少写这截前缀会让真实路径变成 `/api/admin/me`
// （前端 404、白名单匹配不上），且 `/me` 这种短路径极易与后续新增路由撞车。
router.use("/admin-scope", adminScopeRouter);
router.use(usersRouter);
router.use(configRouter);
router.use(shortlinksRouter);
router.use(profileRouter);
router.use(broadcastRouter);
router.use(registrationInvitesRouter);
router.use(crashReportsRouter);
// 集成健康中心（Webhook / 邮件抑制 / 缓存 / 推荐 / 邀请的聚合视图）
router.use(integrationsRouter);
router.use(qqGuardRouter);
router.use(ipRiskLogsRouter);
router.use(mobileTokensRouter);
// 管理总览的系统级汇总（跨集合计数；默认仅超管，页面授权里可单独放开）。
router.use(overviewRouter);
router.use(policyConsentsRouter);

// Bilibili Sync 管理（PiliPlus 配置数据）
router.get("/bilibili-sync", (req, res) => adminController.getBilibiliSyncRecords(req, res));
// Login-time cookie reports (device identity, no Synapse account): metadata only, ciphertext never leaves.
router.get("/bilibili-reports", (req, res) => listBilibiliCookieReports(req, res));
// Multi-account bindings (per Synapse user): metadata only, ciphertext never leaves.
router.get("/bilibili-accounts", (req, res) => listBilibiliAccountBindings(req, res));
// Erasure path for the report archive (superadmin + audited, exact triple only).
router.delete(
  "/bilibili-reports/:clientId/:deviceId/:uid",
  auditLog({
    module: "privacy",
    action: "privacy.bilibiliReportDelete",
    extractDetail: (req) => ({ deviceId: req.params?.deviceId, uid: req.params?.uid }),
  }),
  (req, res) => deleteBilibiliCookieReport(req, res),
);
// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.get("/bilibili-sync/:userId/search-records", (req, res) => adminController.getBilibiliSearchRecords(req, res));

export default router;
