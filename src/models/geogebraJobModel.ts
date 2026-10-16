import mongoose, { type Document, Schema } from "mongoose";

// GeoGebra 异步任务（GEO-15/16/21）：AI 生成/解读与导出共用一个集合与一个 runner，
// 因为它们的生命周期完全一致（queued → running → completed/failed/cancelled + 租约 + TTL）。
//
// 明确不存：上传原文、AI 供应商凭证、账号凭据、完整错误栈。
// 图片/产物一律通过 assetId 引用（见 geogebraAssetModel）。
export const GEOGEBRA_JOB_KINDS = [
  "ai-drawing",
  "ai-insight",
  "ai-annotation",
  "ai-explanation",
  "export",
] as const;

export type GeoGebraJobKind = (typeof GEOGEBRA_JOB_KINDS)[number];
export type GeoGebraJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "expired";

export interface GeoGebraJobResult {
  /** 面向用户的简短结论（已按长度裁剪，且始终按不可信文本渲染）。 */
  summary?: string;
  commands?: string[];
  notes?: string[];
  /** AI 自评把握度；模型没给出可用数字时为 null（导出类任务也为 null）。 */
  confidence?: number | null;
  /** 产物下载用（export 任务）。 */
  assetId?: string;
  /** 运行时缺口说明，例如某导出格式在目标端不可用。 */
  unsupportedReason?: string;
}

export interface IGeoGebraJob extends Document {
  jobId: string;
  kind: GeoGebraJobKind;
  ownerUserId: string;
  projectId: string | null;
  status: GeoGebraJobStatus;
  /** 幂等键：同一用户 + 同一键只允许一个未终态任务，重复提交返回既有任务。 */
  idempotencyKey: string;
  progress: number;
  /** 有界输入快照（脚本/画布模式/格式/参考图 assetId 等），不含任何凭据。 */
  input: Record<string, unknown>;
  result: GeoGebraJobResult | null;
  errorCode: string | null;
  errorMessage: string | null;
  attempts: number;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  subjectDeletedAt: number;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

const GeoGebraJobSchema = new Schema<IGeoGebraJob>(
  {
    jobId: { type: String, required: true, unique: true },
    kind: { type: String, enum: [...GEOGEBRA_JOB_KINDS], required: true },
    ownerUserId: { type: String, required: true },
    projectId: { type: String, default: null },
    status: {
      type: String,
      enum: ["queued", "running", "completed", "failed", "cancelled", "expired"],
      default: "queued",
      required: true,
    },
    idempotencyKey: { type: String, required: true },
    progress: { type: Number, default: 0 },
    input: { type: Schema.Types.Mixed, default: {} },
    result: { type: Schema.Types.Mixed, default: null },
    errorCode: { type: String, default: null },
    errorMessage: { type: String, default: null },
    attempts: { type: Number, default: 0 },
    leaseOwner: { type: String, default: null },
    leaseExpiresAt: { type: Date, default: null },
    subjectDeletedAt: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
  },
  { collection: "geogebra_jobs" },
);

GeoGebraJobSchema.index({ ownerUserId: 1, createdAt: -1 });
GeoGebraJobSchema.index({ status: 1, createdAt: 1 });
// 幂等：同一用户的同一幂等键只能有一条未终态任务（终态任务不参与唯一性约束）。
GeoGebraJobSchema.index(
  { ownerUserId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ["queued", "running"] } } },
);
GeoGebraJobSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.models.GeoGebraJob
  || mongoose.model<IGeoGebraJob>("GeoGebraJob", GeoGebraJobSchema);
