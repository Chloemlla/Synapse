const mockAudit = jest.fn();
const mockAuditRegistrations: unknown[] = [];
const mockAuditWrite = jest.fn().mockResolvedValue(undefined);
const mockPages = jest.fn();
jest.mock("../services/auditLogService", () => ({ AuditLogService: { log: (...args: unknown[]) => mockAuditWrite(...args) } }));
jest.mock("../middleware/auditLog", () => {
  const actual = jest.requireActual("../middleware/auditLog");
  return { auditLog: (options: unknown) => { mockAudit(options); mockAuditRegistrations.push(options); return actual.auditLog(options); } };
});
jest.mock("../services/adminScopeConfigService", () => ({ getPagesForUser: (...args: unknown[]) => mockPages(...args) }));
jest.mock("../controllers/adminController", () => ({ adminController: new Proxy({}, { get: () => jest.fn() }) }));
jest.mock("../controllers/cdictDonationController", () => ({ CDictDonationController: new Proxy({}, { get: () => jest.fn() }) }));
jest.mock("../controllers/ttsProviderController", () => ({ ttsProviderController: new Proxy({}, { get: () => jest.fn() }) }));
jest.mock("../services/profileUpdateVerificationService", () => ({
  clearProfileVerificationSessions: jest.fn(),
  validateProfileVerificationSession: (userId: string, token: string) => token === "valid-test-session"
    ? { userId, method: "password", issuedIp: "" } : null,
}));
jest.mock("../services/mongoService", () => {
  const actual = jest.requireActual("../services/mongoService");
  return { ...actual, mongoose: { ...actual.mongoose,
    // Controllers see ready storage; actual Mongoose models remain disconnected and no IO occurs.
    connection: { readyState: 1 }, model: actual.mongoose.model.bind(actual.mongoose),
  } };
});
jest.mock("../utils/logger", () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import express, { type Request } from "express";
import request from "supertest";
import configRouter from "../routes/admin/config";
import { requireAdminScope } from "../middleware/adminScope";
import { auditLog } from "../middleware/auditLog";
import { RuntimeConfigService } from "../services/runtimeConfigService";
import { isSensitiveAuditField } from "../utils/auditRedaction";
import { CdictUpstreamValidationError } from "../config/cdictUpstreamConfig";

const url = "/api/admin/cdict-upstream/setting";
const secret = "synthetic-private-vivo-key";
let getSetting = jest.spyOn(RuntimeConfigService, "getCdictUpstreamSetting");
let setSetting = jest.spyOn(RuntimeConfigService, "setCdictUpstreamSetting");
let deleteSetting = jest.spyOn(RuntimeConfigService, "deleteCdictUpstreamSetting");
const app = express();
app.use(express.json());
// Fixture for the already authenticated admin mount. Real scope/superadmin/security-session
// and Origin guards below are not mocked; no token/session storage requests are needed.
app.use((req, _res, next) => {
  const role = req.header("x-test-role");
  if (role) req.user = { id: "test-admin", role, username: "fixture" } as NonNullable<Request["user"]>;
  next();
});
app.use("/api/admin", requireAdminScope, configRouter);

beforeEach(() => {
  // restoreMocks detaches spies before each test, so reattach them to the live service.
  getSetting = jest.spyOn(RuntimeConfigService, "getCdictUpstreamSetting");
  setSetting = jest.spyOn(RuntimeConfigService, "setCdictUpstreamSetting");
  deleteSetting = jest.spyOn(RuntimeConfigService, "deleteCdictUpstreamSetting");
  mockAuditWrite.mockClear();
  mockPages.mockResolvedValue(["env"]);
  getSetting.mockReset().mockResolvedValue({ setting: { config: {
    translateBaseUrl: "https://vivotrans.vivo.com", translateAppId: "test-id", ttsUrl: "https://vivotrans.vivo.com.cn/fy/tts",
    ttsAppId: "test-tts", ttsAppKey: "********", hasTtsAppKey: true,
  } } });
  setSetting.mockReset().mockResolvedValue({ updatedAt: "2026-10-24T00:00:00.000Z" });
  deleteSetting.mockReset().mockResolvedValue(undefined);
});
afterAll(() => { getSetting.mockRestore(); setSetting.mockRestore(); deleteSetting.mockRestore(); });

it.each(["get", "post", "delete"] as const)("denies anonymous/user %s before reading or writing configuration", async (method) => {
  for (const role of ["", "user"]) {
    const res = await request(app)[method](url).set("x-test-role", role);
    expect(res.status).toBe(403);
    expect(getSetting).not.toHaveBeenCalled();
    expect(setSetting).not.toHaveBeenCalled();
    expect(deleteSetting).not.toHaveBeenCalled();
  }
});

it("requires env page scope for admin GET and never exposes the key", async () => {
  mockPages.mockResolvedValueOnce([]);
  const denied = await request(app).get(url).set("x-test-role", "admin");
  expect(denied.status).toBe(403);
  expect(denied.body.code).toBe("ADMIN_SCOPE_FORBIDDEN");
  expect(denied.body.requiredPages).toContain("env");
  expect(getSetting).not.toHaveBeenCalled();
  const allowed = await request(app).get(url).set("x-test-role", "admin");
  expect(allowed.status).toBe(200);
  expect(allowed.body.setting.config).toMatchObject({ ttsAppKey: "********", hasTtsAppKey: true });
  expect(allowed.text).not.toContain(secret);
  expect(allowed.headers["cache-control"]).toBe("private, no-store");
});

it.each(["post", "delete"] as const)("never allows a scoped ordinary admin to %s", async (method) => {
  const res = await request(app)[method](url).set("x-test-role", "admin").set("x-verification-token", "valid-test-session");
  expect(res.status).toBe(403);
  expect(setSetting).not.toHaveBeenCalled();
  expect(deleteSetting).not.toHaveBeenCalled();
});

it.each(["post", "delete"] as const)("requires a real shared security-session guard for superadmin %s", async (method) => {
  for (const token of ["", "expired-test-session"]) {
    const res = await request(app)[method](url).set("x-test-role", "superadmin").set("x-verification-token", token);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("SECURITY_SESSION_REQUIRED");
    expect(setSetting).not.toHaveBeenCalled();
    expect(deleteSetting).not.toHaveBeenCalled();
  }
  const accepted = await request(app)[method](url).set("x-test-role", "superadmin")
    .set("x-verification-token", "valid-test-session").send(method === "post" ? { ttsAppKey: secret } : {});
  expect(accepted.status).toBe(200);
  expect(accepted.text).not.toContain(secret);
  expect(JSON.stringify(mockAuditWrite.mock.calls)).not.toContain(secret);
  expect(mockAuditWrite.mock.calls.every(([entry]) => entry.detail.reqBody === undefined)).toBe(true);
  if (method === "post") expect(setSetting).toHaveBeenCalledWith({ ttsAppKey: secret });
  else expect(deleteSetting).toHaveBeenCalledTimes(1);
});

it.each(["post", "delete"] as const)("blocks cross-origin superadmin %s even with a valid security session", async (method) => {
  const res = await request(app)[method](url).set("x-test-role", "superadmin")
    .set("x-verification-token", "valid-test-session").set("Origin", "https://evil.example.net");
  expect(res.status).toBe(403);
  expect(setSetting).not.toHaveBeenCalled();
  expect(deleteSetting).not.toHaveBeenCalled();
});

it("reports safe validation errors, but never echoes storage errors containing secret documents", async () => {
  setSetting.mockRejectedValueOnce(new CdictUpstreamValidationError("ttsAppKey 不能保存掩码占位符"));
  const invalid = await request(app).post(url).set("x-test-role", "superadmin")
    .set("x-verification-token", "valid-test-session").send({ ttsAppKey: "********" });
  expect(invalid.status).toBe(400);
  expect(invalid.body.error).toContain("掩码");
  setSetting.mockRejectedValueOnce(new Error(`Mongo rejected {ttsAppKey:${secret}}`));
  const failed = await request(app).post(url).set("x-test-role", "superadmin")
    .set("x-verification-token", "valid-test-session").send({ ttsAppKey: secret });
  expect(failed.status).toBe(500);
  expect(failed.text).not.toContain(secret);
});

it("uses the real audit sanitizer to redact field and env aliases in nested payloads", async () => {
  const sandbox = express();
  sandbox.use(express.json());
  sandbox.post("/probe", auditLog({ module: "config", action: "test.alias-redaction" }), (req, res) => res.json(req.body));
  await request(sandbox).post("/probe").send({ config: { ttsAppKey: secret, VIVO_TTS_APP_KEY: secret, hasTtsAppKey: true } });
  expect(mockAuditWrite).toHaveBeenCalledTimes(1);
  const entry = mockAuditWrite.mock.calls[0][0];
  expect(entry.detail.reqBody.config).toEqual({ ttsAppKey: "[REDACTED]", VIVO_TTS_APP_KEY: "[REDACTED]", hasTtsAppKey: true });
  expect(entry.detail.resBody.config).toEqual(entry.detail.reqBody.config);
  expect(JSON.stringify(entry)).not.toContain(secret);
});

it("disables request-body audit capture on read/write/reset and registers both secret aliases", () => {
  for (const action of ["read", "set", "delete"]) {
    const registration = mockAuditRegistrations.map((options) => options as { action: string; captureBody?: boolean })
      .find((options) => options.action === `config.cdict-upstream.${action}`);
    expect(registration).toMatchObject({ captureBody: false });
  }
  expect(isSensitiveAuditField("ttsAppKey")).toBe(true);
  expect(isSensitiveAuditField("VIVO_TTS_APP_KEY")).toBe(true);
});
