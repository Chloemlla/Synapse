import logger from "../utils/logger";
import { sendEmail } from "./emailSender";

const INTERNAL_PLACEHOLDER_EMAIL_DOMAINS = new Set(["linuxdo.oauth.local", "google.nexai", "github.nexai"]);

function getEmailDomain(email: string): string {
  const atIndex = email.lastIndexOf("@");
  return atIndex >= 0 ? email.slice(atIndex + 1).trim().toLowerCase() : "";
}

export function canSendProviderCredentialEmail(email: string): boolean {
  const normalizedEmail = String(email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    return false;
  }

  return !INTERNAL_PLACEHOLDER_EMAIL_DOMAINS.has(getEmailDomain(normalizedEmail));
}

export async function sendProviderGeneratedPasswordEmail(params: {
  email: string;
  username: string;
  password?: string;
  providerLabel: string;
}): Promise<void> {
  if (!canSendProviderCredentialEmail(params.email)) {
    logger.info("[ProviderCredentialEmail] Skipped generated password email for non-deliverable provider email", {
      username: params.username,
      providerLabel: params.providerLabel,
      emailDomain: getEmailDomain(params.email),
    });
    return;
  }

  try {
    // 邮件长期留存；新账号只发送操作指引，随机初始口令不离开认证流程。
    const html = "<p>您的 Synapse 账号已创建。</p><p>请使用第三方账号登录。若需要密码登录，请在登录页选择“忘记密码”，通过验证邮箱设置密码。</p>";
    const result = await sendEmail({
      to: params.email,
      subject: "Synapse 账号已创建",
      html,
      logTag: "第三方注册通知",
      // 安全/账户事件通知（由合法操作触发，不可被匿名滥用），不占用也不受验证码发送配额限制。
      checkQuota: false,
      purpose: "transactional",
    });

    if (!result.success) {
      logger.warn("[ProviderCredentialEmail] Generated password email failed", {
        username: params.username,
        providerLabel: params.providerLabel,
        email: params.email,
        error: result.error,
      });
    }
  } catch (error) {
    logger.warn("[ProviderCredentialEmail] Generated password email threw", {
      username: params.username,
      providerLabel: params.providerLabel,
      email: params.email,
      error,
    });
  }
}
