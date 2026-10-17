const mockSend = jest.fn();
const mockBatchSend = jest.fn();
const mockInsertMany = jest.fn();
const mockFind = jest.fn();
const mockCountDocuments = jest.fn();
const mockFilterSuppressed = jest.fn();

let mockConfig = {
  enabled: true, resendDomain: "example.com", resendApiKey: "re_primary12345", quotaTotal: 100,
  outemailEnabled: true, outemailDomain: "example.com", outemailApiKey: "re_outemail12345", outemailQuotaTotal: 10,
  outemailCode: "",
};

jest.mock("resend", () => ({ Resend: jest.fn().mockImplementation(() => ({ emails: { send: mockSend }, batch: { send: mockBatchSend } })) }));
jest.mock("../services/emailQuotaService", () => ({}));
jest.mock("../services/runtimeConfigService", () => ({ RuntimeConfigService: { getCachedConfig: () => ({ email: mockConfig }) } }));
jest.mock("../services/emailSuppressionService", () => ({
  normalizeEmail: (email: string) => (typeof email === "string" && email.includes("@") ? email.trim().toLowerCase() : ""),
  filterSuppressedEmails: (...args: unknown[]) => mockFilterSuppressed(...args),
}));
jest.mock("../services/logger", () => ({ logger: { log: jest.fn(), error: jest.fn(), warn: jest.fn() } }));

/** 溯源列表查询的链式替身：sort→skip→limit→lean→exec。 */
function queryChain(result: unknown[]) {
  const chain: Record<string, any> = {};
  chain.sort = () => chain;
  chain.skip = () => chain;
  chain.limit = () => chain;
  chain.lean = () => chain;
  chain.exec = async () => result;
  return chain;
}

jest.mock("../services/mongoService", () => {
  const actual = jest.requireActual("mongoose");
  const model = {
    insertMany: (...args: unknown[]) => mockInsertMany(...args),
    find: (...args: unknown[]) => mockFind(...args),
    countDocuments: (...args: unknown[]) => mockCountDocuments(...args),
  };
  return {
    mongoose: {
      Schema: actual.Schema,
      models: {},
      connection: { readyState: 1 },
      model: () => model,
    },
  };
});

import { EmailService } from "../services/emailService";
import { getEmailTraceRecords, recordEmailTraces } from "../services/emailTraceService";

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("system mail traceability", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConfig = { ...mockConfig, enabled: true, outemailEnabled: true };
    mockFilterSuppressed.mockResolvedValue({ allowed: [], suppressed: [] });
    mockSend.mockResolvedValue({ data: { id: "single-id" }, error: null });
    mockBatchSend.mockResolvedValue({ data: { data: [{ id: "batch-id" }] }, error: null });
    mockInsertMany.mockResolvedValue([]);
    mockFind.mockReturnValue(queryChain([]));
    mockCountDocuments.mockResolvedValue(0);
  });

  it("records internal system mail (password reset) with the internal channel", async () => {
    await EmailService.sendEmail({
      from: "noreply@example.com",
      to: ["user@example.com"],
      subject: "Synapse 账号密码重置",
      html: "<p>reset link</p>",
    });
    await flush();
    expect(mockInsertMany).toHaveBeenCalledWith([{
      to: "user@example.com",
      subject: "Synapse 账号密码重置",
      content: "<p>reset link</p>",
      ip: "",
      channel: "internal",
    }]);
  });

  it("records one row per accepted recipient of an internal batch", async () => {
    await EmailService.sendBatchEmail({
      from: "noreply@example.com",
      messages: [
        { to: ["a@example.com"], subject: "通知", html: "<p>a</p>" },
        { to: ["b@example.com", "b@example.com"], subject: "通知", html: "<p>b</p>" },
      ],
    });
    await flush();
    expect(mockInsertMany).toHaveBeenCalledWith([
      { to: "a@example.com", subject: "通知", content: "<p>a</p>", ip: "", channel: "internal" },
      { to: "b@example.com", subject: "通知", content: "<p>b</p>", ip: "", channel: "internal" },
    ]);
  });

  it("does not double-record the public outemail channel", async () => {
    await EmailService.sendEmail({
      channel: "outemail",
      from: "noreply@example.com",
      to: ["user@example.com"],
      subject: "external",
      html: "<p>external</p>",
    });
    await flush();
    // 对外发信由 outEmailService 负责落库，避免同一次发送两行。
    expect(mockInsertMany).not.toHaveBeenCalled();
  });

  it("does not record mail the provider rejected", async () => {
    mockSend.mockResolvedValue({ data: null, error: { message: "provider error" } });
    await EmailService.sendEmail({ from: "noreply@example.com", to: ["user@example.com"], subject: "x", html: "x" });
    await flush();
    expect(mockInsertMany).not.toHaveBeenCalled();
  });

  it("never fails the send when trace persistence fails", async () => {
    mockInsertMany.mockRejectedValue(new Error("storage offline"));
    await expect(recordEmailTraces([{ channel: "internal", to: "user@example.com", subject: "x", content: "x" }]))
      .resolves.toBeUndefined();
  });

  it("maps legacy rows without a channel to outemail and filters by channel", async () => {
    mockFind.mockReturnValue(queryChain([
      { _id: "legacy", to: "old@example.com", subject: "old", content: "old", sentAt: new Date(), ip: "" },
      { _id: "internal", to: "new@example.com", subject: "new", content: "new", sentAt: new Date(), ip: "", channel: "internal" },
    ]));
    const all = await getEmailTraceRecords({ page: 1, pageSize: 20 });
    expect(all.records.map((record) => record.channel)).toEqual(["outemail", "internal"]);

    await getEmailTraceRecords({ channel: "internal" });
    expect(mockFind).toHaveBeenLastCalledWith(expect.objectContaining({ channel: "internal" }));

    await getEmailTraceRecords({ channel: "outemail" });
    expect(mockFind).toHaveBeenLastCalledWith(expect.objectContaining({ channel: { $ne: "internal" } }));
  });
});
