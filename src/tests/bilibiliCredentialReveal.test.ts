import { beforeEach, describe, expect, it, jest } from "@jest/globals";

process.env.BILIBILI_COOKIE_ENCRYPTION_KEY = "test-bilibili-cookie-report-key";

jest.mock("axios", () => ({
  __esModule: true,
  default: { get: jest.fn() },
}));

jest.mock("../middleware/auth", () => ({
  isAdminRole: (role: unknown) => role === "admin" || role === "superadmin",
  isSuperAdmin: (req: { user?: { role?: unknown } }) => req?.user?.role === "superadmin",
}));

jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// 控制器里是 `void AuditLogService.log({...}).catch(() => {})`，替身必须返回 Promise，
// 否则 `undefined.catch` 会在审计那一行抛 TypeError（与真实实现在这里必须同形）。
const mockAuditLog = jest.fn(async (_entry: unknown): Promise<void> => undefined);

jest.mock("../services/auditLogService", () => ({
  AuditLogService: { log: (...args: unknown[]) => mockAuditLog(...args) },
}));

jest.mock("../models/bilibiliSyncModel", () => ({
  BilibiliSyncModel: { findOne: jest.fn(), updateOne: jest.fn() },
}));

const mockReportFind = jest.fn();
const mockAccountFind = jest.fn();

jest.mock("../models/bilibiliCookieReportModel", () => ({
  BilibiliCookieReportModel: {
    countDocuments: jest.fn(),
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn(),
    find: mockReportFind,
    deleteOne: jest.fn(),
  },
}));

jest.mock("../models/bilibiliAccountBindingModel", () => ({
  BilibiliAccountBindingModel: {
    find: mockAccountFind,
    findOne: jest.fn(),
    countDocuments: jest.fn(),
    deleteOne: jest.fn(),
    deleteMany: jest.fn(),
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn(),
    updateMany: jest.fn(),
  },
}));

const reportService = require("../services/bilibiliCookieReportService") as typeof import("../services/bilibiliCookieReportService");
const accountService = require("../services/bilibiliAccountService") as typeof import("../services/bilibiliAccountService");
const syncService = require("../services/bilibiliSyncService") as typeof import("../services/bilibiliSyncService");
const controller = require("../controllers/bilibiliCookieReportController") as typeof import("../controllers/bilibiliCookieReportController");

const DEVICE_ID = "Zm9vYmFyYmF6cXV1eGNvcmcd";
const PLAINTEXT_COOKIE = "SESSDATA=abc123; bili_jct=def456; DedeUserID=12345";

/** `find().select().lean()` 链式替身。 */
function chain<T>(value: T) {
  const handle: Record<string, jest.Mock> = {
    select: jest.fn(),
    lean: jest.fn().mockResolvedValue(value),
  };
  handle.select!.mockReturnValue(handle);
  return handle;
}

function responder() {
  const res: Record<string, unknown> = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      (res.headers as Record<string, string>)[name] = value;
      return res;
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res as unknown as {
    statusCode: number;
    body: any;
    headers: Record<string, string>;
    setHeader(name: string, value: string): unknown;
    json(payload: unknown): unknown;
    status(code: number): unknown;
  };
}

function reportDoc(overrides: Record<string, unknown> = {}) {
  return {
    clientId: "piliplus",
    deviceId: DEVICE_ID,
    bilibiliUid: "12345",
    credentialStatus: "active",
    lastReportedAt: new Date("2026-09-26T00:00:00.000Z"),
    ...syncService.encryptCredential(PLAINTEXT_COOKIE),
    ...overrides,
  };
}

function accountDoc(overrides: Record<string, unknown> = {}) {
  return {
    userId: "user-1",
    bilibiliUid: "12345",
    credentialStatus: "active",
    lastSyncedAt: new Date("2026-09-26T00:00:00.000Z"),
    ...syncService.encryptCredential(PLAINTEXT_COOKIE),
    ...overrides,
  };
}

describe("bilibili credential reveal (admin step-up)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReportFind.mockImplementation(() => chain([]));
    mockAccountFind.mockImplementation(() => chain([]));
  });

  it("round-trips stored ciphertext back to the plaintext cookie", async () => {
    mockReportFind.mockImplementation(() => chain([reportDoc()]));

    const rows = await reportService.revealBilibiliCookieReports([
      { clientId: "piliplus", deviceId: DEVICE_ID, uid: "12345" },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      clientId: "piliplus",
      deviceId: DEVICE_ID,
      uid: "12345",
      status: "active",
      cookie: PLAINTEXT_COOKIE,
    });
    expect(rows[0].error).toBeUndefined();
    // 密文字段必须显式 select 回来，否则 select:false 会让每条都判成 undecryptable。
    const selectArg = (mockReportFind.mock.results[0]?.value as { select: jest.Mock }).select.mock.calls[0]?.[0];
    expect(String(selectArg)).toContain("+credentialCiphertext");
  });

  it("marks a row with a foreign key version as undecryptable instead of failing the batch", async () => {
    mockReportFind.mockImplementation(() =>
      chain([reportDoc({ credentialCiphertext: Buffer.from("garbage").toString("base64") })]),
    );

    const rows = await reportService.revealBilibiliCookieReports([
      { clientId: "piliplus", deviceId: DEVICE_ID, uid: "12345" },
    ]);

    expect(rows[0].cookie).toBeNull();
    expect(rows[0].error).toBe("undecryptable");
  });

  it("reports a missing record as not-found", async () => {
    mockReportFind.mockImplementation(() => chain([]));

    const rows = await reportService.revealBilibiliCookieReports([
      { clientId: "piliplus", deviceId: DEVICE_ID, uid: "99999" },
    ]);

    expect(rows[0]).toMatchObject({ uid: "99999", status: "unknown", cookie: null, error: "not-found" });
  });

  it("rejects an empty batch and a batch beyond the cap", async () => {
    await expect(reportService.revealBilibiliCookieReports([])).rejects.toMatchObject({
      code: "BILIBILI_REVEAL_ITEMS_REQUIRED",
      statusCode: 400,
    });

    const tooMany = Array.from({ length: reportService.MAX_REVEAL_ROWS + 1 }, () => ({
      clientId: "piliplus",
      deviceId: DEVICE_ID,
      uid: "12345",
    }));
    await expect(reportService.revealBilibiliCookieReports(tooMany)).rejects.toMatchObject({
      code: "BILIBILI_REVEAL_ITEMS_TOO_MANY",
      statusCode: 413,
    });
    expect(mockReportFind).not.toHaveBeenCalled();
  });

  it("reveals account bindings by (userId, uid) with the same contract", async () => {
    mockAccountFind.mockImplementation(() => chain([accountDoc()]));

    const rows = await accountService.revealBilibiliAccountCredentials([{ userId: "user-1", uid: "12345" }]);

    expect(rows[0]).toMatchObject({ userId: "user-1", uid: "12345", cookie: PLAINTEXT_COOKIE });
    await expect(accountService.revealBilibiliAccountCredentials([{ uid: "12345" }])).rejects.toMatchObject({
      code: "BILIBILI_REVEAL_USER_REQUIRED",
    });
  });

  it("returns plaintext with no-store and audits counts only (never the cookie)", async () => {
    mockReportFind.mockImplementation(() => chain([reportDoc()]));
    const req = {
      body: { items: [{ clientId: "piliplus", deviceId: DEVICE_ID, uid: "12345" }] },
      user: { id: "admin-1", username: "root", role: "superadmin" },
      requestId: "req-1",
      headers: { "user-agent": "jest" },
      ip: "127.0.0.1",
      method: "POST",
      originalUrl: "/api/admin/bilibili-reports/credentials",
    } as any;
    const res = responder();

    await controller.revealReportCredentials(req, res as any);

    expect(res.statusCode).toBe(200);
    expect(res.headers["Cache-Control"]).toBe("no-store");
    expect(res.body.success).toBe(true);
    expect(res.body.data[0].cookie).toBe(PLAINTEXT_COOKIE);

    expect(mockAuditLog).toHaveBeenCalledTimes(1);
    const entry = mockAuditLog.mock.calls[0]?.[0] as { action: string; detail: Record<string, unknown> };
    expect(entry.action).toBe("privacy.bilibiliReportReveal");
    expect(entry.detail).toMatchObject({ requested: 1, revealed: 1, undecryptable: 0 });
    // 审计里绝不能出现明文（序列化后全文比对）。
    expect(JSON.stringify(entry)).not.toContain("SESSDATA");
  });

  it("audits the failure path when the batch is rejected", async () => {
    const req = {
      body: { items: [] },
      user: { id: "admin-1", username: "root", role: "superadmin" },
      headers: {},
      method: "POST",
      originalUrl: "/api/admin/bilibili-reports/credentials",
    } as any;
    const res = responder();

    await controller.revealReportCredentials(req, res as any);

    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe("BILIBILI_REVEAL_ITEMS_REQUIRED");
    const entry = mockAuditLog.mock.calls[0]?.[0] as { result: string; detail: Record<string, unknown> };
    expect(entry.result).toBe("failure");
    expect(entry.detail.statusCode).toBe(400);
  });
});
