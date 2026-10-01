import { Router } from "express";
import { requireAdminScope } from "../middleware/adminScope";
import {
  cleanExpiredConsents,
  getCurrentPolicyVersion,
  getPolicyDocument,
  getPolicyStats,
  recordPolicyConsent,
  revokePolicyConsent,
} from "../controllers/policyController";
import {
  getPolicyConsentHistory,
  getPolicyStatus,
  verifyPolicyConsent,
} from "../controllers/policyStatusController";
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
 *           description: 设备指纹（由调用方声明，归属由服务端按凭据 cookie 或首访验证令牌核验）
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
 *         - documentHash
 *         - title
 *         - effectiveDate
 *         - lastUpdated
 *         - sections
 *       properties:
 *         version:
 *           type: string
 *           description: 政策版本号，与 /api/policy/version 返回的版本一致
 *           example: "2.1"
 *         documentHash:
 *           type: string
 *           description: 条文指纹（sha256）：对章节正文、勾选项文案与重点提示取哈希。同意记录会一并落库，用于对账
 *           example: "4f2a1c9d…"
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
 *       客户端无法自行计算），调用方只需证明设备归属：本端点此前下发的凭据 cookie，或首访
 *       验证令牌（X-IP-Verification-Token）二者之一。成功后下发与指纹绑定的凭据 cookie，
 *       供 /api/policy/check 与 /api/policy/revoke 证明归属。注意：登录会话不是设备凭据——
 *       它只证明调用者是谁，不证明调用者是这台设备，因此不能用于证明归属。
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
 *                 documentHash:
 *                   type: string
 *                   description: 落到这条同意记录里的条文指纹
 *                 validityDays:
 *                   type: number
 *                   example: 30
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
 *         description: 未能证明设备归属（缺少凭据 cookie 或首访验证令牌）
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
 *     description: |
 *       检查指定设备指纹是否有有效的政策同意记录。指纹优先从 `X-Fingerprint` 请求头读取
 *       （避免指纹落到访问日志与 Referer），查询串上的 `fingerprint` 仍兼容；
 *       `version` 可省略，省略时按当前版本查。响应会回带同意时间、来源与勾选项，
 *       便于用户端面板展示——这些字段只对持有设备凭据的调用者可见。
 *     tags: [Policy]
 *     parameters:
 *       - in: header
 *         name: X-Fingerprint
 *         schema:
 *           type: string
 *         description: 设备指纹（优先于查询串）
 *       - in: query
 *         name: fingerprint
 *         required: false
 *         schema:
 *           type: string
 *         description: 设备指纹（兼容旧客户端；隐藏在请求头里更合适）
 *       - in: query
 *         name: version
 *         required: false
 *         schema:
 *           type: string
 *         description: 政策版本，省略即按当前版本查
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
// 这里刻意不挂 optionalAuthenticateToken：同意记录的所有权单位是「设备」（指纹），而会话只证明
// 「你是谁」，不证明「你是这台设备」。放行会话 = 任何登录用户只要拿到一个指纹（日志里就带着它），
// 就能查/撤别人设备的同意；而指纹在本系统里正是设备凭据本身（同意 cookie 就是它的 HMAC）。
// 设备没了 cookie 的正解是重新同意（本地重新下发 cookie），或走政策条文里给的邮箱通道。
router.get("/check", policyRateLimit, verifyPolicyConsent);

/**
 * @swagger
 * /api/policy/status:
 *   get:
 *     summary: 获取本设备的政策与同意状态
 *     description: |
 *       一次取回「当前版本 + 有效期 + 条文指纹 + 本设备同意状态」，取代「先 /version 再 /check」
 *       的两次往返。指纹从 `X-Fingerprint` 请求头读取。与 /check 的差别：这里 success 恒为 true，
 *       同意状态落在 hasValidConsent；无有效同意时 reason 给出 none / expired / revoked /
 *       incomplete / other-version。必须持有本端点此前下发的设备凭据 cookie（或首访验证令牌），
 *       登录会话不能替代。
 *     tags: [Policy]
 *     parameters:
 *       - in: header
 *         name: X-Fingerprint
 *         required: true
 *         schema:
 *           type: string
 *         description: 设备指纹
 *       - in: query
 *         name: version
 *         required: false
 *         schema:
 *           type: string
 *         description: 政策版本，省略即当前版本
 *     responses:
 *       200:
 *         description: 状态
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 hasValidConsent:
 *                   type: boolean
 *                 reason:
 *                   type: string
 *                   enum: [active, none, expired, revoked, incomplete, other-version]
 *                 version:
 *                   type: string
 *                 currentVersion:
 *                   type: string
 *                 validityDays:
 *                   type: number
 *                 documentHash:
 *                   type: string
 *                 consentDocumentHash:
 *                   type: string
 *                 expiresAt:
 *                   type: string
 *                   format: date-time
 *                 recordedAt:
 *                   type: string
 *                   format: date-time
 *                 source:
 *                   type: string
 *                 agreements:
 *                   type: array
 *                   items:
 *                     type: string
 *                 agreementsComplete:
 *                   type: boolean
 *                 missingAgreements:
 *                   type: array
 *                   items:
 *                     type: string
 *       400:
 *         description: 缺少设备指纹
 *       403:
 *         description: 未能证明设备归属
 *       429:
 *         description: 请求过于频繁
 *       500:
 *         description: 服务器内部错误
 */
router.get("/status", policyRateLimit, getPolicyStatus);

/**
 * @swagger
 * /api/policy/revoke:
 *   post:
 *     summary: 撤销隐私政策同意
 *     description: |
 *       撤销指定设备指纹的政策同意记录（软撤回，保留 revokedAt / revokedIP 留痕，到期由 TTL 回收）。
 *       body 里带 `purge: true` 时改为硬删除该指纹的全部记录并清除设备凭据 cookie，用于行使「删除」权利。
 *       必须携带设备凭据 cookie（或首访验证令牌），登录会话不能替代。
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
 *               purge:
 *                 type: boolean
 *                 description: 为 true 时硬删除本指纹的全部同意记录（不可恢复），并清除设备凭据 cookie
 *     responses:
 *       200:
 *         description: 处理完成
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
 *                 hadActiveConsent:
 *                   type: boolean
 *                   description: 本次是否真的改动了有效记录（false = 本来就无需撤回）
 *                 purged:
 *                   type: boolean
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
 *     description: 返回当前版本的完整政策条文（章节、重点提示、修订记录与联系方式）。版本号与 /api/policy/version 同源，前端政策页面直接渲染该返回值。查询串带 `format=md`（或请求头 Accept 为 text/markdown）时，返回同一份内容的 Markdown 存档副本，供用户离线保存并与同意记录里的 documentHash 对账。
 *     tags: [Policy]
 *     parameters:
 *       - in: query
 *         name: format
 *         required: false
 *         schema:
 *           type: string
 *           enum: [json, md]
 *         description: 省略或 json 返回 JSON；md 返回 text/markdown 存档副本
 *     responses:
 *       200:
 *         description: 政策条文（JSON）或 Markdown 存档
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
 *           text/markdown:
 *             schema:
 *               type: string
 *       304:
 *         description: 条文未变化（ETag 匹配）
 *       429:
 *         description: 请求过于频繁
 *       500:
 *         description: 服务器内部错误
 */
router.get("/document", policyRateLimit, getPolicyDocument);

/**
 * @swagger
 * /api/policy/history:
 *   get:
 *     summary: 获取本设备的同意轨迹
 *     description: |
 *       按时间倒序返回本设备的历次同意记录（版本、同意时间、到期、来源、勾选项、条文指纹、
 *       是否已撤回）。指纹从 `X-Fingerprint` 请求头读取；必须持有本端点此前下发的设备凭据 cookie
 *       （或首访验证令牌），登录会话不能替代。entries[].state 为 active / expired / revoked / superseded。
 *     tags: [Policy]
 *     parameters:
 *       - in: header
 *         name: X-Fingerprint
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: limit
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 50
 *         description: 返回条数上限，默认 20，服务端收敛到 1–50
 *     responses:
 *       200:
 *         description: 同意轨迹
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 currentVersion:
 *                   type: string
 *                 documentHash:
 *                   type: string
 *                 limit:
 *                   type: number
 *                 entries:
 *                   type: array
 *                   items:
 *                     type: object
 *       400:
 *         description: 缺少设备指纹
 *       403:
 *         description: 未能证明设备归属
 *       429:
 *         description: 请求过于频繁
 *       500:
 *         description: 服务器内部错误
 */
router.get("/history", policyRateLimit, getPolicyConsentHistory);

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
router.get("/admin/stats", adminRateLimit, authenticateToken, adminOnly, requireAdminScope, getPolicyStats);

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
