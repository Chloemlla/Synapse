import { EmailService } from "./emailService";
import { UserModel } from "./userService";
import logger from "../utils/logger";

/**
 * 运维告警投递：本部署只有**邮件**与可选的 **webhook** 两条通道（没有钉钉 / 企业微信）。
 *
 * 用途：死信任务、队列异常等需要人工介入的事件。调用方负责去重 / 合并（一次事件一封摘要邮件），
 * 本模块只负责投递。投递失败只记日志、绝不抛给调用方——告警通道本身不能把业务或看门狗打挂。
 *
 * - 邮件：发给 admin / superadmin 团队（与工单通知同一批收件人）。
 * - webhook：配置 `ALERT_WEBHOOK_URL` 时 POST 一段 JSON；未配置直接跳过（不是失败）。
 */

export interface AdminAlertPayload {
  /** 事件标题（邮件主题会加 `[Synapse 告警]` 前缀）。 */
  subject: string;
  /** 纯文本摘要：邮件渲染在 <pre> 里，webhook 原样带上。 */
  text: string;
  /** 结构化上下文（条数、任务 id 等），随 webhook 一起发出，便于接收端自动分流。 */
  detail?: Record<string, unknown>;
  level?: "warning" | "critical";
}

/** 管理团队收件人：admin / superadmin 的邮箱去重。 */
export async function getAdminTeamEmails(): Promise<string[]> {
  const adminDocs = await UserModel.find({ role: { $in: ["admin", "superadmin"] } })
    .select("email")
    .lean();
  return [...new Set(adminDocs.map((doc: any) => doc.email).filter(Boolean))] as string[];
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

export async function sendAdminAlert(payload: AdminAlertPayload): Promise<void> {
  const level = payload.level ?? "warning";
  const subject = `[Synapse 告警] ${payload.subject}`;

  try {
    const recipients = await getAdminTeamEmails();
    if (recipients.length > 0) {
      const html = [
        `<div style="font-family:Arial,sans-serif;line-height:1.6;color:#333;">`,
        `<p><strong>${escapeHtml(payload.subject)}</strong></p>`,
        `<pre style="white-space:pre-wrap;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:12px;">${escapeHtml(payload.text)}</pre>`,
        `</div>`,
      ].join("");
      await EmailService.sendBatchHtmlEmails(recipients, subject, html);
    } else {
      logger.warn("[AdminAlert] 没有可投递的管理员邮箱，跳过邮件告警", { subject });
    }
  } catch (error) {
    logger.error("[AdminAlert] 邮件告警投递失败", {
      subject,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  const webhookUrl = process.env.ALERT_WEBHOOK_URL?.trim();
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "synapse",
        level,
        subject: payload.subject,
        text: payload.text,
        detail: payload.detail ?? {},
        timestamp: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    logger.error("[AdminAlert] Webhook 告警投递失败", {
      subject,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
