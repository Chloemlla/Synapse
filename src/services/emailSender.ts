/** Account and notification mail does not consume the user's self-service sending allowance. */
import { EmailService, type EmailPurpose } from "./emailService";
import logger from "../utils/logger";

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  logTag: string;
  /** Only explicit account actions may bypass a subscription unsubscribe. */
  purpose?: EmailPurpose;
  /** @deprecated User email quotas belong to self-service sending, not account notifications. */
  checkQuota?: boolean;
  /** @deprecated Retained for callers that attached account context to notifications. */
  userId?: string;
}

export interface SendEmailResult {
  success: boolean;
  error?: string;
}

export async function sendEmail(options: SendEmailOptions): Promise<SendEmailResult> {
  const { to, subject, html, logTag, purpose = "notification" } = options;
  try {
    const result = await EmailService.sendHtmlEmail([to], subject, html, undefined, purpose);
    if (result.success) {
      logger.info(`[${logTag}] 邮件发送成功`);
      return { success: true };
    }
    logger.error(`[${logTag}] 邮件发送失败`, { error: result.error });
  } catch (error) {
    logger.error(`[${logTag}] 邮件发送异常`, { error });
  }
  return { success: false, error: "邮件发送失败，请稍后重试" };
}
