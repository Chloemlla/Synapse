import { mongoose } from "./mongoService";
import { logger } from "./logger";
import { escapeRegexLiteral } from "../utils/regexEscape";

/**
 * 邮件发信溯源记录（`outemail_records`）。
 *
 * 两个来源共用同一集合：
 * - `internal`：系统内部发信（密码重置、邮箱验证、通知、管理端手动发信等），
 *   走 `EmailService` 的 primary 通道；
 * - `outemail`：对外发信 API（`/api/outemail/**`）。
 *
 * 历史文档没有 `channel` 字段，统一按 `outemail` 解释，避免老记录在筛选里消失。
 */
export type EmailTraceChannel = "internal" | "outemail";

export interface EmailTraceRecordInput {
  channel: EmailTraceChannel;
  /** 收件人；多收件人按与历史记录一致的方式用逗号拼接后落库。 */
  to: string | string[];
  subject: string;
  content: string;
  ip?: string;
}

export interface EmailTraceListParams {
  page?: number;
  pageSize?: number;
  to?: string;
  subject?: string;
  channel?: string;
  startDate?: string;
  endDate?: string;
}

export interface EmailTraceListItem {
  _id: string;
  to: string;
  subject: string;
  content: string;
  sentAt: Date;
  ip: string;
  channel: EmailTraceChannel;
}

const EmailTraceRecordSchema = new mongoose.Schema(
  {
    to: String,
    subject: String,
    content: String,
    sentAt: { type: Date, default: Date.now },
    ip: String,
    // 老文档无此字段：默认按对外发信处理。
    channel: { type: String, default: "outemail" },
  },
  { collection: "outemail_records" },
);
EmailTraceRecordSchema.index({ sentAt: -1 });
EmailTraceRecordSchema.index({ channel: 1, sentAt: -1 });

const EmailTraceRecord =
  mongoose.models.OutEmailRecord ||
  mongoose.model("OutEmailRecord", EmailTraceRecordSchema);

function normalizeChannel(value: unknown): EmailTraceChannel {
  return value === "internal" ? "internal" : "outemail";
}

function normalizeRecipients(to: string | string[]): string {
  return Array.isArray(to) ? to.join(",") : String(to ?? "");
}

/**
 * 批量写入溯源记录。
 *
 * 溯源是旁路：调用方已确认供应商受理，记录写入失败只能记日志，绝不能反过来
 * 把「已发出」的报告成失败（否则会诱导调用方重试并重复投递）。
 */
export async function recordEmailTraces(records: EmailTraceRecordInput[]): Promise<void> {
  if (!records.length) return;
  // 单测与 Mongo 未连接（启动早期/连接中断）时直接跳过：不让旁路写入排队阻塞发送。
  if (mongoose.connection?.readyState !== 1) return;
  try {
    await EmailTraceRecord.insertMany(
      records.map((record) => ({
        to: normalizeRecipients(record.to),
        subject: String(record.subject ?? ""),
        content: String(record.content ?? ""),
        ip: record.ip || "",
        channel: record.channel,
      })),
    );
  } catch (error) {
    logger.error("邮件发信记录保存失败（不影响发送结果）", {
      error: (error as any)?.message,
      count: records.length,
      channels: [...new Set(records.map((record) => record.channel))],
    });
  }
}

export async function getEmailTraceRecords(params: EmailTraceListParams): Promise<{
  records: EmailTraceListItem[];
  total: number;
  page: number;
  pageSize: number;
}> {
  const page = Math.max(1, params.page || 1);
  const pageSize = Math.min(100, Math.max(1, params.pageSize || 20));
  const filter: Record<string, any> = {};

  // `to` / `subject` 是运营手输的关键词：不转义的话 `.`/`*` 会变成通配符（搜出来的记录与
  // 关键词不符），病态模式还能触发 Mongo 侧灾难性回溯。
  if (params.to) {
    filter.to = { $regex: escapeRegexLiteral(params.to), $options: "i" };
  }
  if (params.subject) {
    filter.subject = { $regex: escapeRegexLiteral(params.subject), $options: "i" };
  }
  if (params.channel === "internal") {
    filter.channel = "internal";
  } else if (params.channel === "outemail") {
    // 老记录没有 channel 字段，它们都来自对外发信通道。
    filter.channel = { $ne: "internal" };
  }
  if (params.startDate || params.endDate) {
    filter.sentAt = {};
    if (params.startDate) filter.sentAt.$gte = new Date(params.startDate);
    if (params.endDate) filter.sentAt.$lte = new Date(params.endDate);
  }

  try {
    const [records, total] = await Promise.all([
      EmailTraceRecord.find(filter)
        .sort({ sentAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean()
        .exec(),
      EmailTraceRecord.countDocuments(filter),
    ]);
    return {
      records: records.map((record: any) => ({
        _id: String(record._id),
        to: record.to || "",
        subject: record.subject || "",
        content: (record.content || "").substring(0, 200),
        sentAt: record.sentAt || new Date(),
        ip: record.ip || "",
        channel: normalizeChannel(record.channel),
      })),
      total,
      page,
      pageSize,
    };
  } catch (error) {
    logger.error("查询邮件发信记录失败", { error: (error as any)?.message });
    return { records: [], total: 0, page, pageSize };
  }
}

export async function getEmailTraceRecordById(id: string): Promise<EmailTraceListItem | null> {
  const record = await EmailTraceRecord.findById(id).lean().exec();
  if (!record) return null;
  const doc = record as any;
  return {
    _id: String(doc._id),
    to: doc.to || "",
    subject: doc.subject || "",
    content: doc.content || "",
    sentAt: doc.sentAt || new Date(),
    ip: doc.ip || "",
    channel: normalizeChannel(doc.channel),
  };
}
