import { mongoose } from "../services/mongoService";

/**
 * 配额事件台账（RC-28）。
 *
 * 为什么单独建集合而不是塞进 `security_events`：余额预警是**计费/运营**信号，
 * 与账户风险事件的查询面、保留期、权限都不一样（安全事件 90 天、这里 180 天）；
 * 混在一起会让「按用户查风险事件」被大量计费噪声淹没。
 *
 * 去重契约：`(scope, keyId, resource, threshold, periodKey, cycle)` 唯一。
 * - `threshold` 取 0.8 / 1.0；
 * - `periodKey` 是上海账期（日预算 `YYYY-MM-DD`、月预算/Key 预算 `YYYY-MM`）；
 * - `cycle` 是 Key 的预算周期序号（每次充值 +1）——没有它，「充值后再次花掉 80%」
 *   会被账期去重吞掉，用户永远收不到第二次预警。
 *
 * TTL 180 天：超过半年的「当时为什么发过预警」已不影响客服判断，留档足够。
 */
export type QuotaEventScope = "key" | "account" | "upstream";

export interface QuotaEventDoc {
  scope: QuotaEventScope;
  /** Key 维度事件的 keyId；账户/上游维度为空串（不用 null，方便建唯一索引）。 */
  keyId: string;
  userId: string;
  /** `api-key-balance` / `account-daily-budget` / `account-monthly-budget` / `upstream-quota`。 */
  resource: string;
  /** 0.8 / 1.0（不允许用百分数，避免 80 与 0.8 两套口径并存）。 */
  threshold: number;
  periodKey: string;
  cycle: number;
  /** 稳定 code，供前端/告警区分「你的额度不够」与「平台上游额度不够」。 */
  code: string;
  detail: Record<string, unknown>;
  createdAt: Date;
}

const QuotaEventSchema = new mongoose.Schema<QuotaEventDoc>(
  {
    scope: { type: String, enum: ["key", "account", "upstream"], required: true, index: true },
    keyId: { type: String, default: "" },
    userId: { type: String, default: "", index: true },
    resource: { type: String, required: true },
    threshold: { type: Number, required: true },
    periodKey: { type: String, required: true },
    cycle: { type: Number, default: 0 },
    code: { type: String, required: true },
    detail: { type: mongoose.Schema.Types.Mixed, default: {} },
    createdAt: { type: Date, default: Date.now },
  },
  { collection: "quota_events", timestamps: false },
);

// 去重键本体：并发请求各自 upsert，唯一索引保证「一条只写一次」。
QuotaEventSchema.index(
  { scope: 1, keyId: 1, resource: 1, threshold: 1, periodKey: 1, cycle: 1 },
  { unique: true },
);
QuotaEventSchema.index({ userId: 1, createdAt: -1 });
QuotaEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

export const QuotaEventModel =
  (mongoose.models.QuotaEvent as mongoose.Model<QuotaEventDoc>) ||
  mongoose.model<QuotaEventDoc>("QuotaEvent", QuotaEventSchema);
