import type { Document } from "mongoose";
import { mongoose } from "../services/mongoService";

/**
 * step-up grant（RC-46 / D22）。
 *
 * 为什么需要它：前端并发多个写请求会拿到多个不同的 `challengeId`，
 * 用户只过了一次人机验证 —— 若每个请求各签一枚单次挑战，重放 B 时 A 已被消费，
 * 用户看到的是“验证通过了但操作依旧失败”。
 *
 * 它**不是**“验证一次免 30 秒”：
 * - `allowedRouteKeys` 来自**服务端验签后的票据**，不信任前端上传的数组（否则可申领高危路由）；
 * - `remainingUses` 严格等于合法票据数量且 ≤ 5（D22）；
 * - 只放行“用户已经发起、且已经看到弹窗”的那批请求；前端队列排空即主动丢弃。
 */
export interface IStepUpGrant extends Document {
  grantId: string;
  userId: string;
  /** 本 grant 允许的路由键集合（由服务端票据推导）。 */
  allowedRouteKeys: string[];
  /** 已经兑换过的 payloadHash：同一请求在一枚 grant 内只能过一次（防重放）。 */
  usedPayloadHashes: string[];
  remainingUses: number;
  maxUses: number;
  ipAddress: string;
  fingerprint: string;
  issuedAt: Date;
  expiresAt: Date;
}

const stepUpGrantSchema = new mongoose.Schema<IStepUpGrant>(
  {
    grantId: { type: String, required: true, unique: true },
    userId: { type: String, required: true, index: true },
    allowedRouteKeys: { type: [String], default: [] },
    usedPayloadHashes: { type: [String], default: [] },
    remainingUses: { type: Number, required: true },
    maxUses: { type: Number, required: true },
    ipAddress: { type: String, default: "" },
    fingerprint: { type: String, default: "" },
    issuedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: false, collection: "step_up_grants" },
);

stepUpGrantSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
stepUpGrantSchema.index({ userId: 1, issuedAt: -1 });

export const StepUpGrant =
  (mongoose.models.StepUpGrant as mongoose.Model<IStepUpGrant>) ||
  mongoose.model<IStepUpGrant>("StepUpGrant", stepUpGrantSchema);
