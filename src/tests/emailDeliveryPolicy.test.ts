const mockSend = jest.fn();
const mockBatchSend = jest.fn();
const mockFilterSuppressed = jest.fn();
const mockClients = jest.fn();
let mockConfig = {
  enabled: true, resendDomain: "example.com", resendApiKey: "re_primary12345", quotaTotal: 1,
  outemailEnabled: true, outemailDomain: "example.com", outemailApiKey: "re_outemail12345", outemailQuotaTotal: 10,
  outemailCode: "",
};

jest.mock("resend", () => ({ Resend: jest.fn().mockImplementation((key: string) => {
  mockClients(key);
  return { emails: { send: mockSend }, batch: { send: mockBatchSend } };
}) }));
jest.mock("../services/emailQuotaService", () => ({}));
jest.mock("../services/runtimeConfigService", () => ({ RuntimeConfigService: { getCachedConfig: () => ({ email: mockConfig }) } }));
jest.mock("../services/emailSuppressionService", () => ({
  normalizeEmail: (email: string) => typeof email === "string" && email.includes("@") ? email.trim().toLowerCase() : "",
  filterSuppressedEmails: (...args: unknown[]) => mockFilterSuppressed(...args),
}));
jest.mock("../services/logger", () => ({ logger: { log: jest.fn(), error: jest.fn(), warn: jest.fn() } }));
jest.mock("../utils/logger", () => ({ __esModule: true, default: { info: jest.fn(), error: jest.fn() } }));

import { EmailService, getOutEmailServiceStatus } from "../services/emailService";
import { sendEmail } from "../services/emailSender";

describe("Email delivery policy", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConfig = { ...mockConfig, enabled: true, outemailEnabled: true };
    mockFilterSuppressed.mockResolvedValue({ allowed: [], suppressed: [] });
    mockSend.mockResolvedValue({ data: { id: "single-id" }, error: null });
    mockBatchSend.mockResolvedValue({ data: { data: [{ id: "batch-id" }] }, error: null });
  });

  it("account mail never consumes self-service quota, including legacy checkQuota=true callers", async () => {
    expect(await sendEmail({ to: "user@example.com", subject: "Verify", html: "hello", logTag: "test", checkQuota: true, purpose: "transactional" })).toEqual({ success: true });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockFilterSuppressed).toHaveBeenCalledWith(["user@example.com"], { transactional: true });
  });

  it("notifications retain unsubscribe filtering by default", async () => {
    mockFilterSuppressed.mockResolvedValue({ allowed: [], suppressed: ["user@example.com"] });
    expect(await sendEmail({ to: "user@example.com", subject: "News", html: "hello", logTag: "test" })).toMatchObject({ success: false });
    expect(mockFilterSuppressed).toHaveBeenCalledWith(["user@example.com"], { transactional: false });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("same-domain primary and public delivery use their own credentials", async () => {
    const mail = { from: "noreply@example.com", to: ["user@example.com"], subject: "test", html: "test" };
    await EmailService.sendEmail(mail);
    await EmailService.sendEmail({ ...mail, channel: "outemail" });
    expect(mockClients.mock.calls.map(([key]) => key)).toEqual(["re_primary12345", "re_outemail12345"]);
  });

  it("disabling primary mail does not fall through to enabled public credentials", async () => {
    mockConfig = { ...mockConfig, enabled: false };
    expect(await EmailService.getServiceStatus()).toMatchObject({ available: false });
    expect(getOutEmailServiceStatus()).toMatchObject({ available: true });
    expect(await sendEmail({ to: "user@example.com", subject: "test", html: "test", logTag: "test" })).toMatchObject({ success: false });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("batch returns provider IDs and counts only deliverable, deduplicated recipients", async () => {
    mockFilterSuppressed.mockResolvedValue({ allowed: [], suppressed: ["suppressed@example.com"] });
    const result = await EmailService.sendBatchEmail({
      from: "noreply@example.com",
      messages: [
        { to: ["user@example.com", "USER@example.com", "suppressed@example.com"], subject: "one", html: "one" },
        { to: ["suppressed@example.com"], subject: "two", html: "two" },
      ],
    });
    expect(result).toMatchObject({ success: true, ids: ["batch-id"], acceptedCount: 1, acceptedMessages: [{ index: 0, to: ["user@example.com"] }] });
    expect(mockBatchSend.mock.calls[0][0]).toHaveLength(1);
  });

  it("single delivery exposes actual accepted recipients for quota settlement", async () => {
    mockFilterSuppressed.mockResolvedValue({ allowed: [], suppressed: ["suppressed@example.com"] });
    const result = await EmailService.sendEmail({ from: "noreply@example.com", to: ["user@example.com", "suppressed@example.com"], subject: "test", html: "test" });
    expect(result).toMatchObject({ success: true, acceptedCount: 1, acceptedRecipients: ["user@example.com"] });
  });

  it("mixed malformed and valid batch recipients fail before provider delivery", async () => {
    expect(await EmailService.sendBatchEmail({ from: "noreply@example.com", messages: [{ to: ["user@example.com", "invalid"], subject: "test", html: "test" }] })).toMatchObject({ success: false });
    expect(mockBatchSend).not.toHaveBeenCalled();
  });

  it("accepts plus-addressing on allowed recipient domains", () => {
    expect(EmailService.isValidEmail("user+verify@GMAIL.COM")).toBe(true);
  });
});
