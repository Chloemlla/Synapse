import { Router } from "express";
import { TOTPController } from "../controllers/totpController";
import { authenticateToken } from "../middleware/authenticateToken";
import { totpLimiter } from "../middleware/routeLimiters";
import { requireTwoFactorConfigSession } from "../utils/securitySession";

const router = Router();

// 双因素配置类接口统一要求「安全会话」：账号已配置 TOTP/Passkey 时只能用 TOTP 或 Passkey
// 建立的会话（见 requireTwoFactorConfigSession），避免仅凭密码就能改动二次验证配置。
// /status 供各页面探测已配置的因素、/verify-token 是登录流程，两者不加该守卫。

/**
 * @openapi
 * /totp/generate-setup:
 *   post:
 *     summary: 生成TOTP设置信息
 *     responses:
 *       200:
 *         description: 生成TOTP设置信息
 */
router.post("/generate-setup", authenticateToken, totpLimiter, requireTwoFactorConfigSession, TOTPController.generateSetup);

/**
 * @openapi
 * /totp/verify-and-enable:
 *   post:
 *     summary: 验证并启用TOTP
 *     responses:
 *       200:
 *         description: 验证并启用TOTP
 */
router.post("/verify-and-enable", authenticateToken, totpLimiter, requireTwoFactorConfigSession, TOTPController.verifyAndEnable);

/**
 * @openapi
 * /totp/verify-token:
 *   post:
 *     summary: 验证TOTP令牌（登录时使用，无需JWT认证）
 *     responses:
 *       200:
 *         description: 验证TOTP令牌
 */
router.post("/verify-token", totpLimiter, TOTPController.verifyToken);

/**
 * @openapi
 * /totp/disable:
 *   post:
 *     summary: 禁用TOTP
 *     responses:
 *       200:
 *         description: 禁用TOTP
 */
router.post("/disable", authenticateToken, totpLimiter, requireTwoFactorConfigSession, TOTPController.disable);

/**
 * @openapi
 * /totp/status:
 *   get:
 *     summary: 获取TOTP状态
 *     responses:
 *       200:
 *         description: 获取TOTP状态
 */
router.get("/status", authenticateToken, totpLimiter, TOTPController.getStatus);

/**
 * @openapi
 * /totp/backup-codes:
 *   get:
 *     summary: 获取备用恢复码
 *     responses:
 *       200:
 *         description: 获取备用恢复码
 */
router.get("/backup-codes", authenticateToken, totpLimiter, requireTwoFactorConfigSession, TOTPController.getBackupCodes);

/**
 * @openapi
 * /totp/regenerate-backup-codes:
 *   post:
 *     summary: 重新生成备用恢复码
 *     responses:
 *       200:
 *         description: 重新生成备用恢复码
 */
router.post(
  "/regenerate-backup-codes",
  authenticateToken,
  totpLimiter,
  requireTwoFactorConfigSession,
  TOTPController.regenerateBackupCodes,
);

export default router;
