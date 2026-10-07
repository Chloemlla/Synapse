import { completeAuthEmail, releaseAuthEmail, reserveAuthEmail } from "./authEmailCooldownService";
import { sendEmail, type SendEmailOptions, type SendEmailResult } from "./emailSender";

// 多个 IP 触发同一账户的失败/锁定事件时，也只能按收件人与事件短时发送一次。
export async function sendThrottledAuthNotification(options: SendEmailOptions, event: string): Promise<SendEmailResult> {
  const reserved = await reserveAuthEmail(options.to, event, 15 * 60_000);
  if (!reserved.success) return { success: false, error: "同类安全提醒已发送" };
  let delivered = false;
  try {
    const result = await sendEmail({ ...options, checkQuota: false });
    if (result.success) {
      delivered = true;
      await completeAuthEmail(reserved.reservation);
    }
    return result;
  } finally {
    if (!delivered) await releaseAuthEmail(reserved.reservation);
  }
}
