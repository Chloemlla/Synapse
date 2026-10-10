import crypto from "node:crypto";

const mockKeyFindOne = jest.fn();
const mockSyncFindOne = jest.fn();
const mockSyncUpdate = jest.fn();
const mockGet = jest.fn();
jest.mock("axios", () => ({ __esModule: true, default: { get: mockGet } }));
jest.mock("../models/apiKeyModel", () => ({ ApiKeyModel: { findOne: mockKeyFindOne } }));
jest.mock("../models/bilibiliSyncModel", () => ({
  BilibiliSyncModel: { findOne: mockSyncFindOne, updateOne: mockSyncUpdate },
}));
jest.mock("../utils/logger", () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const { validateApiKey } = require("../services/apiKeyService") as typeof import("../services/apiKeyService");
const { encryptCredential, getBilibiliSettings, verifyBilibiliCookie } = require("../services/bilibiliSyncService") as typeof import("../services/bilibiliSyncService");

describe("audit services 1: authoritative credential state", () => {
  beforeEach(() => jest.clearAllMocks());

  it("rechecks revocation, permissions, expiry and deletion after a successful cached proof", async () => {
    const plainKey = "ak_1a2b3c4d.audit-regression-secret";
    const base = {
      keyId: "ak_1a2b3c4d", enabled: true, permissions: ["tts"], expiresAt: null,
      keyHash: crypto.scryptSync(plainKey, "api-key-static-salt", 64).toString("hex"),
    };
    let current: unknown = base;
    mockKeyFindOne.mockImplementation(() => ({ lean: async () => current }));
    expect(await validateApiKey(plainKey)).toMatchObject({ permissions: ["tts"] });
    current = { ...base, enabled: false };
    expect(await validateApiKey(plainKey)).toBeNull();
    current = { ...base, permissions: ["status"], rateLimit: 1 };
    expect(await validateApiKey(plainKey)).toMatchObject({ permissions: ["status"], rateLimit: 1 });
    current = { ...base, expiresAt: new Date(Date.now() - 1) };
    expect(await validateApiKey(plainKey)).toBeNull();
    current = { ...base, keyHash: "0".repeat(128) };
    expect(await validateApiKey(plainKey)).toBeNull();
    current = null;
    expect(await validateApiKey(plainKey)).toBeNull();
    expect(mockKeyFindOne).toHaveBeenCalledTimes(6);
  });

  it.each([
    { status: 503, data: {} },
    { status: 429, data: {} },
    { status: 200, data: { code: 0, data: {} } },
  ])("does not invalidate credentials on unavailable/malformed upstream replies: %j", async (response) => {
    const doc = { userId: "u1", bilibiliUid: "12345", credentialStatus: "active", ...encryptCredential("SESSDATA=fixture") };
    mockSyncFindOne.mockReturnValue({ select: jest.fn().mockReturnThis(), lean: async () => doc });
    mockGet.mockResolvedValue(response);
    await expect(getBilibiliSettings("u1")).rejects.toMatchObject({ code: "BILIBILI_UPSTREAM_UNAVAILABLE", statusCode: 503 });
    expect(mockSyncUpdate).not.toHaveBeenCalled();
  });

  it("keeps a timeout retryable and preserves explicit login rejection", async () => {
    mockGet.mockRejectedValueOnce(new Error("ECONNRESET"));
    await expect(verifyBilibiliCookie("SESSDATA=fixture", "12345")).rejects.toMatchObject({ code: "BILIBILI_UPSTREAM_UNAVAILABLE" });
    mockGet.mockResolvedValueOnce({ status: 200, data: { code: -101 } });
    await expect(verifyBilibiliCookie("SESSDATA=fixture", "12345")).rejects.toMatchObject({ code: "BILIBILI_COOKIE_INVALID", statusCode: 401 });
  });

  it("invalidates only the verified credential version on explicit rejection", async () => {
    const doc = { userId: "u1", bilibiliUid: "12345", credentialStatus: "active", ...encryptCredential("SESSDATA=fixture") };
    mockSyncFindOne.mockReturnValue({ select: jest.fn().mockReturnThis(), lean: async () => doc });
    mockGet.mockResolvedValue({ status: 200, data: { code: 0, data: { isLogin: false } } });
    await expect(getBilibiliSettings("u1")).rejects.toMatchObject({ code: "BILIBILI_COOKIE_INVALID" });
    expect(mockSyncUpdate).toHaveBeenCalledWith(
      { userId: "u1", credentialCiphertext: doc.credentialCiphertext },
      { $set: { credentialStatus: "invalid", credentialLastCheckedAt: expect.any(Date) } },
    );
  });

  it("reuses a recent successful check without another external request", async () => {
    const doc = { userId: "u1", bilibiliUid: "12345", credentialStatus: "active", credentialLastCheckedAt: new Date(), ...encryptCredential("SESSDATA=fixture") };
    mockSyncFindOne.mockReturnValue({ select: jest.fn().mockReturnThis(), lean: async () => doc });
    await expect(getBilibiliSettings("u1")).resolves.toMatchObject({ settings: {} });
    expect(mockGet).not.toHaveBeenCalled();
  });
});
