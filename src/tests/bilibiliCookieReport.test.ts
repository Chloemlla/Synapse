import { beforeEach, describe, expect, it, jest } from "@jest/globals";

process.env.BILIBILI_COOKIE_ENCRYPTION_KEY = "test-bilibili-cookie-report-key";

jest.mock("axios", () => ({
  __esModule: true,
  default: { get: jest.fn() },
}));

jest.mock("../models/bilibiliSyncModel", () => ({
  BilibiliSyncModel: {
    findOne: jest.fn(),
    updateOne: jest.fn(),
  },
}));

const mockReportCountDocuments = jest.fn();
const mockReportFindOne = jest.fn();
const mockReportFindOneAndUpdate = jest.fn();
const mockReportUpdateOne = jest.fn();
const mockReportFind = jest.fn();
const mockReportDeleteOne = jest.fn();

jest.mock("../middleware/auth", () => ({
  isAdminRole: (role: unknown) => role === "admin" || role === "superadmin",
}));

jest.mock("../models/bilibiliCookieReportModel", () => ({
  BilibiliCookieReportModel: {
    countDocuments: mockReportCountDocuments,
    findOne: mockReportFindOne,
    findOneAndUpdate: mockReportFindOneAndUpdate,
    updateOne: mockReportUpdateOne,
    find: mockReportFind,
    deleteOne: mockReportDeleteOne,
  },
}));

const mockAxiosGet = (jest.requireMock("axios") as { default: { get: jest.Mock } }).default.get;

const service = require("../services/bilibiliCookieReportService") as typeof import("../services/bilibiliCookieReportService");
const controller = require("../controllers/bilibiliCookieReportController") as typeof import("../controllers/bilibiliCookieReportController");

const DEVICE_ID = "Zm9vYmFyYmF6cXV1eGNvcmcd";

function reportDoc(overrides: Record<string, unknown> = {}) {
  return {
    clientId: "piliplus",
    deviceId: DEVICE_ID,
    bilibiliUid: "12345",
    isPrimary: true,
    credentialStatus: "active",
    reportCount: 2,
    firstReportedAt: new Date("2026-09-01T00:00:00.000Z"),
    lastReportedAt: new Date("2026-09-26T00:00:00.000Z"),
    device: { platform: "Android", model: "Pixel 9" },
    permissions: { notification: "granted" },
    client: { platform: "Android" },
    ...overrides,
  };
}

function chain<T>(value: T) {
  const handle: Record<string, jest.Mock> = {
    select: jest.fn(),
    sort: jest.fn(),
    skip: jest.fn(),
    limit: jest.fn(),
    lean: jest.fn().mockResolvedValue(value),
  };
  for (const key of ["select", "sort", "skip", "limit"]) {
    handle[key]!.mockReturnValue(handle);
  }
  return handle;
}

function responder() {
  const res: Record<string, unknown> = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res as unknown as { statusCode: number; body: any; json(payload: unknown): unknown; status(code: number): unknown };
}

describe("bilibiliCookieReportService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAxiosGet.mockResolvedValue({ status: 200, data: { code: 0, data: { isLogin: true, mid: 12345 } } });
    mockReportCountDocuments.mockResolvedValue(0);
    mockReportFindOne.mockImplementation(() => chain(null));
    mockReportFindOneAndUpdate.mockImplementation(() => chain(reportDoc()));
    mockReportUpdateOne.mockResolvedValue({ acknowledged: true });
    mockReportFind.mockImplementation(() => chain([]));
    mockReportDeleteOne.mockResolvedValue({ deletedCount: 1 });
  });

  it("rejects a client that is not on the report allow list", async () => {
    await expect(
      service.reportBilibiliCookie({ clientId: "evil", deviceId: DEVICE_ID, uid: "12345", cookie: "SESSDATA=x" }),
    ).rejects.toMatchObject({ code: "BILIBILI_REPORT_CLIENT_UNKNOWN", statusCode: 403 });
    expect(mockAxiosGet).not.toHaveBeenCalled();
  });

  it("rejects a malformed device id before touching Bilibili", async () => {
    await expect(
      service.reportBilibiliCookie({ clientId: "piliplus", deviceId: "短", uid: "12345", cookie: "SESSDATA=x" }),
    ).rejects.toMatchObject({ code: "BILIBILI_REPORT_DEVICE_INVALID" });
    expect(mockAxiosGet).not.toHaveBeenCalled();
  });

  it("requires the body and the identity header to name the same device", () => {
    expect(() => service.resolveReportDeviceId(DEVICE_ID, `${DEVICE_ID}x`)).toThrow(
      expect.objectContaining({ code: "BILIBILI_REPORT_DEVICE_MISMATCH" }),
    );
    expect(service.resolveReportDeviceId(DEVICE_ID, DEVICE_ID)).toBe(DEVICE_ID);
    expect(service.resolveReportDeviceId(DEVICE_ID, undefined)).toBe(DEVICE_ID);
  });

  it("rejects an empty or oversized cookie", async () => {
    await expect(
      service.reportBilibiliCookie({ clientId: "piliplus", deviceId: DEVICE_ID, uid: "12345", cookie: "   " }),
    ).rejects.toMatchObject({ code: "BILIBILI_COOKIE_REQUIRED" });
    await expect(
      service.reportBilibiliCookie({
        clientId: "piliplus",
        deviceId: DEVICE_ID,
        uid: "12345",
        cookie: "S=".padEnd(service.MAX_REPORT_COOKIE_BYTES + 1, "x"),
      }),
    ).rejects.toMatchObject({ code: "BILIBILI_COOKIE_TOO_LARGE" });
  });

  it("fails closed when the cookie does not belong to the claimed UID", async () => {
    mockAxiosGet.mockResolvedValue({ status: 200, data: { code: 0, data: { isLogin: true, mid: 99999 } } });
    await expect(
      service.reportBilibiliCookie({ clientId: "piliplus", deviceId: DEVICE_ID, uid: "12345", cookie: "SESSDATA=x" }),
    ).rejects.toMatchObject({ code: "BILIBILI_COOKIE_INVALID" });
    expect(mockReportUpdateOne).toHaveBeenCalledWith(
      { clientId: "piliplus", deviceId: DEVICE_ID, bilibiliUid: "12345" },
      expect.objectContaining({ $set: expect.objectContaining({ credentialStatus: "invalid" }) }),
    );
    expect(mockReportFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("caps how many accounts one device may archive", async () => {
    mockReportCountDocuments.mockResolvedValue(service.MAX_REPORTS_PER_DEVICE);
    await expect(
      service.reportBilibiliCookie({ clientId: "piliplus", deviceId: DEVICE_ID, uid: "12345", cookie: "SESSDATA=x" }),
    ).rejects.toMatchObject({ code: "BILIBILI_REPORT_DEVICE_LIMIT", statusCode: 409 });
  });

  it("keeps reporting for a UID the device already archived at the cap", async () => {
    mockReportCountDocuments.mockResolvedValue(service.MAX_REPORTS_PER_DEVICE);
    mockReportFindOne.mockImplementation(() => chain({ reportCount: 4 }));
    const result = await service.reportBilibiliCookie({
      clientId: "piliplus",
      deviceId: DEVICE_ID,
      uid: "12345",
      cookie: "SESSDATA=x; bili_jct=y; DedeUserID=12345",
    });
    expect(result).toMatchObject({ accepted: true, uid: "12345", status: "active", reportCount: 2 });
  });

  it("stores only ciphertext and never echoes the cookie back", async () => {
    const cookie = "SESSDATA=secret-value; bili_jct=csrf; DedeUserID=12345";
    const result = await service.reportBilibiliCookie({
      clientId: "piliplus",
      deviceId: DEVICE_ID,
      uid: "12345",
      cookie,
      isPrimary: true,
      device: { platform: "Android", model: "Pixel 9" },
      permissions: { notification: "granted" },
      client: { client_id: "piliplus", platform: "Android" },
    });

    expect(JSON.stringify(result)).not.toContain("secret-value");
    const [, update] = mockReportFindOneAndUpdate.mock.calls[0] as [unknown, { $set: Record<string, unknown>; $inc: Record<string, number> }];
    expect(update.$set.credentialCiphertext).toBeTruthy();
    expect(update.$set.credentialCiphertext).not.toContain("secret-value");
    expect(update.$set.credentialStatus).toBe("active");
    expect(update.$set.client).toMatchObject({ clientId: "piliplus", platform: "Android" });
    expect(update.$inc).toEqual({ reportCount: 1 });
    expect(update.$set).not.toHaveProperty("cookie");
  });

  it("lists reports as metadata without credential fields", async () => {
    mockReportFind.mockImplementation(() => chain([reportDoc()]));
    const result = await service.listBilibiliCookieReports({ page: 1, limit: 20 });
    expect(result.reports[0]).toMatchObject({
      clientId: "piliplus",
      deviceId: DEVICE_ID,
      uid: "12345",
      status: "active",
      reportCount: 2,
    });
    expect(result.reports[0]).not.toHaveProperty("credentialCiphertext");
    expect(result.reports[0]).not.toHaveProperty("credentialIv");
    expect(result.reports[0]).not.toHaveProperty("permissions");
    expect(result.reports[0].deviceSummary).toMatchObject({ platform: "Android", model: "Pixel 9" });
  });

  it("deletes a single report", async () => {
    const result = await service.removeBilibiliCookieReport("piliplus", DEVICE_ID, "12345");
    expect(result).toEqual({ removed: true });
    expect(mockReportDeleteOne).toHaveBeenCalledWith({ clientId: "piliplus", deviceId: DEVICE_ID, bilibiliUid: "12345" });
  });
});

describe("bilibiliCookieReportController", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAxiosGet.mockResolvedValue({ status: 200, data: { code: 0, data: { isLogin: true, mid: 12345 } } });
    mockReportCountDocuments.mockResolvedValue(0);
    mockReportFindOne.mockImplementation(() => chain(null));
    mockReportFindOneAndUpdate.mockImplementation(() => chain(reportDoc()));
  });

  it("accepts a report and answers with metadata only", async () => {
    const res = responder();
    await controller.reportCookie(
      {
        body: { client_id: "piliplus", device_id: DEVICE_ID, uid: "12345", cookie: "SESSDATA=secret-value" },
        headers: { "x-device-id": DEVICE_ID },
      } as any,
      res as any,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { accepted: true, uid: "12345" } });
    expect(JSON.stringify(res.body)).not.toContain("secret-value");
  });

  it("refuses a report whose device header disagrees with the body", async () => {
    const res = responder();
    await controller.reportCookie(
      {
        body: { client_id: "piliplus", device_id: DEVICE_ID, uid: "12345", cookie: "SESSDATA=x" },
        headers: { "x-device-id": "a-nother-device-id-value" },
      } as any,
      res as any,
    );
    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ success: false, code: "BILIBILI_REPORT_DEVICE_MISMATCH" });
    expect(mockReportFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("keeps the admin listing behind the admin role", async () => {
    const res = responder();
    await controller.listReports({ user: { role: "user" }, query: {} } as any, res as any);
    expect(res.statusCode).toBe(403);
    expect(mockReportFind).not.toHaveBeenCalled();
  });
});
