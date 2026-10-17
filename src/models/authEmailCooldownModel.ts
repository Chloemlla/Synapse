import { mongoose } from "../services/mongoService";

interface AuthEmailCooldown {
  _id: string;
  reservationId: string;
  expiresAt: Date;
}

// 仅保存用途与规范化邮箱的摘要，不额外复制邮箱或验证码。
const schema = new mongoose.Schema<AuthEmailCooldown>({
  _id: { type: String, required: true },
  reservationId: { type: String, required: true },
  expiresAt: { type: Date, required: true },
}, { collection: "auth_email_cooldowns", versionKey: false });
// 查询索引（**不是 TTL**）：过期预约由 legalHoldCleanupService 清理（裁决三 / D8）。
schema.index({ expiresAt: 1 });

export const AuthEmailCooldownModel =
  (mongoose.models.AuthEmailCooldown as mongoose.Model<AuthEmailCooldown>) ||
  mongoose.model<AuthEmailCooldown>("AuthEmailCooldown", schema);
