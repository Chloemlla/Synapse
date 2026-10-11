import { mongoose } from "../services/mongoService";

export interface ApiKeyDoc {
  keyId: string; // 公开标识，如 ak_xxxx（前缀 + 8位随机）
  keyHash: string; // SHA-256 哈希，存储而非明文
  name: string; // 用户自定义名称
  userId: string; // 所属用户 ID
  permissions: string[]; // 权限列表，如 ['tts', 'shorturl', 'status', 'outemail']
  rateLimit: number; // 每分钟请求上限
  expiresAt: Date | null; // 过期时间，null 表示永不过期
  lastUsedAt: Date | null;
  lastUsedIp: string | null;
  usageCount: number;
  /**
   * RC-19：三态（原先只有 enabled 两态）。
   * - `active`：正常；
   * - `throttled`：降速（额度打到 10% 并带 Retry-After），用于“突发/爬虫节奏”这类可疑但未定的滥用；
   * - `suspended`：直接 403 `API_KEY_SUSPENDED`（带稳定 code，前端/客户端才识别得了）。
   */
  status: "active" | "throttled" | "suspended";
  /** 处罚截止时间；为空 = 永久（只用于 `suspended`，其余状态忽略）。 */
  penaltyUntil: Date | null;
  /** 降速后的每分钟额度；缺省时按 `rateLimit` 的 10% 计算（至少 1）。 */
  effectiveRateLimit?: number | null;
  /** 归因：`auto:SPIKE` / `auto:ROBOTIC_CADENCE` / `manual:<operatorId>` / `account-risk:<tier>`。 */
  penaltySource?: string;
  penaltyReason?: string;
  enabled: boolean;
  billingEnabled: boolean;
  billingMode: "metered" | "prepaid";
  balanceCredits: number;
  totalChargedCredits: number;
  totalBillableRequests: number;
  lastBillingAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const ApiKeySchema = new mongoose.Schema<ApiKeyDoc>(
  {
    keyId: { type: String, required: true, unique: true, index: true },
    keyHash: { type: String, required: true, unique: true, index: true },
    name: { type: String, required: true },
    userId: { type: String, required: true, index: true },
    permissions: { type: [String], default: ["status"] },
    rateLimit: { type: Number, default: 60 },
    expiresAt: { type: Date, default: null },
    lastUsedAt: { type: Date, default: null },
    lastUsedIp: { type: String, default: null },
    usageCount: { type: Number, default: 0 },
    enabled: { type: Boolean, default: true },
    // RC-19：与 enabled 并行的三态 + 处罚归因。存量文档没有这些字段 ⇒ 默认 active / null。
    status: { type: String, enum: ["active", "throttled", "suspended"], default: "active", index: true },
    penaltyUntil: { type: Date, default: null },
    effectiveRateLimit: { type: Number, default: null },
    penaltySource: { type: String, default: "" },
    penaltyReason: { type: String, default: "" },
    billingEnabled: { type: Boolean, default: true },
    billingMode: { type: String, enum: ["metered", "prepaid"], default: "metered" },
    balanceCredits: { type: Number, default: 0, min: 0 },
    totalChargedCredits: { type: Number, default: 0, min: 0 },
    totalBillableRequests: { type: Number, default: 0, min: 0 },
    lastBillingAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

// TTL 索引：过期后自动清理（可选，仅对设置了 expiresAt 的文档生效）
ApiKeySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, partialFilterExpression: { expiresAt: { $ne: null } } });

const ApiKeyModel =
  (mongoose.models.ApiKey as mongoose.Model<ApiKeyDoc>) || mongoose.model<ApiKeyDoc>("ApiKey", ApiKeySchema);

export { ApiKeyModel };
