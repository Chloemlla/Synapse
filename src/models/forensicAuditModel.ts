import { mongoose } from "../services/mongoService";

/**
 * 取证审计集合（RC-35.2 / D16 = (a)）。
 *
 * 为什么必须独立于 `audit_logs`：`audit_logs` 有 60 天 TTL（与政策正文一致），
 * 而调查/调取的周期经常超过 60 天。把取证访问记录留在 TTL 集合里，等于让
 * 「谁在什么时候导出过谁的证据」在两个月后自动消失 —— 这正是 RC-35 要划清的边界：
 * 普通业务审计继续 60 天，**取证类事件进不设 TTL 的独立集合**。
 *
 * 两张表都刻意不建任何 TTL 索引。保留期由内部策略决定（见
 * docs/reference/data-retention-and-legal-hold.md），不交给数据库后台线程。
 */

export type ForensicSubjectScope = "user" | "ip" | "fingerprint";

export interface IForensicAuditLog {
  /** 稳定事件 ID（`fev_...`），用于与审计日志对账。 */
  eventId: string;
  /** 例如 legal_hold.create / legal_hold.release / forensic_export.request。 */
  action: string;
  actorId: string;
  actorUsername: string;
  actorRole: string;
  /** 案件编号：没有它就无法说明「为什么保留/导出」。 */
  caseRef: string;
  scope: ForensicSubjectScope | "";
  subjectValue: string;
  reason: string;
  /** 关联的导出申请（仅导出类事件）。 */
  exportRequestId?: string;
  targetIds?: string[];
  detail?: Record<string, unknown>;
  ip: string;
  userAgent?: string;
  path?: string;
  method?: string;
  createdAt: Date;
}

const forensicAuditLogSchema = new mongoose.Schema<IForensicAuditLog>(
  {
    eventId: { type: String, required: true, unique: true },
    action: { type: String, required: true, index: true },
    actorId: { type: String, required: true, index: true },
    actorUsername: { type: String, required: true },
    actorRole: { type: String, required: true },
    caseRef: { type: String, default: "", index: true },
    scope: { type: String, enum: ["user", "ip", "fingerprint", ""], default: "" },
    subjectValue: { type: String, default: "", index: true },
    reason: { type: String, default: "" },
    exportRequestId: { type: String },
    targetIds: { type: [String], default: [] },
    detail: { type: mongoose.Schema.Types.Mixed },
    ip: { type: String, required: true },
    userAgent: { type: String },
    path: { type: String },
    method: { type: String },
    createdAt: { type: Date, default: Date.now, index: true },
  },
  { collection: "forensic_audit_logs", timestamps: false },
);

forensicAuditLogSchema.index({ caseRef: 1, createdAt: -1 });
forensicAuditLogSchema.index({ subjectValue: 1, createdAt: -1 });
forensicAuditLogSchema.index({ action: 1, createdAt: -1 });

/**
 * 取证导出申请（双人确认的持久化载体）。
 *
 * 为什么落库而不是放内存 Map：双人确认的两个人通常在不同时间、不同会话里操作；
 * 进程重启后内存里的「待批准申请」会消失，而调查方已经拿到申请编号。落库也让
 * 「谁发起、谁批准、导出了多少行、校验和是多少」成为可追溯的取证事件。
 *
 * 不设 TTL：导出记录本身就是证据链的一部分。
 */
export type ForensicExportStatus = "pending" | "approved" | "downloaded" | "expired";

export interface IForensicExportRequest {
  requestId: string;
  requestedByUserId: string;
  requestedByUsername: string;
  approvedByUserId: string;
  approvedByUsername: string;
  caseRef: string;
  reason: string;
  scope: ForensicSubjectScope;
  subjectValue: string;
  from: Date | null;
  to: Date | null;
  status: ForensicExportStatus;
  /** 申请有效期：超时后必须重新发起 + 重新批准。 */
  expiresAt: Date;
  approvedAt: Date | null;
  downloadedAt: Date | null;
  rowCount: number;
  checksum: string;
  createdAt: Date;
  updatedAt: Date;
}

const forensicExportRequestSchema = new mongoose.Schema<IForensicExportRequest>(
  {
    requestId: { type: String, required: true, unique: true },
    requestedByUserId: { type: String, required: true, index: true },
    requestedByUsername: { type: String, required: true },
    approvedByUserId: { type: String, default: "" },
    approvedByUsername: { type: String, default: "" },
    caseRef: { type: String, required: true, index: true },
    reason: { type: String, required: true },
    scope: { type: String, enum: ["user", "ip", "fingerprint"], required: true },
    subjectValue: { type: String, required: true, index: true },
    from: { type: Date, default: null },
    to: { type: Date, default: null },
    status: {
      type: String,
      enum: ["pending", "approved", "downloaded", "expired"],
      default: "pending",
      index: true,
    },
    expiresAt: { type: Date, required: true },
    approvedAt: { type: Date, default: null },
    downloadedAt: { type: Date, default: null },
    rowCount: { type: Number, default: 0 },
    checksum: { type: String, default: "" },
  },
  { collection: "forensic_export_requests", timestamps: true },
);

forensicExportRequestSchema.index({ status: 1, expiresAt: 1 });

export const ForensicAuditLogModel =
  (mongoose.models.ForensicAuditLog as mongoose.Model<IForensicAuditLog>) ||
  mongoose.model<IForensicAuditLog>("ForensicAuditLog", forensicAuditLogSchema);

export const ForensicExportRequestModel =
  (mongoose.models.ForensicExportRequest as mongoose.Model<IForensicExportRequest>) ||
  mongoose.model<IForensicExportRequest>("ForensicExportRequest", forensicExportRequestSchema);
