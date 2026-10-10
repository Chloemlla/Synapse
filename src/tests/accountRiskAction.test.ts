import { beforeEach, describe, expect, it, jest } from "@jest/globals";

/**
 * 统一风险出口 `applyAccountRiskAction`（RC-07）的语义。
 *
 * 这里钉的是四条会直接造成事故的性质：
 * 1. 封停**必须**撤销存量会话（否则“封了但还能用”）；超管不得经此出口被封；
 * 2. 档位单调（观察/受限不会被同一出口降回去），只有 unban / clear_flags 是显式降级；
 * 3. 每次动作都写 `ACCOUNT_RISK_ACTION` 事件与审计（事后能回答“谁因为什么封的”）；
 * 4. 没有理由就不许处罚（无理由的处罚既不可申诉也不可审计）。
 */

const mockGetAccountRiskState = jest.fn();
const mockUpdateUser = jest.fn();
const mockCountSuperadmins = jest.fn();
const mockRevokeAllAuthSessions = jest.fn();
const mockAuditLog = jest.fn();
const mockCreate = jest.fn(async (doc: Record<string, unknown>) => doc);

jest.mock("../services/userService", () => ({
  UserModel: { countDocuments: () => ({ exec: async () => 2 }) },
  getAccountRiskState: (...args: unknown[]) => mockGetAccountRiskState(...args),
  updateUser: (...args: unknown[]) => mockUpdateUser(...args),
}));

jest.mock("../services/authSessionService", () => ({
  getLatestAuthSessionIpLocation: jest.fn(async () => null),
  revokeAllAuthSessions: (...args: unknown[]) => mockRevokeAllAuthSessions(...args),
}));

jest.mock("../services/auditLogService", () => ({
  AuditLogService: { log: (...args: unknown[]) => mockAuditLog(...args) },
}));

jest.mock("../models/securityEventModel", () => ({
  SecurityEvent: { create: (doc: Record<string, unknown>) => mockCreate(doc) },
}));

jest.mock("../models/accountIpSignalModel", () => ({ AccountIpSignal: {} }));
jest.mock("../models/deviceTrackingModel", () => ({ DeviceTracking: {} }));
jest.mock("../services/ipRiskService", () => ({
  getCachedIpRisk: jest.fn(async () => null),
  getIpRisk: jest.fn(async () => ({ source: "unavailable" })),
  CACHE_LOOKUP_STATUS: "cache",
}));

jest.mock("../services/mongoService", () => ({
  mongoose: { connection: { readyState: 1 } },
  isConnected: () => true,
}));

jest.mock("../config/config", () => ({
  config: {
    jwtSecret: "test-secret",
    accountRisk: {
      enabled: true,
      evaluateOnLogin: true,
      windowDays: 30,
      ipSignalRetentionDays: 180,
      highRiskIpScore: 66,
      minDistinctHighRiskIps: 2,
      watchScoreThreshold: 50,
      restrictedScoreThreshold: 80,
      dangerScoreThreshold: 90,
      autoEscalationCap: "watch",
      newAccountWatchDays: 7,
      stepUpTtlSeconds: 3600,
      stepUpMode: "sensitive",
      stepUpEnabled: false,
      stepUpChallengeTtlSeconds: 120,
      stepUpGrantTtlSeconds: 30,
      stepUpGrantMaxUses: 5,
    },
  },
}));

import { applyAccountRiskAction } from "../services/accountRiskService";

const baseState = (overrides: Record<string, unknown> = {}) => ({
  id: "u1",
  role: "user",
  riskTier: "normal",
  riskScore: 0,
  riskFlags: [],
  stepUpUntil: 0,
  stepUpMode: "sensitive",
  accountStatus: "active",
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAccountRiskState.mockResolvedValue(baseState());
  mockUpdateUser.mockResolvedValue(baseState());
  mockRevokeAllAuthSessions.mockResolvedValue(undefined);
  mockAuditLog.mockResolvedValue(undefined);
  void mockCountSuperadmins;
});

describe("applyAccountRiskAction", () => {
  it("没有理由不许处罚（既不可申诉也不可审计）", async () => {
    await expect(
      applyAccountRiskAction({ userId: "u1", action: "suspend", reason: "  ", operatorId: "admin1" }),
    ).resolves.toMatchObject({ ok: false, code: "REASON_REQUIRED" });
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it("superadmin 不能被该出口封停（封停超管必须走专用路径）", async () => {
    mockGetAccountRiskState.mockResolvedValue(baseState({ role: "superadmin" }));
    await expect(
      applyAccountRiskAction({ userId: "u9", action: "suspend", reason: "测试", operatorId: "admin1" }),
    ).resolves.toMatchObject({ ok: false, code: "TARGET_IS_SUPERADMIN" });
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it("封停：写 accountStatus、清 step-up、撤销存量会话，并写事件与审计", async () => {
    const result = await applyAccountRiskAction({
      userId: "u1",
      action: "suspend",
      reason: "多次刷量",
      operatorId: "admin1",
    });

    expect(result).toMatchObject({ ok: true, action: "suspend", toTier: "normal" });
    const patch = mockUpdateUser.mock.calls[0][1] as Record<string, unknown>;
    expect(patch.accountStatus).toBe("suspended");
    expect(patch.stepUpUntil).toBe(0);
    // 封停不踢会话 = “封了但还能用”
    expect(mockRevokeAllAuthSessions).toHaveBeenCalledWith("u1");

    await Promise.resolve();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const event = mockCreate.mock.calls[0][0];
    expect(event.eventType).toBe("ACCOUNT_RISK_ACTION");
    expect((event.eventData as Record<string, unknown>).action).toBe("suspend");
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ module: "security", action: "security.account-risk.suspend", targetId: "u1" }),
    );
  });

  it("标记观察：只升不降", async () => {
    await applyAccountRiskAction({ userId: "u1", action: "mark_watch", reason: "新号观察", operatorId: "admin1" });
    expect((mockUpdateUser.mock.calls[0][1] as Record<string, unknown>).riskTier).toBe("watch");

    jest.clearAllMocks();
    mockGetAccountRiskState.mockResolvedValue(baseState({ riskTier: "restricted", stepUpUntil: Date.now() + 1000 }));
    mockUpdateUser.mockResolvedValue(baseState());
    await applyAccountRiskAction({ userId: "u1", action: "mark_watch", reason: "复核后仍受限", operatorId: "admin1" });
    // restricted 不会被“标记观察”降回去
    expect((mockUpdateUser.mock.calls[0][1] as Record<string, unknown>).riskTier).toBeUndefined();
  });

  it("受限：升到 restricted 并签出 step-up 窗口与范围", async () => {
    const before = Date.now();
    await applyAccountRiskAction({
      userId: "u1",
      action: "restrict",
      reason: "命中多个 flag",
      operatorId: "auto",
      durationHours: 2,
    });
    const patch = mockUpdateUser.mock.calls[0][1] as Record<string, unknown>;
    expect(patch.riskTier).toBe("restricted");
    expect(patch.stepUpMode).toBe("sensitive");
    expect(patch.stepUpUntil as number).toBeGreaterThanOrEqual(before + 2 * 60 * 60 * 1000 - 5_000);
  });

  it("解除：显式降级并清空旗标、分数与 step-up 窗口", async () => {
    mockGetAccountRiskState.mockResolvedValue(
      baseState({ riskTier: "restricted", riskFlags: ["HIGH_RISK_LOGIN_IP"], riskScore: 82, accountStatus: "suspended" }),
    );
    const result = await applyAccountRiskAction({
      userId: "u1",
      action: "unban",
      reason: "人工复核确认为误判",
      operatorId: "admin1",
    });

    expect(result).toMatchObject({ ok: true, toTier: "normal" });
    const patch = mockUpdateUser.mock.calls[0][1] as Record<string, unknown>;
    expect(patch).toMatchObject({
      accountStatus: "active",
      riskTier: "normal",
      riskFlags: [],
      riskScore: 0,
      stepUpUntil: 0,
    });
    // 解除封停不需要再踢会话（本来就没有有效会话）
    expect(mockRevokeAllAuthSessions).not.toHaveBeenCalled();
  });

  it("已是封停状态时重复封停返回明确错误（幂等语义由调用方决定）", async () => {
    mockGetAccountRiskState.mockResolvedValue(baseState({ accountStatus: "suspended" }));
    await expect(
      applyAccountRiskAction({ userId: "u1", action: "suspend", reason: "重复操作", operatorId: "admin1" }),
    ).resolves.toMatchObject({ ok: false, code: "ALREADY_SUSPENDED" });
  });
});
