/**
 * Pixel 用户态路由契约用例（PIX-02…PIX-09 的 HTTP 层）。
 *
 * 直接挂 createPixelRouter（express + supertest），注入假 service 与假鉴权/同意中间件：
 * 不连 Mongo、不碰网络。只验「路由契约」——鉴权、错误码映射、导出响应头、
 * 请求字段是否原样交给 service。
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import express from "express";
import request from "supertest";
import { createPixelRouter, type PixelRouterDeps } from "../routes/pixelRoutes";
import { createPixelAuditGuard } from "../pixel/requestAudit";
import { PixelDomainError } from "../pixel/types";
import { AuditLogService } from "../services/auditLogService";
import type { PixelCardQuotaView, PixelExportFileView, PixelSettingsView, PixelTaskDetailView } from "../pixel/types";

// 鉴权与同意门禁换成测试替身（它们各自的实现由 middleware 自己的用例覆盖）：
// 这里只关心「路由在无用户时是否拒绝」。
jest.mock("../middleware/authenticateToken", () => ({
  authenticateToken: (req: { headers: Record<string, unknown>; user?: unknown }, _res: unknown, next: () => void) => {
    const header = req.headers["x-test-user"];
    if (typeof header === "string" && header) {
      req.user = { id: header, username: header, role: "user" };
    }
    next();
  },
}));

jest.mock("../middleware/featureConsent", () => ({
  POLICY_CONSENT_REQUIRED_CODE: "POLICY_CONSENT_REQUIRED",
  requireFeatureConsent: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// 真实 service 会 import mongoose 模型；路由用例只验契约，换成占位（默认导出才会用到它们）。
jest.mock("../pixel/cardService", () => ({ pixelCardService: {} }));
jest.mock("../pixel/taskService", () => ({ pixelTaskService: {} }));

// 审计服务换成可断言的假实现：既避免真的起 1s 批量定时器（detectOpenHandles 会盯它），
// 也让「审计条目里没有载荷」这条断言成为可能。
jest.mock("../services/auditLogService", () => ({
  AuditLogService: { log: jest.fn(async () => undefined) },
}));

const SETTINGS: PixelSettingsView = {
  autoBindEnabled: true,
  autoBindOneDollarEnabled: false,
  services: [{ type: "link_only", quotaCost: 0.5, enabled: true }],
};

const QUOTA: PixelCardQuotaView = {
  valid: true,
  remainingQuota: "5",
  totalQuota: "10",
  remainingUnits: 10,
  totalUnits: 20,
  historyAvailable: true,
  message: "卡密有效。",
};

const DETAIL: PixelTaskDetailView = {
  taskId: "t1",
  status: "completed",
  totalAccounts: 1,
  cancelledCount: 0,
  accounts: [],
};

describe("pixel 用户态路由", () => {
  let verifiedCards: unknown[] = [];
  let submittedInputs: Array<Record<string, unknown>> = [];
  let taskLookups: Array<[string, unknown]> = [];
  let cancels: Array<[string, unknown, unknown]> = [];
  let cardError: unknown = null;
  let taskError: unknown = null;
  let exportFile: PixelExportFileView = { filename: "task_t1_success.txt", text: "a@example.com----https://l/1\n" };

  const cards: PixelRouterDeps["cards"] = {
    async getSettings() {
      return SETTINGS;
    },
    async verifyCard(_userId, rawCard) {
      verifiedCards.push(rawCard);
      if (cardError) throw cardError;
      return QUOTA;
    },
  };

  const tasks: PixelRouterDeps["tasks"] = {
    async submitTask(userId, input) {
      submittedInputs.push({ userId, ...(input as unknown as Record<string, unknown>) });
      if (taskError) throw taskError;
      return { taskId: "t1", totalAccounts: 1, status: "pending", message: "任务已提交，正在处理。" };
    },
    async getTask(userId, taskId) {
      taskLookups.push([userId, taskId]);
      if (taskError) throw taskError;
      return DETAIL;
    },
    async listTasksByCard() {
      if (taskError) throw taskError;
      return { tasks: [], total: 0, message: "当前卡密下还没有你的历史任务。" };
    },
    async exportTaskText(userId, taskId) {
      taskLookups.push([userId, taskId]);
      if (taskError) throw taskError;
      return exportFile;
    },
    async exportByCardText() {
      return exportFile;
    },
    async cancelQueuedAccount(userId, taskId, accountId) {
      cancels.push([userId, taskId, accountId]);
      if (taskError) throw taskError;
      return { cancelled: true, alreadyCancelled: false };
    },
    async exportUserPixelData() {
      return { exportedAt: "2026-01-01T00:00:00.000Z", tasks: [], usageLogs: [] };
    },
  };

  const app = express();
  app.use(express.json());
  app.use("/api/pixel", createPixelRouter({ cards, tasks }));

  beforeEach(() => {
    verifiedCards = [];
    submittedInputs = [];
    taskLookups = [];
    cancels = [];
    cardError = null;
    taskError = null;
    exportFile = { filename: "task_t1_success.txt", text: "a@example.com----https://l/1\n" };
  });

  it("未登录时所有用户态端点都是 401（不落到业务层）", async () => {
    for (const path of ["/api/pixel/settings", "/api/pixel/tasks/t1", "/api/pixel/export"]) {
      const response = await request(app).get(path);
      expect(response.status).toBe(401);
      expect(response.body.code).toBe("PIXEL_UNAUTHENTICATED");
    }
    const submit = await request(app).post("/api/pixel/submit-task").send({ card: "c" });
    expect(submit.status).toBe(401);
  });

  it("读取服务开关", async () => {
    const response = await request(app).get("/api/pixel/settings").set("x-test-user", "u1");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, data: SETTINGS });
  });

  it("验证卡密把 body.card 原样交给 service（卡密不进 URL）", async () => {
    const response = await request(app)
      .post("/api/pixel/verify-card")
      .set("x-test-user", "u1")
      .send({ card: "dist-card-0001" });
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(QUOTA);
    expect(verifiedCards).toEqual(["dist-card-0001"]);
  });

  it("领域错误按自带状态码与 code 回（文案已经是用户可读中文）", async () => {
    cardError = new PixelDomainError("卡密不存在或已失效。", 404, "PIXEL_CARD_NOT_FOUND");
    const response = await request(app)
      .post("/api/pixel/verify-card")
      .set("x-test-user", "u1")
      .send({ card: "nope" });
    expect(response.status).toBe(404);
    expect(response.body).toEqual({ success: false, error: "卡密不存在或已失效。", code: "PIXEL_CARD_NOT_FOUND" });
  });

  it("领域错误的 details 只带定位信息（行号/计数）", async () => {
    cardError = new PixelDomainError("第 2 行格式不正确。", 400, "PIXEL_ACCOUNT_LINE_INVALID", { lineNumber: 2 });
    const response = await request(app)
      .post("/api/pixel/submit-task")
      .set("x-test-user", "u1")
      .send({ card: "c", serviceType: "link_only", accountsText: "x", idempotencyKey: "idem-key-0001" });
    expect(response.status).toBe(400);
    expect(response.body.details).toEqual({ lineNumber: 2 });
  });

  it("未预期异常一律 500 通用文案（不泄漏内部信息/栈）", async () => {
    taskError = new Error("ECONNREFUSED https://upstream.internal/api/task");
    const response = await request(app).get("/api/pixel/tasks/t1").set("x-test-user", "u1");
    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      success: false,
      error: "请求暂时无法完成，请稍后重试。",
      code: "PIXEL_INTERNAL_ERROR",
    });
    expect(JSON.stringify(response.body)).not.toContain("upstream.internal");
  });

  it("提交任务把幂等键与账号文本交给 service", async () => {
    const response = await request(app)
      .post("/api/pixel/submit-task")
      .set("x-test-user", "u1")
      .send({
        card: "dist-card-0001",
        serviceType: "link_only",
        accountsText: "a@example.com----p",
        idempotencyKey: "idem-key-0001",
      });
    expect(response.status).toBe(200);
    expect(submittedInputs[0]).toMatchObject({
      userId: "u1",
      card: "dist-card-0001",
      accountsText: "a@example.com----p",
      idempotencyKey: "idem-key-0001",
    });
  });

  it("单任务导出返回 text/plain 与安全的 Content-Disposition", async () => {
    const response = await request(app).get("/api/pixel/tasks/t1/export").set("x-test-user", "u1");
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.headers["content-disposition"]).toBe('attachment; filename="task_t1_success.txt"');
    expect(response.text).toContain("a@example.com----https://l/1");
    expect(taskLookups).toEqual([["u1", "t1"]]);
  });

  it("按卡密导出把 card/accountQuery 交给 service，并返回纯文本", async () => {
    exportFile = { filename: "all_tasks_success_20260101_000000.txt", text: "x@example.com----https://l/x\n" };
    const response = await request(app)
      .post("/api/pixel/tasks/export-by-card")
      .set("x-test-user", "u1")
      .send({ card: "dist-card-0001", accountQuery: "x@" });
    expect(response.status).toBe(200);
    expect(response.headers["content-disposition"]).toContain("all_tasks_success_");
    expect(response.text).toBe("x@example.com----https://l/x\n");
  });

  it("取消排队把 taskId 与 accountId 交给 service", async () => {
    const response = await request(app)
      .post("/api/pixel/tasks/t1/accounts/4/cancel-queue")
      .set("x-test-user", "u1");
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ cancelled: true, alreadyCancelled: false });
    expect(cancels).toEqual([["u1", "t1", "4"]]);
  });

  it("取消失败按领域错误回 409", async () => {
    taskError = new PixelDomainError("该账号已经在处理中，无法取消排队。", 409, "PIXEL_ACCOUNT_NOT_CANCELLABLE");
    const response = await request(app)
      .post("/api/pixel/tasks/t1/accounts/4/cancel-queue")
      .set("x-test-user", "u1");
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("PIXEL_ACCOUNT_NOT_CANCELLABLE");
  });

  it("数据副本端点返回本人任务与脱敏溯源", async () => {
    const response = await request(app).get("/api/pixel/export").set("x-test-user", "u1");
    expect(response.status).toBe(200);
    expect(response.body.data.tasks).toEqual([]);
  });

  it("每个请求都写一条不含载荷的审计（凭据/结果链接不进审计库）", async () => {
    const auditMock = AuditLogService.log as unknown as jest.Mock;
    auditMock.mockClear();
    await request(app).post("/api/pixel/submit-task").set("x-test-user", "u1").send({
      card: "dist-card-0001",
      serviceType: "link_only",
      accountsText: "victim@example.com----P@ssw0rd----r@example.com----TOTPKEY",
      idempotencyKey: "idem-key-0001",
    });
    // finish 事件在响应写完时同步触发；等一拍确保断言看到它
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(auditMock).toHaveBeenCalled();
    const calls = auditMock.mock.calls;
    const entry = calls[calls.length - 1]?.[0] as Record<string, unknown>;
    expect(entry.action).toBe("pixel.user.post");
    expect(entry.path).toBe("/api/pixel/submit-task");
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain("victim@example.com");
    expect(serialized).not.toContain("P@ssw0rd");
    expect(serialized).not.toContain("TOTPKEY");
    expect(serialized).not.toContain("dist-card-0001");
  });
});

describe("pixel 审计守卫", () => {
  it("关掉全局审计的载荷捕获，并写出只含状态码/耗时的条目", async () => {
    const auditMock = AuditLogService.log as unknown as jest.Mock;
    auditMock.mockClear();
    const guardApp = express();
    guardApp.use(express.json());
    guardApp.use(
      createPixelAuditGuard({ module: "other", actionPrefix: "pixel.user" }),
      (req, res) => {
        res.json({
          success: true,
          data: {
            payloadCaptureSuppressed: Boolean((req as { __routeAuditEnabled?: boolean }).__routeAuditEnabled),
          },
        });
      },
    );
    const response = await request(guardApp).get("/anything?card=dist-card-0001");
    expect(response.body.data.payloadCaptureSuppressed).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const calls = auditMock.mock.calls;
    const entry = calls[calls.length - 1]?.[0] as Record<string, unknown>;
    expect(entry).toMatchObject({ action: "pixel.user.get", path: "/anything", method: "GET" });
    expect(entry.detail).toEqual({ statusCode: 200, durationMs: expect.any(Number) });
    expect(JSON.stringify(entry)).not.toContain("dist-card-0001");
  });
});
