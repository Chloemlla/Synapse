import express from "express";
import {
  revealAccountCredentials,
  revealReportCredentials,
} from "../../controllers/bilibiliCookieReportController";
import { authenticateSuperAdmin } from "../../middleware/auth";
import { requireAllowedOriginForWrites } from "../../middleware/corsMiddleware";
import { suppressAuditPayloadCapture } from "../../pixel/requestAudit";
import { requireSecuritySession } from "../../utils/securitySession";

/**
 * Bilibili 凭据「解密查看」（`/api/admin/bilibili-{reports,accounts}/credentials`）。
 *
 * 挂载点：/api/admin（src/routes/admin/index.ts）。页面 /admin/bilibili-data。
 *
 * 为什么单独一个 router：明文出库是这一片功能里唯一的“高危出口”，把四道闸门放在同一处，
 * 审阅时一眼能看全，也避免以后有人在旁边顺手加一条 GET 绕过闸门。
 *
 * 闸门（缺一不可）：
 *  0. `requireAllowedOriginForWrites` —— 带 Origin/Referer 的浏览器写请求必须在来源白名单内
 *     （CSRF 纵深防御）；无 Origin 的非浏览器请求不携会话，放行交给鉴权；
 *  1. `authenticateSuperAdmin` —— 普通 admin 只能看元数据，不能解密；
 *  2. `requireSecuritySession` —— 必须先在页面上建立安全会话（密码/TOTP/Passkey 二次验证），
 *     光有一个长期登录态不足以读明文；
 *  3. `suppressAuditPayloadCapture` —— 关掉全局审计对 req.body / resBody 的捕获，
 *     否则响应体里的明文 Cookie 会被抄进 60 天保留期的审计库；载荷之外仍由控制器显式写一条
 *     「谁解了多少条」的审计；
 *  4. 控制器内的单批上限（50 条）+ `Cache-Control: no-store`，明文不落浏览器缓存。
 *
 * 全部是 POST：要解密的记录集合放请求体，避免设备 id / UID 进 URL（访问日志、Referer、审计 query）。
 */
const router = express.Router();

// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.post(
  "/bilibili-reports/credentials",
  // 先掐载荷捕获再进业务：中间件顺序就是审计行为的顺序。
  (req, _res, next) => {
    suppressAuditPayloadCapture(req);
    next();
  },
  requireAllowedOriginForWrites,
  authenticateSuperAdmin,
  requireSecuritySession,
  revealReportCredentials,
);

// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.post(
  "/bilibili-accounts/credentials",
  (req, _res, next) => {
    suppressAuditPayloadCapture(req);
    next();
  },
  requireAllowedOriginForWrites,
  authenticateSuperAdmin,
  requireSecuritySession,
  revealAccountCredentials,
);

export default router;
