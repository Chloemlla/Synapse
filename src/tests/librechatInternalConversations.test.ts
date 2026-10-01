import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockSendMessage = jest.fn();

jest.mock("../services/libreChatService", () => ({
  libreChatService: {
    sendMessage: (...args: unknown[]) => mockSendMessage(...args),
  },
}));

// moderationService 在模块作用域建 mongoose Schema；这里不需要真连接。
jest.mock("../services/mongoService", () => ({
  mongoose: {
    connection: { readyState: 0 },
    Schema: function MockSchema(this: Record<string, unknown>) {
      this.index = () => this;
    },
    models: {},
    model: jest.fn(() => ({})),
  },
}));

jest.mock("../services/userService", () => ({}));

import {
  createInternalConversation,
  isInternalServiceComponent,
  listLegacyInternalOwnerKeys,
  lookupLegacyInternalConversation,
} from "../services/librechat/conversations";
import { deriveUserOwnerKey, isConversationOwnerKey } from "../services/librechat/history";
import { ModerationService } from "../services/moderationService";

function internalMetaOf(call: unknown[]): { component: string; name: string } | undefined {
  const options = call[4] as { internal?: { component: string; name: string } } | undefined;
  return options?.internal;
}

describe("createInternalConversation", () => {
  it("会话名以组件名开头，ownerKey 是合法 canonical owner", () => {
    const conversation = createInternalConversation("moderation", "check");

    expect(conversation.component).toBe("moderation");
    expect(conversation.name.startsWith("moderation:check:")).toBe(true);
    expect(isConversationOwnerKey(conversation.ownerKey)).toBe(true);
    expect(conversation.ownerKey).toBe(deriveUserOwnerKey(`system:${conversation.name}`));
  });

  it("不传标识 ⇒ 每次都是全新会话（不复用同一对话）", () => {
    const first = createInternalConversation("moderation", "check");
    const second = createInternalConversation("moderation", "check");

    expect(first.ownerKey).not.toBe(second.ownerKey);
    expect(first.name).not.toBe(second.name);
  });

  it("传稳定标识 ⇒ 同一标识映射同一会话（一工单一会话）", () => {
    const first = createInternalConversation("ticket-ai", "reply", "ticket-abc123");
    const second = createInternalConversation("ticket-ai", "reply", "ticket-abc123");

    expect(second.ownerKey).toBe(first.ownerKey);
    expect(first.name).toBe("ticket-ai:reply:ticket-abc123");
  });

  it("标识与用途里的危险字符被净化，避免污染会话名", () => {
    const conversation = createInternalConversation("qq-guard", "mod/erate", "g1 2/../3");

    expect(conversation.name).toMatch(/^qq-guard:mod-erate:[A-Za-z0-9_.-]+$/);
    expect(conversation.name).not.toContain("/");
    expect(conversation.name).not.toContain(" ");
  });

  it("组件名识别只认登记过的组件", () => {
    expect(isInternalServiceComponent("moderation")).toBe(true);
    expect(isInternalServiceComponent("qq-guard")).toBe(true);
    expect(isInternalServiceComponent("ticket-ai")).toBe(true);
    expect(isInternalServiceComponent("recaptcha")).toBe(false);
    expect(isInternalServiceComponent(null)).toBe(false);
  });
});

describe("历史遗留内部会话", () => {
  it("固定身份写入的旧会话仍能给出可读名", () => {
    const legacy = lookupLegacyInternalConversation(deriveUserOwnerKey("system:moderation:check"));

    expect(legacy).toEqual({ component: "moderation", name: "moderation:check:legacy" });
    expect(listLegacyInternalOwnerKeys()).toHaveLength(3);
  });

  it("未登记的身份不臆造名字", () => {
    expect(lookupLegacyInternalConversation(deriveUserOwnerKey("u-1"))).toBeNull();
  });
});

describe("工单言论审查的会话隔离", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("每次审查都开新会话，且带组件名前缀的名字登记给管理端", async () => {
    mockSendMessage.mockResolvedValue("false");

    await ModerationService.checkContentWithAi("第一条内容", "u1", "user1");
    await ModerationService.checkContentWithAi("第二条内容", "u2", "user2");

    expect(mockSendMessage).toHaveBeenCalledTimes(2);
    const [firstCall, secondCall] = mockSendMessage.mock.calls as unknown[][];

    // 关键：两次审查的 ownerKey 必须不同，否则第二次会读到第一条的上下文。
    expect(firstCall[0]).not.toBe(secondCall[0]);
    expect(firstCall[0]).toBe(deriveUserOwnerKey(`system:${internalMetaOf(firstCall)?.name}`));
    expect(internalMetaOf(firstCall)?.component).toBe("moderation");
    expect(internalMetaOf(firstCall)?.name).toMatch(/^moderation:check:/);
    expect(internalMetaOf(secondCall)?.name).toMatch(/^moderation:check:/);
  });

  it("违规原因追问同样独立开会话", async () => {
    mockSendMessage.mockResolvedValue("含人身攻击");

    const reason = await ModerationService.getAiViolationReason("违规内容");

    expect(reason).toBe("含人身攻击");
    const call = mockSendMessage.mock.calls[0] as unknown[];
    expect(internalMetaOf(call)?.component).toBe("moderation");
    expect(internalMetaOf(call)?.name).toMatch(/^moderation:reason:/);
  });
});
