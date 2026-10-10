const mockModels: Record<string, any> = {};
jest.mock("../models/lumen/index", () => {
  for (const name of ["Entitlement", "CrashReport", "AdminCrashReport", "PendingLogin", "Session", "User", "AdminSession", "AdminActionAudit"]) {
    mockModels[name] = {
      findOne: jest.fn(), findById: jest.fn(), findOneAndDelete: jest.fn(),
      findOneAndUpdate: jest.fn(), create: jest.fn(), deleteOne: jest.fn(),
      updateOne: jest.fn(), countDocuments: jest.fn(),
    };
  }
  return mockModels;
});
jest.mock("../config/lumen", () => ({ lumenConfig: {
  acceptUnverifiedPurchases: false, accessTokenTtlSeconds: 7200, refreshTokenTtlSeconds: 86400,
  adminSessionTtlSeconds: 3600, adminRefreshTtlSeconds: 86400,
} }));
jest.mock("../services/lumen/outemail.service", () => ({ sendLoginCode: jest.fn() }));
jest.mock("../utils/logger", () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const { verifyGooglePurchase } = require("../services/lumen/entitlements.service");
const { recordCrashReport } = require("../services/lumen/crash.service");
const { verifyEmailLogin, refreshSession } = require("../services/lumen/auth.service");
const { refreshAdminSession, applyAdminAction } = require("../services/lumen/admin.service");

function query(value: unknown) {
  const chain: any = { exec: () => Promise.resolve(value), lean: () => chain, select: () => chain };
  return chain;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockModels.Session.create.mockResolvedValue({});
  mockModels.AdminSession.create.mockResolvedValue({});
});

it("manual plans omit sparse unique purchase tokens and remove legacy empty placeholders", async () => {
  mockModels.Entitlement.updateOne.mockReturnValue(query({}));
  mockModels.AdminActionAudit.create.mockResolvedValue({});
  await applyAdminAction("operator", "change-plan", { userId: "u1", tier: "PRO" });
  await applyAdminAction("operator", "change-plan", { userId: "u2", tier: "PLUS" });
  for (const [, update] of mockModels.Entitlement.updateOne.mock.calls) {
    expect(update.$setOnInsert).not.toHaveProperty("purchaseToken");
    expect(update.$unset).toEqual({ purchaseToken: "" });
  }
});

it("concurrent purchase retries reuse the same primary key and return the recorded entitlement", async () => {
  let stored: any = null;
  mockModels.Entitlement.findOne.mockImplementation(() => query(stored));
  mockModels.Entitlement.create.mockImplementation(async (doc: any) => {
    if (stored) throw Object.assign(new Error("duplicate"), { code: 11000 });
    stored = doc;
    return doc;
  });
  const results = await Promise.all([
    verifyGooglePurchase("u1", "pro_monthly", "purchase-retry"),
    verifyGooglePurchase("u1", "pro_monthly", "purchase-retry"),
  ]);
  expect(results[0].entitlement.id).toBe(results[1].entitlement.id);
  expect(results.map((r) => r.tier)).toEqual(["FREE", "FREE"]);
  await expect(verifyGooglePurchase("u1", "pro_monthly", "purchase-retry")).resolves.toMatchObject({ tier: "FREE", status: "pending" });
  expect(mockModels.Entitlement.create.mock.calls[0][0]._id).toBe(mockModels.Entitlement.create.mock.calls[1][0]._id);
});

it("concurrent crash retries aggregate once and report the losing insert as a duplicate", async () => {
  let stored: any = null;
  mockModels.CrashReport.findOne.mockImplementation(() => query(stored));
  mockModels.CrashReport.countDocuments.mockReturnValue(query(0));
  mockModels.CrashReport.create.mockImplementation(async (doc: any) => {
    if (stored) throw Object.assign(new Error("duplicate"), { code: 11000 });
    stored = doc;
    return doc;
  });
  mockModels.AdminCrashReport.findOneAndUpdate.mockReturnValue(query({ _id: "group", devices: ["device"], count: 1 }));
  mockModels.AdminCrashReport.updateOne.mockReturnValue(query({}));
  const request = { reportId: "report", deviceInstallationId: "device" };
  const results = await Promise.all([recordCrashReport("u1", request), recordCrashReport("u1", request)]);
  expect(results.map((r) => r.duplicate).sort()).toEqual([false, true]);
  expect(mockModels.AdminCrashReport.findOneAndUpdate).toHaveBeenCalledTimes(1);
});

it("only the successful atomic login-code claimant can create a session", async () => {
  const pending = { _id: "request", email: "u@example.com", code: "123456", attempts: 0, expiresAt: new Date(Date.now() + 60_000) };
  mockModels.PendingLogin.findById.mockReturnValue(query(pending));
  let available = true;
  mockModels.PendingLogin.findOneAndDelete.mockImplementation(() => {
    const value = available ? pending : null;
    available = false;
    return query(value);
  });
  mockModels.User.findOneAndUpdate.mockReturnValue({ lean: async () => ({ _id: "u1", email: pending.email, createdAt: 1 }) });
  const results = await Promise.allSettled([
    verifyEmailLogin(pending.email, "request", "123456"),
    verifyEmailLogin(pending.email, "request", "123456"),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(mockModels.Session.create).toHaveBeenCalledTimes(1);
  expect(mockModels.PendingLogin.findOneAndDelete.mock.calls[0][0]).toMatchObject({ expiresAt: { $gt: expect.any(Date) } });
});

it.each(["Session", "AdminSession"])("%s refresh tokens can be rotated only once", async (modelName) => {
  let available = true;
  mockModels[modelName].findOneAndDelete.mockImplementation(() => {
    const value = available ? { _id: "old", userId: "u1", username: "admin", refreshExpiresAt: new Date(Date.now() + 60_000) } : null;
    available = false;
    return query(value);
  });
  const refresh = modelName === "Session" ? refreshSession : refreshAdminSession;
  const results = await Promise.allSettled([refresh("refresh"), refresh("refresh")]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(mockModels[modelName].create).toHaveBeenCalledTimes(1);
});
