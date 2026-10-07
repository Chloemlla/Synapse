import type { Request, Response } from "express";

jest.mock("../services/emailService", () => ({
  EmailService: {
    sendEmail: jest.fn(), sendSimpleEmail: jest.fn(), sendMarkdownEmail: jest.fn(), sendBatchHtmlEmails: jest.fn(),
    isValidSenderDomain: jest.fn(() => true),
    validateEmails: jest.fn((emails: string[]) => ({ valid: emails, invalid: [] })),
  },
  getAllSenderDomains: jest.fn(() => ["chloemlla.com"]),
  getEmailQuota: jest.fn(), consumeEmailQuota: jest.fn(), refundEmailQuota: jest.fn(), settleEmailQuota: jest.fn(),
}));
jest.mock("../services/emailSuppressionService", () => ({ addSuppression: jest.fn(), verifyUnsubscribeToken: jest.fn() }));
jest.mock("../utils/logger", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

import { EmailController } from "../controllers/emailController";
import { EmailService, consumeEmailQuota, refundEmailQuota, settleEmailQuota } from "../services/emailService";

const reservation = { id: "reservation", ledgerId: "ledger", userId: "admin", count: 2, resetAt: "2026-10-08T00:00:00Z" };
const bodies = {
  sendEmail: { html: "<p>Notice</p>" },
  sendSimpleEmail: { content: "Notice" },
  sendMarkdownEmail: { markdown: "# Notice" },
  sendEmailBatch: { text: "Notice" },
};
type Method = keyof typeof bodies;
function request(method: Method, extra: Record<string, unknown> = {}) {
  return { user: { id: "admin" }, body: { from: "noreply@chloemlla.com", to: ["one@gmail.com", "two@gmail.com"], subject: "Notice", ...bodies[method], ...extra } } as unknown as Request;
}
function response() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis(), setHeader: jest.fn() } as unknown as Response;
}
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(consumeEmailQuota).mockResolvedValue({ success: true, quotaTotal: 100, reservation });
  jest.mocked(refundEmailQuota).mockResolvedValue(undefined);
  jest.mocked(settleEmailQuota).mockResolvedValue(undefined);
  for (const send of [EmailService.sendEmail, EmailService.sendSimpleEmail, EmailService.sendMarkdownEmail, EmailService.sendBatchHtmlEmails]) {
    jest.mocked(send).mockReset().mockResolvedValue({ success: true, acceptedCount: 2 });
  }
});

describe("EmailController delivery and quota", () => {
  it("validates configured custom sender domains separately from recipient policy", async () => {
    await EmailController.sendEmail(request("sendEmail", { from: "noreply@mail.example.com" }), response());
    expect(EmailService.isValidSenderDomain).toHaveBeenCalledWith("noreply@mail.example.com");
    expect(EmailService.validateEmails).toHaveBeenCalledWith(["one@gmail.com", "two@gmail.com"]);
    expect(EmailService.sendEmail).toHaveBeenCalled();
  });
  it.each(Object.keys(bodies) as Method[])("%s shares one budget and reserves recipients", async (method) => {
    const res = response();
    await EmailController[method](request(method), res);
    expect(consumeEmailQuota).toHaveBeenCalledWith("admin", undefined, 2);
    expect(settleEmailQuota).toHaveBeenCalledWith(reservation, 2);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, acceptedCount: 2 }));
  });

  it("settles only recipients accepted after suppression", async () => {
    jest.mocked(EmailService.sendEmail).mockResolvedValue({ success: true, acceptedCount: 1 });
    await EmailController.sendEmail(request("sendEmail"), response());
    expect(settleEmailQuota).toHaveBeenCalledWith(reservation, 1);
    expect(refundEmailQuota).not.toHaveBeenCalled();
  });

  it("refunds exactly once when transport rejects", async () => {
    jest.mocked(EmailService.sendEmail).mockRejectedValue(new Error("transport unavailable"));
    const res = response();
    await EmailController.sendEmail(request("sendEmail"), res);
    expect(refundEmailQuota).toHaveBeenCalledTimes(1);
    expect(refundEmailQuota).toHaveBeenCalledWith(reservation);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it("settles a definite provider rejection to zero", async () => {
    jest.mocked(EmailService.sendSimpleEmail).mockResolvedValue({ success: false, error: "Rejected", acceptedCount: 0 });
    await EmailController.sendSimpleEmail(request("sendSimpleEmail"), response());
    expect(settleEmailQuota).toHaveBeenCalledWith(reservation, 0);
  });

  it("does not refund or misreport accepted mail when settlement fails", async () => {
    jest.mocked(settleEmailQuota).mockRejectedValue(new Error("database unavailable"));
    const res = response();
    await EmailController.sendEmail(request("sendEmail"), res);
    expect(refundEmailQuota).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it.each([{ to: [] }, { to: {} }, { to: [42] }, { from: {} }, { html: {} }, { subject: " " }, { html: "x".repeat(50_001) }])("rejects malformed input before reserving quota", async (extra) => {
    const res = response();
    await EmailController.sendEmail(request("sendEmail", extra), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(consumeEmailQuota).not.toHaveBeenCalled();
    expect(EmailService.sendEmail).not.toHaveBeenCalled();
  });

  it.each([["exhausted", 429], ["unavailable", 503]] as const)("reports %s distinctly", async (reason, status) => {
    jest.mocked(consumeEmailQuota).mockResolvedValue({ success: false, quotaTotal: 0, reason });
    const res = response();
    await EmailController.sendEmail(request("sendEmail"), res);
    expect(res.status).toHaveBeenCalledWith(status);
    expect(EmailService.sendEmail).not.toHaveBeenCalled();
  });
});
