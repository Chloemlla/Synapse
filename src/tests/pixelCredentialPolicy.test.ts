/**
 * Pixel 账号凭据的**合并阻断**用例（PRD 6.1.2/6.1.3/6.1.4）。
 *
 * 这个文件的用意不是覆盖率，而是「不可退让的观测面边界」：
 * 账号邮箱 / 密码 / 辅助邮箱 / 2FA 秘钥 / 卡密**只能在请求处理内存与上游请求体里存在**，
 * 绝不能出现在
 *   a) 日志（logger 的任意一次调用）；
 *   b) 持久化（usage log / task access 文档字段）；
 *   c) 返回给用户的响应体（含错误）；
 *   d) 用户数据副本（导出）。
 *
 * 任何一次「顺手加个字段」把哨兵带进上面任一面，这个文件就会红——那时应该改代码，
 * 而不是放宽这里的断言。
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import express from "express";
import request from "supertest";
import { parsePixelAccountsText } from "../pixel/accountText";
import { pixelUsageLogService } from "../pixel/usageLogService";
import PixelUsageLogModel from "../models/pixelUsageLogModel";
import { createPixelUpstreamClient } from "../pixel/upstreamClient";
import { createPixelTaskService, type PixelTaskServiceDeps } from "../pixel/taskService";
import { createPixelRouter } from "../routes/pixelRoutes";
import { createPixelAdminRouter } from "../routes/admin/pixelRoutes";
import { PixelDomainError } from "../pixel/types";
import type { PixelRuntimeLimits } from "../pixel/runtime";
import type { PixelCdkMappingCreatedView } from "../pixel/types";
import type { AuditEntry } from "../services/auditLogService";
import logger from "../utils/logger";

jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock("../models/pixelUsageLogModel", () => ({
  __esModule: true,
  default: { create: jest.fn(), find: jest.fn(), findOne: jest.fn() },
}));

jest.mock("../middleware/authenticateToken", () => ({
  authenticateToken: (req: { headers: Record<string, unknown>; user?: unknown }, _res: unknown, next: () => void) => {
    const header = req.headers["x-test-user"];
    if (typeof header === "string" && header) req.user = { id: header, username: header, role: "user" };
    next();
  },
}));

jest.mock("../middleware/featureConsent", () => ({
  POLICY_CONSENT_REQUIRED_CODE: "POLICY_CONSENT_REQUIRED",
  requireFeatureConsent: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock("../middleware/auth", () => ({
  authenticateAdmin: (req: { headers: Record<string, unknown>; user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: "admin-1", username: "admin", role: req.headers["x-test-role"] === "superadmin" ? "superadmin" : "admin" };
    next();
  },
  authenticateSuperAdmin: (req: { headers: Record<string, unknown>; user?: unknown }, res: { status: (code: number) => { json: (body: unknown) => void } }, next: () => void) => {
    if (req.headers["x-test-role"] !== "superadmin") {
      res.status(403).json({ success: false, error: "需要超级管理员权限", code: "FORBIDDEN" });
      return;
    }
    req.user = { id: "admin-1", username: "admin", role: "superadmin" };
    next();
  },
}));

jest.mock("../pixel/cardService", () => ({ pixelCardService: {} }));
jest.mock("../pixel/taskService", () => ({ pixelTaskService: {} }));

const SENTINEL_EMAIL = "sentinel-9f3a@example.test";
const SENTINEL_PASSWORD = "SENTINEL-PASSWORD-9f3a";
const SENTINEL_TOTP = "SENTINEL-TOTP-9f3a";
const SENTINEL_CARD = "SENTINEL-CARD-9f3a";
const SENTINELS = [SENTINEL_EMAIL, SENTINEL_PASSWORD, SENTINEL_TOTP, SENTINEL_CARD];
const ACCOUNT_LINE = `${SENTINEL_EMAIL}----${SENTINEL_PASSWORD}----${SENTINEL_EMAIL}----${SENTINEL_TOTP}`;

const LIMITS: PixelRuntimeLimits = {
  maxAccountsPerSubmission: 5,
  maxAccountLineChars: 512,
  maxAccountsTextBytes: 8_192,
  usageLogRetentionDays: 30,
  upstreamTimeoutMs: 5_000,
};

/** 递归序列化后检查哨兵：任何一层出现都算泄漏。 */
function expectNoSentinels(value: unknown, label: string): void {
  const text = JSON.stringify(value) ?? "";
  for (const sentinel of SENTINELS) {
    // label 用于失败时定位是哪一面泄漏了。
    expect({ label, contains: text.includes(sentinel) }).toEqual({ label, contains: false });
  }
}

function loggerCalls(): unknown[] {
  const mocked = logger as unknown as { info: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock };
  return [
    ...mocked.info.mock.calls,
    ...mocked.warn.mock.calls,
    ...mocked.error.mock.calls,
    ...mocked.debug.mock.calls,
  ];
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("账号文本解析：只在内存里多出一个规范化副本", () => {
  it("解析结果只含 accountCount 与 normalizedText 两个字段", () => {
    const parsed = parsePixelAccountsText(ACCOUNT_LINE, LIMITS);
    expect(Object.keys(parsed).sort()).toEqual(["accountCount", "normalizedText"]);
    expect(parsed.accountCount).toBe(1);
  });

  it("行格式错误时的错误体只带行号与上限，不复述账号内容", () => {
    try {
      parsePixelAccountsText(`${SENTINEL_EMAIL}----`, LIMITS);
      throw new Error("expected parse to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PixelDomainError);
      const domainError = error as PixelDomainError;
      expectNoSentinels({ message: domainError.message, details: domainError.details, code: domainError.code }, "parse-error");
      expect(domainError.details?.lineNumber).toBe(1);
    }
  });

  it("超出条数上限时只报计数", () => {
    const text = Array.from({ length: 6 }, () => ACCOUNT_LINE).join("\n");
    try {
      parsePixelAccountsText(text, LIMITS);
      throw new Error("expected parse to throw");
    } catch (error) {
      expectNoSentinels((error as PixelDomainError).details, "parse-limit-details");
    }
  });
});

describe("溯源日志：字段白名单 + 查询串剥离 + 卡密遮罩", () => {
  it("落库文档的字段恰好是白名单，且不含任何凭据原文", async () => {
    (PixelUsageLogModel.create as jest.Mock).mockImplementation(async (doc: unknown) => doc);

    await pixelUsageLogService.record({
      userId: "user-1",
      requestedCdk: SENTINEL_CARD,
      mappingId: "pcm_1",
      matchedMapping: true,
      method: "POST",
      // 查询串里也放一个哨兵：路径必须被剥掉 query，否则卡密会随 URL 落库。
      path: `/api/pixel/submit-task?card=${SENTINEL_CARD}&email=${SENTINEL_EMAIL}`,
      serviceType: "link_only",
      accountCount: 1,
      requestBytes: 128,
      responseBytes: 64,
      upstreamStatus: 200,
      outcome: "success",
      durationMs: 42,
    });

    const doc = (PixelUsageLogModel.create as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual([
      "accountCount",
      "createdAt",
      "durationMs",
      "logId",
      "mappingId",
      "matchedMapping",
      "method",
      "outcome",
      "path",
      "requestBytes",
      "requestId",
      "requestedCdkMasked",
      "responseBytes",
      "serviceType",
      "upstreamStatus",
      "userId",
    ]);
    expect(doc.path).toBe("/api/pixel/submit-task");
    expect(String(doc.requestedCdkMasked)).not.toBe(SENTINEL_CARD);
    expectNoSentinels(doc, "usage-log-doc");
  });
});

describe("上游适配器：失败与超时都不把上游原文/凭据带进日志或错误", () => {
  const config = {
    upstreamBaseUrl: "https://upstream.example.test",
    allowedHosts: ["upstream.example.test"],
    enabled: true,
    requestTimeoutMs: 1_000,
  };

  it("上游抛出的异常不会出现在错误消息或日志里", async () => {
    const client = createPixelUpstreamClient({
      loadConfig: async () => config,
      assertHostPublic: async () => true,
      transport: async () => {
        throw new Error(`socket hang up with body ${SENTINEL_PASSWORD}`);
      },
    });

    await expect(client.call({ route: "submitTask", body: { card_key: SENTINEL_CARD, service_type: "link_only", accounts_text: ACCOUNT_LINE } }))
      .rejects.toMatchObject({ code: "PIXEL_UPSTREAM_UNREACHABLE" });

    const thrown = await client.call({ route: "verifyCard", body: { card_key: SENTINEL_CARD } }).catch((error: unknown) => error as PixelDomainError);
    expectNoSentinels({ message: thrown.message, details: thrown.details }, "upstream-error");
    expectNoSentinels(loggerCalls(), "upstream-logger");
  });

  it("上游 5xx 的响应正文（可能是 HTML 错误页）不会进入错误对象", async () => {
    const client = createPixelUpstreamClient({
      loadConfig: async () => config,
      assertHostPublic: async () => true,
      transport: async () => ({ status: 502, bodyText: `<html>down ${SENTINEL_EMAIL}</html>` }),
    });

    const result = await client.call({ route: "settings" });
    expectNoSentinels(result.data, "upstream-result-data");
  });
});

describe("HTTP 层：内部异常与上游细节不外泄", () => {
  function userRouterWithFailingTaskService(): express.Express {
    const app = express();
    app.use(express.json());
    app.use(createPixelRouter({
      cards: {
        getSettings: async () => { throw new Error(`internal ${SENTINEL_PASSWORD}`); },
        verifyCard: async () => { throw new Error(`internal ${SENTINEL_TOTP}`); },
      },
      tasks: {
        submitTask: async () => { throw new Error(`upstream said ${SENTINEL_EMAIL}`); },
        getTask: async () => { throw new Error(`db ${SENTINEL_PASSWORD}`); },
        listTasksByCard: async () => { throw new Error(`db ${SENTINEL_CARD}`); },
        exportTaskText: async () => { throw new Error(`db ${SENTINEL_CARD}`); },
        exportByCardText: async () => { throw new Error(`db ${SENTINEL_CARD}`); },
        cancelQueuedAccount: async () => { throw new Error(`db ${SENTINEL_CARD}`); },
        exportUserPixelData: async () => { throw new Error(`db ${SENTINEL_EMAIL}`); },
      },
    } as unknown as Parameters<typeof createPixelRouter>[0]));
    return app;
  }

  it("未知内部错误统一返回通用文案，且日志里没有凭据哨兵", async () => {
    const app = userRouterWithFailingTaskService();
    const response = await request(app).post("/submit-task").set("x-test-user", "user-1").send({
      card: SENTINEL_CARD,
      serviceType: "link_only",
      accountsText: ACCOUNT_LINE,
      idempotencyKey: "idem-1",
    });

    expect(response.status).toBe(500);
    expectNoSentinels(response.body, "http-500-body");
    expectNoSentinels(loggerCalls(), "http-500-logger");
  });

  it("导出接口失败时也不回显账号原文", async () => {
    const app = userRouterWithFailingTaskService();
    const response = await request(app).get("/export").set("x-test-user", "user-1");
    expect(response.status).toBe(500);
    expectNoSentinels(response.body, "export-error-body");
  });
});

describe("用户数据副本：只有归属与脱敏溯源", () => {
  it("exportUserPixelData 的输出里不含账号凭据", async () => {
    const usageRows = [{
      logId: "pxl_1",
      requestId: "pxr_1",
      userId: "user-1",
      mappingId: "pcm_1",
      requestedCdkMasked: "sent...9f3a",
      matchedMapping: true,
      method: "POST",
      path: "/api/pixel/submit-task",
      serviceType: "link_only",
      accountCount: 1,
      requestBytes: 10,
      responseBytes: 10,
      upstreamStatus: 200,
      outcome: "success" as const,
      durationMs: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    }];
    const service = createPixelTaskService({
      upstream: { call: async () => { throw new Error("unused"); } },
      mappings: { findByDistributionCdk: async () => null, decryptUpstreamCdk: () => "" },
      access: {
        createIdempotent: async () => { throw new Error("unused"); },
        findByUserAndKey: async () => null,
        findByTaskId: async () => null,
        listByCard: async () => [],
        listByUser: async () => [{
          accessId: "pxa_1",
          userId: "user-1",
          mappingId: "pcm_1",
          distributionCdkHash: "hash-1",
          upstreamTaskId: "task-1",
          serviceType: "link_only",
          accountCount: 1,
          submitState: "accepted" as const,
          submitOutcomeCode: "",
          status: "completed",
          idempotencyKey: "idem-1",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          lastPolledAt: null,
          subjectDeletedAt: 0,
        }],
        patch: async () => undefined,
        remove: async () => undefined,
        markUserDeleted: async () => 0,
      },
      usage: {
        record: async () => undefined,
        listForUser: async () => usageRows,
        deleteForUser: async () => 0,
      },
      settings: async () => ({ autoBindEnabled: true, autoBindOneDollarEnabled: false, services: [] }),
      limits: LIMITS,
    } as unknown as PixelTaskServiceDeps);

    const exported = await service.exportUserPixelData("user-1");
    expectNoSentinels(exported, "user-export");
    // 归属字段在，凭据字段一个都没有。
    expect(Object.keys((exported.tasks as unknown[])[0] as object).sort()).toEqual([
      "accessId",
      "accountCount",
      "createdAt",
      "mappingId",
      "serviceType",
      "status",
      "submitState",
      "upstreamTaskId",
    ]);
    expect(JSON.stringify(exported)).not.toMatch(/password|recovery|totp|secret/i);
  });
});

describe("管理端：分发卡密明文只出现在创建响应，不进审计", () => {
  it("审计条目里不含分发卡密明文与上游卡密", async () => {
    const auditEntries: AuditEntry[] = [];
    const created: PixelCdkMappingCreatedView = {
      mapping: {
        mappingId: "pcm_1",
        distributionCdkMasked: "sent...9f3a",
        upstreamCdkMasked: "upst...9f3a",
        note: "",
        enabled: true,
        createdByUsername: "admin",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
      distributionCdk: SENTINEL_CARD,
    };

    const app = express();
    app.use(express.json());
    app.use(createPixelAdminRouter({
      mappings: {
        create: async () => created,
        list: async () => [],
        remove: async () => undefined,
      },
      usage: { list: async () => ({ items: [], nextCursor: null }), get: async () => null },
      config: {
        getView: async () => ({
          configured: false, enabled: false, upstreamBaseUrl: "", allowedHosts: [],
          requestTimeoutMs: 20_000, updatedAt: null, updatedByUsername: "",
        }),
        save: async () => ({
          configured: false, enabled: false, upstreamBaseUrl: "", allowedHosts: [],
          requestTimeoutMs: 20_000, updatedAt: null, updatedByUsername: "",
        }),
      },
      dashboard: async () => ({
        config: { configured: false, enabled: false, host: "" },
        mappings: { total: 0, enabled: 0 },
        usage: { total: 0, last24h: 0, last7d: 0, lastAt: null },
        tasks: { total: 0, bySubmitState: {} },
      }),
      audit: (entry) => { auditEntries.push(entry); },
    } as unknown as Parameters<typeof createPixelAdminRouter>[0]));

    const response = await request(app)
      .post("/pixel/cdks")
      .set("x-test-role", "superadmin")
      .send({ upstreamCdk: `upstream-${SENTINEL_TOTP}`, note: "" });

    expect(response.status).toBe(201);
    // 明文只在这一次响应里（管理员要当场复制给用户）。
    expect(response.body.data.distributionCdk).toBe(SENTINEL_CARD);
    expectNoSentinels(auditEntries, "admin-audit");
  });
});
