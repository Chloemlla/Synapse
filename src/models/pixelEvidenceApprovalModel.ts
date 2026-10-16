import mongoose, { type Document, Schema } from "mongoose";

// 内容级取证的**审批单**（PIX 正当版本：只对特定个案按审批开启）。
//
// 这个表存在的意义是「没有审批就没有留取」：提交账号时只有命中一张**有效审批**
// （未撤销、未过期、userId 匹配）才会把账号内容加密留存。默认对所有人关闭。
export interface IPixelEvidenceApproval extends Document {
  approvalId: string;
  /** 被授权留取内容的账号（个案范围，不是全局开关）。 */
  userId: string;
  caseRef: string;
  /** 明确的法律或同意依据（例如「搜查令编号 X」/「用户书面同意」）。必填。 */
  legalBasis: string;
  reason: string;
  approvedByUserId: string;
  approvedByUsername: string;
  approvedAt: Date;
  /** 审批有效期：到期即不再留取，且已留取内容按各自的 expiresAt 回收。 */
  expiresAt: Date;
  revokedAt: Date | null;
  revokedByUserId: string;
  revokedByUsername: string;
  revokeReason: string;
  createdAt: Date;
  updatedAt: Date;
}

const PixelEvidenceApprovalSchema = new Schema<IPixelEvidenceApproval>(
  {
    approvalId: { type: String, required: true, unique: true },
    userId: { type: String, required: true },
    caseRef: { type: String, required: true },
    legalBasis: { type: String, required: true },
    reason: { type: String, default: "" },
    approvedByUserId: { type: String, required: true },
    approvedByUsername: { type: String, default: "" },
    approvedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    revokedByUserId: { type: String, default: "" },
    revokedByUsername: { type: String, default: "" },
    revokeReason: { type: String, default: "" },
  },
  { collection: "pixel_evidence_approvals", timestamps: true },
);

PixelEvidenceApprovalSchema.index({ userId: 1, revokedAt: 1 });
PixelEvidenceApprovalSchema.index({ caseRef: 1 });
// 审批单本身不需要长期保留：到期后再留一段时间便于核对，然后自动回收。
PixelEvidenceApprovalSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

export default mongoose.models.PixelEvidenceApproval
  || mongoose.model<IPixelEvidenceApproval>("PixelEvidenceApproval", PixelEvidenceApprovalSchema);
