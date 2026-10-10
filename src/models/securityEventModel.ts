import mongoose, { type Document, Schema } from "mongoose";

export interface ISecurityEvent extends Document {
  deviceFingerprint: string;
  userId?: string;
  eventType: string;
  eventData?: Record<string, any>;
  riskScore?: number;
  ipAddress?: string;
  userAgent?: string;
  createdAt: Date;
}

const securityEventSchema = new Schema<ISecurityEvent>(
  {
    deviceFingerprint: { type: String, required: true, index: true },
    userId: { type: String, index: true },
    eventType: { type: String, required: true, index: true },
    eventData: { type: Schema.Types.Mixed },
    riskScore: { type: Number },
    ipAddress: { type: String },
    userAgent: { type: String },
    createdAt: { type: Date, required: true, default: Date.now, index: true },
  },
  { timestamps: false },
);

// Serves `find({ eventType }).sort({ createdAt: -1 })` — the security event list query.
// The single-field eventType index leaves an in-memory sort behind; the compound index
// lets MongoDB use the index for both filter and sort.
securityEventSchema.index({ eventType: 1, createdAt: -1 });

// getSecurityEvents 支持按 deviceFingerprint 过滤并按 createdAt 倒序分页（find({ deviceFingerprint }).sort({ createdAt: -1 })）。
// 单字段 deviceFingerprint 索引只能服务过滤，后续 createdAt 排序仍落到内存；
// 单个高频设备累积大量事件时会撞 sort memory limit。补复合索引让过滤+排序都走索引。
securityEventSchema.index({ deviceFingerprint: 1, createdAt: -1 });

// RC-12: 账户维度聚合（evaluateAccountRisk 要取「该用户最近 N 天的事件」）走
// `find({ userId }).sort({ createdAt: -1 })` / `countDocuments({ userId, createdAt: {$gte} })`。
// 单列 userId 索引只能服务过滤，createdAt 排序与范围会落到内存；事件量大的账号会撞
// sort memory limit，因此补与 (eventType, createdAt) 同口径的复合索引。
securityEventSchema.index({ userId: 1, createdAt: -1 });

export const SecurityEvent =
  (mongoose.models.SecurityEvent as mongoose.Model<ISecurityEvent>) ||
  mongoose.model<ISecurityEvent>("SecurityEvent", securityEventSchema);
