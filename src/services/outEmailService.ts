import crypto from "node:crypto";
import { logger } from "./logger";
import { mongoose } from "./mongoService";
import {
  EmailService,
  getOutEmailCodeFallback,
  getOutEmailServiceStatus,
  resolveOutEmailDomain,
  type EmailAttachmentInput,
} from "./emailService";
import { getPublicEmailQuota, reservePublicEmailQuota, settleEmailQuota, refundEmailQuota, type EmailQuotaResult } from "./emailQuotaService";
import { plainTextifyHtmlContent } from "./htmlToPlainText";
import { containsHtmlTag } from "./outEmailHtmlProbe";
import { sanitizeEmailHtml } from "../utils/announcementHtml";
import { recordUsage, validateApiKey } from "./apiKeyService";
import { UserStorage } from "../utils/userStorage";
import {
  getEmailTraceRecordById,
  getEmailTraceRecords,
  recordEmailTraces,
} from "./emailTraceService";

// 溯源记录的模型/查询定义在 emailTraceService：内部发信与对外发信共用同一个集合。
// 这里保留同名导出，路由与既有测试不需要跟着改 import。
export const getOutEmailRecords = getEmailTraceRecords;
export const getOutEmailRecordById = getEmailTraceRecordById;

/**
 * 构造出站邮件的 text/plain 与 text/html 两份正文。
 * - text：始终用 plainTextifyHtmlContent 的纯文本（作为 text/plain 回退）。
 * - html：原文含 HTML 时，用 DOMPurify 净化后**保留排版**（修复旧逻辑把 HTML
 *   剪成纯文本再当 html 发送、丢失全部样式的 bug）；纯文本则沿用带 <br> 的转义兜底。
 */
function buildEmailBodies(content: unknown): { text: string; html: string } {
  const raw = String(content ?? "");
  const { text, html: plainHtml } = plainTextifyHtmlContent(raw);
  if (!containsHtmlTag(raw)) {
    return { text, html: plainHtml };
  }
  const sanitized = sanitizeEmailHtml(raw);
  // 净化后若为空（原文只有不允许的标签），回退到纯文本 html，避免发出空正文。
  const html = sanitized.trim() ? sanitized : plainHtml;
  return { text, html };
}

interface OutEmailSettingDoc {
  domain: string;
  code?: string;
  apiKey?: string;
  updatedAt?: Date;
}

const OutEmailSettingSchema = new mongoose.Schema<OutEmailSettingDoc>(
  {
    domain: { type: String, default: "" },
    code: { type: String, default: "" },
    apiKey: { type: String, default: "" },
    updatedAt: { type: Date, default: Date.now },
  },
  { collection: "outemail_settings" },
);

const OutEmailSetting =
  (mongoose.models.OutEmailSetting as mongoose.Model<OutEmailSettingDoc>) ||
  mongoose.model<OutEmailSettingDoc>("OutEmailSetting", OutEmailSettingSchema);

// ---- G6-07 出站邮件净化辅助 ----
// 对外邮件是带本域 DKIM/SPF 的发送通道，禁止把调用方提交的任意 HTML/富文本
// 直接转发，也禁止未校验收件人/未净化 display-name 的地址列表注入。

const BASIC_EMAIL_RE = /^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/;

function stripControlChars(value: unknown): string {
  return String(value ?? "")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim();
}

function sanitizeRecipient(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 320 || !BASIC_EMAIL_RE.test(trimmed)) return null;
  return trimmed;
}

function sanitizeDisplayName(name: string): string {
  // RFC 5322 display-name 里不允许的字符直接剔除，防止回信落到攻击者邮箱。
  return String(name || "")
    .replace(/[<>",;:()@[\]\\]/g, "")
    .trim();
}

export interface OutEmailQuotaInfo {
  used: number;
  total: number;
  resetAt: string;
}

function normalizeAuthSecret(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function timingSafeSecretEqual(candidate: unknown, expected: unknown): boolean {
  const left = normalizeAuthSecret(candidate);
  const right = normalizeAuthSecret(expected);
  if (!left || !right) return false;

  // Shared API secrets are compared directly in constant time. These are not password hashes.
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  if (leftBytes.length !== rightBytes.length) {
    crypto.timingSafeEqual(leftBytes, leftBytes);
    return false;
  }
  return crypto.timingSafeEqual(leftBytes, rightBytes);
}

async function getOutEmailAuthSettingFromDb(domain?: string): Promise<OutEmailSettingDoc | null> {
  try {
    const domainKey = typeof domain === "string" ? domain.trim().toLowerCase() : "";
    let doc = (await OutEmailSetting.findOne({ domain: domainKey }).lean().exec()) as OutEmailSettingDoc | null;
    if ((!doc || (!normalizeAuthSecret(doc.code) && !normalizeAuthSecret(doc.apiKey))) && domainKey) {
      doc = (await OutEmailSetting.findOne({ domain: "" }).lean().exec()) as OutEmailSettingDoc | null;
    }
    return doc;
  } catch (error) {
    logger.error("读取对外邮件鉴权配置失败", { error: (error as any)?.message });
    return null;
  }
}

export type OutEmailAuthSuccess = {
  success: true;
  authKind: "outemail-setting" | "outemail-code" | "platform-api-key";
  keyId?: string;
  userId?: string;
};

export type OutEmailAuthFailure = {
  success: false;
  error: string;
};

export type OutEmailAuthResult = OutEmailAuthSuccess | OutEmailAuthFailure;

/**
 * 校验对外邮件鉴权，顺序：
 * 1. EnvManager / outemail_settings 外部 API Key
 * 2. 兼容校验码 code（DB 或 OUTEMAIL_CODE 回退）
 * 3. 平台 API Key（admin?tab=apikeys 创建，需 outemail 或 * 权限）
 */
async function tryValidatePlatformOutemailApiKey(
  plainKey: string,
  ip?: string,
): Promise<OutEmailAuthResult> {
  try {
    const doc = await validateApiKey(plainKey);
    if (!doc) {
      return { success: false, error: "鉴权失败" };
    }

    if (!doc.permissions.includes("outemail") && !doc.permissions.includes("*")) {
      return { success: false, error: '此 API Key 无 "outemail" 权限' };
    }

    const owner = await UserStorage.getUserById(doc.userId);
    if (!owner) {
      return { success: false, error: "API Key 所属用户不存在" };
    }
    if ((owner as any).disabled || (owner as any).accountStatus === "suspended") {
      return { success: false, error: "API Key 所属账户不可用" };
    }

    if (ip) {
      recordUsage(doc.keyId, ip).catch(() => {});
    }

    return {
      success: true,
      authKind: "platform-api-key",
      keyId: doc.keyId,
      userId: doc.userId,
    };
  } catch (error) {
    logger.error("验证平台 API Key（outemail）失败", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { success: false, error: "鉴权失败" };
  }
}

export async function ensureOutEmailAuth({
  code,
  apiKey,
  domain,
  ip,
}: {
  code?: string;
  apiKey?: string;
  domain: string;
  ip?: string;
}): Promise<OutEmailAuthResult> {
  const presentedApiKey = normalizeAuthSecret(apiKey);
  const presentedCode = normalizeAuthSecret(code);

  if (!presentedApiKey && !presentedCode) {
    return { success: false, error: "缺少鉴权信息" };
  }

  const dbSetting = await getOutEmailAuthSettingFromDb(domain);
  const dbCode = normalizeAuthSecret(dbSetting?.code);
  const dbApiKey = normalizeAuthSecret(dbSetting?.apiKey);
  const fallbackCode = getOutEmailCodeFallback();
  const expectedCode = dbCode || fallbackCode;

  // 1) EnvManager / Mongo outemail_settings 外部 Key（明文比对，保持原行为）
  if (dbApiKey && presentedApiKey && timingSafeSecretEqual(presentedApiKey, dbApiKey)) {
    return { success: true, authKind: "outemail-setting" };
  }

  // 2) 兼容校验码（body.code）
  if (expectedCode && presentedCode && timingSafeSecretEqual(presentedCode, expectedCode)) {
    return { success: true, authKind: "outemail-code" };
  }

  // 3) 平台 API Key（admin apikeys 创建，带 outemail/* 权限）
  if (presentedApiKey) {
    return tryValidatePlatformOutemailApiKey(presentedApiKey, ip);
  }

  // 仅传了 code 且未匹配
  if (!dbApiKey && !expectedCode) {
    // code 字段不接受平台 API Key；若外部鉴权也未配置则提示未配置
    return { success: false, error: "对外邮件鉴权未配置" };
  }

  return { success: false, error: "鉴权失败" };
}

function buildPublicSender(fromUser: string | undefined, displayName: string | undefined, domain: string) {
  // display-name 必须按 RFC 5322 净化后再进 replyTo / X-From-Name，防止地址列表注入。
  const safeName = sanitizeDisplayName(String(displayName || ""));
  return EmailService.buildSenderAddress(fromUser || "noreply", domain, safeName || undefined);
}

export async function getOutEmailQuota(): Promise<OutEmailQuotaInfo> {
  return getPublicEmailQuota();
}

export interface OutEmailFailure {
  success: false;
  error: string;
  code: "INVALID_EMAIL_REQUEST" | "EMAIL_AUTH_FAILED" | "EMAIL_QUOTA_EXCEEDED" | "EMAIL_RATE_LIMITED" | "EMAIL_SERVICE_UNAVAILABLE" | "EMAIL_SEND_FAILED";
  statusCode: number;
  retryAfterSeconds?: number;
}

export type OutEmailSendResult = OutEmailFailure | {
  success: true;
  messageId?: string;
  ids?: string[];
  acceptedCount: number;
};

function failure(error: string, code: OutEmailFailure["code"] = "INVALID_EMAIL_REQUEST", statusCode = 400, retryAfterSeconds?: number): OutEmailFailure {
  return { success: false, error, code, statusCode, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) };
}

function quotaFailure(result: Extract<EmailQuotaResult, { success: false }>): OutEmailFailure {
  if (result.reason === "unavailable") return failure("邮件服务暂时不可用，请稍后重试", "EMAIL_SERVICE_UNAVAILABLE", 503);
  if (result.reason === "invalid") return failure("收件人数无效");
  return result.reason === "rate_limited"
    ? failure("发送过于频繁，单次最多发送20个收件人，请稍后重试", "EMAIL_RATE_LIMITED", 429, result.retryAfterSeconds)
    : failure("今日邮件发送额度不足", "EMAIL_QUOTA_EXCEEDED", 429, result.retryAfterSeconds);
}

export async function getOutEmailAuthStatus(domain?: string): Promise<{
  configured: boolean;
  hasApiKey: boolean;
  hasCode: boolean;
  platformApiKeySupported: boolean;
}> {
  const dbSetting = await getOutEmailAuthSettingFromDb(domain);
  const hasApiKey = Boolean(normalizeAuthSecret(dbSetting?.apiKey));
  const hasCode = Boolean(normalizeAuthSecret(dbSetting?.code) || getOutEmailCodeFallback());
  // 平台 API Key（admin apikeys + outemail 权限）始终可作为鉴权方式
  const platformApiKeySupported = true;
  return {
    configured: hasApiKey || hasCode || platformApiKeySupported,
    hasApiKey,
    hasCode,
    platformApiKeySupported,
  };
}

export async function sendOutEmailBatch({
  messages, code, apiKey, ip, from: fromUser, displayName, domain,
}: {
  messages: Array<{ to: string | string[]; subject: string; content: string }>;
  code?: string;
  apiKey?: string;
  ip: string;
  from?: string;
  displayName?: string;
  domain?: string;
}): Promise<OutEmailSendResult> {
  const status = getOutEmailServiceStatus(domain);
  if (!status.available) return failure(status.error || "对外邮件服务不可用", "EMAIL_SERVICE_UNAVAILABLE", 503);
  if (!Array.isArray(messages) || !messages.length || messages.length > 100) {
    return failure("消息列表必须包含1至100条消息");
  }
  const outemailDomain = resolveOutEmailDomain(domain);
  if (!EmailService.isValidSenderDomain(`noreply@${outemailDomain}`, "outemail")) return failure("发件域名不可用");
  const authResult = await ensureOutEmailAuth({ code, apiKey, domain: outemailDomain, ip });
  if (!authResult.success) return failure(authResult.error, "EMAIL_AUTH_FAILED", 401);

  // Validate every target before reserving quota: never silently discard malformed addresses.
  const prepared: Array<{ to: string[]; subject: string; text: string; html: string }> = [];
  try {
    for (const message of messages) {
      if (!message || typeof message.subject !== "string" || typeof message.content !== "string") return failure("消息内容格式无效");
      const rawRecipients = Array.isArray(message.to) ? message.to : [message.to];
      const recipients = rawRecipients.map(sanitizeRecipient);
      if (!recipients.length || recipients.some((recipient) => recipient === null)) return failure("消息包含无效的收件人邮箱地址");
      const to = [...new Set((recipients as string[]).map((recipient) => recipient.toLowerCase()))];
      prepared.push({ to, subject: stripControlChars(message.subject) || "(无主题)", ...buildEmailBodies(message.content) });
    }
  } catch (error) {
    logger.error("对外邮件正文处理失败", { error });
    return failure("邮件内容无法处理");
  }
  const requestedCount = prepared.reduce((count, message) => count + message.to.length, 0);
  const quota = await reservePublicEmailQuota(requestedCount);
  if (!quota.success) return quotaFailure(quota);

  let result: Awaited<ReturnType<typeof EmailService.sendBatchEmail>>;
  try {
    const sender = buildPublicSender(fromUser, displayName, outemailDomain);
    result = await EmailService.sendBatchEmail({
      channel: "outemail",
      from: sender.email,
      messages: prepared.map((message) => ({
        ...message,
        ...(sender.name && sender.name !== (fromUser || "")
          ? { replyTo: `${sender.name} <${sender.email}>`, headers: { "X-From-Name": sender.name } }
          : {}),
      })),
    });
  } catch (error) {
    await refundEmailQuota(quota.reservation);
    logger.error("对外批量邮件发送异常", { error });
    return failure("邮件发送失败，请稍后重试", "EMAIL_SEND_FAILED", 502);
  }
  if (!result.success) {
    await refundEmailQuota(quota.reservation);
    return failure("邮件发送失败，请稍后重试", "EMAIL_SEND_FAILED", 502);
  }
  const acceptedCount = result.acceptedCount ?? requestedCount;
  await settleEmailQuota(quota.reservation, acceptedCount);
  // Provider acceptance is the send result. History persistence cannot undo delivery
  // (recordEmailTraces 自身吞掉写入异常，只记日志).
  const acceptedMessages = result.acceptedMessages ?? prepared.map((message, index) => ({ index, to: message.to }));
  await recordEmailTraces(
    acceptedMessages.map(({ index, to }) => ({
      channel: "outemail",
      to,
      subject: prepared[index].subject,
      content: messages[index].content,
      ip,
    })),
  );
  return { success: true, ids: result.ids, acceptedCount };
}

export async function sendOutEmail({
  to, subject, content, code, apiKey, ip, from: fromUser, displayName, domain, attachments,
}: {
  to: string;
  subject: string;
  content: string;
  code?: string;
  apiKey?: string;
  ip: string;
  from?: string;
  displayName?: string;
  domain?: string;
  attachments?: EmailAttachmentInput[];
}): Promise<OutEmailSendResult> {
  const status = getOutEmailServiceStatus(domain);
  if (!status.available) return failure(status.error || "对外邮件服务不可用", "EMAIL_SERVICE_UNAVAILABLE", 503);
  const outemailDomain = resolveOutEmailDomain(domain);
  if (!EmailService.isValidSenderDomain(`noreply@${outemailDomain}`, "outemail")) return failure("发件域名不可用");
  const recipient = sanitizeRecipient(to);
  if (!recipient || typeof subject !== "string" || typeof content !== "string") return failure("收件人或邮件内容格式无效");
  const authResult = await ensureOutEmailAuth({ code, apiKey, domain: outemailDomain, ip });
  if (!authResult.success) return failure(authResult.error, "EMAIL_AUTH_FAILED", 401);
  let bodies: ReturnType<typeof buildEmailBodies>;
  try {
    bodies = buildEmailBodies(content);
  } catch (error) {
    logger.error("对外邮件正文处理失败", { error });
    return failure("邮件内容无法处理");
  }
  const quota = await reservePublicEmailQuota(1);
  if (!quota.success) return quotaFailure(quota);
  let result: Awaited<ReturnType<typeof EmailService.sendEmail>>;
  try {
    const sender = buildPublicSender(fromUser, displayName, outemailDomain);
    result = await EmailService.sendEmail({
      channel: "outemail",
      from: sender.email,
      to: [recipient],
      subject: stripControlChars(subject) || "(无主题)",
      ...bodies,
      attachments: EmailService.normalizeAttachments(attachments),
      ...(sender.name && sender.name !== (fromUser || "")
        ? { replyTo: `${sender.name} <${sender.email}>`, headers: { "X-From-Name": sender.name } }
        : {}),
    });
  } catch (error) {
    await refundEmailQuota(quota.reservation);
    logger.error("对外邮件发送异常", { error });
    return failure("邮件发送失败，请稍后重试", "EMAIL_SEND_FAILED", 502);
  }
  if (!result.success) {
    await refundEmailQuota(quota.reservation);
    return failure("邮件发送失败，请稍后重试", "EMAIL_SEND_FAILED", 502);
  }
  const acceptedCount = result.acceptedCount ?? 1;
  await settleEmailQuota(quota.reservation, acceptedCount);
  // 同样走旁路写入：记录失败不改变「已发出」的结果。
  await recordEmailTraces([{
    channel: "outemail",
    to: result.acceptedRecipients?.[0] || recipient,
    subject: stripControlChars(subject),
    content,
    ip,
  }]);
  return { success: true, messageId: result.messageId, acceptedCount };
}
