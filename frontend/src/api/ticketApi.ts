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

export interface ITicket {
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
}

/**
 * 列表项（后端 `summary=1` 投影）：不含 `messages`。
 *
 * 列表一次要渲染几十条工单，而单条 AI 回复可达数千字 —— 把全部对话装进列表响应会让
 * 首屏变成大响应。列表只看「最后一条 + 计数 + 未读」，正文在选中时走详情接口。
 */
export interface ITicketSummary {
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
  awaitingReply: number;
  slaBreached: number;
  oldestAwaitingHours: number;
  slaHours: number;
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

  // 用户创建工单
  async createTicket(data: {
    title: string;
    description: string;
    priority?: string;
  }): Promise<ITicket> {
    const response = await api.post("/api/tickets", data);
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
  // 管理员获取所有工单（分页 + 摘要 + 关键词/日期/分类/受理人筛选）
  async getAllTickets(params?: {
    status?: string;
    priority?: string;
    category?: string;
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

  // 管理端综合更新（状态 / 优先级 / 分类 / 受理人）
  async updateFields(
    id: string,
    fields: { status?: string; priority?: string; category?: string; assignee?: string | null },
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
};
