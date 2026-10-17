import express from "express";
import { authenticateAdmin, authenticateSuperAdmin } from "../../middleware/auth";
import { auditLog } from "../../middleware/auditLog";
import { requireSecuritySession } from "../../utils/securitySession";
import { getGeoGebraDiagnostics } from "../../geogebra/adminDiagnosticsService";
import {
  GeoGebraAiConfigError,
  getGeoGebraAiAdminSetting,
  saveGeoGebraAiSetting,
} from "../../geogebra/aiProviderConfigService";
import { cleanupExpiredGeoGebraAssets } from "../../geogebra/assetService";
import { expireGeoGebraJobs } from "../../geogebra/jobService";
import logger from "../../utils/logger";

/**
 * GeoGebra 管理诊断（GEO-22 / GEO-24）。
 *
 * 挂载点：/api/admin（src/routes/admin/index.ts），页面前缀 /admin/geogebra。
 * 读接口要求 admin 角色 + adminScope 页面授权（页面 key 登记在 src/config/adminPages.ts）；
 * 维护写操作要求 superadmin，与同目录其它系统级写操作同级。
 *
 * Scamalytics/IP 风险查询（GEO-23）不在这里重复实现：仓库已有
 * src/services/ipVerificationService.ts + src/utils/scamalytics.ts 与 /admin/config 的
 * ipqs.scamalyticsUser 配置，语义相同即复用，避免第二套判定口径。
 */
const router = express.Router();

// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter); in-router copy would split quota
router.get("/geogebra/overview", authenticateAdmin, async (_req, res) => {
  try {
    res.json({ success: true, data: await getGeoGebraDiagnostics() });
  } catch (error) {
    logger.error("[GeoGebraAdmin] Failed to build diagnostics", {
      errorType: error instanceof Error ? error.name : "unknown",
    });
    res.status(500).json({ success: false, error: "暂时无法读取运行概览。", code: "GEOGEBRA_ADMIN_OVERVIEW_FAILED" });
  }
});

// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter); in-router copy would split quota
router.post("/geogebra/maintenance", authenticateSuperAdmin, async (_req, res) => {
  try {
    const [assets, jobs] = await Promise.all([cleanupExpiredGeoGebraAssets(), expireGeoGebraJobs()]);
    logger.info("[GeoGebraAdmin] Maintenance sweep done", { removedAssets: assets.removed, expiredJobs: jobs.expired });
    res.json({ success: true, data: { removedAssets: assets.removed, expiredJobs: jobs.expired } });
  } catch (error) {
    logger.error("[GeoGebraAdmin] Maintenance sweep failed", {
      errorType: error instanceof Error ? error.name : "unknown",
    });
    res.status(500).json({ success: false, error: "清理暂时无法完成，请稍后重试。", code: "GEOGEBRA_ADMIN_MAINTENANCE_FAILED" });
  }
});

/**
 * @openapi
 * /admin/geogebra/ai/setting:
 *   get:
 *     summary: 读取 GeoGebra AI 提供商配置（超管）
 *     description: 返回脱敏后的当前配置、可复用的 LibreChat 提供者清单，以及当前是否已配置。
 *     responses:
 *       200:
 *         description: 配置、提供者清单与生效状态
 */
// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter); in-router copy would split quota
router.get("/geogebra/ai/setting", authenticateSuperAdmin, async (_req, res) => {
  try {
    res.json({ success: true, ...(await getGeoGebraAiAdminSetting()) });
  } catch (error) {
    logger.error("[GeoGebraAdmin] Failed to read AI provider setting", {
      errorType: error instanceof Error ? error.name : "unknown",
    });
    res.status(500).json({ success: false, error: "暂时无法读取 AI 提供商配置。", code: "GEOGEBRA_AI_CONFIG_READ_FAILED" });
  }
});

/**
 * @openapi
 * /admin/geogebra/ai/setting:
 *   put:
 *     summary: 保存 GeoGebra AI 提供商配置（超管 + 安全会话）
 *     description: |
 *       mode 三选一：env（沿用 GEOGEBRA_AI_* 环境变量）、custom（独立填写地址/密钥/模型）、
 *       librechat（复用 chat_providers 中一条 OpenAI Chat Completions 格式的提供者）。
 *       apiKey 留空表示沿用已保存的密钥。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               mode:
 *                 type: string
 *                 enum: [env, custom, librechat]
 *               baseUrl:
 *                 type: string
 *               apiKey:
 *                 type: string
 *               model:
 *                 type: string
 *               vision:
 *                 type: boolean
 *               librechatProviderId:
 *                 type: string
 *     responses:
 *       200:
 *         description: 保存后的脱敏配置
 *       400:
 *         description: 入参不完整或地址不合法
 *       409:
 *         description: 所选 LibreChat 提供者已停用或协议不兼容
 */
// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter); in-router copy would split quota
router.put(
  "/geogebra/ai/setting",
  authenticateSuperAdmin,
  auditLog({
    module: "geogebra",
    action: "geogebra.ai.setting.set",
    captureBody: false,
    extractDetail: (req) => ({
      mode: req.body?.mode,
      model: req.body?.model,
      librechatProviderId: req.body?.librechatProviderId,
    }),
  }),
  requireSecuritySession,
  async (req, res) => {
    try {
      const setting = await saveGeoGebraAiSetting(req.body, (req as { user?: { username?: string } }).user?.username ?? "unknown");
      res.json({ success: true, ...setting });
    } catch (error) {
      if (error instanceof GeoGebraAiConfigError) {
        res.status(error.status).json({ success: false, error: error.message, code: error.code });
        return;
      }
      logger.error("[GeoGebraAdmin] Failed to save AI provider setting", {
        errorType: error instanceof Error ? error.name : "unknown",
      });
      res.status(500).json({ success: false, error: "保存 AI 提供商配置失败，请稍后重试。", code: "GEOGEBRA_AI_CONFIG_SAVE_FAILED" });
    }
  },
);

export default router;
