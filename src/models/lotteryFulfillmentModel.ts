import { mongoose } from "../services/mongoService";

/**
 * 抽奖履约记录（PRD §3.5）。
 *
 * 与奖品配置解耦：奖品只声明「这类奖品怎么发」（fulfillment.type），
 * 具体某一次中奖落一条履约记录，走租约队列异步处理（虚拟直充 / 卡密池 / 实物邮寄）。
 */

export type LotteryFulfillmentType = "virtual" | "code" | "physical";

export type LotteryFulfillmentStatus =
  | "pending" // 待 Worker 处理（虚拟/卡密）
  | "processing" // Worker 已认领（带租约）
  | "awaiting_address" // 实物：等待中奖者填写地址
  | "ready" // 已就绪待发货 / 待人工核销
  | "completed" // 已完成（虚拟直充成功 / 卡密已取出）
  | "failed" // 死信（重试超限）
  | "redeemed"; // 已折现/折积分为抽奖积分

export interface LotteryFulfillmentAddress {
  name: string;
  phone: string;
  detail: string;
  submittedAt: string;
}

export interface LotteryFulfillmentHistoryEntry {
  action: string;
  at: string;
  by?: string;
  detail?: string;
}

export interface LotteryFulfillmentRecord {
  id: string;
  roundId: string;
  /** 当前归属用户（转赠后指向受赠人）。 */
  userId: string;
  /** 最初中奖用户（转赠后保留，便于审计）。 */
  originalUserId: string;
  username: string;
  prizeId: string;
  prizeName: string;
  prizeValue: number;
  type: LotteryFulfillmentType;
  provider?: string;
  params?: Record<string, unknown>;
  status: LotteryFulfillmentStatus;
  attempts: number;
  processingOwner?: string;
  leaseExpiresAt?: string;
  /** 卡密内容（仅本人与超管可见）。 */
  code?: string;
  address?: LotteryFulfillmentAddress;
  error?: string;
  history?: LotteryFulfillmentHistoryEntry[];
  createdAt: string;
  updatedAt: string;
}

const addressSchema = new mongoose.Schema<LotteryFulfillmentAddress>(
  {
    name: { type: String, required: true },
    phone: { type: String, required: true },
    detail: { type: String, required: true },
    submittedAt: { type: String, required: true },
  },
  { _id: false },
);

const historySchema = new mongoose.Schema<LotteryFulfillmentHistoryEntry>(
  {
    action: { type: String, required: true },
    at: { type: String, required: true },
    by: { type: String },
    detail: { type: String },
  },
  { _id: false },
);

const fulfillmentSchema = new mongoose.Schema<LotteryFulfillmentRecord>(
  {
    id: { type: String, required: true, unique: true, index: true },
    roundId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    originalUserId: { type: String, required: true },
    username: { type: String, required: true },
    prizeId: { type: String, required: true },
    prizeName: { type: String, required: true },
    prizeValue: { type: Number, default: 0 },
    type: { type: String, required: true, enum: ["virtual", "code", "physical"] },
    provider: { type: String },
    params: { type: mongoose.Schema.Types.Mixed },
    status: { type: String, required: true, index: true },
    attempts: { type: Number, default: 0 },
    processingOwner: { type: String, index: true },
    leaseExpiresAt: { type: String, index: true },
    code: { type: String },
    address: { type: addressSchema },
    error: { type: String },
    history: { type: [historySchema], default: [] },
    createdAt: { type: String, required: true, index: true },
    updatedAt: { type: String, required: true },
  },
  { collection: "lottery_fulfillments" },
);

fulfillmentSchema.index({ status: 1, createdAt: 1 });
fulfillmentSchema.index({ status: 1, leaseExpiresAt: 1 });
fulfillmentSchema.index({ userId: 1, createdAt: -1 });

export const LotteryFulfillmentModel =
  mongoose.models.LotteryFulfillment ||
  mongoose.model<LotteryFulfillmentRecord>("LotteryFulfillment", fulfillmentSchema);
