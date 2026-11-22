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

const userAggregate = jest.fn();
const userCount = jest.fn();
const userFind = jest.fn();
const userIndexes = jest.fn();

jest.mock("../services/userService", () => ({
  UserModel: {
    aggregate: (...args: unknown[]) => userAggregate(...args),
    countDocuments: (...args: unknown[]) => userCount(...args),
    find: (...args: unknown[]) => userFind(...args),
    collection: { indexes: () => userIndexes() },
  },
}));

const eventCount = jest.fn();
const eventFind = jest.fn();
const eventAggregate = jest.fn();

jest.mock("../models/securityEventModel", () => ({
  SecurityEvent: {
    countDocuments: (...args: unknown[]) => eventCount(...args),
    find: (...args: unknown[]) => eventFind(...args),
    aggregate: (...args: unknown[]) => eventAggregate(...args),
  },
}));

const ipCount = jest.fn();
jest.mock("../models/accountIpSignalModel", () => ({
  AccountIpSignal: {
    countDocuments: (...args: unknown[]) => ipCount(...args),
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
    userCount.mockResolvedValue(1);
    userFind.mockReturnValue(
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

    const match = (userFind.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(match.riskTier).toBe("watch");
    expect(match.riskFlags).toBe("GEO_JUMP");
    expect(match.accountStatus).toEqual({ $in: ["active", null] });

    const chain = userFind.mock.results[0]!.value as Record<string, jest.Mock>;
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
    userCount.mockResolvedValue(0);
    userFind.mockReturnValue(queryChain([]));

    const res = makeRes();
    await AccountRiskAdminController.listAccounts(
      asReq({ q: "a.b" }),
      res as unknown as never,
      jest.fn() as never,
    );

    const match = (userFind.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    const or = match.$or as Array<Record<string, RegExp>>;
    expect(or[0]!.username!.source).toContain("a\\.b");
  });
});

describe("accountRiskAdmin 信号", () => {
  it("匿名筛选写进 eventData.anonymous，载荷递归脱敏", async () => {
    eventCount.mockResolvedValue(1);
    eventFind.mockReturnValue(
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

    const match = (eventFind.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
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
    eventCount.mockResolvedValue(0);
    eventFind.mockReturnValue(queryChain([]));

    const res = makeRes();
    await AccountRiskAdminController.listActions(
      asReq({ action: "suspend", operatorId: "admin-9" }),
      res as unknown as never,
      jest.fn() as never,
    );

    const match = (eventFind.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(match.eventType).toEqual({ $in: ["ACCOUNT_RISK_ACTION", "ACCOUNT_RISK_TIER_CHANGED"] });
    expect(match["eventData.action"]).toBe("suspend");
    expect(match["eventData.operatorId"]).toBe("admin-9");
  });
});

describe("accountRiskAdmin 概览", () => {
  it("风险档缺项补 0，缺索引显式报出来", async () => {
    userAggregate.mockReturnValueOnce(aggregateChain([{ _id: "watch", count: 2 }]));
    userAggregate.mockReturnValueOnce(aggregateChain([{ _id: "active", count: 5 }]));
    userAggregate.mockReturnValueOnce(aggregateChain([]));
    eventCount.mockResolvedValue(0);
    eventAggregate.mockReturnValueOnce(aggregateChain([]));
    eventAggregate.mockReturnValueOnce(aggregateChain([]));
    eventFind.mockReturnValue(queryChain([]));
    ipCount.mockResolvedValue(0);
    userIndexes.mockResolvedValue([{ name: "riskTier_1" }]);

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
    expect(userAggregate).not.toHaveBeenCalled();
  });
});
