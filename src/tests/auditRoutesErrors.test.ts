import express from "express";
import request from "supertest";
import outemail from "../routes/outemailRoutes";
import ipVerification from "../routes/ipVerificationRoutes";
import * as emailService from "../services/outEmailService";
import IpVerificationService from "../services/ipVerificationService";

jest.mock("../middleware/rateLimiter", () => ({ createLimiter: () => (_req: any, _res: any, next: () => void) => next() }));
jest.mock("../middleware/routeLimiters", () => ({ createLimiter: () => (_req: any, _res: any, next: () => void) => next() }));
jest.mock("../middleware/adminScope", () => ({ requireAdminScope: (_req: any, _res: any, next: () => void) => next() }));
jest.mock("../middleware/auth", () => ({
  authMiddlewareV2: (_req: any, _res: any, next: () => void) => next(),
  adminAuthMiddleware: (_req: any, _res: any, next: () => void) => next(),
  authenticateSuperAdmin: (_req: any, _res: any, next: () => void) => next(),
}));
jest.mock("../services/emailService", () => ({ getOutEmailServiceStatus: jest.fn(), resolveOutEmailDomain: jest.fn() }));
jest.mock("../services/outEmailService", () => ({
  getOutEmailAuthStatus: jest.fn(), getOutEmailQuota: jest.fn(), sendOutEmail: jest.fn(),
  sendOutEmailBatch: jest.fn(), getOutEmailRecords: jest.fn(), getOutEmailRecordById: jest.fn(),
}));
jest.mock("../services/ipVerificationService", () => ({ __esModule: true, default: {
  initializeSession: jest.fn(), completeVerification: jest.fn(),
} }));
jest.mock("../utils/logger", () => ({ __esModule: true, default: { error: jest.fn() } }));

describe("public route error boundaries", () => {
  const app = express();
  app.use(express.json());
  app.use("/email", outemail);
  app.use("/verification", ipVerification);
  const failure = new Error("private upstream credential and hostname");

  beforeEach(() => jest.clearAllMocks());

  it.each([
    ["/quota", "getOutEmailQuota", "无法获取配额信息"],
    ["/records", "getOutEmailRecords", "查询失败"],
    ["/records/item", "getOutEmailRecordById", "查询失败"],
  ] as const)("does not expose errors from GET %s", async (path, method, error) => {
    (emailService[method] as jest.Mock).mockRejectedValue(failure);
    const response = await request(app).get(`/email${path}`);
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ success: false, error });
  });

  it("preserves a missing-record 404 separately from a database failure", async () => {
    (emailService.getOutEmailRecordById as jest.Mock).mockResolvedValue(null);
    await request(app).get("/email/records/missing").expect(404);
  });

  it.each([
    ["/send", "sendOutEmail", { to: "receiver@example.com", subject: "subject", content: "body" }, "发送失败"],
    ["/batch-send", "sendOutEmailBatch", { messages: [{ to: "receiver@example.com", subject: "subject", content: "body" }] }, "批量发送失败"],
  ] as const)("does not expose errors from POST %s", async (path, method, body, error) => {
    (emailService[method] as jest.Mock).mockRejectedValue(failure);
    const response = await request(app).post(`/email${path}`).send(body);
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error });
  });

  it.each([
    ["/session", "initializeSession", "Failed to initialize verification session"],
    ["/complete", "completeVerification", "Failed to complete verification"],
  ] as const)("does not expose errors from verification %s", async (path, method, error) => {
    (IpVerificationService[method] as jest.Mock).mockRejectedValue(failure);
    const response = await request(app).post(`/verification${path}`).send({ fingerprint: "device" });
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ success: false, verified: false, requiresVerification: true, error, tokenTtlMinutes: expect.any(Number) });
  });
});
