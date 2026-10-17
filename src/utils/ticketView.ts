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

function toEventList(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map((event) => toPlainObject(event)) : [];
}

/**
 * 给老文档补上新字段的默认值。
 *
 * Mongoose 的 default 只在**写入**时生效：本轮之前落库的工单，读出来是不带
 * `type` / `relatedService` / `attachmentCount` 的。视图层统一归一，前端就不必在渲染时
 * 到处写 `?? 'other'`（那样早晚会漏一处，列表和详情显示成两种口径）。
 * 新增的事件 / 首响 / 解决 / 满意度字段同理，老文档一律补 null / []。
 */
function withTicketFieldDefaults(ticket: Record<string, unknown>): Record<string, unknown> {
  return {
    ...ticket,
    type: typeof ticket.type === "string" ? ticket.type : "inquiry",
    relatedService: typeof ticket.relatedService === "string" ? ticket.relatedService : "other",
    relatedServiceRef: typeof ticket.relatedServiceRef === "string" ? ticket.relatedServiceRef : null,
    contactEmail: typeof ticket.contactEmail === "string" ? ticket.contactEmail : null,
    relatedTickets: Array.isArray(ticket.relatedTickets) ? ticket.relatedTickets : [],
    attachmentLinks: Array.isArray(ticket.attachmentLinks) ? ticket.attachmentLinks : [],
    attachmentCount: typeof ticket.attachmentCount === "number" ? ticket.attachmentCount : 0,
    events: toEventList(ticket.events),
    firstResponseAt: toDate(ticket.firstResponseAt),
    resolvedAt: toDate(ticket.resolvedAt),
    csatRating: typeof ticket.csatRating === "number" ? ticket.csatRating : null,
    csatComment: typeof ticket.csatComment === "string" ? ticket.csatComment : null,
    csatSubmittedAt: toDate(ticket.csatSubmittedAt),
  };
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
 *
 * 事件里的管理员身份同理：属主视角只保留「客服」这个角色标签，不泄露具体账号名；
 * 系统 / AI / 属主自己的事件保留原值（用户需要知道「这是系统做的」）。
 * `csatComment` 给属主与 superadmin（属主需要看到自己写过的评价并修改），列表摘要不带。
 */
export function toTicketView(
  ticket: unknown,
  includeAiErrorDetails: boolean,
  options: TicketViewOptions = {},
): Record<string, unknown> {
  const plainTicket = toPlainObject(ticket);
  const includeInternal = options.includeInternal === true;
  const allMessages = (Array.isArray(plainTicket.messages) ? plainTicket.messages : []).map((message) =>
    toPlainObject(message),
  );
  const visibleMessages = includeInternal ? allMessages : allMessages.filter((message) => !isInternalMessage(message));

  const view = withTicketFieldDefaults({
    ...plainTicket,
    ...(Array.isArray(plainTicket.messages)
      ? {
          messages: visibleMessages.map((message) => {
            const plainMessage = { ...message };
            if (!includeAiErrorDetails) delete plainMessage.aiErrorDetails;
            // 正文格式：老消息（本轮之前落库）没有该字段，历史行为就是全部按 Markdown 渲染。
            // 在这里统一归一，前端只判 `format === "plain"`，不必到处写缺省回退。
            plainMessage.format = message.format === "plain" ? "plain" : "markdown";
            return plainMessage;
          }),
        }
      : {}),
    ...(includeInternal
      ? { internalNoteCount: allMessages.filter((message) => isInternalMessage(message)).length }
      : {}),
  });

  const events = toEventList(view.events).map((event) => {
    if (includeInternal || (event.actorRole !== "admin" && event.actorRole !== "superadmin")) return event;
    const redacted = { ...event };
    delete redacted.actorId;
    redacted.actorName = "客服";
    return redacted;
  });
  view.events = events;
  // `csatComment` 保留给属主与 superadmin：属主需要看到自己写过的评价（可修改），
  // 而列表摘要已单独把它剔除（列表只带 csatRating）。普通管理员本就拿不到他人工单详情。
  return view;
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

  const summary: Record<string, unknown> = withTicketFieldDefaults({
    ...plainTicket,
    messageCount: publicMessages.length,
    internalNoteCount: options.includeInternal ? internalNoteCount : undefined,
    lastMessagePreview,
    lastSenderRole,
    lastMessageAt: lastMessageAt ? lastMessageAt.toISOString() : null,
    hasUnread,
    awaitingReply,
    ageHours,
  });

  // 内部已读水位不进响应；正文由详情接口提供。
  // 事件 / 评价内容 / 首响时间同样只属于详情：列表只需要 csatRating 画星级，
  // 把 100 条事件带进列表会让分页响应失去「与工单数量线性相关」的约束。
  delete summary.messages;
  delete summary.userLastReadAt;
  delete summary.adminLastReadAt;
  delete summary.events;
  delete summary.firstResponseAt;
  delete summary.csatComment;
  delete summary.csatSubmittedAt;
  if (summary.internalNoteCount === undefined) delete summary.internalNoteCount;

  return summary;
}
