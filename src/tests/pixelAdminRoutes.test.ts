/**
 * Pixel 管理端路由用例（PIX-11…PIX-14 的 HTTP 层 + 审计脱敏）。
 *
 * 注入假 service 与假管理员鉴权；重点断言：
 *   · 写操作只认 superadmin；
 *   · 审计条目里不出现分发卡密明文或上游 CDK（创建响应里有明文，审计里绝不能有）。
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import express from "express";
import request from "supertest";
import { createPixelAdminRouter, type PixelAdminRouterDeps } from "../routes/admin/pixelRoutes";
import { PixelDomainError } from "../pixel/types";
import type { PixelAdminDashboardView, PixelCdkMappingView, PixelUsageLogView } from "../pixel/types";

jest.mock("../middleware/auth", () => ({
  authenticateAdmin: (req: { headers: Record<string, unknown>; user?: unknown }, res: { status: (code: number) => { json: (body: unknown) => void } }, next: () => void) => {
    const admin = req.headers["x-test-admin"];
    const superadmin = req.headers["x-test-superadmin"];
    if (typeof superadmin === "string" && superadmin) {
      req.user = { id: superadmin, username: superadmin, role: "superadmin" };
      next();
      return;
    }
    if (typeof admin === "string" && admin) {
      req.user = { id: admin, username: admin, role: "admin" };
      next();
      return;
    }
    res.status(403).json({ error: "需要管理员权限" });
  },
  authenticateSuperAdmin: (req: { headers: Record<string, unknown>; user?: unknown }, res: { status: (code: number) => { json: (body: unknown) => void } }, next: () => void) => {
    const superadmin = req.headers["x-test-superadmin"];
    if (typeof superadmin === "string" && superadmin) {
      req.user = { id: superadmin, username: superadmin, role: "superadmin" };
      next();
      return;
    }
    res.status(403).json({ error: "需要超级管理员权限" });
  },
}));

// 默导出会实例化真实 service：它们在模块加载时 import mongoose 模型，这里换成占位。
jest.mock("../pixel/cdkMappingService", () => ({ pixelCdkMappingService: {} }));
jest.mock("../pixel/usageLogService", () => ({ pixelUsageLogService: {} }));
jest.mock("../pixel/integrationConfigService", () => ({
  getPixelIntegrationConfigView: async () => ({}),
  savePixelIntegrationConfig: async () => ({}),
}));
jest.mock("../pixel/dashboardService", () => ({ getPixelAdminDashboard: async () => ({}) }));
jest.mock("../services/auditLogService", () => ({ AuditLogService: { log: async () => undefined } }));

const MAPPING: PixelCdkMappingView = {
  mappingId: "pcm_1",
  distributionCdkMasked: "dist...0001",
  upstreamCdkMasked: "upst...0002",
  note: "",
  enabled: true,
  createdByUsername: "admin",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const USAGE: PixelUsageLogView = {
  logId: "pxl_1",
  requestId: "pxr_1",
  userId: "u1",
  mappingId: "pcm_1",
  requestedCdkMasked: "dist...0001",
  matchedMapping: true,
  method: "POST",
  path: "/api/submit-task",
  serviceType: "link_only",
  accountCount: 2,
  requestBytes: 100,
  responseBytes: 50,
  upstreamStatus: 200,
  outcome: "success",
  durationMs: 120,
  createdAt: "2026-01-02T00:00:00.000Z",
};

const DASHBOARD: PixelAdminDashboardView = {
  config: { configured: true, enabled: true, host: "upstream.example.com" },
  mappings: { total: 1, enabled: 1 },
  usage: { total: 3, last24h: 1, last7d: 3, lastAt: "2026-01-02T00:00:00.000Z" },
  tasks: { total: 2, bySubmitState: { accepted: 2 } },
};

describe("pixel 管理端路由", () => {
  let audits: Array<Record<string, unknown>> = [];
  let createError: unknown = null;
  let usageQuery: unknown[] = [];
  let saveCalls: Array<Record<string, unknown>> = [];

  const deps: PixelAdminRouterDeps = {
    mappings: {
      async create(input) {
        if (createError) throw createError;
        return { mapping: MAPPING, distributionCdk: String(input.distributionCdk ?? "") };
      },
      async list() {
        return [MAPPING];
      },
      async remove(mappingId) {
        if (mappingId !== "pcm_1") throw new PixelDomainError("映射不存在。", 404, "PIXEL_MAPPING_NOT_FOUND");
      },
    },
    usage: {
      async list(query) {
        usageQuery.push({ ...query });
        return { items: [USAGE], nextCursor: null };
      },
      async get(logId) {
        return logId === "pxl_1" ? USAGE : null;
      },
    },
    config: {
      async getView() {
        return {
          configured: true,
          enabled: true,
          upstreamBaseUrl: "https://upstream.example.com",
          allowedHosts: ["upstream.example.com"],
          requestTimeoutMs: 20_000,
          updatedAt: "2026-01-01T00:00:00.000Z",
          updatedByUsername: "root",
        };
      },
      async save(input, actor) {
        saveCalls.push({ ...(input as Record<string, unknown>), actor: actor.username });
        if (input && typeof input === "object" && (input as { upstreamBaseUrl?: unknown }).upstreamBaseUrl === "http://bad") {
          throw new PixelDomainError("上游地址必须使用 HTTPS。", 400, "PIXEL_CONFIG_URL_INSECURE");
        }
        return {
          configured: true,
          enabled: true,
          upstreamBaseUrl: "https://upstream.example.com",
          allowedHosts: ["upstream.example.com"],
          requestTimeoutMs: 20_000,
          updatedAt: "2026-01-01T00:00:00.000Z",
          updatedByUsername: actor.username,
        };
      },
    },
    dashboard: async () => DASHBOARD,
    // 合规通道（保全/取证）：本文件只驗管理端契约，这两个通道各自有用例
    // （src/tests/pixelEvidence.test.ts）；这里给能跑通的最小实现。
    holds: {
      async create() {
        throw new PixelDomainError("本用例不覆盖保全登记", 400, "PIXEL_HOLD_NOT_COVERED");
      },
      async list() {
        return [];
      },
      async release() {
        throw new PixelDomainError("本用例不覆盖保全解除", 404, "PIXEL_HOLD_NOT_FOUND");
      },
    },
    evidence: {
      async createApproval() {
        throw new PixelDomainError("本用例不覆盖取证审批", 400, "PIXEL_EVIDENCE_NOT_COVERED");
      },
      async listApprovals() {
        return [];
      },
      async revokeApproval() {
        throw new PixelDomainError("本用例不覆盖取证审批", 404, "PIXEL_EVIDENCE_APPROVAL_NOT_FOUND");
      },
      async listEvidence() {
        return [];
      },
      async readEvidence() {
        throw new PixelDomainError("本用例不覆盖取证读取", 404, "PIXEL_EVIDENCE_NOT_FOUND");
      },
    },
    audit: (entry) => {
      audits.push(entry as unknown as Record<string, unknown>);
    },
  };

  const app = express();
  app.use(express.json());
  app.use("/api/admin", createPixelAdminRouter(deps));

  beforeEach(() => {
    audits = [];
    createError = null;
    usageQuery = [];
    saveCalls = [];
  });

  it("未登录/非管理员被拒绝", async () => {
    expect((await request(app).get("/api/admin/pixel/cdks")).status).toBe(403);
    expect((await request(app).get("/api/admin/pixel/dashboard")).status).toBe(403);
  });

  it("管理员可以读映射列表（只有遮罩值）", async () => {
    const response = await request(app).get("/api/admin/pixel/cdks").set("x-test-admin", "a1");
    expect(response.status).toBe(200);
    expect(response.body.data.items).toEqual([MAPPING]);
    expect(JSON.stringify(response.body)).not.toContain("upstream-cdk");
  });

  it("写操作只认 superadmin（普通管理员 403 且不落审计）", async () => {
    const response = await request(app)
      .post("/api/admin/pixel/cdks")
      .set("x-test-admin", "a1")
      .send({ upstreamCdk: "upstream-cdk-secret" });
    expect(response.status).toBe(403);
    expect(audits).toHaveLength(0);
  });

  it("创建映射：响应含一次分发卡密明文，但审计里没有明文", async () => {
    const response = await request(app)
      .post("/api/admin/pixel/cdks")
      .set("x-test-superadmin", "root")
      .send({ distributionCdk: "dist-card-0001", upstreamCdk: "upstream-cdk-secret", note: "备注" });
    expect(response.status).toBe(201);
    expect(response.body.data.distributionCdk).toBe("dist-card-0001");
    expect(response.body.data.mapping.upstreamCdkMasked).toBe("upst...0002");
    expect(audits).toHaveLength(1);
    const serializedAudit = JSON.stringify(audits[0]);
    expect(serializedAudit).not.toContain("dist-card-0001");
    expect(serializedAudit).not.toContain("upstream-cdk-secret");
    expect(audits[0].action).toBe("pixel.cdk.create");
    expect(audits[0].targetId).toBe("pcm_1");
  });

  it("重复分发卡密按 409 回，并留下失败审计（同样无明文）", async () => {
    createError = new PixelDomainError("该分发卡密已存在。", 409, "PIXEL_MAPPING_CONFLICT");
    const response = await request(app)
      .post("/api/admin/pixel/cdks")
      .set("x-test-superadmin", "root")
      .send({ distributionCdk: "dist-card-0001", upstreamCdk: "upstream-cdk-secret" });
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("PIXEL_MAPPING_CONFLICT");
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0])).not.toContain("upstream-cdk-secret");
  });

  it("删除映射：不存在返回 404", async () => {
    expect((await request(app).delete("/api/admin/pixel/cdks/pcm_1").set("x-test-superadmin", "root")).status).toBe(200);
    const missing = await request(app).delete("/api/admin/pixel/cdks/pcm_9").set("x-test-superadmin", "root");
    expect(missing.status).toBe(404);
  });

  it("溯源列表原样把过滤条件交给 service，并只回脱敏字段", async () => {
    const response = await request(app)
      .get("/api/admin/pixel/cdk-usage?mappingId=pcm_1&cdkMask=dist...0001&limit=25")
      .set("x-test-admin", "a1");
    expect(response.status).toBe(200);
    expect(usageQuery[0]).toMatchObject({ mappingId: "pcm_1", cdkMask: "dist...0001", limit: "25" });
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain("a@example.com");
    expect(serialized).not.toContain("upstream-cdk-secret");
  });

  it("溯源详情：不存在返回 404", async () => {
    expect((await request(app).get("/api/admin/pixel/cdk-usage/pxl_1").set("x-test-admin", "a1")).status).toBe(200);
    expect((await request(app).get("/api/admin/pixel/cdk-usage/pxl_9").set("x-test-admin", "a1")).status).toBe(404);
  });

  it("读取集成配置（管理端才有上游 host）", async () => {
    const response = await request(app).get("/api/admin/pixel/configs").set("x-test-admin", "a1");
    expect(response.status).toBe(200);
    expect(response.body.data.upstreamBaseUrl).toBe("https://upstream.example.com");
  });

  it("保存集成配置仅 superadmin，非法地址按 400 回", async () => {
    expect(
      (await request(app).put("/api/admin/pixel/configs").set("x-test-admin", "a1").send({ upstreamBaseUrl: "https://x.example.com", allowedHosts: ["x.example.com"] })).status,
    ).toBe(403);

    const saved = await request(app)
      .put("/api/admin/pixel/configs")
      .set("x-test-superadmin", "root")
      .send({ upstreamBaseUrl: "https://upstream.example.com", allowedHosts: ["upstream.example.com"], enabled: true });
    expect(saved.status).toBe(200);
    expect(saveCalls[0]).toMatchObject({ enabled: true, actor: "root" });
    expect(audits.some((entry) => entry.action === "pixel.config.update")).toBe(true);

    const rejected = await request(app)
      .put("/api/admin/pixel/configs")
      .set("x-test-superadmin", "root")
      .send({ upstreamBaseUrl: "http://bad", allowedHosts: ["bad"] });
    expect(rejected.status).toBe(400);
    expect(rejected.body.code).toBe("PIXEL_CONFIG_URL_INSECURE");
  });

  it("总览返回真实计数字段", async () => {
    const response = await request(app).get("/api/admin/pixel/dashboard").set("x-test-admin", "a1");
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(DASHBOARD);
  });
});
