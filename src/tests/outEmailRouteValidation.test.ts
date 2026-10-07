import express from "express";
import request from "supertest";

const mockSendOutEmail = jest.fn();
const mockSendOutEmailBatch = jest.fn();
jest.mock("../middleware/adminScope", () => ({ requireAdminScope: (_q: unknown, _s: unknown, next: () => void) => next() }));
jest.mock("../middleware/rateLimiter", () => ({ createLimiter: () => (_q: unknown, _s: unknown, next: () => void) => next() }));
jest.mock("../middleware/auth", () => {
  const pass = (_q: unknown, _s: unknown, next: () => void) => next();
  return { authMiddlewareV2: pass, adminAuthMiddleware: pass, authenticateSuperAdmin: pass };
});
jest.mock("../services/emailService", () => ({
  getOutEmailServiceStatus: () => ({ available: true }), resolveOutEmailDomain: () => "example.com",
}));
jest.mock("../services/outEmailService", () => ({
  sendOutEmail: (...args: unknown[]) => mockSendOutEmail(...args),
  sendOutEmailBatch: (...args: unknown[]) => mockSendOutEmailBatch(...args),
}));
jest.mock("../utils/logger", () => ({ __esModule: true, default: { error: jest.fn() } }));

import outemailRoutes from "../routes/outemailRoutes";
const app = express();
app.use(express.json());
app.use("/api/outemail", outemailRoutes);

describe("public email request integrity", () => {
  const message = { to: "first+tag@example.com", subject: "subject", content: "body" };
  beforeEach(() => {
    jest.clearAllMocks();
    mockSendOutEmail.mockResolvedValue({ success: true, messageId: "sent-1" });
    mockSendOutEmailBatch.mockResolvedValue({ success: true, ids: ["sent-1"] });
  });

  it.each([{ to: "first+tag@example.com" }, { to: ["first+tag@example.com"] }])("accepts a complete single-recipient request %j", async ({ to }) => {
    const response = await request(app).post("/api/outemail/send").send({ ...message, to });
    expect(response.status).toBe(200);
    expect(mockSendOutEmail).toHaveBeenCalledWith(expect.objectContaining({ to: message.to }));
  });

  it("rejects multiple recipients instead of reporting only the first as a successful send", async () => {
    const response = await request(app).post("/api/outemail/send").send({ ...message, to: [message.to, "second@example.com"] });
    expect(response.status).toBe(400);
    expect(mockSendOutEmail).not.toHaveBeenCalled();
  });

  it.each([
    { messages: [message, { ...message, to: [message.to, "invalid"] }] },
    { messages: [message, { ...message, subject: {} }] },
    { messages: Array.from({ length: 101 }, () => message) },
  ])("rejects an invalid batch without silently dropping messages", async ({ messages }) => {
    const response = await request(app).post("/api/outemail/batch-send").send({ messages });
    expect(response.status).toBe(400);
    expect(mockSendOutEmailBatch).not.toHaveBeenCalled();
  });

  it("preserves the quota error code, status and server retry interval", async () => {
    mockSendOutEmail.mockResolvedValue({ success: false, statusCode: 429, code: "EMAIL_RATE_LIMITED", error: "稍后重试", retryAfterSeconds: 12 });
    const response = await request(app).post("/api/outemail/send").send(message);
    expect(response.status).toBe(429);
    expect(response.headers["retry-after"]).toBe("12");
    expect(response.body.code).toBe("EMAIL_RATE_LIMITED");
  });

  it("reports temporary service unavailability separately from quota exhaustion", async () => {
    mockSendOutEmailBatch.mockResolvedValue({ success: false, statusCode: 503, code: "EMAIL_SERVICE_UNAVAILABLE", error: "暂不可用" });
    const response = await request(app).post("/api/outemail/batch-send").send({ messages: [message] });
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("EMAIL_SERVICE_UNAVAILABLE");
  });
});
