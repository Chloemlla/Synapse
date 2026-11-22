import { beforeEach, describe, expect, it, jest } from "@jest/globals";

/**
 * `/api/admin/account-risk/*` 的服务端契约（页面 `/admin/account-risk`）。
 *
 * 这个面板的失败模式与其它只读面板不同：它同时展示**用户风险档**与**原始证据**，
 * 所以测试重点放在三件事上 ——
 *   1. 筛选/排序/分页必须下推 Mongo（否则 total 与行数会互相矛盾）；
 *   2. PII 一律打码（IP 前两段、指纹前 12 位、eventData 递归脱敏）；
 *   3. 集合越权（处置记录只认两个事件类型）与分页上限（≤200）。
 */

jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockMongo = { connection: { readyState: 1 } };
jest.mock("../services/mongoService", () => ({
  mongoose: mockMongo,
}));

jest.mock("../services/accountRiskService", () => ({
  ACCOUNT_ABUSE_EVENT_PREFIX: "ACCOUNT_ABUSE",
  AUTOMATION_TRACE_EVENT: "AUTOMATION_TRACE",
}));

jest.mock("../services/runtimeConfigService", () => ({
  RuntimeConfigService: {
    getCachedConfig: () => ({
      accountRisk: {
        enabled: true,
        evaluateOnLogin: true,
        windowDays: 30,
        ipSignalRetentionDays: 180,
        ipRecheckEnabled: false,
        stepUpEnabled: false,
        autoEscalationCap: "watch",
      },
    }),
  },
}));

const mockUserAggregate = jest.fn();
const mockUserCount = jest.fn();
/** countDocuments 返回 Query（调用方会 .exec()），替身要给 exec。 */
const countQuery = (value: number) => ({ exec: jest.fn().mockResolvedValue(value) });
const mockUserFind = jest.fn();
const mockUserIndexes = jest.fn();

jest.mock("../services/userService", () => ({
  UserModel: {
    aggregate: (...args: unknown[]) => mockUserAggregate(...args),
    countDocuments: (...args: unknown[]) => mockUserCount(...args),
    find: (...args: unknown[]) => mockUserFind(...args),
    collection: { indexes: () => mockUserIndexes() },
  },
}));

const mockEventCount = jest.fn();
const mockEventFind = jest.fn();
const mockEventAggregate = jest.fn();

jest.mock("../models/securityEventModel", () => ({
  SecurityEvent: {
    countDocuments: (...args: unknown[]) => mockEventCount(...args),
    find: (...args: unknown[]) => mockEventFind(...args),
    aggregate: (...args: unknown[]) => mockEventAggregate(...args),
  },
}));

const mockIpCount = jest.fn();
jest.mock("../models/accountIpSignalModel", () => ({
  AccountIpSignal: {
    countDocuments: (...args: unknown[]) => mockIpCount(...args),
    find: jest.fn(),
  },
}));

import { AccountRiskAdminController } from "../controllers/accountRiskAdminController";

function queryChain(result: unknown) {
  const handle: Record<string, jest.Mock> = {};
  for (const key of ["select", "sort", "skip", "limit", "lean"]) {
    handle[key] = jest.fn().mockReturnValue(handle);
  }
  handle.exec = jest.fn().mockResolvedValue(result);
  return handle;
}

function aggregateChain(result: unknown) {
  const handle: Record<string, jest.Mock> = {};
  handle.exec = jest.fn().mockResolvedValue(result);
  return handle;
}

function makeRes() {
  return {
    statusCode: 200,
    body: null as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
  };
}

const asReq = (query: Record<string, unknown> = {}, params: Record<string, string> = {}) =>
  ({ query, params, user: { id: "admin-1", role: "superadmin" } }) as never;

beforeEach(() => {
  jest.clearAllMocks();
  mockMongo.connection.readyState = 1;
});

describe("accountRiskAdmin 账户列表", () => {
  it("筛选下推 Mongo，limit 被钳到 200，IP 打码，密码类字段不在投影里", async () => {
    mockUserCount.mockImplementation(() => countQuery(1));
    mockUserFind.mockReturnValue(
      queryChain([
        {
          id: "u-1",
          username: "alice",
          email: "alice@example.com",
          role: "user",
          riskTier: "watch",
          riskScore: 62,
          riskFlags: ["DATACENTER_LOGIN_IP", "GEO_JUMP"],
          accountStatus: "active",
          lastLoginIp: "203.0.113.7",
          riskUpdatedAt: 1_700_000_000_000,
        },
      ]),
    );

    const res = makeRes();
    await AccountRiskAdminController.listAccounts(
      asReq({ tier: "watch", status: "active", flag: "GEO_JUMP", limit: "9999", offset: "20" }),
      res as unknown as never,
      jest.fn() as never,
    );

    const match = (mockUserFind.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(match.riskTier).toBe("watch");
    expect(match.riskFlags).toBe("GEO_JUMP");
    expect(match.accountStatus).toEqual({ $in: ["active", null] });

    const chain = mockUserFind.mock.results[0]!.value as Record<string, jest.Mock>;
    expect(chain.limit).toHaveBeenCalledWith(200);
    expect(chain.skip).toHaveBeenCalledWith(20);

    const projection = (chain.select.mock.calls[0] as unknown[])[0] as string;
    expect(projection).not.toContain("password");
    expect(projection).not.toContain("token");

    const body = res.body as { accounts: Array<Record<string, unknown>>; limit: number };
    expect(body.limit).toBe(200);
    expect(body.accounts[0]!.lastLoginIp).toBe("203.0.*.*");
    expect(body.accounts[0]!.riskFlags).toEqual(["DATACENTER_LOGIN_IP", "GEO_JUMP"]);
    expect(res.headers["Cache-Control"]).toBe("no-store");
  });

  it("按关键词搜索时把关键词当字面量（`.` 不得变通配符）", async () => {
    mockUserCount.mockImplementation(() => countQuery(0));
    mockUserFind.mockReturnValue(queryChain([]));

    const res = makeRes();
    await AccountRiskAdminController.listAccounts(
      asReq({ q: "a.b" }),
      res as unknown as never,
      jest.fn() as never,
    );

    const match = (mockUserFind.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    const or = match.$or as Array<Record<string, RegExp>>;
    expect(or[0]!.username!.source).toContain("a\\.b");
  });
});

describe("accountRiskAdmin 信号", () => {
  it("匿名筛选写进 eventData.anonymous，载荷递归脱敏", async () => {
    mockEventCount.mockImplementation(() => countQuery(1));
    mockEventFind.mockReturnValue(
      queryChain([
        {
          _id: "evt-1",
          eventType: "ACCOUNT_ABUSE_CAPTCHA_FAILED",
          userId: "u-1",
          ipAddress: "198.51.100.9",
          deviceFingerprint: "0123456789abcdef0123",
          eventData: { anonymous: true, password: "hunter2", nested: { apiKey: "k-123" } },
          createdAt: new Date("2026-11-01T00:00:00Z"),
        },
      ]),
    );

    const res = makeRes();
    await AccountRiskAdminController.listSignals(
      asReq({ anonymous: "true", eventType: "ACCOUNT_ABUSE_CAPTCHA_FAILED" }),
      res as unknown as never,
      jest.fn() as never,
    );

    const match = (mockEventFind.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(match["eventData.anonymous"]).toBe(true);
    expect(match.eventType).toBe("ACCOUNT_ABUSE_CAPTCHA_FAILED");

    const body = res.body as { signals: Array<Record<string, unknown>> };
    const row = body.signals[0]!;
    expect(row.anonymous).toBe(true);
    expect(row.ip).toBe("198.51.*.*");
    expect(String(row.deviceFingerprint)).toContain("…");
    const data = row.eventData as Record<string, unknown>;
    expect(data.password).toBe("[REDACTED]");
    expect((data.nested as Record<string, unknown>).apiKey).toBe("[REDACTED]");
  });
});

describe("accountRiskAdmin 处置记录", () => {
  it("只认两个处置事件类型，操作者可筛", async () => {
    mockEventCount.mockImplementation(() => countQuery(0));
    mockEventFind.mockReturnValue(queryChain([]));

    const res = makeRes();
    await AccountRiskAdminController.listActions(
      asReq({ action: "suspend", operatorId: "admin-9" }),
      res as unknown as never,
      jest.fn() as never,
    );

    const match = (mockEventFind.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(match.eventType).toEqual({ $in: ["ACCOUNT_RISK_ACTION", "ACCOUNT_RISK_TIER_CHANGED"] });
    expect(match["eventData.action"]).toBe("suspend");
    expect(match["eventData.operatorId"]).toBe("admin-9");
  });
});

describe("accountRiskAdmin 概览", () => {
  it("风险档缺项补 0，缺索引显式报出来", async () => {
    mockUserAggregate.mockReturnValueOnce(aggregateChain([{ _id: "watch", count: 2 }]));
    mockUserAggregate.mockReturnValueOnce(aggregateChain([{ _id: "active", count: 5 }]));
    mockUserAggregate.mockReturnValueOnce(aggregateChain([]));
    // 概览里还有一个 countDocuments（待逐步验证数），没给替身的话会在 undefined.exec() 上炸。
    mockUserCount.mockImplementation(() => countQuery(0));
    mockEventCount.mockImplementation(() => countQuery(0));
    mockEventAggregate.mockReturnValueOnce(aggregateChain([]));
    mockEventAggregate.mockReturnValueOnce(aggregateChain([]));
    mockEventFind.mockReturnValue(queryChain([]));
    mockIpCount.mockImplementation(() => countQuery(0));
    mockUserIndexes.mockResolvedValue([{ name: "riskTier_1" }]);

    const res = makeRes();
    await AccountRiskAdminController.getOverview(asReq(), res as unknown as never, jest.fn() as never);

    const body = res.body as {
      accounts: { tiers: Record<string, number> };
      indexes: { missing: string[] };
    };
    expect(body.accounts.tiers.watch).toBe(2);
    expect(body.accounts.tiers.normal).toBe(0);
    expect(body.accounts.tiers.danger).toBe(0);
    expect(body.indexes.missing).toContain("riskTier_1_riskUpdatedAt_-1");
    expect(body.indexes.missing).not.toContain("riskTier_1");
  });

  it("Mongo 未就绪时回 503，不去查库", async () => {
    mockMongo.connection.readyState = 0;
    const res = makeRes();
    await AccountRiskAdminController.getOverview(asReq(), res as unknown as never, jest.fn() as never);

    expect(res.statusCode).toBe(503);
    expect(mockUserAggregate).not.toHaveBeenCalled();
  });
});
