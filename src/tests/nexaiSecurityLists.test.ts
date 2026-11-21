import { beforeEach, describe, expect, it, jest } from "@jest/globals";

/**
 * NexAI 安全面板「列表页看全量」的服务端契约：
 *  - 不带 timeRange 时**不得**默认截到 24 小时（否则老数据只能靠带参手查）；
 *  - status / eventType / search 全部下推到查询（分页 total 才与行数一致）；
 *  - 关键词当字面量进 `$regex`（`.`/`*` 不得变通配符）。
 */

jest.mock("../middleware/auth", () => ({
  isAdminRole: (role: unknown) => role === "admin" || role === "superadmin",
}));

jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockDeviceCount = jest.fn();
const mockDeviceFind = jest.fn();
const mockEventCount = jest.fn();
const mockEventFind = jest.fn();

jest.mock("../models/deviceTrackingModel", () => ({
  DeviceTracking: {
    countDocuments: (...args: unknown[]) => mockDeviceCount(...args),
    find: (...args: unknown[]) => mockDeviceFind(...args),
  },
}));

jest.mock("../models/securityEventModel", () => ({
  SecurityEvent: {
    countDocuments: (...args: unknown[]) => mockEventCount(...args),
    find: (...args: unknown[]) => mockEventFind(...args),
  },
}));

jest.mock("../services/nexaiSecurityService", () => ({
  detectAnomalies: jest.fn(),
  extractSecurityHeaders: jest.fn(),
  getDeviceStatus: jest.fn(),
  getPublicReportAction: jest.fn(),
  getRiskStrategy: jest.fn(),
  incrementBlockedCount: jest.fn(),
  recordSecurityEvent: jest.fn(),
  trackDevice: jest.fn(),
}));

import { getDeviceList, getSecurityEvents } from "../controllers/nexaiSecurityController";

function chain(result: unknown) {
  const handle: Record<string, jest.Mock> = {
    sort: jest.fn(),
    skip: jest.fn(),
    limit: jest.fn(),
    lean: jest.fn(),
  };
  for (const key of ["sort", "skip", "limit"]) handle[key]!.mockReturnValue(handle);
  handle.lean!.mockResolvedValue(result);
  return handle;
}

function makeRes() {
  return {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
}

const adminReq = (query: Record<string, unknown>) =>
  ({ query, user: { role: "admin" } }) as unknown as Parameters<typeof getDeviceList>[0];

beforeEach(() => {
  jest.clearAllMocks();
  mockDeviceCount.mockResolvedValue(0);
  mockDeviceFind.mockReturnValue(chain([]));
  mockEventCount.mockResolvedValue(0);
  mockEventFind.mockReturnValue(chain([]));
});

describe("GET /nexai/security/devices", () => {
  it("默认不限时间窗：不带 timeRange 时不加 lastSeen 条件", async () => {
    const res = makeRes();
    await getDeviceList(adminReq({}), res as never);

    expect(mockDeviceFind).toHaveBeenCalledWith({});
    expect(res.statusCode).toBe(200);
  });

  it("status / riskLevel 下推成查询条件", async () => {
    const res = makeRes();
    await getDeviceList(adminReq({ status: "compromised", riskLevel: "HIGH" }), res as never);

    expect(mockDeviceFind).toHaveBeenCalledWith({ isCompromised: true, riskLevel: "HIGH" });

    await getDeviceList(adminReq({ status: "normal" }), makeRes() as never);
    expect(mockDeviceFind).toHaveBeenLastCalledWith({ isCompromised: { $ne: true } });
  });

  it("timeRange 合法时加下界，非法值退回不限", async () => {
    const before = Date.now();
    await getDeviceList(adminReq({ timeRange: "7d" }), makeRes() as never);
    const firstFilter = mockDeviceFind.mock.calls[0]?.[0] as { lastSeen: { $gte: Date } };
    expect(firstFilter.lastSeen.$gte.getTime()).toBeGreaterThanOrEqual(before - 7 * 24 * 60 * 60 * 1000 - 1000);
    expect(firstFilter.lastSeen.$gte.getTime()).toBeLessThanOrEqual(Date.now());

    await getDeviceList(adminReq({ timeRange: "bogus" }), makeRes() as never);
    expect(mockDeviceFind).toHaveBeenLastCalledWith({});
  });

  it("search 覆盖指纹 / 用户 / IP，且关键词按字面量转义", async () => {
    await getDeviceList(adminReq({ search: "10.0.*" }), makeRes() as never);

    const filter = mockDeviceFind.mock.calls[0]?.[0] as { $or: Array<Record<string, { $regex: string }>> };
    const fields = filter.$or.map((clause) => Object.keys(clause)[0]);
    expect(fields).toEqual(["deviceFingerprint", "userId", "ipAddress"]);
    expect(filter.$or[0]?.deviceFingerprint?.$regex).toBe("10\\.0\\.\\*");
  });

  it("非管理员 403", async () => {
    const res = makeRes();
    await getDeviceList(
      { query: {}, user: { role: "user" } } as unknown as Parameters<typeof getDeviceList>[0],
      res as never,
    );
    expect(res.statusCode).toBe(403);
    expect(mockDeviceFind).not.toHaveBeenCalled();
  });
});

describe("GET /nexai/security/events", () => {
  it("默认不限时间窗，按 createdAt 倒序分页", async () => {
    const res = makeRes();
    await getSecurityEvents(adminReq({ limit: "50", page: "2" }), res as never);

    expect(mockEventFind).toHaveBeenCalledWith({});
    const handle = mockEventFind.mock.results[0]?.value as Record<string, jest.Mock>;
    expect(handle.sort).toHaveBeenCalledWith({ createdAt: -1 });
    expect(handle.skip).toHaveBeenCalledWith(50);
    expect(handle.limit).toHaveBeenCalledWith(50);
    expect((res.body as Record<string, any>).pagination).toEqual({ page: 2, limit: 50, total: 0, totalPages: 0 });
  });

  it("eventType / search / timeRange 全部下推", async () => {
    await getSecurityEvents(
      adminReq({ eventType: "vpn_detected", search: "abc" }),
      makeRes() as never,
    );

    const filter = mockEventFind.mock.calls[0]?.[0] as Record<string, any>;
    expect(filter.eventType).toBe("vpn_detected");
    const fields = (filter.$or as Array<Record<string, unknown>>).map((clause) => Object.keys(clause)[0]);
    expect(fields).toEqual(["deviceFingerprint", "userId", "ipAddress", "eventType"]);

    await getSecurityEvents(adminReq({ timeRange: "24h" }), makeRes() as never);
    const bounded = mockEventFind.mock.calls[1]?.[0] as { createdAt: { $gte: Date } };
    expect(bounded.createdAt.$gte).toBeInstanceOf(Date);
  });

  it("limit 超过上限时压到 100", async () => {
    await getSecurityEvents(adminReq({ limit: "9999" }), makeRes() as never);
    const handle = mockEventFind.mock.results[0]?.value as Record<string, jest.Mock>;
    expect(handle.limit).toHaveBeenCalledWith(100);
  });
});
