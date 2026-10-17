import { mongoose } from "../services/mongoService";

interface AccessTokenDoc {
  token: string;
  fingerprint: string;
  ipAddress: string; // 新增：存储用户IP地址
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date; // 过期时间，用于TTL索引
}

const AccessTokenSchema = new mongoose.Schema<AccessTokenDoc>(
  {
    token: { type: String, required: true, unique: true, index: true },
    fingerprint: { type: String, required: true, index: true },
    ipAddress: { type: String, required: true, index: true }, // 新增：IP地址字段
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true },
);

// 查询索引（**不是 TTL**）：过期令牌由 legalHoldCleanupService 清理。
// 裁决三（RC-22.2 / D8）：TTL 后台线程会绕开 legal_holds，关键集合改应用层清理。
AccessTokenSchema.index({ expiresAt: 1 });

// 复合索引，用于快速查询
AccessTokenSchema.index({ token: 1, fingerprint: 1, ipAddress: 1 });
AccessTokenSchema.index({ fingerprint: 1, ipAddress: 1, expiresAt: 1 });
AccessTokenSchema.index({ ipAddress: 1, expiresAt: 1 });

const AccessTokenModel =
  (mongoose.models.AccessToken as mongoose.Model<AccessTokenDoc>) ||
  mongoose.model<AccessTokenDoc>("AccessToken", AccessTokenSchema);

export { type AccessTokenDoc, AccessTokenModel };
