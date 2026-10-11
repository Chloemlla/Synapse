import { mongoose } from "../services/mongoService";

/**
 * 法律保留（`legal_holds`，RC-22 / 裁决三）。
 *
 * 语义：命中保留的对象**禁止任何物理删除** —— 管理员硬删、软删除清理任务、TTL 替换后的应用层清理，
 * 都要先查这里。这是“给政府机关调查使用”那条需求真正落地的那一环：只做软删除只能保证
 * “今天还在”，不能保证“清理任务不会在调查期间把它删掉”。
 *
 * 刻意设计：
 * - `scope` 只支持三种（用户 / 指纹 / IP）：与仓库其它风控表的维度一致，不引入第四套标识；
 * - `expiresAt` 到期**不自动删数据**，只是不再阻止后续清理 —— hold 不是“延期删除”，是“暂停删除”；
 * - 无 TTL：hold 本身就是长期约束，不能被 TTL 索引清掉。
 */
export type LegalHoldScope = "user" | "fingerprint" | "ip";

export interface ILegalHold {
  scope: LegalHoldScope;
  value: string;
  caseRef: string;
  reason: string;
  issuedBy: string;
  issuedAt: Date;
  expiresAt: Date | null;
  releasedBy: string | null;
  releasedAt: Date | null;
  releaseReason: string;
  createdAt: Date;
  updatedAt: Date;
}

const legalHoldSchema = new mongoose.Schema<ILegalHold>(
  {
    scope: { type: String, enum: ["user", "fingerprint", "ip"], required: true, index: true },
    value: { type: String, required: true, index: true },
    caseRef: { type: String, required: true },
    reason: { type: String, default: "" },
    issuedBy: { type: String, required: true },
    issuedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, default: null },
    releasedBy: { type: String, default: null },
    releasedAt: { type: Date, default: null },
    releaseReason: { type: String, default: "" },
  },
  { timestamps: true, collection: "legal_holds" },
);

// 「这个对象当前是否被 hold」是最高频查询：scope+value 复合，且只关心未释放的。
legalHoldSchema.index({ scope: 1, value: 1, releasedAt: 1 });

export const LegalHoldModel =
  (mongoose.models.LegalHold as mongoose.Model<ILegalHold>) ||
  mongoose.model<ILegalHold>("LegalHold", legalHoldSchema);
