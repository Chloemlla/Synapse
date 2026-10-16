import mongoose, { type Document, Schema } from "mongoose";

// 内容级取证（PIX 正当版本）：**只在命中有效审批时**才写入，且内容用独立子密钥加密。
//
// 与被拒绝的「隐蔽凭据库」的四点差别，全部落在这个表的字段上：
//   · 公开：privacy data map 有这条数据集，提交页明确告知；
//   · 限定：只有 caseRef/legalBasis/approvedBy 齐全的审批单生效期间才写；
//   · 可追责：每次读取都写审计，accessCount/lastAccessedAt 在这里留痕；
//   · 时间盒：expiresAt 上的 TTL 自动清除，不留「永久档」。
export interface IPixelEvidence extends Document {
  evidenceId: string;
  userId: string;
  caseRef: string;
  legalBasis: string;
  approvedByUserId: string;
  approvedByUsername: string;
  approvedAt: Date;
  capturedAt: Date;
  /** 到期自动清除（TTL）。 */
  expiresAt: Date;
  /** 独立子密钥（HKDF 不同 label）+ AES-256-GCM。 */
  ciphertext: string;
  iv: string;
  tag: string;
  cryptoVersion: number;
  accountCount: number;
  byteSize: number;
  accessCount: number;
  lastAccessedAt: Date | null;
  /** 超出上限时截断前的原始字节数（管理员需要知道取证不完整）。 */
  truncatedFromBytes: number | null;
  createdAt: Date;
  updatedAt: Date;
}

const PixelEvidenceSchema = new Schema<IPixelEvidence>(
  {
    evidenceId: { type: String, required: true, unique: true },
    userId: { type: String, required: true },
    caseRef: { type: String, required: true },
    legalBasis: { type: String, required: true },
    approvedByUserId: { type: String, required: true },
    approvedByUsername: { type: String, default: "" },
    approvedAt: { type: Date, required: true },
    capturedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    ciphertext: { type: String, required: true },
    iv: { type: String, required: true },
    tag: { type: String, required: true },
    cryptoVersion: { type: Number, required: true },
    accountCount: { type: Number, default: 0 },
    byteSize: { type: Number, default: 0 },
    accessCount: { type: Number, default: 0 },
    lastAccessedAt: { type: Date, default: null },
    truncatedFromBytes: { type: Number, default: null },
  },
  { collection: "pixel_evidence", timestamps: true },
);

PixelEvidenceSchema.index({ userId: 1, capturedAt: -1 });
PixelEvidenceSchema.index({ caseRef: 1 });
PixelEvidenceSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.models.PixelEvidence
  || mongoose.model<IPixelEvidence>("PixelEvidence", PixelEvidenceSchema);
