import { mongoose } from "../services/mongoService";

/**
 * 邮件抑制名单（EM-1 / EM-2）。
 *
 * 为什么必须有：`email.bounced` / `email.complained` 事件如果只落 `webhook_events`，
 * 后续发送仍会打到同一地址——既拉低发件域声誉，也没有真正的退订落地。本集合是发送前
 * 的唯一判据，命中即拒发。
 *
 * 数据最小化：只存规范化后的邮箱 + 原因 + 来源 + 时间，不存邮件正文、不存 IP。
 */

export type EmailSuppressionReason = "bounce" | "complaint" | "unsubscribe" | "manual";

export interface EmailSuppressionDoc {
  /** 规范化（trim + toLowerCase）后的邮箱，主判据。 */
  email: string;
  reason: EmailSuppressionReason;
  /** 写入来源：resend-webhook / admin / user-unsubscribe / system。 */
  source: string;
  /** 可读备注（不含正文），例如退信的 smtp 状态码。 */
  detail?: string;
  /** null 表示永久抑制；软退信可给一个到期时间。 */
  expiresAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const EmailSuppressionSchema = new mongoose.Schema<EmailSuppressionDoc>(
  {
    email: { type: String, required: true, unique: true, index: true },
    reason: {
      type: String,
      required: true,
      enum: ["bounce", "complaint", "unsubscribe", "manual"],
      index: true,
    },
    source: { type: String, default: "system" },
    detail: { type: String, default: "" },
    expiresAt: { type: Date, default: null },
  },
  { collection: "email_suppressions", timestamps: true },
);

// 常用查询：按原因 + 时间倒序列举；以及到期清扫。
EmailSuppressionSchema.index({ reason: 1, createdAt: -1 });
EmailSuppressionSchema.index({ expiresAt: 1 });

export const EmailSuppressionModel =
  (mongoose.models.EmailSuppression as mongoose.Model<EmailSuppressionDoc>) ||
  mongoose.model<EmailSuppressionDoc>("EmailSuppression", EmailSuppressionSchema);
