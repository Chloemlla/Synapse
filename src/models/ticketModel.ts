import { mongoose } from "../services/mongoService";

/** 工单类型：咨询 / 故障（两端标签见 frontend ticketConstants.ts 的 TICKET_TYPE_META）。 */
export const TICKET_TYPES = ["inquiry", "incident"] as const;
export type TicketType = (typeof TICKET_TYPES)[number];

/** 相关服务（平台模块）。前端 TICKET_SERVICE_META 必须与本列表一一对应。 */
export const TICKET_RELATED_SERVICES = [
  "tts",
  "transcribe",
  "librechat",
  "geogebra",
  "pixel",
  "lottery",
  "store",
  "articles",
  "shortlink",
  "outemail",
  "image-upload",
  "api",
  "account",
  "billing",
  "other",
] as const;
export type TicketRelatedService = (typeof TICKET_RELATED_SERVICES)[number];

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

/**
 * 关联工单：存标题快照而不是只存 id。
 *
 * 证据：列表与详情都要渲染关联工单的标题，只存 id 的话每次响应都得再查一遍关联工单
 * （工单详情是热路径）。代价是对方标题改后快照会旧 —— 链接本身（`ticketId`）永远指向最新工单。
 */
const ticketRelationSchema = new mongoose.Schema(
  {
    ticketId: { type: String, required: true },
    title: { type: String, required: true },
  },
  { _id: false },
);

/**
 * 附件链接：指向外部（图床 / 网盘 / 截图服务）的地址。
 *
 * 为什么要有它：附件上传默认对普通用户关闭（见 TICKET_ATTACHMENTS 运行时开关），
 * 但用户常常就是要把一张截图给客服看 —— 这时链接是最低成本的通道：我们只存 URL，
 * 不代管文件本身（不引入 SSRF、不占存储、不把本站变成文件托管）。
 */
const ticketAttachmentLinkSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    label: { type: String, default: null },
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
    /**
     * 工单类型：咨询（怎么用 / 想提建议）还是故障（功能坏了 / 报错）。
     * 与 `category` 是两个维度：分类回答「哪方面的问题」，类型回答「是不是坏了」。
     */
    type: { type: String, enum: [...TICKET_TYPES], default: "inquiry", index: true },
    /** 相关服务：工单指向的平台模块，管理端据此按模块分流。 */
    relatedService: { type: String, enum: [...TICKET_RELATED_SERVICES], default: "other", index: true },
    /** 相关服务的具体对象（任务 ID / 订单号 / 资源 ID 等），自由文本，≤120 字。 */
    relatedServiceRef: { type: String, default: null },
    /**
     * 联系邮箱快照：缺省取账号邮箱。
     *
     * 只用于客服回访/展示，**不作为通知收件人**（除账号没有邮箱时兜底），否则等于开放
     * 「把本站通知改寄到任意地址」的入口。见 ticketController.resolveTicketNotifyEmail。
     */
    contactEmail: { type: String, default: null },
    /** 关联工单（≤5 条，创建/管理端设置时校验归属）。 */
    relatedTickets: { type: [ticketRelationSchema], default: [] },
    /** 附件链接（≤5 条，仅 http/https；上传文件默认关闭，见模型注释）。 */
    attachmentLinks: { type: [ticketAttachmentLinkSchema], default: [] },
    /**
     * 附件计数：列表徽标用。
     *
     * 附件正文存在独立集合里（见 ticketAttachmentModel），文档里只留计数 —— `tickets`
     * 列表接口会整档读文档，把 1MB 附件塞进来会让列表退化成大 IO。
     */
    attachmentCount: { type: Number, default: 0 },
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

/** 关联工单快照（`ticketId` 指向真实工单，`title` 是建立关联时的标题）。 */
export interface ITicketRelation {
  ticketId: string;
  title: string;
}

/** 附件链接（外部地址 + 可选说明）。 */
export interface ITicketAttachmentLink {
  url: string;
  label?: string | null;
}

export interface ITicket {
  _id: string;
  userId: string;
  username: string;
  title: string;
  description: string;
  status: "open" | "in-progress" | "resolved" | "closed";
  priority: "low" | "medium" | "high";
  category: TicketCategory;
  type?: TicketType;
  relatedService?: TicketRelatedService;
  relatedServiceRef?: string | null;
  contactEmail?: string | null;
  relatedTickets?: ITicketRelation[];
  attachmentLinks?: ITicketAttachmentLink[];
  attachmentCount?: number;
  assigneeId?: string | null;
  assigneeName?: string | null;
  messages: ITicketMessage[];
  createdAt: Date;
  updatedAt: Date;
  userLastReadAt?: Date | null;
  adminLastReadAt?: Date | null;
}
