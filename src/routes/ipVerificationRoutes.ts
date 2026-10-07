import express from "express";
import IpVerificationService from "../services/ipVerificationService";
import { config } from "../config/config";
import { createLimiter } from "../middleware/routeLimiters";
import { getClientIP } from "../utils/ipUtils";
import logger from "../utils/logger";

const router = express.Router();

const sessionLimiter = createLimiter({
  name: "ipVerificationSession",
  profile: "standard",
  category: "verification",
  message: "Too many verification requests",
});

function resolveIpAddress(req: express.Request): string {
  return getClientIP(req);
}

router.post("/session", sessionLimiter, async (req, res) => {
  try {
    const fingerprint = typeof req.body?.fingerprint === "string" ? req.body.fingerprint : "";
    const result = await IpVerificationService.initializeSession({
      fingerprint,
      ipAddress: resolveIpAddress(req),
      userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined,
      userLanguage: typeof req.headers["accept-language"] === "string" ? req.headers["accept-language"] : undefined,
    });

    if (result.banned) {
      // 形状与 ipBanCheck 的封禁响应对齐：前端 ipVerification.ts 按 error==="IP已被封禁"
      // 读出 banData，首访闸门据此直接渲染阻断页（与首访验闸同一套设计语言）。
      // GB-03: 补 errorCode:"IP_BANNED"，与 security/ipBlockPage.ts、services/turnstile/verify.ts
      // 的同名稳定码一致；前端已兼容该码，靠文案匹配识别处罚态是最后选择。
      return res.status(403).json({
        errorCode: "IP_BANNED",
        error: "IP已被封禁",
        reason: result.banReason || "IP 风险过高，已自动拦截",
        expiresAt: result.banExpiresAt,
      });
    }

    if (!result.success) {
      return res.status(400).json(result);
    }

    res.status(200).json(result);
  } catch (error) {
    logger.error("[IpVerification] 初始化验证会话失败", error);
    res.status(500).json({
      success: false,
      verified: false,
      requiresVerification: true,
      error: "Failed to initialize verification session",
      // GB-07: TTL 取运行时可配值（服务层各分支同一写法），不再硬编码 40——
      // 超管把 tokenTtlMinutes 调小后，兜底 500 仍说 40 会让前后端认知分叉。
      tokenTtlMinutes: config.ipqs.tokenTtlMinutes,
    });
  }
});

router.post("/complete", sessionLimiter, async (req, res) => {
  try {
    const fingerprint = typeof req.body?.fingerprint === "string" ? req.body.fingerprint : "";
    const captchaToken = typeof req.body?.captchaToken === "string" ? req.body.captchaToken : "";
    const captchaType = ["hcaptcha", "trycap"].includes(req.body?.captchaType) ? req.body.captchaType : "turnstile";

    const result = await IpVerificationService.completeVerification(
      fingerprint,
      resolveIpAddress(req),
      captchaToken,
      typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined,
      captchaType,
    );

    if (!result.success) {
      return res.status(400).json(result);
    }

    res.json(result);
  } catch (error) {
    logger.error("[IpVerification] 完成验证失败", error);
    res.status(500).json({
      success: false,
      verified: false,
      requiresVerification: true,
      error: "Failed to complete verification",
      // GB-07: TTL 取运行时可配值（服务层各分支同一写法），不再硬编码 40——
      // 超管把 tokenTtlMinutes 调小后，兜底 500 仍说 40 会让前后端认知分叉。
      tokenTtlMinutes: config.ipqs.tokenTtlMinutes,
    });
  }
});

export default router;
