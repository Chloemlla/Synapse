import { mongoose } from "../services/mongoService";

export interface IAuditLog {
  /** 请求 ID (用于链路追踪) */
  requestId?: string;
  /** 操作者 ID */
  userId: string;
  /** 操作者用户名 */
  username: string;
  /** 操作者角色 */
  role: string;
  /** 操作类型，如 user.create / cdk.delete / ipban.create */
  action: string;
  /** 操作模块分类 */
  module:
    | "auth"
    | "user"
    | "system"
    | "cdk"
    | "api"
    | "admin"
    | "security"
    | "config"
    | "email"
    | "tts"
    | "shorturl"
    | "ipfs"
    | "media"
    | "network"
    | "oauth"
    | "life"
    | "social"
    | "lottery"
    | "workspace"
    | "resource"
    | "recommendation"
    | "policy"
    | "privacy"
    | "debug"
    | "ipban"
    | "env"
    | "announcement"
    | "lumen-config"
    | "modlist"
    | "other";
  /** 操作目标标识（如被操作的用户ID、CDK ID等） */
  targetId?: string;
  /** 操作目标描述 */
  targetName?: string;
  /** 操作结果 */
  result: "success" | "failure";
  /** 失败原因 */
  errorMessage?: string;
  /** 操作详情（变更前后等） */
  detail?: Record<string, any>;
  /** 请求 IP */
  ip: string;
  /** User-Agent */
  userAgent?: string;
  /** 请求路径 */
  path?: string;
  /** 请求方法 */
  method?: string;
  /** 创建时间 */
  createdAt: Date;
}

const AuditLogSchema = new mongoose.Schema<IAuditLog>(
  {
    requestId: { type: String },
    userId: { type: String, required: true, index: true },
    username: { type: String, required: true },
    role: { type: String, required: true },
    action: { type: String, required: true, index: true },
    module: { type: String, required: true, index: true },
    targetId: { type: String },
    targetName: { type: String },
    result: { type: String, required: true, enum: ["success", "failure"] },
    errorMessage: { type: String },
    detail: { type: mongoose.Schema.Types.Mixed },
    ip: { type: String, required: true },
    userAgent: { type: String },
    path: { type: String },
    method: { type: String },
    createdAt: { type: Date, default: Date.now },
  },
  {
    collection: "audit_logs",
    timestamps: false,
  },
);

// 查询索引
AuditLogSchema.index({ requestId: 1 });
AuditLogSchema.index({ createdAt: -1 });
AuditLogSchema.index({ module: 1, createdAt: -1 });
AuditLogSchema.index({ userId: 1, createdAt: -1 });
AuditLogSchema.index({ action: 1, createdAt: -1 });

/**
 * 审计日志保留期：60 天（2026-10-03 从 90 天收窄）。
 *
 * 为什么没人会在启动时自动生效：MongoDB **不会**因为 schema 里改了 `expireAfterSeconds`
 * 就更新已有索引 —— TTL 是索引的物理属性，同名不同选项时 Mongoose 的 autoIndex 只能报错、
 * 什么也改不了。也就是说「只改代码 + 重启」会让线上仍按 90 天过期，而界面已经显示 60 天，
 * 属于典型的「声明与行为不一致」。
 *
 * 存量部署的一次性迁移（幂等）：`ts-node src/scripts/applyAuditLogTtl.ts`。
 * 那里按**索引形状**（`createdAt: 1` 且带 expireAfterSeconds）定位，而不是按名字 ——
 * 所以这里继续保持隐式命名（`createdAt_1`）：显式改成别的名字会与存量索引键相同、名不同，
 * MongoDB 会拒绝创建（IndexKeySpecsConflict）。
 */
export const AUDIT_LOG_RETENTION_DAYS = 60;
AuditLogSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: AUDIT_LOG_RETENTION_DAYS * 24 * 60 * 60 },
);

export const AuditLogModel =
  (mongoose.models.AuditLog as mongoose.Model<IAuditLog>) || mongoose.model<IAuditLog>("AuditLog", AuditLogSchema);
