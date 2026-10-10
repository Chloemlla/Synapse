import { type Document, type Model, Schema } from "mongoose";
import { mongoose } from "../services/mongoService";

// 隐私政策同意记录接口
export interface IPolicyConsent extends Document {
  id: string;
  timestamp: number;
  version: string;
  fingerprint: string;
  checksum: string;
  userAgent?: string;
  ipAddress?: string;
  // 这条同意归哪个账号。同意必须能回答「是谁勾的」：记录只按 fingerprint（设备身份）归属时，
  // 同一台设备上换个账号就能蹭到上一位用户的同意 —— 功能门禁因此只认 userId 命中的记录
  // （见 policyConsentService.hasValidUserConsent），而设备级记录（登录/注册/匿名 TTS 门禁）
  // 早于本字段存在，所以保持可选。
  userId?: string;
  username?: string;
  recordedAt: Date;
  isValid: boolean;
  expiresAt: Date;
  // 记录来源（login / register / feature）；早于该功能写入的记录没有这两个字段
  source?: string;
  // 当时逐项勾选的文件键名，见 policyConsentService.POLICY_AGREEMENT_KEYS
  agreements?: string[];
  // 同意时的条文指纹（sha256），用于事后证明用户同意的是哪一份文本
  documentHash?: string;
  // 撤回留痕。原先 controller 的 updateMany 只写了 revokedAt / revokedIP，而 schema 上没有这两个
  // 字段，Mongoose strict 模式把它们静默丢弃 —— 「谁在何时从哪个 IP 撤回」从未落库。
  revokedAt?: Date | null;
  revokedIP?: string;
  revokedReason?: string;

  // 实例方法
  isExpired(): boolean;
}

// 静态方法接口
export interface IPolicyConsentModel extends Model<IPolicyConsent> {
  findValidConsent(fingerprint: string, version: string): Promise<IPolicyConsent | null>;
  findValidConsentForUser(userId: string, version: string): Promise<IPolicyConsent | null>;
  findLatestConsent(fingerprint: string): Promise<IPolicyConsent | null>;
  findConsentHistory(fingerprint: string, limit?: number): Promise<IPolicyConsent[]>;
  cleanExpiredConsents(): Promise<{ deletedCount?: number }>;
  getStats(startDate?: Date, endDate?: Date): Promise<any[]>;
}

// 隐私政策同意记录Schema
const policyConsentSchema = new Schema<IPolicyConsent>(
  {
    id: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    timestamp: {
      type: Number,
      required: true,
    },
    version: {
      type: String,
      required: true,
      index: true,
    },
    fingerprint: {
      type: String,
      required: true,
      index: true,
    },
    checksum: {
      type: String,
      required: true,
    },
    userAgent: {
      type: String,
      maxlength: 500,
    },
    ipAddress: {
      type: String,
      index: true,
    },
    // 未登录的设备级同意没有这两个字段（可选，保持向后兼容）
    userId: {
      type: String,
    },
    username: {
      type: String,
    },
    recordedAt: {
      type: Date,
      default: Date.now,
      // 索引在复合索引中定义
    },
    isValid: {
      type: Boolean,
      default: true,
      index: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    source: {
      type: String,
    },
    agreements: {
      type: [String],
      default: undefined,
    },
    documentHash: {
      type: String,
    },
    revokedAt: {
      type: Date,
      default: null,
    },
    revokedIP: {
      type: String,
    },
    revokedReason: {
      type: String,
    },
  },
  {
    timestamps: true,
    collection: "policy_consents",
  },
);

// 创建索引
// timestamp 字段不需要单独索引，复合索引和字段级索引已足够
policyConsentSchema.index({ fingerprint: 1, version: 1 });
// 用户级门禁的查询形状：按 userId 命中 + 时间倒序取最新一条
policyConsentSchema.index({ userId: 1, recordedAt: -1 });
policyConsentSchema.index({ ipAddress: 1, recordedAt: -1 });
// 管理端两大筛选维度（来源 + 时间倒序）与状态筛选的支撑
policyConsentSchema.index({ source: 1, recordedAt: -1 });
policyConsentSchema.index({ isValid: 1, expiresAt: 1 }, { name: "state_scan" });
policyConsentSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL索引

// 实例方法：检查是否过期
policyConsentSchema.methods.isExpired = function (): boolean {
  return new Date() > this.expiresAt;
};

// 静态方法：查找有效的同意记录
policyConsentSchema.statics.findValidConsent = function (fingerprint: string, version: string) {
  return this.findOne({
    fingerprint,
    version,
    isValid: true,
    expiresAt: { $gt: new Date() },
  });
};

// 静态方法：查该用户自己的有效同意记录（用户级门禁的唯一判据）。
// 与 findValidConsent 的差别只有归属维度：这里不看 fingerprint —— 同一个人换了设备、重新同意后，
// 新设备上写的是一条新的 userId 记录，不该被旧设备指纹的有无左右。
// 显式按 recordedAt 倒序：同一用户+版本可能留下多条（续期走原地改写，但过期后重新同意会新增），
// 排序让「哪条算数」是确定的，而不是由存储顺序决定。
policyConsentSchema.statics.findValidConsentForUser = function (userId: string, version: string) {
  return this.findOne({
    userId,
    version,
    isValid: true,
    expiresAt: { $gt: new Date() },
  }).sort({ recordedAt: -1 });
};

// 静态方法：取该指纹最近的一条记录（不分有效/无效）
// 用于把「从未同意过」与「同意过但已过期 / 已被撤回」区分开 —— 后者才能给用户看到有意义的提示。
policyConsentSchema.statics.findLatestConsent = function (fingerprint: string) {
  return this.findOne({ fingerprint }).sort({ recordedAt: -1 });
};

// 静态方法：该设备（指纹）的同意轨迹，按时间倒序。
// 面板用它回答「本设备历次同意过哪些版本、什么时候、被撤回过吗」——透明性的一部分。
policyConsentSchema.statics.findConsentHistory = function (fingerprint: string, limit = 20) {
  const cap = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 50) : 20;
  return this.find({ fingerprint }).sort({ recordedAt: -1 }).limit(cap);
};

// 静态方法：清理过期记录
policyConsentSchema.statics.cleanExpiredConsents = function () {
  return this.deleteMany({
    $or: [{ expiresAt: { $lt: new Date() } }, { isValid: false }],
  });
};

// 静态方法：获取统计信息
policyConsentSchema.statics.getStats = function (startDate?: Date, endDate?: Date) {
  const match: any = {};

  if (startDate || endDate) {
    match.recordedAt = {};
    if (startDate) match.recordedAt.$gte = startDate;
    if (endDate) match.recordedAt.$lte = endDate;
  }

  return this.aggregate([
    { $match: match },
    {
      $group: {
        _id: {
          version: "$version",
          date: {
            $dateToString: {
              format: "%Y-%m-%d",
              date: "$recordedAt",
            },
          },
        },
        count: { $sum: 1 },
        uniqueFingerprints: { $addToSet: "$fingerprint" },
        uniqueIPs: { $addToSet: "$ipAddress" },
      },
    },
    {
      $project: {
        _id: 1,
        count: 1,
        uniqueFingerprints: { $size: "$uniqueFingerprints" },
        uniqueIPs: { $size: "$uniqueIPs" },
      },
    },
    { $sort: { "_id.date": -1, "_id.version": 1 } },
  ]);
};

const createPolicyConsentModel = () =>
  mongoose.model<IPolicyConsent, IPolicyConsentModel>("PolicyConsent", policyConsentSchema);

export const PolicyConsent =
  (mongoose.models.PolicyConsent as unknown as ReturnType<typeof createPolicyConsentModel>) ||
  createPolicyConsentModel();
