import { mongoose } from "../services/mongoService";

/**
 * 人机验证供应商的按月用量计数。
 *
 * 与 proxycheck 的 `proxycheck_daily_quotas` 同构，只是切分粒度从「日」改成「月」：
 * hCaptcha 免费额度是按月给的，用日切会把额度算错（月中重置 → 超发）。
 * monthKey 采用 Asia/Shanghai 的 `YYYY-MM`，与前端展示的「本月」一致。
 */
export interface CaptchaQuotaDoc {
  provider: string;
  monthKey: string;
  count: number;
  exhaustedAt?: Date;
  lastUsedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const CaptchaQuotaSchema = new mongoose.Schema<CaptchaQuotaDoc>(
  {
    provider: { type: String, required: true },
    monthKey: { type: String, required: true },
    count: { type: Number, required: true, default: 0 },
    exhaustedAt: { type: Date, default: undefined },
    lastUsedAt: { type: Date, default: undefined },
  },
  {
    collection: "captcha_monthly_quotas",
    timestamps: true,
  },
);

// 复合唯一索引同时充当 provider/monthKey 前缀索引，不再单独建索引。
CaptchaQuotaSchema.index({ provider: 1, monthKey: 1 }, { unique: true });

export const CaptchaQuotaModel =
  (mongoose.models.CaptchaQuota as mongoose.Model<CaptchaQuotaDoc>) ||
  mongoose.model<CaptchaQuotaDoc>("CaptchaQuota", CaptchaQuotaSchema);
