import { describe, expect, it } from "@jest/globals";
import { toTicketSummary, toTicketView } from "../utils/ticketView";
import {
  TICKET_EVENTS_LIMIT,
  buildBulkTicketUpdate,
  buildTicketEvent,
  normalizeCsatInput,
} from "../services/ticketWorkflowService";

/**
 * 工单 v2 的纯函数单测：事件构造、CSAT 校验、批量更新构造、视图脱敏。
 *
 * 这些规则同时被单条更新、批量更新、WS 广播与用户详情复用，散落实现迟早漂移；
 * 用例只覆盖纯函数，不碰数据库（聚合与 bulkWrite 由 CI 的集成场景兜底）。
 */

const NOW = new Date("2026-10-17T08:00:00.000Z");

describe("buildTicketEvent", () => {
  it("fills nullable fields and keeps actor metadata", () => {
    expect(
      buildTicketEvent({
        type: "status",
        actorId: "admin-1",
        actorName: "客服小王",
        actorRole: "superadmin",
        from: "open",
        to: "in-progress",
        createdAt: NOW,
      }),
    ).toEqual({
      type: "status",
      actorRole: "superadmin",
      actorId: "admin-1",
      actorName: "客服小王",
      from: "open",
      to: "in-progress",
      note: null,
      createdAt: NOW,
    });
  });

  it("omits actor fields for system events", () => {
    const event = buildTicketEvent({ type: "service", actorRole: "system", createdAt: NOW });
    expect(event).toEqual({
      type: "service",
      actorRole: "system",
      from: null,
      to: null,
      note: null,
      createdAt: NOW,
    });
    expect(event).not.toHaveProperty("actorId");
    expect(event).not.toHaveProperty("actorName");
  });
});

describe("normalizeCsatInput", () => {
  it("accepts an integer rating and trims the comment", () => {
    expect(normalizeCsatInput({ rating: 5, comment: "  描述清楚，问题解决了  " })).toEqual({
      ok: true,
      rating: 5,
      comment: "描述清楚，问题解决了",
    });
  });

  it("treats a missing or blank comment as null", () => {
    expect(normalizeCsatInput({ rating: 3 })).toEqual({ ok: true, rating: 3, comment: null });
    expect(normalizeCsatInput({ rating: 3, comment: "   " })).toEqual({ ok: true, rating: 3, comment: null });
  });

  it.each([
    ["non-integer", { rating: 3.5 }],
    ["zero", { rating: 0 }],
    ["above five", { rating: 6 }],
    ["missing", {}],
    ["boolean", { rating: true }],
  ])("rejects %s ratings", (_label, input) => {
    const result = normalizeCsatInput(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("1 到 5");
  });

  it("rejects comments longer than 500 characters", () => {
    const result = normalizeCsatInput({ rating: 4, comment: "好".repeat(501) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("500");
  });

  it("rejects non-string comments instead of coercing them", () => {
    const result = normalizeCsatInput({ rating: 4, comment: ["ok"] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("格式");
  });
});

describe("buildBulkTicketUpdate", () => {
  const actor = { id: "admin-1", name: "客服小王", role: "superadmin" };
  const baseTicket = {
    _id: "t1",
    status: "open",
    priority: "medium",
    category: "other",
    assigneeId: null,
    assigneeName: null,
    firstResponseAt: null,
    resolvedAt: null,
  };

  it("does nothing when the patch matches the current values", () => {
    const result = buildBulkTicketUpdate({
      ticket: baseTicket,
      patch: { status: "open", priority: "medium", category: "other", assigneeId: null },
      actor,
      now: NOW,
    });
    expect(result.changed).toBe(false);
    expect(result.$set).toEqual({});
    expect(result.$push).toBeUndefined();
  });

  it("writes only changed fields and appends one event per change", () => {
    const result = buildBulkTicketUpdate({
      ticket: baseTicket,
      patch: { status: "resolved", priority: "high" },
      actor,
      now: NOW,
    });

    expect(result.changed).toBe(true);
    expect(result.$set).toEqual({ status: "resolved", priority: "high", resolvedAt: NOW });
    expect(result.$set).not.toHaveProperty("category");
    expect(result.$set).not.toHaveProperty("assigneeId");

    const events = result.$push?.events;
    expect(events?.$slice).toBe(-TICKET_EVENTS_LIMIT);
    expect(events?.$each).toEqual([
      expect.objectContaining({ type: "status", from: "open", to: "resolved", actorRole: "superadmin" }),
      expect.objectContaining({ type: "priority", from: "medium", to: "high" }),
    ]);
  });

  it("keeps an existing resolvedAt when moving resolved -> closed", () => {
    const resolvedAt = new Date("2026-10-16T00:00:00.000Z");
    const result = buildBulkTicketUpdate({
      ticket: { ...baseTicket, status: "resolved", resolvedAt },
      patch: { status: "closed" },
      actor,
      now: NOW,
    });
    expect(result.$set).toEqual({ status: "closed" });
  });

  it("clears resolvedAt when reopening, without touching firstResponseAt", () => {
    const resolvedAt = new Date("2026-10-16T00:00:00.000Z");
    const result = buildBulkTicketUpdate({
      ticket: { ...baseTicket, status: "closed", resolvedAt },
      patch: { status: "in-progress" },
      actor,
      now: NOW,
    });
    expect(result.$set).toEqual({ status: "in-progress", resolvedAt: null });
    // 批量改状态不是「回复」：首响时间只能由消息写入路径产生。
    expect(result.$set).not.toHaveProperty("firstResponseAt");
    expect(result.$push?.events.$each).toEqual([
      expect.objectContaining({ type: "status", from: "closed", to: "in-progress" }),
    ]);
  });

  it("records assignee changes with names and supports unassigning", () => {
    const assigned = buildBulkTicketUpdate({
      ticket: { ...baseTicket, assigneeId: "admin-2", assigneeName: "小李" },
      patch: { assigneeId: null, assigneeName: null },
      actor,
      now: NOW,
    });
    expect(assigned.$set).toEqual({ assigneeId: null, assigneeName: null });
    expect(assigned.$push?.events.$each).toEqual([
      expect.objectContaining({ type: "assignee", from: "小李", to: null }),
    ]);

    const claimed = buildBulkTicketUpdate({
      ticket: baseTicket,
      patch: { assigneeId: "admin-1", assigneeName: "客服小王" },
      actor,
      now: NOW,
    });
    expect(claimed.$set).toEqual({ assigneeId: "admin-1", assigneeName: "客服小王" });
    expect(claimed.$push?.events.$each).toEqual([
      expect.objectContaining({ type: "assignee", from: null, to: "客服小王" }),
    ]);
  });
});

describe("toTicketView event redaction", () => {
  const ticket = {
    _id: "t1",
    userId: "u1",
    status: "resolved",
    csatRating: 2,
    csatComment: "响应太慢",
    csatSubmittedAt: NOW,
    firstResponseAt: NOW,
    resolvedAt: NOW,
    events: [
      {
        type: "created",
        actorId: "u1",
        actorName: "alice",
        actorRole: "user",
        from: null,
        to: "open",
        createdAt: NOW,
      },
      {
        type: "assignee",
        actorId: "admin-1",
        actorName: "客服小王",
        actorRole: "superadmin",
        from: null,
        to: "客服小王",
        createdAt: NOW,
      },
      {
        type: "service",
        actorRole: "system",
        from: "other",
        to: "tts",
        createdAt: NOW,
      },
    ],
    messages: [],
  };

  it("hides admin identity but keeps the owner's own CSAT comment in the owner view", () => {
    const view = toTicketView(ticket, false);
    const events = view.events as Array<Record<string, unknown>>;

    expect(view.csatRating).toBe(2);
    expect(view.csatSubmittedAt).toEqual(NOW);
    // 属主需要看到自己写过的评价（可修改）；列表摘要才是不带评论的那一层。
    expect(view.csatComment).toBe("响应太慢");

    const adminEvent = events[1];
    expect(adminEvent.actorName).toBe("客服");
    expect(adminEvent).not.toHaveProperty("actorId");

    // 属主自己的事件保留，系统事件保留。
    expect(events[0]).toMatchObject({ actorId: "u1", actorName: "alice" });
    expect(events[2]).toMatchObject({ actorRole: "system" });
  });

  it("keeps the real actor and CSAT comment for the superadmin view", () => {
    const view = toTicketView(ticket, true, { includeInternal: true });
    const events = view.events as Array<Record<string, unknown>>;

    expect(view.csatComment).toBe("响应太慢");
    expect(events[1]).toMatchObject({ actorId: "admin-1", actorName: "客服小王" });
  });

  it("fills event / CSAT defaults for legacy tickets", () => {
    // 老文档缺字段时视图层统一补 null / []，前端无需到处写 `?? null`。
    const view = toTicketView({ _id: "legacy", messages: [] }, false, { includeInternal: true });
    expect(view).toMatchObject({
      events: [],
      firstResponseAt: null,
      resolvedAt: null,
      csatRating: null,
      csatComment: null,
      csatSubmittedAt: null,
    });
  });
});

describe("toTicketSummary CSAT projection", () => {
  it("carries only csatRating and drops events / comment / first response", () => {
    const summary = toTicketSummary(
      {
        _id: "t1",
        userId: "u1",
        status: "resolved",
        csatRating: 4,
        csatComment: "还不错",
        csatSubmittedAt: NOW,
        firstResponseAt: NOW,
        resolvedAt: NOW,
        events: [{ type: "status", actorRole: "system", createdAt: NOW }],
        messages: [{ senderId: "u1", senderRole: "user", content: "问题", createdAt: NOW }],
      },
      { viewer: "admin", includeInternal: true },
    );

    expect(summary.csatRating).toBe(4);
    expect(summary).not.toHaveProperty("csatComment");
    expect(summary).not.toHaveProperty("csatSubmittedAt");
    expect(summary).not.toHaveProperty("events");
    expect(summary).not.toHaveProperty("firstResponseAt");
    expect(summary.resolvedAt).toEqual(NOW);
  });
});
