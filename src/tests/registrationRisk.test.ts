import { beforeEach, describe, expect, it, jest } from "@jest/globals";

/**
 * 注册反滥用闸门（RC-05）。
 *
 * 只测判定逻辑与计数口径（不连库）：
 * - **规范化**：`+tag` / gmail 点号必须折成同一个身份键，否则“换个写法”就是最廉价的批量注册；
 * - **三维配额**：IP / 指纹 / 邮箱变体各自独立触发，且只统计**成功**注册；
 * - **IDC + 无邀请码**是独立规则（不与风险分耦合），有邀请码时放行。
 */

const mockCount = jest.fn();
const mockDistinct = jest.fn();
const mockCreate = jest.fn(async (doc: Record<string, unknown>) => doc);
const mockGetCachedIpRisk = jest.fn();

jest.mock("../models/registrationAttemptModel", () => ({
  RegistrationAttempt: {
    countDocuments: (...args: unknown[]) => mockCount(...(args as [])),
    distinct: (...args: unknown[]) => mockDistinct(...(args as [])),
    create: (doc: Record<string, unknown>) => mockCreate(doc),
  },
}));

jest.mock("../services/ipRiskService", () => ({
  getCachedIpRisk: (...args: unknown[]) => mockGetCachedIpRisk(...(args as [string])),
}));

// 用**真实的 mongoose**（而不是手写替身）：blockedIdentityModel 在 import 阶段就要
// `mongoose.Schema`/`mongoose.model`，手写替身会在 require 阶段抛 “Schema is not a constructor”，
// 把“闸门逻辑有问题”伪装成“套件跑不起来”。readyState 在 beforeEach 里强行置 1（connection 上是 getter）。
jest.mock("../services/mongoService", () => {
  const actualMongoose = jest.requireActual("mongoose");
  return { mongoose: actualMongoose, isConnected: () => true };
});

jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { evaluateRegistrationRisk, recordRegistrationAttempt } from "../services/registrationRiskService";
import { mongoose } from "../services/mongoService";

const baseInput = {
  ipAddress: "203.0.113.10",
  fingerprint: "fp-1",
  email: "newuser@gmail.com",
  hasInvite: false,
};

beforeEach(() => {
  jest.clearAllMocks();
  // 强制 readyState=1：accountRisk/registration 这些服务的 mongoReady() 都会读它。
  (mongoose.connection as unknown as { readyState: number }).readyState = 1;
  mockCount.mockResolvedValue(0);
  mockDistinct.mockResolvedValue([]);
  mockGetCachedIpRisk.mockResolvedValue(null);
});

describe("evaluateRegistrationRisk", () => {
  it("同 IP 24h 内的成功注册超限 → REGISTRATION_IP_QUOTA", async () => {
    mockCount.mockResolvedValueOnce(3).mockResolvedValueOnce(0);

    const decision = await evaluateRegistrationRisk(baseInput);
    expect(decision).toMatchObject({ allowed: false, code: "REGISTRATION_IP_QUOTA" });
    // 计数只看成功注册，且限定窗口
    const firstQuery = mockCount.mock.calls[0][0] as Record<string, unknown>;
    expect(firstQuery.outcome).toBe("succeeded");
    expect(firstQuery.ipAddress).toBe("203.0.113.10");
    expect(firstQuery.createdAt).toBeTruthy();
  });

  it("同指纹超限 → REGISTRATION_DEVICE_QUOTA（与 IP 独立）", async () => {
    mockCount.mockResolvedValueOnce(0).mockResolvedValueOnce(2);

    const decision = await evaluateRegistrationRisk(baseInput);
    expect(decision).toMatchObject({ allowed: false, code: "REGISTRATION_DEVICE_QUOTA" });
  });

  it("同一来源出现过太多不同邮箱 → REGISTRATION_EMAIL_VARIANTS", async () => {
    mockDistinct.mockResolvedValue(["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com"]);

    const decision = await evaluateRegistrationRisk(baseInput);
    expect(decision).toMatchObject({ allowed: false, code: "REGISTRATION_EMAIL_VARIANTS" });
  });

  it("已出现过的邮箱（同一身份再次尝试）不计入变体上限", async () => {
    mockDistinct.mockResolvedValue(["newuser@gmail.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com"]);

    await expect(evaluateRegistrationRisk(baseInput)).resolves.toMatchObject({ allowed: true });
  });

  it("机房/IDC 出口 + 无邀请码 → 拒绝；带邀请码 → 放行", async () => {
    mockGetCachedIpRisk.mockResolvedValue({ risk: 20, flags: ["datacenter"], networkType: "hosting" });

    await expect(evaluateRegistrationRisk(baseInput)).resolves.toMatchObject({
      allowed: false,
      code: "REGISTRATION_IDC_NO_INVITE",
    });
    await expect(evaluateRegistrationRisk({ ...baseInput, hasInvite: true })).resolves.toMatchObject({
      allowed: true,
    });
  });

  it("普通住宅 IP 无历史 → 放行，并回传风险分快照", async () => {
    mockGetCachedIpRisk.mockResolvedValue({ risk: 12, flags: [], networkType: "residential" });
    await expect(evaluateRegistrationRisk(baseInput)).resolves.toMatchObject({ allowed: true, ipRiskScore: 12 });
  });
});

describe("recordRegistrationAttempt", () => {
  it("落库时把邮箱折叠成规范化键（变体不再各算一个身份）", async () => {
    await recordRegistrationAttempt({
      ipAddress: "203.0.113.10",
      fingerprint: "fp-1",
      email: "User+Spam@Gmail.com",
      inviteCode: "INV",
      outcome: "succeeded",
    });

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const doc = mockCreate.mock.calls[0][0];
    expect(doc.emailCanonical).toBe("user@gmail.com");
    // 原值仍留一份仅供调查，但不作为检索键。
    expect(doc.emailRaw).toBe("User+Spam@Gmail.com");
    expect(doc.outcome).toBe("succeeded");
  });
});
