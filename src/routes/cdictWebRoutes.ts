import express, { type RequestHandler } from "express";
import { CDictController } from "../controllers/cdictController";
import { CDictDonationController } from "../controllers/cdictDonationController";
import { requireFeatureConsent } from "../middleware/featureConsent";
import {
  cdictWebClaimLimiter,
  cdictWebUpstreamGlobalBurstGuard,
  cdictWebUpstreamIpBurstGuard,
  cdictWebUpstreamIpLimiter,
  cdictWebUpstreamUserBurstGuard,
  cdictWebUpstreamUserLimiter,
} from "../middleware/cdictWebLimiters";
import { cdictDonationClaimLimiter } from "../middleware/routeLimiters";

/**
 * @openapi
 * /api/translate/cdict/translate:
 *   post:
 *     tags: [CDict Web]
 *     summary: 登录网站账号使用 CDict 翻译
 *     description: 需要有效网站会话、翻译权限与翻译条款同意；不接受 Android 签名替代登录。返回上游结构，不共享缓存。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [text, to]
 *             properties:
 *               text: { type: string, maxLength: 5000 }
 *               from: { type: string, default: auto }
 *               to: { type: string, example: zh-CHS }
 *     responses:
 *       200: { description: CDict 上游翻译响应 }
 *       400: { description: 参数不合法 }
 *       401: { description: 网站会话无效 }
 *       403: { description: 账号或翻译权限受限，或尚未同意条款 }
 *       413: { description: 文本超过上限 }
 *       429: { description: 请求频率或并发超过上限 }
 *       502: { description: 上游不可用 }
 * /api/translate/cdict/languages:
 *   get:
 *     tags: [CDict Web]
 *     summary: 登录网站账号读取 CDict 语言列表
 *     description: 需要网站会话与翻译权限，语言集合结构与 CDict 上游一致。
 *     responses:
 *       200: { description: 语言集合 }
 *       401: { description: 网站会话无效 }
 *       403: { description: 翻译权限受限 }
 *       429: { description: 请求过于频繁 }
 *       502: { description: 上游不可用 }
 * /api/translate/cdict/tts:
 *   get:
 *     tags: [CDict Web]
 *     summary: 登录网站账号朗读文本
 *     description: 需要网站会话、翻译权限与语音条款同意；PCM 转为浏览器可播放的 WAV，已有 MP3/WAV 保持原字节，响应不共享缓存。
 *     parameters:
 *       - { in: query, name: text, required: true, schema: { type: string, maxLength: 300 } }
 *       - { in: query, name: source, schema: { type: string, enum: [engine, youdao], default: engine } }
 *       - { in: query, name: langType, schema: { type: string, default: en-USA } }
 *       - { in: query, name: type, schema: { type: integer, enum: [1, 2], default: 2 } }
 *     responses:
 *       200:
 *         description: 音频字节
 *         content:
 *           audio/wav: { schema: { type: string, format: binary } }
 *           audio/mpeg: { schema: { type: string, format: binary } }
 *       400: { description: 参数不合法 }
 *       401: { description: 网站会话无效 }
 *       403: { description: 翻译权限受限或尚未同意条款 }
 *       413: { description: 文本超过上限 }
 *       429: { description: 请求频率或并发超过上限 }
 *       502: { description: 上游不可用 }
 * /api/translate/cdict/donate:
 *   get:
 *     tags: [CDict Web]
 *     summary: 登录网站账号读取赞赏渠道
 *     description: 需要网站会话与翻译权限，复用 CDict 渠道、文案与鸣谢名单。
 *     responses:
 *       200: { description: 渠道、文案与鸣谢名单 }
 *       401: { description: 网站会话无效 }
 *       403: { description: 翻译权限受限 }
 *       404: { description: 赞赏功能未开启 }
 *       429: { description: 请求过于频繁 }
 * /api/translate/cdict/donate/claim:
 *   post:
 *     tags: [CDict Web]
 *     summary: 登录网站账号提交赞赏署名申请
 *     description: 需要网站会话与翻译权限；复用 CDict 幂等署名申请，不新增支付或自动核实能力。
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [transactionId, displayName]
 *             properties:
 *               transactionId: { type: string, pattern: '^[A-Za-z0-9_-]{6,64}$' }
 *               displayName: { type: string, maxLength: 32 }
 *     responses:
 *       200: { description: 申请已提交或此前已提交 }
 *       400: { description: 参数不合法或服务暂时不可用 }
 *       401: { description: 网站会话无效 }
 *       403: { description: 翻译权限受限或来源不允许 }
 *       429: { description: 署名提交过于频繁 }
 * /api/translate/cdict/donate/{channel}:
 *   get:
 *     tags: [CDict Web]
 *     summary: 登录网站账号读取赞赏码来源
 *     description: 内置码返回图片字节；外部图床返回 HTTPS imageUrl JSON，不把网站 API 请求重定向到第三方。
 *     parameters:
 *       - { in: path, name: channel, required: true, schema: { type: string, pattern: '^[a-z0-9-]{1,32}$' } }
 *     responses:
 *       200:
 *         description: 内置图片字节或经校验的外部图床地址
 *         content:
 *           image/png: { schema: { type: string, format: binary } }
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 imageUrl: { type: string, format: uri }
 *       401: { description: 网站会话无效 }
 *       403: { description: 翻译权限受限 }
 *       404: { description: 渠道没有可用图片 }
 *       429: { description: 请求过于频繁 }
 *       502: { description: 图片来源读取失败 }
 */

/** Authentication failures must not be cached either. */
export const privateCdictWebResponse: RequestHandler = (_req, res, next) => {
  res.locals.cdictPrivateResponse = true;
  res.setHeader("Cache-Control", "private, no-store");
  next();
};

const router = express.Router();
const upstreamGuards = [
  cdictWebUpstreamIpLimiter,
  cdictWebUpstreamUserLimiter,
  cdictWebUpstreamUserBurstGuard,
  cdictWebUpstreamIpBurstGuard,
  cdictWebUpstreamGlobalBurstGuard,
];

// Mandatory session/access checks are mounted before this router for ALL six endpoints.
// Android bytes/cache/signature classification remain exclusively on cdictRoutes.
router.post("/translate", requireFeatureConsent("deeplx-translate"), ...upstreamGuards, CDictController.translate);
router.get("/languages", CDictController.languages);
router.get("/tts", requireFeatureConsent("tts-generate"), ...upstreamGuards, CDictController.ttsForWeb);
router.get("/donate", CDictDonationController.channels);
router.post("/donate/claim", cdictDonationClaimLimiter, cdictWebClaimLimiter, CDictDonationController.claim);
router.get("/donate/:channel", CDictDonationController.imageForWeb);

export default router;
