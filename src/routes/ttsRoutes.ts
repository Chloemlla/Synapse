import express from "express";
import { requireAdminScope } from "../middleware/adminScope";
import { TtsController } from "../controllers/ttsController";
import { ttsProviderController } from "../controllers/ttsProviderController";
import { apiKeyAuth } from "../middleware/apiKeyAuth";
import { auditLog } from "../middleware/auditLog";
import { authenticateAdmin, authenticateSuperAdmin } from "../middleware/auth";
import { optionalAuthenticateToken } from "../middleware/optionalAuthenticateToken";
import {
  adminLimiter,
  createLimiter,
  historyLimiter,
  ttsLimiter,
} from "../middleware/routeLimiters";
import { ClarityService } from "../services/clarityService";
import { TurnstileService } from "../services/turnstileService";

const router = express.Router();
// 登录闸门：会话 Cookie 由 optionalAuthenticateToken 解析，API Key / OAuth 由 apiKeyAuth
// 的必需模式把关。顺序不能反 —— apiKeyAuth 在 req.user 已就绪时直接放行，
// 反过来写会让 Cookie 用户在 oauthTokenAuth 那里被 401。
const ttsApiKeyAuth = apiKeyAuth("tts", { required: true });
const ttsSubmissionLimiter = ttsLimiter;
const ttsJobReadLimiter = createLimiter({
  name: "ttsJobRead",
  profile: "relaxed",
  category: "tts",
  message: "TTS 任务查询过于频繁，请稍后再试",
});
const ttsAssetLimiter = createLimiter({
  name: "ttsAsset",
  profile: "burst",
  category: "tts",
  max: 120,
  message: "音频资源请求过于频繁，请稍后再试",
});
const ttsConfigReadLimiter = createLimiter({
  name: "ttsConfigRead",
  profile: "relaxed",
  category: "tts",
  message: "配置查询过于频繁，请稍后再试",
});
const ttsConfigWriteLimiter = createLimiter({
  name: "ttsConfigWrite",
  profile: "verification",
  category: "tts",
  message: "配置操作过于频繁，请稍后再试",
});
const ttsHistoryLimiter = historyLimiter;
const ttsHistoryWriteLimiter = createLimiter({
  name: "ttsHistoryWrite",
  profile: "sensitive",
  category: "tts-history",
  message: "记录管理操作过于频繁，请稍后再试",
});
const ttsAdminOperationLimiter = adminLimiter;

/**
 * @openapi
 * /api/tts/generate:
 *   post:
 *     summary: 生成语音
 *     description: 提交文本生成语音
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               text:
 *                 type: string
 *                 description: 文本内容
 *               model:
 *                 type: string
 *                 description: 语音模型
 *               provider:
 *                 type: string
 *                 description: 指定提供商（openai | fish | edge）。仅在管理员启用了多个提供商时可选；未启用或缺失时回落到默认提供商。
 *               voice:
 *                 type: string
 *                 description: 发音人
 *               outputFormat:
 *                 type: string
 *                 description: 输出格式
 *               speed:
 *                 type: number
 *                 description: 语速
 *               generationCode:
 *                 type: string
 *                 description: 生成码
 *     responses:
 *       200:
 *         description: 语音生成成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   description: 是否成功
 *                 audioUrl:
 *                   type: string
 *                   description: 语音文件地址
 *                 signature:
 *                   type: string
 *                   description: 签名
 *                 status:
 *                   type: string
 *                   description: generated | reused
 *                 message:
 *                   type: string
 *                   description: 用户可读结果说明
 *                 usage:
 *                   type: object
 *                   description: 当前账户额度摘要
 *                 nextAction:
 *                   type: object
 *                   description: 建议的下一步动作
 */
router.post("/generate", ttsSubmissionLimiter, optionalAuthenticateToken, ttsApiKeyAuth, TtsController.submitJob);
router.post("/jobs", ttsSubmissionLimiter, optionalAuthenticateToken, ttsApiKeyAuth, TtsController.submitJob);
router.get("/provider-config", ttsConfigReadLimiter, ttsProviderController.getPublicConfig);
router.get("/fish-catalog", ttsConfigReadLimiter, ttsProviderController.getFishCatalog);
router.get("/fish-audio-sample", ttsConfigReadLimiter, ttsProviderController.getFishAudioSample);
router.get("/assets/:fileName", ttsAssetLimiter, TtsController.getAudioAsset);
router.get("/jobs/:taskId", ttsJobReadLimiter, optionalAuthenticateToken, ttsApiKeyAuth, TtsController.getJobStatus);
router.get("/jobs/:taskId/result", ttsJobReadLimiter, optionalAuthenticateToken, ttsApiKeyAuth, TtsController.getJobResult);
router.get("/admin/history", ttsAdminOperationLimiter, authenticateAdmin, requireAdminScope, TtsController.getAllGenerations);
router.patch(
  "/admin/history/:recordId/review",
  ttsAdminOperationLimiter,
  authenticateSuperAdmin,
  auditLog({ module: "tts", action: "tts.recordReview", extractTarget: (req) => ({ targetId: req.params.recordId }) }),
  TtsController.updateGenerationReview,
);

/**
 * @openapi
 * /tts/turnstile/config:
 *   get:
 *     summary: 获取 Turnstile 配置
 *     description: 获取 Turnstile 配置
 *     responses:
 *       200:
 *         description: Turnstile 配置
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 enabled:
 *                   type: boolean
 *                 siteKey:
 *                   type: string
 *                   description: Turnstile 站点密钥
 */
router.get("/turnstile/config", ttsConfigReadLimiter, async (_req, res) => {
  try {
    const turnstileConfig = await TurnstileService.getConfig();

    console.log("Turnstile config response:", {
      enabled: turnstileConfig.enabled,
      siteKey: turnstileConfig.siteKey,
      siteKeyType: typeof turnstileConfig.siteKey,
    });

    res.json({
      enabled: turnstileConfig.enabled,
      siteKey: turnstileConfig.siteKey,
    });
  } catch (error) {
    console.error("获取Turnstile配置失败:", error);
    res.status(500).json({
      enabled: false,
      siteKey: null,
      error: "获取配置失败",
    });
  }
});

/**
 * @openapi
 * /api/tts/clarity/config:
 *   get:
 *     summary: 获取 Clarity 配置
 *     description: 获取 Microsoft Clarity 配置
 *     responses:
 *       200:
 *         description: Clarity 配置
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 enabled:
 *                   type: boolean
 *                 projectId:
 *                   type: string
 *                   description: Clarity 项目ID
 */
router.get("/clarity/config", ttsConfigReadLimiter, async (_req, res) => {
  try {
    const clarityConfig = await ClarityService.getConfig();

    console.log("Clarity config response:", {
      enabled: clarityConfig.enabled,
      projectId: clarityConfig.projectId,
      projectIdType: typeof clarityConfig.projectId,
    });

    res.json({
      enabled: clarityConfig.enabled,
      projectId: clarityConfig.projectId,
    });
  } catch (error) {
    console.error("获取Clarity配置失败:", error);
    res.status(500).json({
      enabled: false,
      projectId: null,
      error: "获取配置失败",
    });
  }
});

/**
 * @openapi
 * /api/tts/clarity/config:
 *   post:
 *     summary: 更新 Clarity 配置
 *     description: 更新 Microsoft Clarity 项目ID配置
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               projectId:
 *                 type: string
 *                 description: Clarity 项目ID
 *     responses:
 *       200:
 *         description: 配置更新成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 */
router.post("/clarity/config", ttsConfigWriteLimiter, authenticateSuperAdmin, auditLog({ module: "tts", action: "tts.clarityConfigSet" }), async (req, res) => {
  try {
    const { projectId } = req.body;

    if (!projectId || typeof projectId !== "string") {
      return res.status(400).json({
        success: false,
        error: "项目ID不能为空",
      });
    }

    // 获取请求元数据（可选）
    const metadata = {
      ip: req.ip || req.socket.remoteAddress,
      userAgent: req.headers["user-agent"],
    };

    const result = await ClarityService.updateConfig(projectId, metadata);

    if (result.success) {
      res.json({
        success: true,
        message: "Clarity配置更新成功",
        data: result.data,
      });
    } else {
      const statusCode = result.error?.code === "INVALID_FORMAT" || result.error?.code === "INVALID_INPUT" ? 400 : 500;
      res.status(statusCode).json({
        success: false,
        error: result.error?.message || "配置更新失败",
        code: result.error?.code,
      });
    }
  } catch (error) {
    console.error("更新Clarity配置失败:", error);
    res.status(500).json({
      success: false,
      error: "配置更新失败",
    });
  }
});

/**
 * @openapi
 * /api/tts/clarity/config:
 *   delete:
 *     summary: 删除 Clarity 配置
 *     description: 删除 Microsoft Clarity 项目ID配置
 *     responses:
 *       200:
 *         description: 配置删除成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 */
router.delete("/clarity/config", ttsConfigWriteLimiter, authenticateSuperAdmin, auditLog({ module: "tts", action: "tts.clarityConfigDelete" }), async (req, res) => {
  try {
    // 获取请求元数据（可选）
    const metadata = {
      ip: req.ip || req.socket.remoteAddress,
      userAgent: req.headers["user-agent"],
    };

    const result = await ClarityService.deleteConfig(metadata);

    if (result.success) {
      res.json({
        success: true,
        message: "Clarity配置删除成功",
      });
    } else {
      res.status(500).json({
        success: false,
        error: result.error?.message || "配置删除失败",
        code: result.error?.code,
      });
    }
  } catch (error) {
    console.error("删除Clarity配置失败:", error);
    res.status(500).json({
      success: false,
      error: "配置删除失败",
    });
  }
});

/**
 * @openapi
 * /tts/clarity/history:
 *   get:
 *     summary: 获取 Clarity 配置历史
 *     description: 获取 Clarity 配置的变更历史记录
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 20
 *         description: 返回的记录数量（最多100条）
 *     responses:
 *       200:
 *         description: 配置历史记录
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       key:
 *                         type: string
 *                       oldValue:
 *                         type: string
 *                       newValue:
 *                         type: string
 *                       operation:
 *                         type: string
 *                       changedAt:
 *                         type: string
 */
router.get("/clarity/history", ttsConfigReadLimiter, authenticateAdmin, requireAdminScope, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string, 10) || 20;
    const result = await ClarityService.getConfigHistory(limit);

    if (result.success) {
      res.json({
        success: true,
        data: result.data,
      });
    } else {
      res.status(500).json({
        success: false,
        error: result.error?.message || "获取配置历史失败",
        code: result.error?.code,
      });
    }
  } catch (error) {
    console.error("获取Clarity配置历史失败:", error);
    res.status(500).json({
      success: false,
      error: "获取配置历史失败",
    });
  }
});

/**
 * @openapi
 * /api/tts/history:
 *   get:
 *     summary: 获取最近生成记录
 *     description: 获取当前登录用户自己的生成记录（不含已被用户删除的记录）。TTS 仅登录可用。
 *     responses:
 *       200:
 *         description: 生成记录列表
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 records:
 *                   type: array
 *                   description: 生成记录列表
 *       401:
 *         description: 未登录
 */
router.get("/history", ttsHistoryLimiter, optionalAuthenticateToken, ttsApiKeyAuth, TtsController.getRecentGenerations);

/**
 * @openapi
 * /api/tts/history/{recordId}:
 *   patch:
 *     summary: 编辑我的生成记录
 *     description: 用户为自己的记录设置自定义标题、备注与预设标签。仅能操作本人记录，文件名不可修改。
 *     parameters:
 *       - in: path
 *         name: recordId
 *         required: true
 *         schema:
 *           type: string
 *         description: 生成记录 ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               userTitle:
 *                 type: string
 *                 description: 自定义标题（最多 120 字，留空即清除）
 *               userNote:
 *                 type: string
 *                 description: 自由文本备注（最多 1000 字，留空即清除）
 *               userTags:
 *                 type: array
 *                 items:
 *                   type: string
 *                 description: 预设标签（最多 10 个，单个最多 24 字）
 *     responses:
 *       200:
 *         description: 更新成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 record:
 *                   type: object
 *                   description: 更新后的记录
 *       400:
 *         description: 请求体格式无效
 *       401:
 *         description: 未登录
 *       404:
 *         description: 记录不存在、非本人记录或已被删除
 */
router.patch(
  "/history/:recordId",
  ttsHistoryWriteLimiter,
  optionalAuthenticateToken,
  ttsApiKeyAuth,
  auditLog({
    module: "tts",
    action: "tts.historyUpdate",
    extractTarget: (req) => ({ targetId: req.params.recordId }),
  }),
  TtsController.updateUserGeneration,
);

/**
 * @openapi
 * /api/tts/history/{recordId}:
 *   delete:
 *     summary: 删除我的生成记录
 *     description: 软删除，仅打标记且不可恢复；记录从用户列表消失，管理后台仍然可见。
 *     parameters:
 *       - in: path
 *         name: recordId
 *         required: true
 *         schema:
 *           type: string
 *         description: 生成记录 ID
 *     responses:
 *       200:
 *         description: 删除成功
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 id:
 *                   type: string
 *                   description: 被删除的记录 ID
 *                 userDeletedAt:
 *                   type: string
 *                   description: 软删除标记时间
 *       401:
 *         description: 未登录
 *       404:
 *         description: 记录不存在、非本人记录或已被删除
 */
router.delete(
  "/history/:recordId",
  ttsHistoryWriteLimiter,
  optionalAuthenticateToken,
  ttsApiKeyAuth,
  auditLog({
    module: "tts",
    action: "tts.historyDelete",
    extractTarget: (req) => ({ targetId: req.params.recordId }),
  }),
  TtsController.deleteGeneration,
);

export default router;
