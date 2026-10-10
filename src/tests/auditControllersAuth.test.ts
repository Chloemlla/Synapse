import { NexaiAuthController } from "../controllers/nexaiAuthController";
import { NexaiUserModel } from "../models/nexaiUserModel";
import { NexaiAuthService } from "../services/nexaiAuthService";
import { getPublicBaseUrl } from "../controllers/oauthController";
import { generateAdminUserUpdatedEmailHtml } from "../templates/emailTemplates";
import { updateCDK } from "../controllers/cdkController";
import { CDKService } from "../services/cdkService";

jest.mock("../config/config", () => ({ config: {} }));
jest.mock("../models/nexaiUserModel", () => ({ NexaiUserModel: { findOne: jest.fn() } }));
jest.mock("../services/nexaiAuthService", () => ({ NexaiAuthService: { verifyPasskeyAuthentication: jest.fn() } }));
jest.mock("../services/oauthService", () => ({}));
jest.mock("../services/oidcService", () => ({}));
jest.mock("../services/authSessionService", () => ({}));
jest.mock("../services/cdkService", () => {
  const instance = { updateCDK: jest.fn() };
  return { CDKService: { getInstance: () => instance } };
});
jest.mock("../utils/ipUtils", () => ({ getClientIP: () => "203.0.113.4" }));
jest.mock("../utils/logger", () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

function response() {
  const res: any = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

describe("controller authentication contracts", () => {
  beforeEach(() => jest.clearAllMocks());

  it("does not distinguish unknown users from invalid passkey credentials", async () => {
    const req: any = { body: { identifier: "someone", response: {} } };
    (NexaiUserModel.findOne as jest.Mock).mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
    const missing = response();
    await NexaiAuthController.verifyPasskeyAuthentication(req, missing);
    (NexaiUserModel.findOne as jest.Mock).mockReturnValue({ lean: jest.fn().mockResolvedValue({ id: "someone" }) });
    (NexaiAuthService.verifyPasskeyAuthentication as jest.Mock).mockRejectedValue(Object.assign(new Error("挑战不存在，请重试"), { statusCode: 400 }));
    const invalid = response();
    await NexaiAuthController.verifyPasskeyAuthentication(req, invalid);
    expect(missing.status).toHaveBeenCalledWith(401);
    expect(invalid.status).toHaveBeenCalledWith(401);
    expect(missing.json.mock.calls).toEqual(invalid.json.mock.calls);
  });

  it("requires a configured production issuer independent of the Host header", () => {
    const original = { NODE_ENV: process.env.NODE_ENV, BASE_URL: process.env.BASE_URL, FRONTEND_URL: process.env.FRONTEND_URL };
    try {
      process.env.NODE_ENV = "production";
      delete process.env.BASE_URL;
      delete process.env.FRONTEND_URL;
      const req: any = { protocol: "https", get: () => "attacker.invalid" };
      expect(() => getPublicBaseUrl(req)).toThrow("OAuth issuer is not configured");
      process.env.BASE_URL = "https://trusted.example/";
      expect(getPublicBaseUrl(req)).toBe("https://trusted.example");
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("sends a password change notice without rendering password values", () => {
    const html = generateAdminUserUpdatedEmailHtml("user", "2026-10-07", "admin", [
      { field: "password", oldValue: "old-secret", newValue: "new-secret" },
    ], true);
    expect(html).toContain("你的密码已被管理员重置");
    expect(html).not.toContain("old-secret");
    expect(html).not.toContain("new-secret");
  });

  it("distinguishes clearing CDK expiration from leaving it unchanged", async () => {
    const service = CDKService.getInstance();
    (service.updateCDK as jest.Mock).mockResolvedValue({ id: "cdk" });
    const cleared = response();
    await updateCDK({ params: { id: "cdk" }, body: { expiresAt: null } } as any, cleared);
    expect(service.updateCDK).toHaveBeenLastCalledWith("cdk", { expiresAt: null });
    expect(cleared.json).toHaveBeenCalledWith({ id: "cdk" });
    await updateCDK({ params: { id: "cdk" }, body: {} } as any, response());
    expect(service.updateCDK).toHaveBeenLastCalledWith("cdk", {});
  });
});
