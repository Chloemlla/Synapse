import { Router } from "express";
import {
  cleanExpiredConsents,
  getCurrentPolicyVersion,
  getPolicyDocument,
  getPolicyStats,
  recordPolicyConsent,
  revokePolicyConsent,
  verifyPolicyConsent,
} from "../controllers/policyController";
import { adminOnly } from "../middleware/adminOnly";
import { auditLog } from "../middleware/auditLog";
import { authenticateSuperAdmin } from "../middleware/auth";
import { authenticateToken } from "../middleware/authenticateToken";
import { createLimiter } from "../middleware/routeLimiters";

const router = Router();

// 速率限制配置（本地请求由 createLimiter 默认 skip）
const policyRateLimit = createLimiter({
  name: "policyPublic",
  profile: "burst",
  category: "public-api",
  max: 120,
  message: "Too many policy requests, please try again later",
});

const adminRateLimit = createLimiter({
  name: "policyAdmin",
  profile: "burst",
  category: "admin",
  max: 120,
  message: "Too many admin requests, please try again later",
});

/**
 * @swagger
 * components:
 *   schemas:
 *     PolicyConsent:
 *       type: object
 *       required:
 *         - fingerprint
 *       properties:
 *         fingerprint:
 *           type: string
 *           description: 设备指纹（由调用方声明，归属由服务端按会话/凭据 cookie/首访验证令牌核验）
 *           example: "abc123def456"
 *         version:
 *           type: string
 *           description: 可选，仅接受当前版本；省略即视为当前版本
 *           example: "2.1"
 *
 *     PolicySection:
 *       type: object
 *       required:
 *         - id
 *         - title
 *         - summary
 *         - icon
 *         - items
 *       properties:
 *         id:
 *           type: string
 *           description: 章节锚点 id，前端渲染为 #policy-<id>
 *           example: "retention"
 *         title:
 *           type: string
 *           example: "数据保存期限与删除"
 *         summary:
 *           type: string
 *           description: 章节摘要
 *         icon:
 *           type: string
 *           description: 图标语义键，由前端映射为具体图标
 *           example: "retention"
 *         emphasis:
 *           type: string
 *           description: 强调级别，前端据此选择配色
 *           enum: [normal, notice, critical]
 *         items:
 *           type: array
 *           description: 条款条目
 *           items:
 *             type: string
 *
 *     PolicyDocument:
 *       type: object
 *       required:
 *         - version
 *         - title
 *         - effectiveDate
 *         - lastUpdated
 *         - sections
 *       properties:
 *         version:
 *           type: string
 *           description: 政策版本号，与 /api/policy/version 返回的版本一致
 *           example: "2.1"
 *         title:
 *           type: string
 *           example: "服务条款与隐私政策"
 *         eyebrow:
 *           type: string
 *           description: 页面眉标
 *           example: "Terms And Privacy"
 *         description:
 *           type: string
 *           description: 页面导语
 *         effectiveDate:
 *           type: string
 *           description: 生效日期（YYYY-MM-DD）
 *           example: "2026-09-29"
 *         lastUpdated:
 *           type: string
 *           description: 最近修订日期（YYYY-MM-DD）
 *           example: "2026-09-29"
 *         historyNote:
 *           type: string
 *           description: 历史版本说明
 *         procedures:
 *           type: object
 *           description: 程序化入口说明（同意有效期、条文/版本/记录/撤回/查询接口）
 *         highlights:
 *           type: array
 *           description: 阅读摘要卡片（title / body / icon）
 *           items:
 *             type: object
 *         sections:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/PolicySection'
 *         warnings:
 *           type: array
 *           description: 重点风险提示（title / body / icon）
 *           items:
 *             type: object
 *         revisions:
 *           type: array
 *           description: 修订记录（version / date / changes）
 *           items:
 *             type: object
 *         contacts:
 *           type: array
 *           description: 联系方式（label / email / scope）
 *           items:
 *             type: object
 */

/**
 * @swagger
 * /api/policy/verify:
 *   post:
 *     summary: 记录隐私政策同意
 *     description: |
 *       记录指定设备指纹对当前版本政策的同意。校验和与时间戳由服务端生成（签名盐不下发，
 *       客户端无法自行计算），调用方只需证明设备归属：已登录会话、本端点此前下发的凭据
 *       cookie，或首访验证令牌（X-IP-Verification-Token）三者之一。成功后下发与指纹绑定的
 *       凭据 cookie，供 /api/policy/check 与 /api/policy/revoke 证明归属。
 *     tags: [Policy]
 *     parameters:
 *       - in: header
 *         name: X-IP-Verification-Token
 *         schema:
 *           type: string
 *         description: 首访验证令牌；首次为该设备写入同意时用于证明指纹归属
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/PolicyConsent'
 *     responses:
 *       200:
 *         description: 同意记录成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Consent recorded successfully"
 *                 consentId:
 *                   type: string
 *                   example: "uuid-string"
 *                 version:
 *                   type: string
 *                   example: "2.1"
 *                 expiresAt:
 *                   type: string
 *                   format: date-time
 *       400:
 *         description: 请求参数错误
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                   example: "Invalid fingerprint format"
 *                 code:
 *                   type: string
 *                   example: "INVALID_FINGERPRINT"
 *       403:
 *         description: 未能证明设备归属（缺少会话、凭据 cookie 或首访验证令牌）
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: false
 *                 error:
 *                   type: string
 *                 code:
 *                   type: string
 *                   example: "DEVICE_CREDENTIAL_REQUIRED"
 *       429:
 *         description: 请求过于频繁
 *       500:
 *         description: 服务器内部错误
 */
router.post("/verify", policyRateLimit, recordPolicyConsent);

/**
 * @swagger
 * /api/policy/check:
 *   get:
 *     summary: 验证隐私政策同意状态
 *     description: 检查指定设备指纹是否有有效的政策同意记录
 *     tags: [Policy]
 *     parameters:
 *       - in: query
 *         name: fingerprint
 *         required: true
 *         schema:
 *           type: string
 *         description: 设备指纹
 *       - in: query
 *         name: version
 *         required: true
 *         schema:
 *           type: string
 *         description: 政策版本
 *     responses:
 *       200:
 *         description: 验证结果
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 hasValidConsent:
 *                   type: boolean
 *                 consentId:
 *                   type: string
 *                 version:
 *                   type: string
 *                 expiresAt:
 *                   type: string
 *                   format: date-time
 *                 recordedAt:
 *                   type: string
 *                   format: date-time
 *       400:
 *         description: 缺少必需参数
 *       500:
 *         description: 服务器内部错误
 */
router.get("/check", policyRateLimit, verifyPolicyConsent);

/**
 * @swagger
 * /api/policy/revoke:
 *   post:
 *     summary: 撤销隐私政策同意
 *     description: 撤销指定设备指纹的政策同意记录
 *     tags: [Policy]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - fingerprint
 *             properties:
 *               fingerprint:
 *                 type: string
 *                 description: 设备指纹
 *               version:
 *                 type: string
 *                 description: 政策版本（可选，不提供则撤销所有版本）
 *     responses:
 *       200:
 *         description: 撤销成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Consent revoked successfully"
 *                 revokedCount:
 *                   type: number
 *                   example: 1
 *       400:
 *         description: 缺少必需参数
 *       500:
 *         description: 服务器内部错误
 */
router.post("/revoke", policyRateLimit, revokePolicyConsent);

/**
 * @swagger
 * /api/policy/document:
 *   get:
 *     summary: 获取服务条款与隐私政策条文
 *     description: 返回当前版本的完整政策条文（章节、重点提示、修订记录与联系方式）。版本号与 /api/policy/version 同源，前端政策页面直接渲染该返回值。
 *     tags: [Policy]
 *     responses:
 *       200:
 *         description: 政策条文
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 document:
 *                   $ref: '#/components/schemas/PolicyDocument'
 *       429:
 *         description: 请求过于频繁
 *       500:
 *         description: 服务器内部错误
 */
router.get("/document", policyRateLimit, getPolicyDocument);

/**
 * @swagger
 * /api/policy/version:
 *   get:
 *     summary: 获取当前政策版本
 *     description: 获取当前隐私政策版本和有效期信息
 *     tags: [Policy]
 *     responses:
 *       200:
 *         description: 版本信息
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 version:
 *                   type: string
 *                   example: "2.0"
 *                 validityDays:
 *                   type: number
 *                   example: 30
 */
router.get("/version", getCurrentPolicyVersion);

// 管理员接口
/**
 * @swagger
 * /api/policy/admin/stats:
 *   get:
 *     summary: 获取隐私政策统计信息（管理员）
 *     description: 获取隐私政策同意的统计信息和分析数据
 *     tags: [Policy Admin]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: startDate
 *         schema:
 *           type: string
 *           format: date
 *         description: 开始日期
 *       - in: query
 *         name: endDate
 *         schema:
 *           type: string
 *           format: date
 *         description: 结束日期
 *     responses:
 *       200:
 *         description: 统计信息
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 stats:
 *                   type: object
 *                   properties:
 *                     total:
 *                       type: object
 *                       properties:
 *                         validConsents:
 *                           type: number
 *                         expiredConsents:
 *                           type: number
 *                         currentVersion:
 *                           type: string
 *                     versions:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           _id:
 *                             type: string
 *                           count:
 *                             type: number
 *                     recentTrend:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           _id:
 *                             type: string
 *                           count:
 *                             type: number
 *       401:
 *         description: 未授权
 *       403:
 *         description: 权限不足
 *       500:
 *         description: 服务器内部错误
 */
router.get("/admin/stats", adminRateLimit, authenticateToken, adminOnly, getPolicyStats);

/**
 * @swagger
 * /api/policy/admin/cleanup:
 *   post:
 *     summary: 清理过期的同意记录（管理员）
 *     description: 删除过期和无效的隐私政策同意记录
 *     tags: [Policy Admin]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: 清理完成
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Expired consents cleaned successfully"
 *                 deletedCount:
 *                   type: number
 *                   example: 42
 *       401:
 *         description: 未授权
 *       403:
 *         description: 权限不足
 *       500:
 *         description: 服务器内部错误
 */
router.post(
  "/admin/cleanup",
  adminRateLimit,
  authenticateToken,
  authenticateSuperAdmin,
  auditLog({ module: "policy", action: "policy.cleanup" }),
  cleanExpiredConsents,
);

export default router;
