import express from "express";
import request from "supertest";
import crypto from "node:crypto";
import shortlinks from "../routes/admin/shortlinks";

jest.mock("mongoose", () => {
  const items = [{ code: "sample", target: "https://example.com" }];
  const query = { sort: jest.fn().mockReturnThis(), skip: jest.fn().mockReturnThis(), limit: jest.fn().mockResolvedValue(items) };
  return { __esModule: true, default: { models: { ShortUrl: { countDocuments: jest.fn().mockResolvedValue(1), find: jest.fn(() => query) } } } };
});
jest.mock("../middleware/authenticateToken", () => ({ authenticateToken: (req: any, _res: any, next: () => void) => { req.user = { id: "admin", role: "admin" }; next(); } }));
jest.mock("../middleware/auth", () => ({ isAdminRole: (role: string) => role === "admin", isSuperAdmin: () => false }));
jest.mock("../middleware/auditLog", () => ({ auditLog: () => (_req: any, _res: any, next: () => void) => next() }));
jest.mock("../middleware/replayProtection", () => ({ replayProtection: () => (_req: any, _res: any, next: () => void) => next() }));
jest.mock("../services/shortUrlMigrationService", () => ({ shortUrlMigrationService: {} }));
jest.mock("../utils/authCookie", () => ({ getTokenFromRequest: () => "test-token" }));
jest.mock("../utils/logger", () => ({ __esModule: true, default: { debug: jest.fn(), error: jest.fn() } }));

describe("admin shortlink authentication response modes", () => {
  const app = express();
  app.use("/api/admin", shortlinks);

  it("returns readable pagination for HttpOnly cookie sessions", async () => {
    const result = await request(app).get("/api/admin/shortlinks?page=2&pageSize=10").set("Cookie", "session=test-token");
    expect(result.status).toBe(200);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.body).toEqual({ success: true, items: [{ code: "sample", target: "https://example.com" }], total: 1, page: 2, pageSize: 10 });
  });

  it("retains the existing Bearer encryption format", async () => {
    const result = await request(app).get("/api/admin/shortlinks").set("Authorization", "Bearer test-token");
    expect(result.status).toBe(200);
    const key = crypto.createHash("sha256").update("test-token").digest();
    const decipher = crypto.createDecipheriv("aes-256-cbc", key, Buffer.from(result.body.iv, "hex"));
    const decoded = decipher.update(result.body.data, "hex", "utf8") + decipher.final("utf8");
    expect(JSON.parse(decoded)).toEqual({ total: 1, items: [{ code: "sample", target: "https://example.com" }] });
  });
});
