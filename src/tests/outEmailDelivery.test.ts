const mockReserve = jest.fn();
const mockSettle = jest.fn();
const mockRefund = jest.fn();
const mockSend = jest.fn();
const mockBatchSend = jest.fn();
const mockCreateRecord = jest.fn();
const mockInsertRecords = jest.fn();
const reservation = { id: "a".repeat(32), ledgerId: "public:outemail", resetAt: "2026-10-08T00:00:00.000Z", count: 1 };

jest.mock("../services/emailQuotaService", () => ({
  reservePublicEmailQuota: (...args: unknown[]) => mockReserve(...args),
  settleEmailQuota: (...args: unknown[]) => mockSettle(...args),
  refundEmailQuota: (...args: unknown[]) => mockRefund(...args),
  getPublicEmailQuota: jest.fn(),
}));
jest.mock("../services/emailService", () => ({
  EmailService: {
    isValidSenderDomain: () => true,
    buildSenderAddress: () => ({ email: "noreply@example.com", name: "noreply", domain: "example.com" }),
    normalizeAttachments: (attachments: unknown) => attachments,
    sendEmail: (...args: unknown[]) => mockSend(...args),
    sendBatchEmail: (...args: unknown[]) => mockBatchSend(...args),
  },
  getOutEmailServiceStatus: () => ({ available: true }),
  resolveOutEmailDomain: () => "example.com",
  getOutEmailCodeFallback: () => "test-secret",
}));
jest.mock("../services/mongoService", () => {
  const mongoose = jest.requireActual("mongoose");
  return { mongoose: {
    Schema: mongoose.Schema, models: {},
    model: (name: string) => name === "OutEmailRecord"
      ? { create: (...args: unknown[]) => mockCreateRecord(...args), insertMany: (...args: unknown[]) => mockInsertRecords(...args) }
      : { findOne: () => ({ lean: () => ({ exec: async () => null }) }) },
  } };
});
jest.mock("../services/apiKeyService", () => ({ recordUsage: jest.fn(), validateApiKey: jest.fn() }));
jest.mock("../utils/userStorage", () => ({ UserStorage: { getUserById: jest.fn() } }));
jest.mock("../utils/announcementHtml", () => ({ sanitizeEmailHtml: (html: string) => html }));
jest.mock("../services/htmlToPlainText", () => ({ plainTextifyHtmlContent: (content: string) => ({ text: content, html: content }) }));
jest.mock("../services/logger", () => ({ logger: { error: jest.fn(), warn: jest.fn() } }));

import { sendOutEmail, sendOutEmailBatch } from "../services/outEmailService";

describe("outemail delivery and quota settlement", () => {
  const single = { to: "user@example.com", subject: "test", content: "hello", code: "test-secret", ip: "127.0.0.1" };
  beforeEach(() => {
    jest.clearAllMocks();
    mockReserve.mockResolvedValue({ success: true, quotaTotal: 100, reservation });
    mockSettle.mockResolvedValue(undefined);
    mockRefund.mockResolvedValue(undefined);
    mockSend.mockResolvedValue({ success: true, messageId: "single-id", acceptedCount: 1, acceptedRecipients: ["user@example.com"] });
    mockBatchSend.mockResolvedValue({ success: true, ids: ["batch-id"], acceptedCount: 1, acceptedMessages: [{ index: 0, to: ["user@example.com"] }] });
    mockCreateRecord.mockResolvedValue({});
    mockInsertRecords.mockResolvedValue([]);
  });

  it("does not report accepted mail as failed when saving history fails", async () => {
    mockCreateRecord.mockRejectedValue(new Error("storage offline"));
    expect(await sendOutEmail(single)).toMatchObject({ success: true, messageId: "single-id" });
    expect(mockSettle).toHaveBeenCalledWith(reservation, 1);
    expect(mockRefund).not.toHaveBeenCalled();
  });

  it("refunds a provider rejection and exposes a stable transport error", async () => {
    mockSend.mockResolvedValue({ success: false, error: "provider error" });
    expect(await sendOutEmail(single)).toMatchObject({ success: false, code: "EMAIL_SEND_FAILED", statusCode: 502 });
    expect(mockRefund).toHaveBeenCalledWith(reservation);
    expect(mockCreateRecord).not.toHaveBeenCalled();
  });

  it("distinguishes unavailable quota storage from exhausted allowance", async () => {
    mockReserve.mockResolvedValue({ success: false, quotaTotal: 100, reason: "unavailable" });
    expect(await sendOutEmail(single)).toMatchObject({ success: false, code: "EMAIL_SERVICE_UNAVAILABLE", statusCode: 503 });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("counts batch recipients and records only actual deliveries", async () => {
    expect(await sendOutEmailBatch({
      code: "test-secret", ip: "127.0.0.1",
      messages: [
        { to: ["user@example.com", "suppressed@example.com"], subject: "one", content: "one" },
        { to: "other-suppressed@example.com", subject: "two", content: "two" },
      ],
    })).toMatchObject({ success: true, acceptedCount: 1, ids: ["batch-id"] });
    expect(mockReserve).toHaveBeenCalledWith(3);
    expect(mockSettle).toHaveBeenCalledWith(reservation, 1);
    expect(mockInsertRecords).toHaveBeenCalledWith([{ to: "user@example.com", subject: "one", content: "one", ip: "127.0.0.1" }]);
  });

  it("rejects a mixed-validity recipient list before quota reservation", async () => {
    expect(await sendOutEmailBatch({ code: "test-secret", ip: "127.0.0.1", messages: [{ to: ["user@example.com", "invalid"], subject: "test", content: "test" }] })).toMatchObject({ success: false, code: "INVALID_EMAIL_REQUEST", statusCode: 400 });
    expect(mockReserve).not.toHaveBeenCalled();
    expect(mockBatchSend).not.toHaveBeenCalled();
  });

  it("keeps a successful batch result if record insertion fails", async () => {
    mockInsertRecords.mockRejectedValue(new Error("storage offline"));
    expect(await sendOutEmailBatch({ code: "test-secret", ip: "127.0.0.1", messages: [{ to: "user@example.com", subject: "test", content: "test" }] })).toMatchObject({ success: true });
    expect(mockRefund).not.toHaveBeenCalled();
  });
});
