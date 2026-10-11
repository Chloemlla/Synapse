import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { NextFunction, Request, Response } from "express";

/**
 * API Key 三态处罚（RC-19）：`suspended` 直接 403（带稳定 code），`throttled` 降速并带 Retry-After，
 * 处罚到期后自动恢复到正常额度。存量 Key（没有 status 字段）必须与改动前**逐字段一致**。
 */

const mockValidateApiKey = jest.fn();
const mockRecordUsage = jest.fn(async () => undefined);
const mockConsume = jest.fn(async (_keyId: string, limit: number) => ({
  allowed: true,
  limit,
  totalHits: 1,
  resetTime: new Date(Date.now() + 60_000),
}));
const mockSetApiKeyPenalty = jest.fn(async () => ({ modified: 1, matched: 1 }));

jest.mock("../services/apiKeyService", () => ({
  validateApiKey: (...args: unknown[]) => mockValidateApiKey(...(args as [string])),
  recordUsage: (...args: unknown[]) => mockRecordUsage(...(args as [string, string])),
  setApiKeyPenalty: (...args: unknown[]) => mockSetApiKeyPenalty(...(args as [])),
}));

jest.mock("../services/apiKeyRateLimitService", () => ({
  apiKeyRateLimiter: { consume: (...args: unknown[]) => mockConsume(...(args as [string, number])) },
  SharedRateLimitUnavailableError: class SharedRateLimitUnavailableError extends Error {},
}));

jest.mock("../services/apiKeyBillingService", () => ({
  preauthorizeApiKeyBilling: jest.fn(async () => ({})),
  attachApiKeyBillingFinalizer: jest.fn(),
}));

// RC-18：调用样本记录/判定是异步旁路，这里只替掉，避免把统计管道拉进本套件。
jest.mock("../services/apiUsageWindowService", () => ({
  recordApiUsageSample: jest.fn(async () => []),
  persistApiUsageFlags: jest.fn(async () => undefined),
}));

jest.mock("../utils/userStorage", () => ({
  UserStorage: {
    getUserById: jest.fn(async () => ({ id: "u1", username: "tester", role: "user" })),
  },
}));

jest.mock("../utils/ipUtils", () => ({ getClientIP: jest.fn(() => "203.0.113.9") }));
jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { apiKeyAuth } from "../middleware/apiKeyAuth";

const baseDoc = {
  keyId: "ak_test0001",
  keyHash: "hash",
  name: "test",
  userId: "u1",
  permissions: ["status"],
  rateLimit: 60,
  expiresAt: null,
  lastUsedAt: null,
  lastUsedIp: null,
  usageCount: 0,
  enabled: true,
  billingEnabled: false,
  billingMode: "metered" as const,
  balanceCredits: 0,
  totalChargedCredits: 0,
  totalBillableRequests: 0,
  lastBillingAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function makeReq(): Request {
  return {
    method: "GET",
    path: "/api/status",
    headers: { "x-api-key": "ak_test0001" },
    ip: "203.0.113.9",
    body: {},
    query: {},
  } as unknown as Request;
}

function makeRes() {
  const setHeader = jest.fn();
  const status = jest.fn();
  const json = jest.fn();
  const res = { setHeader, status: status.mockReturnThis(), json } as unknown as Response;
  return { res, setHeader, status, json };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockConsume.mockImplementation(async (_keyId: string, limit: number) => ({
    allowed: true,
    limit,
    totalHits: 1,
    resetTime: new Date(Date.now() + 60_000),
  }));
});

describe("存量 Key（无 status 字段）行为不变", () => {
  it("按 rateLimit 正常放行", async () => {
    mockValidateApiKey.mockResolvedValue({ ...baseDoc });
    const { res } = makeRes();
    const next = jest.fn() as unknown as NextFunction;

    await apiKeyAuth("status")(makeReq(), res, next);

    expect(mockConsume).toHaveBeenCalledWith("ak_test0001", 60);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe("throttled：降速 + Retry-After", () => {
  it("额度打到 10%，并告诉客户端多久后可以再试", async () => {
    mockValidateApiKey.mockResolvedValue({
      ...baseDoc,
      status: "throttled",
      penaltyUntil: new Date(Date.now() + 30 * 60 * 1000),
      penaltySource: "auto:SPIKE",
      penaltyReason: "突发频率异常",
    });
    const { res, setHeader } = makeRes();
    const next = jest.fn() as unknown as NextFunction;

    await apiKeyAuth("status")(makeReq(), res, next);

    expect(mockConsume).toHaveBeenCalledWith("ak_test0001", 6); // 60 * 10%
    expect(setHeader).toHaveBeenCalledWith("Retry-After", expect.any(String));
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("显式 effectiveRateLimit 优先于 10% 默认", async () => {
    mockValidateApiKey.mockResolvedValue({
      ...baseDoc,
      rateLimit: 100,
      status: "throttled",
      effectiveRateLimit: 15,
      penaltyUntil: new Date(Date.now() + 60_000),
    });
    const { res } = makeRes();
    await apiKeyAuth("status")(makeReq(), res, jest.fn() as unknown as NextFunction);
    expect(mockConsume).toHaveBeenCalledWith("ak_test0001", 15);
  });

  it("处罚到期后自动恢复到正常额度", async () => {
    mockValidateApiKey.mockResolvedValue({
      ...baseDoc,
      status: "throttled",
      penaltyUntil: new Date(Date.now() - 1_000),
    });
    const { res } = makeRes();
    await apiKeyAuth("status")(makeReq(), res, jest.fn() as unknown as NextFunction);
    expect(mockConsume).toHaveBeenCalledWith("ak_test0001", 60);
  });
});

describe("suspended：直接拒绝并带稳定 code", () => {
  it("403 API_KEY_SUSPENDED + Retry-After（有时长时）", async () => {
    mockValidateApiKey.mockResolvedValue({
      ...baseDoc,
      status: "suspended",
      penaltyUntil: new Date(Date.now() + 60 * 60 * 1000),
      penaltyReason: "账户风险处置",
    });
    const { res, status, json, setHeader } = makeRes();
    const next = jest.fn() as unknown as NextFunction;

    await apiKeyAuth("status")(makeReq(), res, next);

    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: "API_KEY_SUSPENDED", reason: "账户风险处置" }));
    expect(setHeader).toHaveBeenCalledWith("Retry-After", expect.any(String));
    expect(next).not.toHaveBeenCalled();
    expect(mockConsume).not.toHaveBeenCalled();
  });

  it("永久暂停（penaltyUntil=null）不给 Retry-After", async () => {
    mockValidateApiKey.mockResolvedValue({ ...baseDoc, status: "suspended", penaltyUntil: null });
    const { res, status, setHeader } = makeRes();
    await apiKeyAuth("status")(makeReq(), res, jest.fn() as unknown as NextFunction);
    expect(status).toHaveBeenCalledWith(403);
    expect(setHeader).not.toHaveBeenCalledWith("Retry-After", expect.any(String));
  });
});
