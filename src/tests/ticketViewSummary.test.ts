import { describe, expect, it } from "@jest/globals";
import { toTicketSummary, toTicketView } from "../utils/ticketView";

/**
 * 内部备注的可见性是安全边界：`visibility: "internal"` 的消息只能下发给 superadmin。
 * 列表摘要、详情响应、WS 广播三处都会经过这两个函数，所以这里锁死行为。
 */
function buildTicket(overrides: Record<string, unknown> = {}) {
  return {
    _id: "t1",
    userId: "u1",
    username: "alice",
    title: "无法登录",
    description: "描述",
    status: "open",
    priority: "high",
    category: "account",
    userLastReadAt: null,
    adminLastReadAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T01:00:00Z"),
    messages: [
      {
        senderId: "u1",
        senderRole: "user",
        content: "  我   打不开页面  ",
        visibility: "public",
        createdAt: new Date("2026-01-01T00:05:00Z"),
      },
      {
        senderId: "a1",
        senderRole: "admin",
        content: "内部：先查网关日志",
        visibility: "internal",
        createdAt: new Date("2026-01-01T00:10:00Z"),
      },
    ],
    ...overrides,
  };
}

describe("toTicketView 内部备注过滤", () => {
  it("hides internal notes from everyone except superadmin", () => {
    const ownerView = toTicketView(buildTicket(), false);
    expect((ownerView.messages as unknown[]).length).toBe(1);
    expect(ownerView.internalNoteCount).toBeUndefined();

    const adminView = toTicketView(buildTicket(), true, { includeInternal: true });
    expect((adminView.messages as unknown[]).length).toBe(2);
    expect(adminView.internalNoteCount).toBe(1);
  });

  it("normalises the message format so the client never has to guess", () => {
    const ticket = buildTicket({
      messages: [
        { senderId: "u1", senderRole: "user", content: "老消息", createdAt: new Date("2026-01-01T00:05:00Z") },
        {
          senderId: "u1",
          senderRole: "user",
          content: "line1
line2",
          format: "plain",
          createdAt: new Date("2026-01-01T00:06:00Z"),
        },
        { senderId: "a1", senderRole: "admin", content: "回复", format: "weird", createdAt: new Date("2026-01-01T00:07:00Z") },
      ],
    });
    const messages = toTicketView(ticket, false).messages as Array<Record<string, unknown>>;
    // 缺字段 / 非法值一律按 markdown（历史行为），显式 plain 原样保留。
    expect(messages.map((message) => message.format)).toEqual(["markdown", "plain", "markdown"]);
  });

  it("strips aiErrorDetails unless explicitly allowed", () => {
    const ticket = buildTicket({
      messages: [
        {
          senderId: "system_ai",
          senderRole: "ai",
          content: "答复",
          isAi: true,
          aiErrorDetails: { reason: "all_providers_failed", summary: "x", attempts: [], occurredAt: new Date() },
          createdAt: new Date("2026-01-01T00:20:00Z"),
        },
      ],
    });
    const hidden = (toTicketView(ticket, false).messages as Array<Record<string, unknown>>)[0];
    expect(hidden.aiErrorDetails).toBeUndefined();

    const shown = (toTicketView(ticket, true).messages as Array<Record<string, unknown>>)[0];
    expect(shown.aiErrorDetails).toBeDefined();
  });
});

describe("toTicketSummary", () => {
  it("drops messages and summarises the last PUBLIC message", () => {
    const summary = toTicketSummary(buildTicket(), { viewer: "admin", includeInternal: true });

    expect(summary.messages).toBeUndefined();
    expect(summary.userLastReadAt).toBeUndefined();
    expect(summary.adminLastReadAt).toBeUndefined();
    // 最后一条是内部备注，摘要必须取最后一条公开消息（否则备注内容会漏给列表）
    expect(summary.lastSenderRole).toBe("user");
    expect(summary.lastMessagePreview).toBe("我 打不开页面");
    expect(summary.messageCount).toBe(1);
    expect(summary.internalNoteCount).toBe(1);
  });

  it("marks unread for the side that has not read the other side's latest message", () => {
    const adminPending = toTicketSummary(buildTicket(), { viewer: "admin" });
    expect(adminPending.hasUnread).toBe(true);
    expect(adminPending.awaitingReply).toBe(true);

    // 用户自己的发言不构成"用户未读"
    const userSelf = toTicketSummary(buildTicket(), { viewer: "user" });
    expect(userSelf.hasUnread).toBe(false);

    // 客服已读水位晚于该消息 ⇒ 不再算未读
    const adminRead = toTicketSummary(
      buildTicket({ adminLastReadAt: new Date("2026-01-01T00:06:00Z") }),
      { viewer: "admin" },
    );
    expect(adminRead.hasUnread).toBe(false);
  });

  it("treats a new admin/AI reply as unread for the user", () => {
    const summary = toTicketSummary(
      buildTicket({
        messages: [
          { senderId: "u1", senderRole: "user", content: "问题", createdAt: new Date("2026-01-01T00:05:00Z") },
          { senderId: "a1", senderRole: "admin", content: "已修复", createdAt: new Date("2026-01-01T00:30:00Z") },
        ],
      }),
      { viewer: "user" },
    );
    expect(summary.hasUnread).toBe(true);
    expect(summary.awaitingReply).toBe(false);
  });
});

/**
 * 票面字段（类型 / 相关服务 / 联系邮箱 / 关联工单 / 附件计数）的视图归一：
 * Mongoose 的 default 只在写入时生效，老工单读出来是缺字段的，两个投影都必须补上默认值。
 */
describe("票面字段的视图归一", () => {
  it("fills defaults for legacy documents", () => {
    const summary = toTicketSummary(buildTicket(), { viewer: "user" });
    expect(summary).toMatchObject({
      type: "inquiry",
      relatedService: "other",
      relatedServiceRef: null,
      contactEmail: null,
      relatedTickets: [],
      attachmentCount: 0,
    });

    const view = toTicketView(buildTicket(), false);
    expect(view).toMatchObject({
      type: "inquiry",
      relatedService: "other",
      relatedTickets: [],
      attachmentCount: 0,
    });
  });

  it("keeps explicit values in both projections", () => {
    const ticket = buildTicket({
      type: "incident",
      relatedService: "tts",
      relatedServiceRef: "job-123",
      contactEmail: "alice@example.com",
      relatedTickets: [{ ticketId: "t2", title: "上一次的工单" }],
      attachmentCount: 2,
    });

    const summary = toTicketSummary(ticket, { viewer: "admin", includeInternal: true });
    expect(summary).toMatchObject({
      type: "incident",
      relatedService: "tts",
      relatedServiceRef: "job-123",
      contactEmail: "alice@example.com",
      attachmentCount: 2,
    });
    expect(summary.relatedTickets).toEqual([{ ticketId: "t2", title: "上一次的工单" }]);

    const view = toTicketView(ticket, false);
    expect(view).toMatchObject({ type: "incident", relatedService: "tts", attachmentCount: 2 });
  });
});
