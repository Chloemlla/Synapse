import mongoose from "mongoose";

/**
 * pixel_cdk_mappings：分发卡密 → 上游 CDK 的映射（Pixel 自助折扣链接，PIX-11）。
 *
 * 关键安全约束（PRD 6.1）：
 *   · **分发卡密明文不落库**。用户在前端输入的卡密就是本表的分发卡密，属「完整卡密」，
 *     因此这里只存 sha256（`distributionCdkHash`，唯一索引）用于查找与去重，加一个遮罩值用于展示。
 *     明文只在创建请求的内存里出现一次（回给创建者的那一次），从此不可读回。
 *   · **上游 CDK 可逆加密存储**（`upstreamCdk*` 三列 + 版本号）：调用上游时必须能取回明文，
 *     所以只能加密而不能哈希；密钥由主密钥 AES_KEY 派生，见 src/pixel/runtime.ts。
 *   · 接口只返回 `*Masked` 列。解密的明文绝不进日志、审计或响应体。
 */
export interface IPixelCdkMapping {
  /** 对外稳定标识（Mongo _id 只在内部分页/索引里用）。 */
  mappingId: string;
  /** sha256(规范化后的分发卡密)，唯一索引；用于「用户提交的卡密 → 映射」查找。 */
  distributionCdkHash: string;
  /** 分发卡密的展示值（前 4 ... 后 4），列表页只看得到它。 */
  distributionCdkMasked: string;
  /** 上游 CDK 密文（AES-256-GCM，base64）。 */
  upstreamCdkCiphertext: string;
  upstreamCdkIv: string;
  upstreamCdkTag: string;
  /** 加密方案版本，为将来轮换密钥留迁移判据（当前只有 1）。 */
  upstreamCdkCryptoVersion: number;
  /** 上游 CDK 的展示值（前 4 ... 后 4）。 */
  upstreamCdkMasked: string;
  note: string;
  enabled: boolean;
  createdByUserId: string;
  createdByUsername: string;
  createdAt: Date;
  updatedAt: Date;
}

const PixelCdkMappingSchema = new mongoose.Schema<IPixelCdkMapping>(
  {
    mappingId: { type: String, required: true, unique: true, maxlength: 80 },
    distributionCdkHash: { type: String, required: true, unique: true, maxlength: 64 },
    distributionCdkMasked: { type: String, required: true, maxlength: 80 },
    upstreamCdkCiphertext: { type: String, required: true },
    upstreamCdkIv: { type: String, required: true },
    upstreamCdkTag: { type: String, required: true },
    upstreamCdkCryptoVersion: { type: Number, required: true, default: 1 },
    upstreamCdkMasked: { type: String, required: true, maxlength: 80 },
    note: { type: String, default: "", maxlength: 200 },
    enabled: { type: Boolean, required: true, default: true },
    createdByUserId: { type: String, required: true },
    createdByUsername: { type: String, default: "", maxlength: 120 },
  },
  { collection: "pixel_cdk_mappings", timestamps: true },
);

// 管理列表：按创建时间倒序
PixelCdkMappingSchema.index({ createdAt: -1 });
// 启用状态筛选（停用的映射不再接受用户请求，但保留记录以便溯源）
PixelCdkMappingSchema.index({ enabled: 1, createdAt: -1 });

export const PixelCdkMappingModel =
  (mongoose.models.PixelCdkMapping as mongoose.Model<IPixelCdkMapping>) ||
  mongoose.model<IPixelCdkMapping>("PixelCdkMapping", PixelCdkMappingSchema);

export default PixelCdkMappingModel;
