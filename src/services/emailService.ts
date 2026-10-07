import { Resend } from "resend";
import type { EmailRuntimeConfig } from "../config/runtimeConfigDefaults";
import { filterSuppressedEmails, normalizeEmail } from "./emailSuppressionService";
import { logger } from "./logger";
import { RuntimeConfigService } from "./runtimeConfigService";

/**
 * EM-4: 发送前过滤抑制名单（退信 / 投诉 / 退订）。
 * 返回 ok=false 表示所有收件人都被抑制——调用方应直接拒发，而不是发一封空收件人的请求。
 */
async function resolveDeliverableRecipients(
  rawTo: unknown,
  purpose: EmailPurpose = "notification",
): Promise<{ ok: true; recipients: string[]; skipped: string[] } | { ok: false; error: string }> {
  if (!Array.isArray(rawTo) || rawTo.some((item) => typeof item !== "string" || !normalizeEmail(item))) {
    return { ok: false, error: "收件人邮箱格式无效" };
  }
  const requested = [...new Set(rawTo.map((item: string) => normalizeEmail(item)))];
  if (requested.length === 0) return { ok: false, error: "收件人不能为空" };

  const { suppressed } = await filterSuppressedEmails(requested, { transactional: purpose === "transactional" });
  if (suppressed.length === 0) return { ok: true, recipients: requested, skipped: [] };

  const suppressedSet = new Set(suppressed);
  const recipients = requested.filter((email) => !suppressedSet.has(normalizeEmail(email)));
  if (recipients.length === 0) {
    return { ok: false, error: "收件地址已在退订/退信抑制名单中，已阻止发送" };
  }
  return { ok: true, recipients, skipped: suppressed };
}

const FALLBACK_RESEND_DOMAIN = process.env.RESEND_DOMAIN || "chloemlla.com";

type MarkedLike = {
  parse?: (markdown: string) => string | Promise<string>;
  (markdown: string): string | Promise<string>;
};

let markedModulePromise: Promise<MarkedLike> | null = null;

async function loadMarked(): Promise<MarkedLike> {
  if (!markedModulePromise) {
    markedModulePromise = import("marked").then((mod: any) => (mod.marked ?? mod.default ?? mod) as MarkedLike);
  }
  return markedModulePromise;
}

async function renderMarkdown(markdown: string): Promise<string> {
  const marked = await loadMarked();
  const parsed = typeof marked.parse === "function" ? marked.parse(markdown || "") : marked(markdown || "");
  return await Promise.resolve(parsed);
}

export const DEFAULT_EMAIL_FROM = `noreply@${FALLBACK_RESEND_DOMAIN}`;

const RESEND_API_KEY_PATTERN = /^re_\w{8,}/;

export { getEmailQuota, addEmailUsage, resetEmailQuota, consumeEmailQuota, refundEmailQuota, settleEmailQuota, EmailQuotaUnavailableError } from "./emailQuotaService";
export type { EmailQuotaInfo, EmailQuotaReservation, EmailQuotaResult } from "./emailQuotaService";

export interface EmailAttachmentInput {
  filename: string;
  path?: string;
  content?: Buffer | string;
  contentType?: string;
  content_id?: string;
}

export interface NormalizedEmailAttachment {
  filename: string;
  path?: string;
  content?: Buffer | string;
  contentType?: string;
  content_id?: string;
}

export type EmailChannel = "primary" | "outemail";
export type EmailPurpose = "transactional" | "notification";

export interface EmailData {
  channel?: EmailChannel;
  purpose?: EmailPurpose;
  from: string;
  to: string[];
  subject: string;
  html: string;
  text?: string;
  attachments?: NormalizedEmailAttachment[];
  replyTo?: string;
  headers?: Record<string, string>;
}

export interface BatchEmailData {
  channel?: EmailChannel;
  purpose?: EmailPurpose;
  from: string;
  messages: Array<{
    to: string[];
    subject: string;
    html: string;
    text?: string;
    attachments?: NormalizedEmailAttachment[];
    replyTo?: string;
    headers?: Record<string, string>;
  }>;
}

export interface EmailResponse {
  success: boolean;
  data?: any;
  error?: string;
  messageId?: string;
  acceptedCount?: number;
  acceptedRecipients?: string[];
  acceptedMessages?: Array<{ index: number; to: string[] }>;
}

function normalizeDomain(domain?: string): string {
  return String(domain || "").trim().toLowerCase();
}

function escapeRegExp(str: string) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const ALLOWED_RECIPIENT_DOMAINS = [
  "gmail.com",
  "outlook.com",
  "qq.com",
  "163.com",
  "126.com",
  "hotmail.com",
  "yahoo.com",
  "icloud.com",
  "foxmail.com",
  "protonmail.com",
  "sina.com",
  "sohu.com",
  "yeah.net",
  "vip.qq.com",
  "aliyun.com",
  "139.com",
  "189.cn",
  "21cn.com",
  "tom.com",
  "263.net",
  "me.com",
  "live.com",
  "msn.com",
  "ymail.com",
  "aol.com",
  "chloemlla.com",
];
const ALLOWED_RECIPIENT_PATTERN = new RegExp(`^[\\w.+-]+@(${ALLOWED_RECIPIENT_DOMAINS.map(escapeRegExp).join("|")})$`, "i");

function pushDomainConfig(map: Record<string, string>, domain?: string, key?: string) {
  const safeDomain = normalizeDomain(domain);
  const safeKey = String(key || "").trim();
  if (!safeDomain || !safeKey) return;
  if (RESEND_API_KEY_PATTERN.test(safeKey)) {
    map[safeDomain] = safeKey;
  }
}

function getEmailRuntimeConfig() {
  return RuntimeConfigService.getCachedConfig().email;
}

// 每次配置写入都会替换整个 email 配置对象，故用对象引用做缓存键即可在配置变更时自动失效
let apiKeyMapCacheKey: EmailRuntimeConfig | null = null;
let apiKeyMapCache: Partial<Record<EmailChannel, Record<string, string>>> = {};
const resendClientCache = new Map<string, Resend>();

function buildDomainApiKeyMap(channel: EmailChannel = "primary"): Record<string, string> {
  const runtimeEmail = getEmailRuntimeConfig();
  if (apiKeyMapCacheKey !== runtimeEmail) {
    apiKeyMapCacheKey = runtimeEmail;
    apiKeyMapCache = {};
    resendClientCache.clear();
  }
  const cached = apiKeyMapCache[channel];
  if (cached) return cached;

  const map: Record<string, string> = {};
  if (channel === "primary" && runtimeEmail.enabled) {
    let resendIdx = 1;
    while (true) {
      const domain = process.env[`RESEND_DOMAIN_${resendIdx}`];
      const key = process.env[`RESEND_API_KEY_${resendIdx}`];
      if (!domain || !key) break;
      pushDomainConfig(map, domain, key);
      resendIdx++;
    }
    pushDomainConfig(map, runtimeEmail.resendDomain, runtimeEmail.resendApiKey);
  }
  if (channel === "outemail" && runtimeEmail.outemailEnabled) {
    let outemailIdx = 1;
    while (true) {
      const domain =
        process.env[`OUTEMAIL_DOMAIN_${outemailIdx}`] || process.env[`RESEND_DOMAIN_OUT_${outemailIdx}`];
      const key =
        process.env[`OUTEMAIL_API_KEY_${outemailIdx}`] || process.env[`RESEND_API_OUT_${outemailIdx}`];
      if (!domain || !key) break;
      pushDomainConfig(map, domain, key);
      outemailIdx++;
    }
    pushDomainConfig(map, runtimeEmail.outemailDomain, runtimeEmail.outemailApiKey);
  }

  apiKeyMapCache[channel] = map;
  return map;
}

export function getDefaultEmailFrom(): string {
  const domains = getAllSenderDomains();
  const runtimeEmail = getEmailRuntimeConfig();
  const preferredDomain =
    runtimeEmail.enabled && runtimeEmail.resendDomain && domains.includes(normalizeDomain(runtimeEmail.resendDomain))
      ? runtimeEmail.resendDomain
      : domains[0] || FALLBACK_RESEND_DOMAIN;
  return `noreply@${preferredDomain}`;
}

export function resolveOutEmailDomain(preferredDomain?: string): string {
  const runtimeEmail = getEmailRuntimeConfig();
  return normalizeDomain(preferredDomain) || normalizeDomain(runtimeEmail.outemailDomain) || normalizeDomain(process.env.OUTEMAIL_DOMAIN) || normalizeDomain(process.env.RESEND_DOMAIN_OUT) || normalizeDomain(process.env.RESEND_DOMAIN);
}

export function getOutEmailQuotaTotal(): number {
  return getEmailRuntimeConfig().outemailQuotaTotal;
}

export function getOutEmailCodeFallback(): string {
  return getEmailRuntimeConfig().outemailCode || "";
}

export function getOutEmailServiceStatus(preferredDomain?: string): { available: boolean; error?: string; domain?: string } {
  const runtimeEmail = getEmailRuntimeConfig();
  const domain = resolveOutEmailDomain(preferredDomain);
  if (!runtimeEmail.outemailEnabled) {
    return { available: false, error: "对外邮件服务未启用", domain };
  }
  if (!domain) {
    return { available: false, error: "对外邮件服务未配置域名", domain };
  }
  const domainMap = buildDomainApiKeyMap("outemail");
  if (!domainMap[domain]) {
    return { available: false, error: "未配置有效的对外邮件 API Key（re_ 开头）", domain };
  }
  return { available: true, domain };
}

export function getAllSenderDomains(channel: EmailChannel = "primary"): string[] {
  return Object.keys(buildDomainApiKeyMap(channel));
}

function getResendInstanceByDomain(domain: string, channel: EmailChannel = "primary") {
  const key = buildDomainApiKeyMap(channel)[normalizeDomain(domain)];
  if (!key) throw new Error(`未配置该域名(${domain})的API key`);
  let client = resendClientCache.get(key);
  if (!client) {
    client = new Resend(key);
    resendClientCache.set(key, client);
  }
  return client;
}

function getServiceAvailabilityError(domain?: string, channel: EmailChannel = "primary"): string | undefined {
  const domainMap = buildDomainApiKeyMap(channel);
  if (domain && domainMap[normalizeDomain(domain)]) {
    return undefined;
  }
  if (Object.keys(domainMap).length === 0) {
    return "邮件服务未启用，请联系管理员配置 RESEND_API_KEY";
  }
  return undefined;
}

export class EmailService {
  static buildSenderAddress(fromPrefix?: string, domain?: string, displayName?: string) {
    const availableDomains = getAllSenderDomains();
    const senderDomain = normalizeDomain(domain) || availableDomains[0] || FALLBACK_RESEND_DOMAIN;
    const prefix = String(fromPrefix || "noreply")
      .trim()
      .replace(/[^a-zA-Z0-9._-]/g, "") || "noreply";
    const name = typeof displayName === "string" && displayName.trim().length > 0 ? displayName.trim() : prefix;
    return {
      email: `${prefix}@${senderDomain}`,
      name,
      domain: senderDomain,
    };
  }

  static normalizeAttachments(
    attachments?: EmailAttachmentInput[],
    maxItems = 10,
  ): NormalizedEmailAttachment[] | undefined {
    if (!Array.isArray(attachments) || attachments.length === 0) return undefined;
    const normalized = attachments
      .filter(
        (attachment) =>
          attachment &&
          typeof attachment.filename === "string" &&
          attachment.filename.trim().length > 0 &&
          (typeof attachment.path === "string" ||
            typeof attachment.content === "string" ||
            attachment.content instanceof Buffer),
      )
      .slice(0, maxItems)
      .map((attachment) => ({
        filename: attachment.filename,
        ...(attachment.path ? { path: attachment.path } : {}),
        ...(attachment.content !== undefined ? { content: attachment.content } : {}),
        ...(attachment.contentType ? { contentType: attachment.contentType } : {}),
        ...(attachment.content_id ? { content_id: attachment.content_id } : {}),
      }));

    return normalized.length > 0 ? normalized : undefined;
  }

  static async sendEmail(emailData: EmailData): Promise<EmailResponse> {
    const domain = normalizeDomain(emailData.from.split("@")[1]);
    const availabilityError = getServiceAvailabilityError(domain, emailData.channel);
    if (availabilityError) {
      return { success: false, error: availabilityError };
    }

    const deliverable = await resolveDeliverableRecipients(emailData.to, emailData.purpose);
    if (!deliverable.ok) {
      return { success: false, error: deliverable.error };
    }
    if (deliverable.skipped.length > 0) {
      logger.warn("部分收件地址在抑制名单中，已跳过", { skipped: deliverable.skipped });
    }

    try {
      const domainMap = buildDomainApiKeyMap(emailData.channel);
      if (!domainMap[domain]) {
        return {
          success: false,
          error: `发件人邮箱必须是已配置域名之一，当前域名: ${domain}`,
        };
      }

      const resend = getResendInstanceByDomain(domain, emailData.channel);
      const normalizedAttachments = EmailService.normalizeAttachments(emailData.attachments);

      logger.log("开始发送邮件", {
        from: emailData.from,
        to: deliverable.recipients,
        subject: emailData.subject,
        hasAttachments: !!normalizedAttachments?.length,
      });

      const { data, error } = await resend.emails.send({
        from: emailData.from,
        to: deliverable.recipients,
        subject: emailData.subject,
        html: emailData.html,
        text: emailData.text,
        attachments: normalizedAttachments,
        replyTo: emailData.replyTo,
        headers: emailData.headers,
      });

      if (error) {
        logger.error("邮件发送失败", {
          error: error.message,
          code: (error as any).statusCode,
          details: error,
        });
        return {
          success: false,
          error: error.message || "邮件发送失败",
        };
      }

      logger.log("邮件发送成功", {
        messageId: data?.id,
        acceptedCount: deliverable.recipients.length,
        acceptedRecipients: deliverable.recipients,
        from: emailData.from,
        to: deliverable.recipients,
        subject: emailData.subject,
      });

      return {
        success: true,
        data,
        messageId: data?.id,
        acceptedCount: deliverable.recipients.length,
        acceptedRecipients: deliverable.recipients,
      };
    } catch (error: any) {
      const errorMessage = error instanceof Error ? error.message : "未知错误";
      logger.error("邮件发送异常", {
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
      });
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  static async sendBatchEmail(batchEmailData: BatchEmailData): Promise<EmailResponse & { ids?: string[] }> {
    const domain = normalizeDomain(batchEmailData.from.split("@")[1]);
    const availabilityError = getServiceAvailabilityError(domain, batchEmailData.channel);
    if (availabilityError) {
      return { success: false, error: availabilityError };
    }

    const safeMessages = batchEmailData.messages;
    if (!Array.isArray(safeMessages) || safeMessages.some((message) => !message || !Array.isArray(message.to) || !message.to.length || message.to.some((to) => !normalizeEmail(to)))) {
      return { success: false, error: "消息包含无效的收件人邮箱地址" };
    }
    if (safeMessages.length === 0) return { success: false, error: "消息列表不能为空" };
    if (safeMessages.length > 100) return { success: false, error: "单次最多批量发送100封" };

    // EM-4: 逐条过滤抑制名单；整条收件人全被抑制则丢弃该条，而不是发空收件人。
    const deliverableMessages: typeof safeMessages = [];
    const acceptedMessages: NonNullable<EmailResponse["acceptedMessages"]> = [];
    let suppressedCount = 0;
    for (const [index, message] of safeMessages.entries()) {
      const deliverable = await resolveDeliverableRecipients(message.to, batchEmailData.purpose);
      if (!deliverable.ok) {
        suppressedCount += 1;
        continue;
      }
      suppressedCount += deliverable.skipped.length;
      deliverableMessages.push({ ...message, to: deliverable.recipients });
      acceptedMessages.push({ index, to: deliverable.recipients });
    }
    if (suppressedCount > 0) {
      logger.warn("批量发送中部分收件地址被抑制", { suppressedCount, remaining: deliverableMessages.length });
    }
    if (deliverableMessages.length === 0) {
      return { success: false, error: "收件地址均已在退订/退信抑制名单中，已阻止发送" };
    }

    const domainMap = buildDomainApiKeyMap(batchEmailData.channel);
    if (!domainMap[domain]) {
      return {
        success: false,
        error: `发件人邮箱必须是已配置域名之一，当前域名: ${domain}`,
      };
    }

    try {
      const resend = getResendInstanceByDomain(domain, batchEmailData.channel);
      const hasAttachments = deliverableMessages.some((message) => (message.attachments || []).length > 0);
      if (hasAttachments) {
        return { success: false, error: "批量发送暂不支持附件" };
      }

      const batch = deliverableMessages.map((message) => ({
        from: batchEmailData.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        replyTo: message.replyTo,
        headers: message.headers,
      }));

      const { data, error } = await resend.batch.send(batch);
      if (error) {
        logger.error("批量邮件发送失败", { error });
        return { success: false, error: error.message || String(error) };
      }

      const ids = data?.data.map((item) => item.id);
      logger.log("批量邮件发送成功", {
        from: batchEmailData.from,
        count: deliverableMessages.length,
        ids,
      });
      return { success: true, data, ids, acceptedMessages, acceptedCount: acceptedMessages.reduce((count, message) => count + message.to.length, 0) };
    } catch (error: any) {
      logger.error("批量邮件发送异常", {
        error: error?.message || "未知错误",
        stack: error?.stack,
      });
      return { success: false, error: error?.message || "批量发送失败" };
    }
  }

  static async sendSimpleEmail(to: string[], subject: string, content: string, from?: string): Promise<EmailResponse> {
    return EmailService.sendEmail({
      from: from || getDefaultEmailFrom(),
      to,
      subject,
      html: `<div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;"><p>${content.replace(/\n/g, "<br>")}</p></div>`,
      text: content,
    });
  }

  static async sendHtmlEmail(to: string[], subject: string, htmlContent: string, from?: string, purpose?: EmailPurpose): Promise<EmailResponse> {
    return EmailService.sendEmail({
      from: from || getDefaultEmailFrom(),
      to,
      subject,
      html: htmlContent,
      purpose,
    });
  }

  static async sendBatchHtmlEmails(
    to: string[],
    subject: string,
    htmlContent: string,
    from?: string,
  ): Promise<EmailResponse & { ids?: string[] }> {
    const safeTo = (to || []).map((item) => String(item).trim()).filter(Boolean);
    return EmailService.sendBatchEmail({
      from: from || getDefaultEmailFrom(),
      messages: safeTo.map((recipient) => ({
        to: [recipient],
        subject,
        html: htmlContent,
      })),
    });
  }

  static async sendMarkdownEmail({
    from,
    to,
    subject,
    markdown,
  }: {
    from: string;
    to: string[];
    subject: string;
    markdown: string;
  }): Promise<EmailResponse> {
    const html = await renderMarkdown(markdown || "");
    return EmailService.sendEmail({ from, to, subject, html, text: markdown });
  }

  static isValidEmail(email: string): boolean {
    return ALLOWED_RECIPIENT_PATTERN.test(email);
  }

  static isValidSenderDomain(email: string, channel: EmailChannel = "primary"): boolean {
    const domain = normalizeDomain(email.split("@")[1]);
    return Boolean(domain && buildDomainApiKeyMap(channel)[domain]);
  }

  static validateEmails(emails: string[]): { valid: string[]; invalid: string[] } {
    const valid: string[] = [];
    const invalid: string[] = [];

    emails.forEach((email) => {
      if (EmailService.isValidEmail(email.trim())) {
        valid.push(email.trim());
      } else {
        invalid.push(email);
      }
    });

    return { valid, invalid };
  }

  static async getServiceStatus(): Promise<{ available: boolean; error?: string }> {
    const keys = Object.values(buildDomainApiKeyMap());
    const key = keys.find((value) => RESEND_API_KEY_PATTERN.test(value));
    if (!key) {
      return { available: false, error: "未配置有效的邮件API密钥（re_ 开头）" };
    }
    return { available: true };
  }
}
