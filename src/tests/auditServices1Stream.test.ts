import { Readable } from "node:stream";
import { deriveUserOwnerKey } from "../services/librechat/history";
const mockPost = jest.fn();
jest.mock("axios", () => ({ __esModule: true, default: { post: mockPost } }));
jest.mock("node:fs", () => ({ ...jest.requireActual("node:fs"), existsSync: () => false }));
jest.mock("node:fs/promises", () => ({ ...jest.requireActual("node:fs/promises"), mkdir: async () => undefined }));
jest.mock("../services/mongoService", () => ({ mongoose: { connection: { readyState: 0 } } }));
jest.mock("../services/librechat/models", () => ({ ChatHistoryModel: {}, ChatProviderModel: {}, ImageRecordModel: {}, LatestRecordModel: {} }));
jest.mock("../utils/logger", () => ({ __esModule: true, default: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() } }));
const { libreChatService } = require("../services/libreChatService") as typeof import("../services/libreChatService");

describe("audit services 1: oversized provider streams", () => {
  afterEach(() => jest.restoreAllMocks());
  afterAll(() => libreChatService.cleanup());

  it("reports failure instead of persisting partial output as a completed answer", async () => {
    const service = libreChatService as any;
    await service.initializationPromise;
    jest.spyOn(service, "getProvidersFresh").mockResolvedValue(undefined);
    jest.spyOn(service, "buildProviderTryList").mockReturnValue([
      { baseUrl: "https://example.com", apiKey: "fixture", model: "fixture", wire: "openai-chat" },
      { baseUrl: "https://second.example.com", apiKey: "fixture", model: "fixture", wire: "openai-chat" },
    ]);
    jest.spyOn(service, "getOwnerMessages").mockResolvedValue([]);
    const persist = jest.spyOn(service, "appendHistoryMessage").mockResolvedValue(2);
    const notify = jest.spyOn(service, "sendSSENotification").mockImplementation(() => undefined);
    const chunk = Buffer.from('data: {"choices":[{"delta":{"content":"partial answer"}}]}\n');
    const stream = Readable.from([chunk, Buffer.alloc(2 * 1024 * 1024 + 1)]);
    mockPost.mockResolvedValue({ data: stream });
    const failure = jest.fn();
    const delta = jest.fn();
    const answer = await libreChatService.sendMessage(deriveUserOwnerKey("user-1"), "Explain rain", delta, failure);
    expect(delta).toHaveBeenCalledWith("partial answer");
    expect(answer).toBe("对话服务暂不可用，请稍后重试。");
    expect(failure).toHaveBeenCalled();
    expect(mockPost).toHaveBeenCalledTimes(1);
    const assistant = persist.mock.calls.map((call) => call[1] as any).find((message) => message.role === "assistant");
    expect(assistant.message).toBe(answer);
    expect(assistant.aiErrorDetails).toBeDefined();
    expect(notify).toHaveBeenCalledWith(expect.any(String), "message_completed", expect.objectContaining({ isFallback: true }));
    expect(stream.destroyed).toBe(true);
  });
});
