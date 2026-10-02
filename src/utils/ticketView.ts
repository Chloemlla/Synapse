function toPlainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const candidate = value as { toObject?: () => Record<string, unknown> };
  return typeof candidate.toObject === "function" ? candidate.toObject() : { ...(value as Record<string, unknown>) };
}

function toDate(value: unknown): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value as string | number);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isInternalMessage(message: Record<string, unknown>): boolean {
  return message.visibility === "internal";
}

/** 列表卡片上「最后一条」预览的最大长度。 */
const MESSAGE_PREVIEW_MAX = 140;

export interface TicketViewOptions {
  /** 是否包含「内部备注」（`visibility: "internal"`）。仅 superadmin 可置真。 */
  includeInternal?: boolean;
}

/**
 * 详情视图。
 *
 * `includeInternal` 是安全边界而不是展示偏好：内部备注永不下发给工单属主，
 * 列表摘要、详情响应、WebSocket 广播三处都必须过滤（漏一处就等于把备注发给用户）。
 */
export function toTicketView(
  ticket: unknown,
  includeAiErrorDetails: boolean,
  options: TicketViewOptions = {},
): Record<string, unknown> {
  const plainTicket = toPlainObject(ticket);
  if (!Array.isArray(plainTicket.messages)) return plainTicket;

  const includeInternal = options.includeInternal === true;
  const allMessages = plainTicket.messages.map((message) => toPlainObject(message));
  const visibleMessages = includeInternal ? allMessages : allMessages.filter((message) => !isInternalMessage(message));

  return {
    ...plainTicket,
    messages: visibleMessages.map((message) => {
      const plainMessage = { ...message };
      if (!includeAiErrorDetails) delete plainMessage.aiErrorDetails;
      return plainMessage;
    }),
    ...(includeInternal
      ? { internalNoteCount: allMessages.filter((message) => isInternalMessage(message)).length }
      : {}),
  };
}

export interface TicketSummaryOptions {
  /** 观察者视角：决定「对方的消息」指的是谁，从而算出 hasUnread。 */
  viewer: "user" | "admin";
  /** 是否统计内部备注（superadmin 的管理端）。 */
  includeInternal?: boolean;
}

/**
 * 列表用摘要：去掉 `messages`（AI 回复可达数千字，全量下发会让管理端列表变成大响应），
 * 补上渲染卡片真正需要的字段。
 *
 * 不返回 `messages` 是刻意的：调用方选中工单后再走详情接口拿全文，
 * 这样列表响应大小与工单数量线性相关，而不是与对话总长度相关。
 */
export function toTicketSummary(ticket: unknown, options: TicketSummaryOptions): Record<string, unknown> {
  const plainTicket = toPlainObject(ticket);
  const allMessages = (Array.isArray(plainTicket.messages) ? plainTicket.messages : []).map((message) =>
    toPlainObject(message),
  );
  const publicMessages = allMessages.filter((message) => !isInternalMessage(message));
  const internalNoteCount = allMessages.length - publicMessages.length;
  const lastMessage = publicMessages.length > 0 ? publicMessages[publicMessages.length - 1] : null;

  const lastSenderRole = typeof lastMessage?.senderRole === "string" ? lastMessage.senderRole : undefined;
  const lastMessageAt = toDate(lastMessage?.createdAt);
  const readAt = toDate(options.viewer === "admin" ? plainTicket.adminLastReadAt : plainTicket.userLastReadAt);

  // 用户侧的「对方」是客服与 AI；客服侧的「对方」只有用户。
  const lastFromOtherSide =
    options.viewer === "admin"
      ? lastSenderRole === "user"
      : lastSenderRole === "admin" || lastSenderRole === "ai";

  const hasUnread = Boolean(
    lastMessageAt && lastFromOtherSide && (!readAt || readAt.getTime() < lastMessageAt.getTime()),
  );

  // 「等客服回复」= 最后一条公开消息是用户发的；管理端据此排出待处理队列。
  const awaitingReply = lastSenderRole === "user";
  const ageAnchor = toDate(plainTicket.updatedAt) || toDate(plainTicket.createdAt);
  const ageHours = ageAnchor ? Math.max(0, Math.round((Date.now() - ageAnchor.getTime()) / 36_000) / 100) : 0;

  const rawPreview = typeof lastMessage?.content === "string" ? lastMessage.content : "";
  const lastMessagePreview = rawPreview.replace(/\s+/g, " ").trim().slice(0, MESSAGE_PREVIEW_MAX);

  const summary: Record<string, unknown> = {
    ...plainTicket,
    messageCount: publicMessages.length,
    internalNoteCount: options.includeInternal ? internalNoteCount : undefined,
    lastMessagePreview,
    lastSenderRole,
    lastMessageAt: lastMessageAt ? lastMessageAt.toISOString() : null,
    hasUnread,
    awaitingReply,
    ageHours,
  };

  // 内部已读水位不进响应；正文由详情接口提供。
  delete summary.messages;
  delete summary.userLastReadAt;
  delete summary.adminLastReadAt;
  if (summary.internalNoteCount === undefined) delete summary.internalNoteCount;

  return summary;
}
