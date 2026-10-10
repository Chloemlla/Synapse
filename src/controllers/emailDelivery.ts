import type { Request, Response } from "express";
import validator from "validator";
import { EmailService, consumeEmailQuota, refundEmailQuota, settleEmailQuota, getAllSenderDomains,
  type EmailQuotaReservation, type EmailResponse } from "../services/emailService";
import type { AuthenticatedRequest } from "../types/authRequest";
import logger from "../utils/logger";

type EmailMode = "html" | "simple" | "markdown" | "batch";
interface EmailInput {
  from?: string;
  to: string[];
  subject: string;
  html?: string;
  text?: string;
  content?: string;
  markdown?: string;
}

function validateInput(body: unknown, mode: EmailMode): { input: EmailInput } | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "邮件参数无效" };
  const data = body as Record<string, unknown>;
  const maxRecipients = mode === "batch" ? 100 : 10;
  if (!Array.isArray(data.to) || data.to.length === 0 || data.to.some((item) => typeof item !== "string" || !item.trim())) {
    return { error: "请提供非空的收件人邮箱数组" };
  }
  if (data.to.length > maxRecipients) return { error: `收件人数量不能超过${maxRecipients}个` };
  if (typeof data.subject !== "string" || !data.subject.trim() || data.subject.length > 200) {
    return { error: "邮件主题不能为空且不能超过200字符" };
  }
  if ((mode !== "simple" && (typeof data.from !== "string" || !data.from.trim())) ||
      (data.from !== undefined && typeof data.from !== "string")) return { error: "请提供有效的发件人邮箱" };
  const input: EmailInput = { to: [...new Set((data.to as string[]).map((item) => item.trim().toLowerCase()))], subject: data.subject.trim() };
  if (typeof data.from === "string" && data.from.trim()) input.from = data.from.trim();
  for (const field of ["html", "text", "content", "markdown"] as const) {
    const value = data[field];
    if (value === undefined) continue;
    if (typeof value !== "string") return { error: `${field} 必须为字符串` };
    const max = field === "content" ? 10_000 : 50_000;
    if (value.length > max) return { error: `邮件内容不能超过${max}字符` };
    input[field] = value;
  }
  const content = mode === "html" ? input.html : mode === "simple" ? input.content : mode === "markdown" ? input.markdown : input.html?.trim() || input.text;
  if (!content?.trim()) return { error: "邮件正文不能为空" };
  return { input };
}

export async function deliverEmailRequest(req: Request, res: Response, mode: EmailMode) {
  let reservation: EmailQuotaReservation | undefined;
  let transportCompleted = false;
  try {
    const parsed = validateInput(req.body, mode);
    if ("error" in parsed) return res.status(400).json({ success: false, error: parsed.error });
    const input = parsed.input;
    const userId = (req as AuthenticatedRequest).user?.id;
    if (!userId) return res.status(401).json({ success: false, error: "未登录" });
    if (input.from && (!validator.isEmail(input.from) || !EmailService.isValidSenderDomain(input.from))) {
      return res.status(400).json({ success: false, error: "发件人邮箱必须使用已配置发信域名", allowedDomains: getAllSenderDomains() });
    }
    const validation = EmailService.validateEmails(input.to);
    if (validation.invalid.length > 0) {
      return res.status(400).json({ success: false, error: "邮箱格式无效", invalidEmails: validation.invalid });
    }
    // 所有端点按同一用户桶、实际收件人数预留，切换模板或发件域名不产生第二份预算。
    const quota = await consumeEmailQuota(userId, undefined, input.to.length);
    if (!quota.success) {
      const exhausted = quota.reason === "exhausted" || quota.reason === "rate_limited";
      if (quota.retryAfterSeconds) res.setHeader("Retry-After", String(quota.retryAfterSeconds));
      return res.status(exhausted ? 429 : 503).json({
        success: false,
        error: exhausted ? "邮件配额不足，请稍后再试" : "邮件配额暂时无法查询，请稍后重试",
        code: exhausted ? "EMAIL_QUOTA_EXCEEDED" : "EMAIL_SERVICE_UNAVAILABLE",
        retryAfterSeconds: quota.retryAfterSeconds,
      });
    }
    reservation = quota.reservation;
    let result: EmailResponse & { ids?: string[] };
    if (mode === "simple") {
      result = await EmailService.sendSimpleEmail(input.to, input.subject, input.content!, input.from);
    } else if (mode === "markdown") {
      result = await EmailService.sendMarkdownEmail({ to: input.to, subject: input.subject, markdown: input.markdown!, from: input.from! });
    } else if (mode === "batch") {
      const html = input.html?.trim() ? input.html : `<pre style="white-space:pre-wrap">${(input.text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>`;
      result = await EmailService.sendBatchHtmlEmails(input.to, input.subject, html, input.from!);
    } else {
      result = await EmailService.sendEmail({ from: input.from!, to: input.to, subject: input.subject, html: input.html!, text: input.text });
    }
    transportCompleted = true;
    const acceptedCount = result.acceptedCount ?? (result.success ? input.to.length : 0);
    try {
      await settleEmailQuota(reservation, acceptedCount);
    } catch (error) {
      // 已经接受投递时保留预留；结算故障不能触发全额退款或误报发送失败。
      logger.error("[EmailController] 邮件额度结算失败", { error, userId, acceptedCount });
    }
    if (!result.success) {
      logger.error('[EmailController] 邮件服务投递失败', { error: result.error, mode, acceptedCount });
      return res.status(500).json({ success: false, error: "邮件发送失败，请稍后重试", acceptedCount });
    }
    return res.json({ success: true, message: mode === "batch" ? "批量发送成功" : "邮件发送成功", messageId: result.messageId, ids: result.ids, data: result.data, acceptedCount });
  } catch (error) {
    if (reservation && !transportCompleted) {
      await refundEmailQuota(reservation).catch((refundError) => logger.error("[EmailController] 失败发送退款失败", { error: refundError }));
    }
    logger.error("[EmailController] 邮件发送异常", { error: error instanceof Error ? error.message : String(error), mode });
    return res.status(500).json({ success: false, error: "邮件发送失败，请稍后重试" });
  }
}
