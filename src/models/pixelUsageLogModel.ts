import mongoose from "mongoose";
import { PIXEL_USAGE_OUTCOMES, type PixelUsageOutcome } from "../pixel/types";
import { pixelLimitsFromEnv } from "../pixel/runtime";

/**
 * pixel_usage_logs：脱敏后的调用溯源（PIX-12，PRD 5.3「Pixel usage log」）。
 *
 * 数据最小化是本表的**唯一设计目标**——它记录「谁在什么时候对哪个映射做了什么、结果如何」，
 * 而**不**记录内容。明确不进本表的字段（对齐 PRD 6.1.3/6.1.4）：
 *   · 原始 IP / User-Agent / Referer / query / 请求体 / 响应体；
 *   · 邮箱、密码、辅助邮箱、2FA/TOTP 秘钥、完整卡密、完整上游 CDK、完整 result link。
 * 因此这里只有：请求 id、归属用户、映射 id、遮罩卡密、method/path、服务类型、账号数、
 * 请求/响应字节数、上游状态码、结果分类、耗时、时间。
 *
 * 保留期用 TTL 索引（Date 字段）：TTL 是索引的物理属性，只对 BSON Date 生效——
 * 换成 epoch 数字会让整张表在「1970 年之后的第 N 天」全员过期（auditLogModel 有同样注释）。
 * 保留天数在模块加载时读一次：MongoDB 不会因为 schema 里的 expireAfterSeconds 变了就更新
 * 既有索引，运行期读它只会让人误以为改了配置就生效。
 */
export interface IPixelUsageLog {
  logId: string;
  /** 内部请求 id（随机生成，不含任何用户输入），用于把同一次请求的多条记录串起来。 */
  requestId: string;
  /** 发起请求的 Synapse 用户（数据副本/删除路径的定位依据）。 */
  userId: string;
  /** 命中的 CDK 映射；未命中映射的请求为 null。 */
  mappingId: string | null;
  /** 请求里带的卡密遮罩值（前 4 ... 后 4），明文不落库、无法从这里还原。 */
  requestedCdkMasked: string;
  matchedMapping: boolean;
  method: string;
  /** 上游路径（已去掉 query）。 */
  path: string;
  serviceType: string | null;
  accountCount: number | null;
  requestBytes: number;
  responseBytes: number | null;
  upstreamStatus: number | null;
  outcome: PixelUsageOutcome;
  durationMs: number;
  createdAt: Date;
}

const PixelUsageLogSchema = new mongoose.Schema<IPixelUsageLog>(
  {
    logId: { type: String, required: true, unique: true, maxlength: 80 },
    requestId: { type: String, required: true, maxlength: 80 },
    userId: { type: String, required: true },
    mappingId: { type: String, default: null },
    requestedCdkMasked: { type: String, default: "", maxlength: 80 },
    matchedMapping: { type: Boolean, default: false },
    method: { type: String, required: true, maxlength: 10 },
    path: { type: String, required: true, maxlength: 200 },
    serviceType: { type: String, default: null, maxlength: 40 },
    accountCount: { type: Number, default: null },
    requestBytes: { type: Number, default: 0 },
    responseBytes: { type: Number, default: null },
    upstreamStatus: { type: Number, default: null },
    outcome: { type: String, enum: PIXEL_USAGE_OUTCOMES, required: true },
    durationMs: { type: Number, default: 0 },
    createdAt: { type: Date, required: true },
  },
  { collection: "pixel_usage_logs", versionKey: false },
);

// 管理列表：全局倒序 / 按映射过滤 / 按用户与时间查（数据副本、排查单用户问题）
PixelUsageLogSchema.index({ createdAt: -1 });
PixelUsageLogSchema.index({ mappingId: 1, createdAt: -1 });
PixelUsageLogSchema.index({ userId: 1, createdAt: -1 });

const USAGE_LOG_RETENTION_DAYS = pixelLimitsFromEnv().usageLogRetentionDays;
PixelUsageLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: USAGE_LOG_RETENTION_DAYS * 24 * 60 * 60 });

export const PixelUsageLogModel =
  (mongoose.models.PixelUsageLog as mongoose.Model<IPixelUsageLog>) ||
  mongoose.model<IPixelUsageLog>("PixelUsageLog", PixelUsageLogSchema);

export default PixelUsageLogModel;
