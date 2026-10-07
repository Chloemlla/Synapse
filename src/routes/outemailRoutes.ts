import express, { type Request, type Response } from "express";
import validator from "validator";
import { requireAdminScope } from "../middleware/adminScope";
import { createLimiter } from "../middleware/rateLimiter";
import { authMiddlewareV2 as authMiddleware, adminAuthMiddleware, authenticateSuperAdmin } from "../middleware/auth";
import { getOutEmailServiceStatus, resolveOutEmailDomain } from "../services/emailService";
import { getOutEmailAuthStatus, getOutEmailQuota, sendOutEmail, sendOutEmailBatch, getOutEmailRecords, getOutEmailRecordById } from "../services/outEmailService";
import { getClientIP } from "../utils/ipUtils";
import { firstString } from "../utils/httpParam";
import logger from "../utils/logger";

const router = express.Router();

// 对外邮件发送限流（与内部邮件独立）
const outEmailLimiter = createLimiter({
  windowMs: 60 * 1000,
  max: 300,
  message: "对外邮件发送过于频繁，请稍后再试",
  routeName: "outemail.send",
});

// 对外邮件服务状态查询限流
const statusQueryLimiter = createLimiter({
  windowMs: 60 * 1000,
  max: 60,
  message: "状态查询过于频繁，请稍后再试",
  routeName: "outemail.status",
});

function sendFailure(res: Response, result: { error?: string; code?: string; statusCode?: number; retryAfterSeconds?: number }) {
  if (result.retryAfterSeconds) res.setHeader("Retry-After", String(result.retryAfterSeconds));
  return res.status(result.statusCode || 400).json({
    success: false,
    error: result.error || "邮件发送失败，请稍后重试",
    code: result.code,
    retryAfterSeconds: result.retryAfterSeconds,
  });
}

function isRecipient(value: unknown): value is string {
  return typeof value === "string" && validator.isEmail(value.trim());
}

function isMessageText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function getHeaderValue(value: unknown): string {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0].trim() : "";
  return typeof value === "string" ? value.trim() : "";
}

function extractBearerToken(authorization: string): string {
  const trimmed = authorization.trimStart();
  if (trimmed.length < 7) return "";
  if (trimmed.slice(0, 6).toLowerCase() !== "bearer") return "";
  const separator = trimmed.charCodeAt(6);
  if (separator !== 0x20 && separator !== 0x09) return "";
  return trimmed.slice(7).trim();
}

function getRequestAuth(req: Request, body: Record<string, unknown>) {
  const authorization = getHeaderValue(req.headers.authorization);
  const bearerToken = extractBearerToken(authorization);
  const headerApiKey =
    bearerToken || getHeaderValue(req.headers["x-outemail-api-key"]) || getHeaderValue(req.headers["x-api-key"]);
  const bodyApiKey =
    typeof body.apiKey === "string"
      ? body.apiKey.trim()
      : typeof body.authKey === "string"
        ? body.authKey.trim()
        : "";
  const code = typeof body.code === "string" ? body.code.trim() : "";

  return {
    code: code || undefined,
    apiKey: headerApiKey || bodyApiKey || undefined,
  };
}

/**
 * GET /api/outemail/quota
 * 公共：查询对外邮件每日配额
 */
router.get("/quota", statusQueryLimiter, async (_req, res) => {
  try {
    const info = await getOutEmailQuota();
    res.json({ success: true, used: info.used, total: info.total, resetAt: info.resetAt });
  } catch (error) {
    logger.error("[OutEmail] 配额查询失败", { error });
    res.status(503).json({ success: false, code: "EMAIL_SERVICE_UNAVAILABLE", error: "邮件额度暂时无法查询，请稍后重试" });
  }
});

/**
 * GET /api/outemail/status
 * 公共：查询对外邮件服务状态
 */
router.get("/status", statusQueryLimiter, async (req, res) => {
  try {
    const outemailStatus = getOutEmailServiceStatus();
    const domain = outemailStatus.domain || resolveOutEmailDomain();
    const authStatus = await getOutEmailAuthStatus(domain);
    const available = outemailStatus.available && authStatus.configured;
    res.json({
      success: true,
      available,
      error: available ? "" : outemailStatus.error || "对外邮件鉴权未配置",
      domain,
      authConfigured: authStatus.configured,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "未知错误";
    logger.error("[OutEmail] 服务状态查询异常", {
      error: errorMessage,
      stack: error instanceof Error ? error.stack : undefined,
      ip: req.ip,
    });
    res.status(500).json({ success: false, available: false, error: "服务状态查询失败" });
  }
});

/**
 * GET /api/outemail/domain
 * 公共：获取对外发信所使用的域名
 */
router.get("/domain", statusQueryLimiter, (_req, res) => {
  res.json({ success: true, domain: resolveOutEmailDomain() });
});

/**
 * POST /api/outemail/send
 * 公共：发送对外邮件（支持 API Key 或兼容校验码鉴权）
 */
router.post("/send", outEmailLimiter, async (req, res) => {
  try {
    const body = (req.body || {}) as Record<string, any>;
    const { to, subject, content, attachments, from, displayName, domain } = body;
    // Do not silently discard additional recipients from the single-message API.
    const recipient = Array.isArray(to) && to.length === 1 ? to[0] : to;
    if (!isRecipient(recipient)) {
      return res.status(400).json({ error: Array.isArray(to) && to.length > 1
        ? "单封发送仅支持一个收件人，请使用批量发送"
        : "收件人邮箱格式无效" });
    }
    if (!isMessageText(subject, 200) || !isMessageText(content, 100_000)) {
      return res.status(400).json({ error: "请提供有效的主题和正文（主题最多200字，正文最多100000字）" });
    }
    if ([from, displayName, domain].some((value) => value !== undefined && typeof value !== "string")) {
      return res.status(400).json({ error: "发件人配置格式无效" });
    }
    if (attachments !== undefined && (!Array.isArray(attachments) || attachments.length > 10 ||
      attachments.some((a: unknown) => {
        if (!a || typeof a !== "object") return true;
        const item = a as Record<string, unknown>;
        return !isMessageText(item.filename, 255) ||
          !(typeof item.path === "string" || typeof item.content === "string");
      }))) {
      return res.status(400).json({ error: "附件格式无效或超过10个" });
    }
    const auth = getRequestAuth(req, body);
    const result = await sendOutEmail({
      to: recipient.trim(), subject, content, code: auth.code, apiKey: auth.apiKey,
      ip: getClientIP(req), attachments, from, displayName, domain,
    });
    if (result.success) return res.json({ success: true, messageId: result.messageId, acceptedCount: result.acceptedCount });
    return sendFailure(res, result);
  } catch (error) {
    logger.error("[OutEmail] 发送请求失败", { error });
    return res.status(503).json({ success: false, code: "EMAIL_SERVICE_UNAVAILABLE", error: "邮件服务暂时不可用，请稍后重试" });
  }
});

// 批量发送（不支持附件）
router.post("/batch-send", outEmailLimiter, async (req, res) => {
  try {
    const body = (req.body || {}) as Record<string, any>;
    const { messages, from, displayName, domain } = body;
    if (!Array.isArray(messages) || !messages.length || messages.length > 100) {
      return res.status(400).json({ error: "消息列表应包含1到100封邮件" });
    }
    if ([from, displayName, domain].some((value) => value !== undefined && typeof value !== "string")) {
      return res.status(400).json({ error: "发件人配置格式无效" });
    }
    const normalized: Array<{ to: string[]; subject: string; content: string }> = [];
    for (const message of messages) {
      if (!message || typeof message !== "object" ||
        !isMessageText(message.subject, 200) || !isMessageText(message.content, 100_000)) {
        return res.status(400).json({ error: "每封邮件都需要有效的主题和正文" });
      }
      const recipients: unknown[] = Array.isArray(message.to) ? message.to : [message.to];
      if (!recipients.length || recipients.length > 100 || !recipients.every(isRecipient)) {
        return res.status(400).json({ error: "消息包含无效的收件人邮箱地址" });
      }
      normalized.push({ to: recipients.map((recipient) => (recipient as string).trim()), subject: message.subject, content: message.content });
    }
    const auth = getRequestAuth(req, body);
    const ip = getClientIP(req);
    const result = await sendOutEmailBatch({
      messages: normalized,
      code: auth.code,
      apiKey: auth.apiKey,
      ip,
      from,
      displayName,
      domain,
    });
    if (result.success) return res.json({ success: true, ids: result.ids, acceptedCount: result.acceptedCount });
    return sendFailure(res, result);
  } catch (error) {
    logger.error("[OutEmail] 批量发送请求失败", { error });
    return res.status(503).json({ success: false, code: "EMAIL_SERVICE_UNAVAILABLE", error: "邮件服务暂时不可用，请稍后重试" });
  }
});

/**
 * GET /api/outemail/records
 * 查询对外邮件发送记录（溯源日志，仅超级管理员）
 * 邮件正文可能包含验证码/重置链接等凭证，因此从 admin 收窄到 superadmin。
 */
router.get("/records", statusQueryLimiter, authMiddleware, adminAuthMiddleware, requireAdminScope, authenticateSuperAdmin, async (req, res) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = parseInt(req.query.pageSize as string) || 20;
    const to = req.query.to as string | undefined;
    const subject = req.query.subject as string | undefined;
    const startDate = req.query.startDate as string | undefined;
    const endDate = req.query.endDate as string | undefined;

    const result = await getOutEmailRecords({ page, pageSize, to, subject, startDate, endDate });
    res.json({ success: true, ...result });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message || "查询失败" });
  }
});

/**
 * GET /api/outemail/records/:id
 * 查询单条邮件记录的完整内容（仅超级管理员）
 */
router.get("/records/:id", statusQueryLimiter, authMiddleware, adminAuthMiddleware, requireAdminScope, authenticateSuperAdmin, async (req, res) => {
  try {
    const id = firstString(req.params.id);
    if (!id) {
      return res.status(400).json({ success: false, error: "缺少记录 ID" });
    }
    const record = await getOutEmailRecordById(id);
    if (!record) {
      return res.status(404).json({ success: false, error: "记录不存在" });
    }
    res.json({ success: true, record });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message || "查询失败" });
  }
});

export default router;
