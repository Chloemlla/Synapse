import { api } from "./api";
import type { AiErrorDetails } from "../types/aiDiagnostics";

export interface ITicketMessage {
  senderId: string;
  senderRole: "user" | "admin" | "ai";
  content: string;
  isAi?: boolean;
  aiErrorDetails?: AiErrorDetails;
  createdAt: string;
}

export type TicketStatus = "open" | "in-progress" | "resolved" | "closed";
export type TicketPriority = "low" | "medium" | "high";
export type TicketCategory = "bug" | "feature" | "account" | "billing" | "other";
/** 工单类型：咨询（怎么用 / 想提建议）还是故障（功能坏了 / 报错）。与后端 TICKET_TYPES 一一对应。 */
export type TicketType = "inquiry" | "incident";

/**
 * 相关服务（平台模块）。
 *
 * 必须与 `src/models/ticketModel.ts` 的 `TICKET_RELATED_SERVICES` 保持同一份清单与顺序：
 * 后端是校验边界（非法值回退 other），这里是展示口径。
 */
export type TicketRelatedService =
  | "tts"
  | "transcribe"
  | "librechat"
  | "geogebra"
  | "pixel"
  | "lottery"
  | "store"
  | "articles"
  | "shortlink"
  | "outemail"
  | "image-upload"
  | "api"
  | "account"
  | "billing"
  | "other";

/** 关联工单快照（`ticketId` 指向真实工单，`title` 是建立关联时的标题）。 */
export interface ITicketRelation {
  ticketId: string;
  title: string;
}

/** 附件元数据（后端永不下发正文，下载走单独端点）。 */
export interface ITicketAttachment {
  id: string;
  fileName: string;
  ext: string;
  mimeType: string;
  size: number;
  uploadedById: string;
  uploadedByName: string;
  createdAt: string | null;
}

/** 附件链接（外部地址 + 可选说明）。展示用的 host 由前端按 URL 计算（见 `attachmentLinkHost`）。 */
export interface ITicketAttachmentLink {
  url: string;
  label?: string | null;
  /** 预留：后端视图若补 host 则直接用；当前前端渲染时自行解析。 */
  host?: string;
}

/** 列表摘要与详情共有的票面字段（后端视图层会给老工单补默认值）。 */
export interface ITicketExtraFields {
  type: TicketType;
  relatedService: TicketRelatedService;
  relatedServiceRef: string | null;
  contactEmail: string | null;
  relatedTickets: ITicketRelation[];
  attachmentLinks: ITicketAttachmentLink[];
  attachmentCount: number;
}

export interface ITicket extends ITicketExtraFields {
  _id: string;
  userId: string;
  username: string;
  title: string;
  description: string;
  status: TicketStatus;
  priority: TicketPriority;
  category?: TicketCategory;
  assigneeId?: string | null;
  assigneeName?: string | null;
  messages: ITicketMessage[];
  createdAt: string;
  updatedAt: string;
  /** 仅 superadmin 的详情响应会带（内部备注条数）。 */
  internalNoteCount?: number;
  /** 详情响应专用：附件元数据（列表只带 attachmentCount）。 */
  attachments?: ITicketAttachment[];
}

/**
 * 列表项（后端 `summary=1` 投影）：不含 `messages`。
 *
 * 列表一次要渲染几十条工单，而单条 AI 回复可达数千字 —— 把全部对话装进列表响应会让
 * 首屏变成大响应。列表只看「最后一条 + 计数 + 未读」，正文在选中时走详情接口。
 */
export interface ITicketSummary extends ITicketExtraFields {
  _id: string;
  userId: string;
  username: string;
  title: string;
  description: string;
  status: TicketStatus;
  priority: TicketPriority;
  category: TicketCategory;
  assigneeId?: string | null;
  assigneeName?: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  internalNoteCount?: number;
  lastMessagePreview: string;
  lastSenderRole?: "user" | "admin" | "ai";
  lastMessageAt: string | null;
  hasUnread: boolean;
  /** 最后一条公开消息是用户发的：管理端待回复队列。 */
  awaitingReply?: boolean;
  /** 距最后更新时间的小时数。 */
  ageHours?: number;
}

/** 管理端概览统计（GET /api/tickets/admin/stats）。 */
export interface TicketStats {
  total: number;
  status: Record<string, number>;
  priority: Record<string, number>;
  category: Record<string, number>;
  /** 按工单类型分组（本轮新增；老工单归入 inquiry）。 */
  type?: Record<string, number>;
  /** 按相关服务分组（本轮新增；老工单归入 other）。 */
  service?: Record<string, number>;
  awaitingReply: number;
  slaBreached: number;
  oldestAwaitingHours: number;
  slaHours: number;
}

/** 工单能力（GET /api/tickets/capabilities）：决定界面显示哪些附件入口。 */
export interface TicketCapabilities {
  /** 普通用户是否可上传附件文件（默认关闭，需管理员在后台开启；管理员始终为 true）。 */
  canUploadAttachments: boolean;
  /** 不可上传时的说明文案（联系管理员 / 改用链接）。 */
  attachmentUploadPolicy: string | null;
  limits: {
    maxAttachments: number;
    maxAttachmentBytes: number;
    allowedExts: string[];
    maxAttachmentLinks: number;
    maxAttachmentLinkLength: number;
    maxAttachmentLinkLabelLength: number;
  };
}

export interface TicketListMeta {
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface TicketListPage {
  tickets: ITicketSummary[];
  meta: TicketListMeta;
}

/** 列表分页元信息在响应头里（响应体仍是数组，兼容既有调用方）。 */
function headerValue(headers: unknown, key: string): unknown {
  if (!headers || typeof headers !== "object") return undefined;
  const bag = headers as Record<string, unknown> & { get?: (name: string) => unknown };
  if (typeof bag.get === "function") {
    const viaGet = bag.get(key);
    if (viaGet !== undefined && viaGet !== null) return viaGet;
  }
  return bag[key] ?? bag[key.toLowerCase()];
}

function readListMeta(headers: unknown, fallbackPageSize: number): TicketListMeta {
  const asNumber = (key: string, fallback: number): number => {
    const parsed = Number.parseInt(String(headerValue(headers, key) ?? ""), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  };
  const total = asNumber("X-Total-Count", 0);
  const page = asNumber("X-Page", 1) || 1;
  const pageSize = asNumber("X-Page-Size", fallbackPageSize) || fallbackPageSize;
  const rawHasMore = headerValue(headers, "X-Has-More");
  const hasMore = rawHasMore === undefined || rawHasMore === null
    ? page * pageSize < total
    : String(rawHasMore) === "true";
  return { total, page, pageSize, hasMore };
}

export const DEFAULT_TICKET_PAGE_SIZE = 50;

/** 单独授权上传附件的用户（管理端视角）。`missing` = 该 ID 对应用户已不存在。 */
export interface TicketAttachmentGrantedUser {
  id: string;
  username: string | null;
  email: string | null;
  missing: boolean;
}

export interface TicketAttachmentSettings {
  userUploadEnabled: boolean;
  userUploadAllowedUserIds: string[];
  userUploadAllowedUsers: TicketAttachmentGrantedUser[];
  updatedAt?: string;
}

export const ticketApi = {
  // 用户获取自己的工单（分页 + 轻量摘要）
  async getMyTickets(params?: { page?: number; limit?: number }): Promise<TicketListPage> {
    const limit = params?.limit ?? DEFAULT_TICKET_PAGE_SIZE;
    const response = await api.get("/api/tickets", {
      params: { summary: 1, page: params?.page ?? 1, limit },
    });
    return {
      tickets: Array.isArray(response.data) ? (response.data as ITicketSummary[]) : [],
      meta: readListMeta(response.headers, limit),
    };
  },

  // 用户创建工单（TP-09：把后端实际读取的字段全部写进类型，
  // 而不是靠「变量多余属性被放行」传过去 —— 一旦调用方改成对象字面量就会静默丢字段）
  async createTicket(data: {
    title: string;
    description: string;
    priority?: string;
    category?: TicketCategory;
    type?: TicketType;
    relatedService?: TicketRelatedService;
    relatedServiceRef?: string | null;
    contactEmail?: string | null;
    relatedTicketIds?: string[];
    attachmentLinks?: Array<{ url: string; label?: string | null }>;
  }): Promise<ITicket> {
    const response = await api.post("/api/tickets", data);
    return response.data;
  },

  /** 工单能力：附件上传开关与限额（服务端是执行边界，这里只用于渲染）。 */
  async getCapabilities(): Promise<TicketCapabilities> {
    const response = await api.get("/api/tickets/capabilities");
    return response.data;
  },

  // 获取工单详情（含全部消息；打开详情同时会在服务端标记本侧已读）
  async getTicket(id: string): Promise<ITicket> {
    const response = await api.get(`/api/tickets/${id}`);
    return response.data;
  },

  // 回复工单（internal=true 时为内部备注，仅超级管理员可用）
  async replyTicket(id: string, content: string, internal = false): Promise<ITicket> {
    const response = await api.post(`/api/tickets/${id}/messages`, { content, internal });
    return response.data;
  },
  // 管理员获取所有工单（分页 + 摘要 + 关键词/日期/分类/类型/服务/受理人筛选）
  async getAllTickets(params?: {
    status?: string;
    priority?: string;
    category?: string;
    type?: string;
    service?: string;
    assignee?: string;
    awaitingReply?: string;
    unread?: string;
    q?: string;
    from?: string;
    to?: string;
    sort?: string;
    page?: number;
    limit?: number;
  }): Promise<TicketListPage> {
    const limit = params?.limit ?? DEFAULT_TICKET_PAGE_SIZE;
    const response = await api.get("/api/tickets/admin/all", {
      params: { ...params, summary: 1, page: params?.page ?? 1, limit },
    });
    return {
      tickets: Array.isArray(response.data) ? (response.data as ITicketSummary[]) : [],
      meta: readListMeta(response.headers, limit),
    };
  },

  // 管理端概览统计
  async getStats(): Promise<TicketStats> {
    const response = await api.get("/api/tickets/admin/stats");
    return response.data;
  },

  // 管理端综合更新（状态 / 优先级 / 分类 / 类型 / 相关服务 / 联系邮箱 / 关联工单 / 受理人）
  async updateFields(
    id: string,
    fields: {
      status?: string;
      priority?: string;
      category?: string;
      type?: string;
      relatedService?: string;
      relatedServiceRef?: string | null;
      contactEmail?: string | null;
      relatedTickets?: string[];
      assignee?: string | null;
    },
  ): Promise<ITicket> {
    const response = await api.patch(`/api/tickets/admin/${id}`, fields);
    return response.data;
  },

  // 管理端批量更新状态
  async bulkUpdateStatus(ids: string[], status: string): Promise<{ success: boolean; updated: number }> {
    const response = await api.patch("/api/tickets/admin/bulk/status", { ids, status });
    return response.data;
  },

  // 未读计数（导航角标）
  async getUnreadCount(): Promise<number> {
    const response = await api.get("/api/tickets/unread-count");
    return typeof response.data?.unread === "number" ? response.data.unread : 0;
  },

  // 属主自助关闭工单
  async closeTicket(id: string): Promise<ITicket> {
    const response = await api.patch(`/api/tickets/${id}/close`);
    return response.data;
  },

  // 管理员更新状态
  async updateStatus(id: string, status: string): Promise<ITicket> {
    const response = await api.patch(`/api/tickets/admin/${id}/status`, { status });
    return response.data;
  },

  // 管理员编辑消息
  async adminEditMessage(ticketId: string, messageIndex: number, content: string): Promise<ITicket> {
    const response = await api.put(`/api/tickets/admin/${ticketId}/messages/${messageIndex}`, { content });
    return response.data;
  },

  // 管理员删除消息
  async adminDeleteMessage(ticketId: string, messageIndex: number): Promise<ITicket> {
    const response = await api.delete(`/api/tickets/admin/${ticketId}/messages/${messageIndex}`);
    return response.data;
  },

  // ── 附件（票面「附件」）──

  /**
   * 上传附件（multipart，字段名 `file`，单次一个文件）。
   *
   * 后端逐层校验（白名单 / MIME / 魔数 / 1MB / 单工单 ≤5 / 仅 ASCII 文件名），
   * 返回的中文原因可直接展示；前端预校验只是不让用户白等一次上传。
   */
  async uploadAttachment(
    ticketId: string,
    file: File,
    onProgress?: (percent: number) => void,
  ): Promise<{ attachment: ITicketAttachment; attachmentCount: number }> {
    const form = new FormData();
    form.append("file", file, file.name);
    const response = await api.post(`/api/tickets/${ticketId}/attachments`, form, {
      onUploadProgress: (event) => {
        if (!onProgress || !event.total) return;
        onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
      },
    });
    return response.data;
  },

  /** 附件下载：先取 blob 再落盘（与转写/媒体工具一致，避免把令牌暴露在 URL 上）。 */
  async downloadAttachment(
    ticketId: string,
    attachment: Pick<ITicketAttachment, "id" | "fileName">,
  ): Promise<void> {
    const response = await api.get<Blob>(
      `/api/tickets/${ticketId}/attachments/${encodeURIComponent(attachment.id)}/download`,
      { responseType: "blob" },
    );
    const url = URL.createObjectURL(response.data);
    try {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = attachment.fileName || "attachment";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } finally {
      window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    }
  },

  /** 更新附件链接（属主或 superadmin）：上传文件关闭时的浏览器通道，开启后也保留。 */
  async updateAttachmentLinks(
    ticketId: string,
    links: Array<{ url: string; label?: string | null }>,
  ): Promise<ITicket> {
    const response = await api.put(`/api/tickets/${ticketId}/attachment-links`, { links });
    return response.data;
  },

  /** 删除附件，返回删除后的附件计数。 */
  async deleteAttachment(ticketId: string, attachmentId: string): Promise<number> {
    const response = await api.delete(
      `/api/tickets/${ticketId}/attachments/${encodeURIComponent(attachmentId)}`,
    );
    return typeof response.data?.attachmentCount === "number" ? response.data.attachmentCount : 0;
  },

  // ── 管理端：附件上传开关（超管）──

  /** 读取「普通用户可上传附件」开关（默认关闭）。 */
  async getAttachmentSettings(): Promise<TicketAttachmentSettings> {
    const response = await api.get("/api/admin/ticket-attachments/setting");
    const setting = response.data?.setting ?? {};
    const config = setting?.config ?? {};
    // 显式标注 unknown[]：`config` 来自 any（axios 响应），`Array.isArray` 收窄后整条
    // 三元表达式仍是 any，链式 filter/map 的回调参数就会退化成隐式 any（TS7006）。
    const grantedRaw: unknown[] = Array.isArray(config.userUploadAllowedUsers) ? config.userUploadAllowedUsers : [];
    return {
      userUploadEnabled: config.userUploadEnabled === true,
      userUploadAllowedUserIds: Array.isArray(config.userUploadAllowedUserIds)
        ? config.userUploadAllowedUserIds.filter((id: unknown): id is string => typeof id === "string")
        : [],
      userUploadAllowedUsers: grantedRaw
        .filter((item: unknown): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
        .map((item: Record<string, unknown>) => ({
          id: String(item.id ?? ""),
          username: typeof item.username === "string" ? item.username : null,
          email: typeof item.email === "string" ? item.email : null,
          missing: item.missing === true,
        }))
        .filter((item) => item.id),
      updatedAt: typeof setting?.updatedAt === "string" ? setting.updatedAt : undefined,
    };
  },

  /**
   * 保存开关与/或单独授权名单。只有超管能写（服务端也会再判一次）。
   *
   * 名单是**整体替换**语义：只传本次改动的那一份完整清单；不传该字段则保持原值。
   * 条目可以是用户 ID、用户名或邮箱 —— 服务端解析成 ID 后落库。
   */
  async saveAttachmentSettings(input: {
    userUploadEnabled?: boolean;
    userUploadAllowedUserIds?: string[];
  }): Promise<void> {
    await api.post("/api/admin/ticket-attachments/setting", input);
  },

  /** 重置开关（回到默认：关闭）。 */
  async resetAttachmentSettings(): Promise<void> {
    await api.delete("/api/admin/ticket-attachments/setting");
  },
};
