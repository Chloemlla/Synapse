import type { Document } from "mongoose";
import { mongoose } from "../services/mongoService";

/**
 * step-up 单次挑战（RC-03 / RC-45 / RC-46）。
 *
 * 为什么不能复用首访令牌（`ip_verification_tokens`）：那张令牌 TTL 40 分钟、
 * `verifyRequestToken` 只校验“存在且未过期”，一次验证换 40 分钟免验证 ——
 * 与「危险账户每一次操作都要验证」语义相反。
 *
 * 本集合是**瞬时令牌**，不是风控证据：
 * 因此建 TTL 索引由数据库自动清理（与 RC-22 裁决三不冲突 —— 那条约束的是
 * 取证/风控证据集合，挑战票据过期即无意义，且 payloadHash 绑定让它无法被复用）。
 */
export interface IStepUpChallenge extends Document {
  challengeId: string;
  userId: string;
  /** 签发时的账户档位快照（事后解释“当时为什么要求验证”）。 */
  riskTier: string;
  /** 服务端归一化后的路由键（RC-45）：绝不取 `req.route.path`。 */
  routeKey: string;
  /** 请求体摘要（RC-03）：防「验一次、改内容重放」。 */
  payloadHash: string;
  /** 客户端声明的供应商；兑换时用于校验同源（防「用 default 的宽松供应商过 step_up」）。 */
  provider: string;
  /** captcha = 供应商控件解；pow = hashcash 式前像难度（RC-36/RC-54，术语纠正见 §2.5）。 */
  type: "captcha" | "pow";
  powDifficulty?: number;
  powSeed?: string;
  ipAddress: string;
  fingerprint: string;
  issuedAt: Date;
  expiresAt: Date;
  consumedAt: Date | null;
}

const stepUpChallengeSchema = new mongoose.Schema<IStepUpChallenge>(
  {
    challengeId: { type: String, required: true, unique: true },
    userId: { type: String, required: true, index: true },
    riskTier: { type: String, default: "normal" },
    routeKey: { type: String, required: true },
    payloadHash: { type: String, required: true },
    provider: { type: String, default: "" },
    type: { type: String, enum: ["captcha", "pow"], default: "captcha" },
    powDifficulty: { type: Number },
    powSeed: { type: String },
    ipAddress: { type: String, default: "" },
    fingerprint: { type: String, default: "" },
    issuedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    consumedAt: { type: Date, default: null },
  },
  { timestamps: false, collection: "step_up_challenges" },
);

// 过期即清理（瞬时令牌，非取证证据）。
stepUpChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
// 管理端/排查：某用户最近的挑战记录。
stepUpChallengeSchema.index({ userId: 1, issuedAt: -1 });

export const StepUpChallenge =
  (mongoose.models.StepUpChallenge as mongoose.Model<IStepUpChallenge>) ||
  mongoose.model<IStepUpChallenge>("StepUpChallenge", stepUpChallengeSchema);
