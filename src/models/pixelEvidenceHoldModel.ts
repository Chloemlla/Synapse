import mongoose, { type Document, Schema } from "mongoose";

// 法律保全快照（PRD 6.1 框架下的「收到法律程序 → 冻结清理」）。
//
// 为什么是**快照**而不是「给主表加标记」：
//   · pixel_usage_logs 靠 TTL 索引按 createdAt 到期自动清理，TTL 是 MongoDB 的物理行为，
//     没有任何条件能挡住它 —— 加个 held 字段，记录照样会被 TTL 删掉，等于保全失败；
//   · 快照集合**没有 TTL**（解除保全后才写 purgeAfter 开始计时），因此证据必然留得住。
//
// 快照里只有「按披露目的已经收集」的数据：任务归属与脱敏溯源（遮罩卡密、账号数、
// 上游状态、耗时）。账号内容不在这里 —— 它本来就不落库，保全也不会凭空产生它。
export interface IPixelEvidenceHold extends Document {
  holdId: string;
  /** 被保全的 Synapse 账号（与 legal_holds 的 scope=user/value=userId 对应）。 */
  userId: string;
  caseRef: string;
  legalBasis: string;
  reason: string;
  issuedByUserId: string;
  issuedByUsername: string;
  issuedAt: Date;
  /** 任务归属的快照。 */
  taskAccess: Array<Record<string, unknown>>;
  /** 脱敏溯源的快照。 */
  usageLogs: Array<Record<string, unknown>>;
  /** 行数超过上限时为 true，管理员需要知道快照不是全量。 */
  truncated: boolean;
  /** 快照行数（列表视图不带明细，因此单独存计数）。 */
  taskAccessCount: number;
  usageLogCount: number;
  releasedAt: Date | null;
  releasedByUserId: string;
  releasedByUsername: string;
  releaseReason: string;
  /** 解除保全后才设置：到期由 TTL 回收；未解除时为 null（永不自动清理）。 */
  purgeAfter: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const PixelEvidenceHoldSchema = new Schema<IPixelEvidenceHold>(
  {
    holdId: { type: String, required: true, unique: true },
    userId: { type: String, required: true },
    caseRef: { type: String, required: true },
    legalBasis: { type: String, default: "" },
    reason: { type: String, default: "" },
    issuedByUserId: { type: String, required: true },
    issuedByUsername: { type: String, default: "" },
    issuedAt: { type: Date, default: Date.now },
    taskAccess: { type: [Schema.Types.Mixed], default: [] },
    usageLogs: { type: [Schema.Types.Mixed], default: [] },
    truncated: { type: Boolean, default: false },
    taskAccessCount: { type: Number, default: 0 },
    usageLogCount: { type: Number, default: 0 },
    releasedAt: { type: Date, default: null },
    releasedByUserId: { type: String, default: "" },
    releasedByUsername: { type: String, default: "" },
    releaseReason: { type: String, default: "" },
    purgeAfter: { type: Date, default: null },
  },
  { collection: "pixel_evidence_holds", timestamps: true },
);

PixelEvidenceHoldSchema.index({ userId: 1, releasedAt: 1 });
PixelEvidenceHoldSchema.index({ caseRef: 1 });
// TTL 只对非 null 生效：未解除保全时不清理。
PixelEvidenceHoldSchema.index({ purgeAfter: 1 }, { expireAfterSeconds: 0 });

export default mongoose.models.PixelEvidenceHold
  || mongoose.model<IPixelEvidenceHold>("PixelEvidenceHold", PixelEvidenceHoldSchema);
