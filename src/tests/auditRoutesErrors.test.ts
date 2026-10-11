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
    ["/quota", "getOutEmailQuota", 503, { success: false, code: "EMAIL_SERVICE_UNAVAILABLE", error: "邮件额度暂时无法查询，请稍后重试" }],
    ["/records", "getOutEmailRecords", 500, { success: false, error: "查询失败" }],
    ["/records/item", "getOutEmailRecordById", 500, { success: false, error: "查询失败" }],
  ] as const)("does not expose errors from GET %s", async (path, method, expectedStatus, expectedBody) => {
    (emailService[method] as jest.Mock).mockRejectedValue(failure);
    const response = await request(app).get(`/email${path}`);
    expect(response.status).toBe(expectedStatus);
    expect(response.body).toEqual(expectedBody);
    // 核心不变式：上游报错原文（含内网主机名/凭据）绝不外泄。
    expect(JSON.stringify(response.body)).not.toContain(failure.message);
  });

  it("preserves a missing-record 404 separately from a database failure", async () => {
    (emailService.getOutEmailRecordById as jest.Mock).mockResolvedValue(null);
    await request(app).get("/email/records/missing").expect(404);
  });

  it.each([
    ["/send", "sendOutEmail", { to: "receiver@example.com", subject: "subject", content: "body" }],
    ["/batch-send", "sendOutEmailBatch", { messages: [{ to: "receiver@example.com", subject: "subject", content: "body" }] }],
  ] as const)("does not expose errors from POST %s", async (path, method, body) => {
    (emailService[method] as jest.Mock).mockRejectedValue(failure);
    const response = await request(app).post(`/email${path}`).send(body);
    // 发送类失败统一 503 + 稳定 code（邮件服务不可用是“稍后重试”，不是服务端 bug）。
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ success: false, code: "EMAIL_SERVICE_UNAVAILABLE", error: "邮件服务暂时不可用，请稍后重试" });
    expect(JSON.stringify(response.body)).not.toContain(failure.message);
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
