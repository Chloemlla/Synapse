import { mongoose } from "../services/mongoService";

const ticketAiProviderFailureSchema = new mongoose.Schema(
  {
    baseUrl: { type: String, required: true },
    model: { type: String, required: true },
    status: { type: Number },
    code: { type: String },
    message: { type: String, required: true },
    occurredAt: { type: Date, required: true },
  },
  { _id: false },
);

const ticketAiErrorDetailsSchema = new mongoose.Schema(
  {
    reason: {
      type: String,
      enum: ["no_provider_configured", "all_providers_failed"],
      required: true,
    },
    summary: { type: String, required: true },
    attempts: { type: [ticketAiProviderFailureSchema], default: [] },
    occurredAt: { type: Date, required: true },
  },
  { _id: false },
);

const ticketMessageSchema = new mongoose.Schema({
  senderId: { type: String, required: true },
  senderRole: { type: String, enum: ["user", "admin", "ai"], required: true },
  content: { type: String, required: true },
  isAi: { type: Boolean, default: false },
  // 内部备注：仅 superadmin 可见，永不下发给工单属主（列表/详情/WS 三处都要过滤）。
  visibility: { type: String, enum: ["public", "internal"], default: "public" },
  aiErrorDetails: { type: ticketAiErrorDetailsSchema },
  createdAt: { type: Date, default: Date.now },
});

const ticketSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    username: { type: String, required: true },
    title: { type: String, required: true },
    description: { type: String, required: true },
    status: {
      type: String,
      enum: ["open", "in-progress", "resolved", "closed"],
      default: "open",
      index: true,
    },
    priority: {
      type: String,
      enum: ["low", "medium", "high"],
      default: "medium",
    },
    /** 工单分类：让管理端能按主题分流（缺陷 / 功能 / 账号 / 计费 / 其他）。 */
    category: {
      type: String,
      enum: ["bug", "feature", "account", "billing", "other"],
      default: "other",
      index: true,
    },
    /** 受理人：superadmin 认领工单，便于「我的工单 / 未分配」筛选。 */
    assigneeId: { type: String, default: null, index: true },
    assigneeName: { type: String, default: null },
    messages: [ticketMessageSchema],
    // 未读状态：分别记录用户侧 / 客服侧最后一次打开该工单的时间。
    // 列表摘要据此算 hasUnread（最后一条来自对方且晚于本侧已读时间）。
    userLastReadAt: { type: Date, default: null },
    adminLastReadAt: { type: Date, default: null },
  },
  {
    collection: "tickets",
    timestamps: true,
  },
);

// Serves `find({ userId }).sort({ updatedAt: -1 })` — ticket list queries sort by
// updatedAt; without this the sort falls back to an in-memory sort that can exceed
// MongoDB's 32MB in-memory sort limit on large ticket histories.
ticketSchema.index({ userId: 1, updatedAt: -1 });
// Serves the admin-wide list `find({ status?, priority? }).sort({ updatedAt: -1 })`
// when no status/priority filter is applied — a bare updatedAt sort over the whole
// collection needs a global index to stay within the in-memory sort limit.
ticketSchema.index({ updatedAt: -1 });

export const TicketModel = mongoose.models.Ticket || mongoose.model("Ticket", ticketSchema);

export interface ITicketAiProviderFailure {
  baseUrl: string;
  model: string;
  status?: number;
  code?: string;
  message: string;
  occurredAt: Date;
}

export interface ITicketAiErrorDetails {
  reason: "no_provider_configured" | "all_providers_failed";
  summary: string;
  attempts: ITicketAiProviderFailure[];
  occurredAt: Date;
}

export interface ITicketMessage {
  senderId: string;
  senderRole: "user" | "admin" | "ai";
  content: string;
  isAi?: boolean;
  visibility?: "public" | "internal";
  aiErrorDetails?: ITicketAiErrorDetails;
  createdAt: Date;
}

export type TicketCategory = "bug" | "feature" | "account" | "billing" | "other";

export interface ITicket {
  _id: string;
  userId: string;
  username: string;
  title: string;
  description: string;
  status: "open" | "in-progress" | "resolved" | "closed";
  priority: "low" | "medium" | "high";
  category: TicketCategory;
  assigneeId?: string | null;
  assigneeName?: string | null;
  messages: ITicketMessage[];
  createdAt: Date;
  updatedAt: Date;
  userLastReadAt?: Date | null;
  adminLastReadAt?: Date | null;
}
