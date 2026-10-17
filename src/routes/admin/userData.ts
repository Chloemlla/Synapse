import express from "express";
import { adminUserDataController } from "../../controllers/adminUserDataController";
import { authenticateSuperAdmin } from "../../middleware/auth";
import { auditLog } from "../../middleware/auditLog";
import { requireSecuritySession } from "../../utils/securitySession";

/**
 * 账户数据（管理端用户详情弹窗使用）。
 *
 * 权限：
 * - 摘要：超级管理员（只读条数，不含正文）；
 * - 导出：超级管理员 + 安全会话（密码 / TOTP / Passkey 二次验证）。
 *   导出内容含账号 PII，属于「能带走一整个账号」的动作；仅凭登录态即可导出会让
 *   一次会话劫持直接变成一次批量数据外带。
 *
 * 审计：三个端点都写 `user.*` 动作，只记录目标与规模，不记录正文。
 */
const router = express.Router();

// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.get(
  "/users/:id/data-summary",
  authenticateSuperAdmin,
  auditLog({
    module: "user",
    action: "user.dataSummary",
    extractTarget: (req) => ({ targetId: req.params.id }),
  }),
  adminUserDataController.getSummary,
);

/**
 * @openapi
 * /admin/users/{id}/export:
 *   get:
 *     summary: 导出单个账户的全部数据（已脱敏）
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: 账户数据 JSON 文件
 *       403:
 *         description: 需要超级管理员与有效安全会话
 */
// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.get(
  "/users/:id/export",
  authenticateSuperAdmin,
  auditLog({
    module: "user",
    action: "user.dataExport",
    extractTarget: (req) => ({ targetId: req.params.id }),
  }),
  requireSecuritySession,
  adminUserDataController.exportUser,
);

/**
 * @openapi
 * /admin/users/export:
 *   post:
 *     summary: 批量导出多个账户的数据（最多 10 个账号）
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               userIds:
 *                 type: array
 *                 items:
 *                   type: string
 *     responses:
 *       200:
 *         description: 多账号数据 JSON 文件
 *       403:
 *         description: 需要超级管理员与有效安全会话
 */
// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.post(
  "/users/export",
  authenticateSuperAdmin,
  auditLog({
    module: "user",
    action: "user.dataExportBulk",
    extractDetail: (req) => ({
      count: Array.isArray(req.body?.userIds) ? req.body.userIds.length : 0,
    }),
  }),
  requireSecuritySession,
  adminUserDataController.exportUsers,
);

export default router;
