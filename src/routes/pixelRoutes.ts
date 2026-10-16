import express, { type Request, type Response } from "express";
import { authenticateToken } from "../middleware/authenticateToken";
import { requireFeatureConsent } from "../middleware/featureConsent";
import { pixelCardService, type PixelCardService } from "../pixel/cardService";
import { pixelTaskService, type PixelTaskService } from "../pixel/taskService";
import { createPixelAuditGuard } from "../pixel/requestAudit";
import { PixelDomainError } from "../pixel/types";
import { asAuthenticatedRequest } from "../types/authRequest";
import logger from "../utils/logger";
import type { FeatureConsentKey } from "../config/featureConsent";

/**
 * Pixel 用户态路由（`/api/pixel`）——卡密验证、任务提交/查询/导出/取消（PIX-02…PIX-09）。
 *
 * 挂载：routeModules 的 pre-docs 相位（与 /api/geogebra 同级），挂载层可再叠一个 JWT 中间件；
 * 本 router 自己也 `router.use(authenticateToken)`，因此无论怎么挂都不会出现未鉴权端点。
 *
 * **限流**：不要在本文件里 `router.use()` 挂共享 limiter 实例（同一实例被计两次会把配额分掉一半）。
 * `/api/pixel` 的限流由 routeLimiterModules 里更早注册的限流模块承担：
 * `pixel-limiter-verify`（20/分）、`pixel-limiter-submit`（10/分），其余查询类由
 * `pixel-limiter-settings` / `pixel-limiter-tasks` / `pixel-limiter-tasks-by-card` /
 * `pixel-limiter-export` 承担（60/分），全部按「用户 + IP」双键分桶。
 *
 * **审计**：整棵子树装 `createPixelAuditGuard`（见 src/pixel/requestAudit.ts）——“每个请求都留痕、
 * 但审计库不出现请求体/响应体/查询串”，因为本域的 body 里有账号凭据、响应里有完整结果链接。
 *
 * **同意门禁**：凡是把账号凭据交给上游的端点都要过 account-credential 类门禁
 * （terms + specific-terms）。这里用专门的 `pixel-tasks`（已登记在 src/config/featureConsent.ts，
 * 分类 account-credential），而不是复用 `cdk-redeem`：前者的用户可见说明写清了
 * 「账号邮箱/密码/辅助邮箱/2FA 秘钥会交给外部服务」这件事，后者只讲 CDK 兑换。
 */
const PIXEL_CONSENT_KEY: FeatureConsentKey = "pixel-tasks";

export interface PixelRouterDeps {
  cards: Pick<PixelCardService, "getSettings" | "verifyCard">;
  tasks: Pick<
    PixelTaskService,
    | "submitTask"
    | "getTask"
    | "listTasksByCard"
    | "exportTaskText"
    | "exportByCardText"
    | "cancelQueuedAccount"
    | "exportUserPixelData"
  >;
}

function currentUserId(req: Request): string {
  return String(asAuthenticatedRequest(req).user?.id ?? "").trim();
}

function requestIdOf(req: Request): string | undefined {
  const value = (req as Request & { requestId?: unknown }).requestId;
  return typeof value === "string" && value ? value : undefined;
}

function jsonBody(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>)
    : {};
}

/**
 * 错误响应：领域错误按自带状态码回（message 已保证是用户可读中文，不含上游地址/原文/栈）；
 * 其它异常统一 500 通用文案，诊断信息只进服务端日志。
 */
function sendError(res: Response, action: string, error: unknown): void {
  if (error instanceof PixelDomainError) {
    res.status(error.status).json({
      success: false,
      error: error.message,
      code: error.code,
      // details 只承载行号/计数这类定位信息（见 types.PixelDomainError 的约束）。
      ...(error.details ? { details: error.details } : {}),
    });
    return;
  }
  logger.error("[Pixel] 请求失败", {
    action,
    errorType: error instanceof Error ? error.name : "unknown",
  });
  res.status(500).json({ success: false, error: "请求暂时无法完成，请稍后重试。", code: "PIXEL_INTERNAL_ERROR" });
}

function sendTextFile(res: Response, filename: string, text: string): void {
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.status(200).send(text);
}

export function createPixelRouter(deps: PixelRouterDeps): express.Router {
  const router = express.Router();

  // 整棵 /api/pixel 只给登录用户：卡密额度、任务归属、结果链接都绑定在 Synapse 账号上。
  router.use(authenticateToken);
  // 审计留痕但不留载荷（账号凭据/结果链接不得落进审计库），挂在认证之后以便审计带 userId。
  router.use(createPixelAuditGuard({ module: "other", actionPrefix: "pixel.user" }));

  /**
   * @openapi
   * /pixel/settings:
   *   get:
   *     summary: 读取可用的服务类型与后台开关
   *     description: 返回三个服务类型（link_only / link_and_bind / link_and_bind_1usd）、预估额度与上游是否可用。上游未配置时 503。
   *     responses:
   *       200:
   *         description: 服务选项
   *       401:
   *         description: 未登录
   *       503:
   *         description: 上游服务未配置或已关闭
   */
  router.get("/settings", async (req, res) => {
    const userId = currentUserId(req);
    if (!userId) {
      res.status(401).json({ success: false, error: "请先登录。", code: "PIXEL_UNAUTHENTICATED" });
      return;
    }
    try {
      const data = await deps.cards.getSettings(userId, requestIdOf(req));
      res.json({ success: true, data });
    } catch (error) {
      sendError(res, "settings", error);
    }
  });

  /**
   * @openapi
   * /pixel/verify-card:
   *   post:
   *     summary: 验证卡密并返回额度
   *     description: 卡密只在请求体里传（避免进入 URL/访问日志）。响应同时给出展示额度与计费单位；卡密无效时仍可查历史任务。
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [card]
   *             properties:
   *               card:
   *                 type: string
   *     responses:
   *       200:
   *         description: 额度视图
   *       400:
   *         description: 卡密缺失或格式不正确
   *       401:
   *         description: 未登录
   *       403:
   *         description: 未同意相关条款，或卡密已停用
   *       404:
   *         description: 卡密不存在
   *       503:
   *         description: 上游未配置
   */
  router.post("/verify-card", requireFeatureConsent(PIXEL_CONSENT_KEY), async (req, res) => {
    const userId = currentUserId(req);
    if (!userId) {
      res.status(401).json({ success: false, error: "请先登录。", code: "PIXEL_UNAUTHENTICATED" });
      return;
    }
    try {
      const data = await deps.cards.verifyCard(userId, jsonBody(req).card, requestIdOf(req));
      res.json({ success: true, data });
    } catch (error) {
      sendError(res, "verify-card", error);
    }
  });

  /**
   * @openapi
   * /pixel/submit-task:
   *   post:
   *     summary: 提交账号处理任务
   *     description: 账号文本每行一个（邮箱----密码----辅助邮箱----2FA密钥），只驻留服务端内存。必须带 idempotencyKey，重复提交不会重复扣额。
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [card, serviceType, accountsText, idempotencyKey]
   *             properties:
   *               card:
   *                 type: string
   *               serviceType:
   *                 type: string
   *                 enum: [link_only, link_and_bind, link_and_bind_1usd]
   *               accountsText:
   *                 type: string
   *               idempotencyKey:
   *                 type: string
   *     responses:
   *       200:
   *         description: 任务已受理
   *       400:
   *         description: 入参非法、服务已关闭或上游明确拒绝
   *       401:
   *         description: 未登录
   *       403:
   *         description: 未同意相关条款，或卡密已停用
   *       404:
   *         description: 卡密不存在
   *       409:
   *         description: 同一幂等键的提交仍在处理中
   *       413:
   *         description: 账号文本过长
   *       502:
   *         description: 提交结果不确定（请勿重复提交）
   *       503:
   *         description: 上游未配置
   */
  router.post("/submit-task", requireFeatureConsent(PIXEL_CONSENT_KEY), async (req, res) => {
    const userId = currentUserId(req);
    if (!userId) {
      res.status(401).json({ success: false, error: "请先登录。", code: "PIXEL_UNAUTHENTICATED" });
      return;
    }
    const body = jsonBody(req);
    try {
      const data = await deps.tasks.submitTask(
        userId,
        {
          card: body.card,
          accountsText: body.accountsText,
          serviceType: body.serviceType,
          idempotencyKey: body.idempotencyKey,
        },
        requestIdOf(req),
      );
      res.json({ success: true, data });
    } catch (error) {
      sendError(res, "submit-task", error);
    }
  });

  /**
   * @openapi
   * /pixel/tasks-by-card:
   *   post:
   *     summary: 查询某个卡密下属于本人的历史任务
   *     description: 上游按整张卡密返回任务，服务端只保留属于调用者的 task id；accountQuery 为可选的账号关键字。
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [card]
   *             properties:
   *               card:
   *                 type: string
   *               accountQuery:
   *                 type: string
   *     responses:
   *       200:
   *         description: 任务摘要列表
   *       400:
   *         description: 入参非法
   *       401:
   *         description: 未登录
   *       403:
   *         description: 未同意相关条款，或卡密已停用
   *       404:
   *         description: 卡密不存在
   */
  router.post("/tasks-by-card", requireFeatureConsent(PIXEL_CONSENT_KEY), async (req, res) => {
    const userId = currentUserId(req);
    if (!userId) {
      res.status(401).json({ success: false, error: "请先登录。", code: "PIXEL_UNAUTHENTICATED" });
      return;
    }
    const body = jsonBody(req);
    try {
      const data = await deps.tasks.listTasksByCard(
        userId,
        { card: body.card, accountQuery: body.accountQuery },
        requestIdOf(req),
      );
      res.json({ success: true, data });
    } catch (error) {
      sendError(res, "tasks-by-card", error);
    }
  });

  /**
   * @openapi
   * /pixel/tasks/export-by-card:
   *   post:
   *     summary: 导出某个卡密下本人已完成账号的文本
   *     description: 纯文本，每行 `email----result_link`；只包含本人任务且有结果链接的账号。
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [card]
   *             properties:
   *               card:
   *                 type: string
   *               accountQuery:
   *                 type: string
   *     responses:
   *       200:
   *         description: text/plain 导出文件
   *       401:
   *         description: 未登录
   *       403:
   *         description: 未同意相关条款，或卡密已停用
   *       404:
   *         description: 卡密不存在
   */
  router.post("/tasks/export-by-card", requireFeatureConsent(PIXEL_CONSENT_KEY), async (req, res) => {
    const userId = currentUserId(req);
    if (!userId) {
      res.status(401).json({ success: false, error: "请先登录。", code: "PIXEL_UNAUTHENTICATED" });
      return;
    }
    const body = jsonBody(req);
    try {
      const file = await deps.tasks.exportByCardText(
        userId,
        { card: body.card, accountQuery: body.accountQuery },
        requestIdOf(req),
      );
      sendTextFile(res, file.filename, file.text);
    } catch (error) {
      sendError(res, "tasks-export-by-card", error);
    }
  });

  /**
   * @openapi
   * /pixel/tasks/{taskId}:
   *   get:
   *     summary: 查询任务详情（含账号状态与结果链接）
   *     description: 只能查询本人在本服务提交过的任务，其他人一律 404。终态为 completed/failed/cancelled。
   *     parameters:
   *       - in: path
   *         name: taskId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: 任务详情
   *       401:
   *         description: 未登录
   *       404:
   *         description: 任务不存在或不属于当前用户
   */
  router.get("/tasks/:taskId", async (req, res) => {
    const userId = currentUserId(req);
    if (!userId) {
      res.status(401).json({ success: false, error: "请先登录。", code: "PIXEL_UNAUTHENTICATED" });
      return;
    }
    try {
      const data = await deps.tasks.getTask(userId, req.params.taskId, requestIdOf(req));
      res.json({ success: true, data });
    } catch (error) {
      sendError(res, "task-detail", error);
    }
  });

  /**
   * @openapi
   * /pixel/tasks/{taskId}/export:
   *   get:
   *     summary: 导出单个任务的成功账号文本
   *     description: 纯文本，每行 `email----result_link`；下载前重新做归属校验，不信任前端缓存。
   *     parameters:
   *       - in: path
   *         name: taskId
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: text/plain 导出文件
   *       401:
   *         description: 未登录
   *       404:
   *         description: 任务不存在或不属于当前用户
   */
  router.get("/tasks/:taskId/export", async (req, res) => {
    const userId = currentUserId(req);
    if (!userId) {
      res.status(401).json({ success: false, error: "请先登录。", code: "PIXEL_UNAUTHENTICATED" });
      return;
    }
    try {
      const file = await deps.tasks.exportTaskText(userId, req.params.taskId, requestIdOf(req));
      sendTextFile(res, file.filename, file.text);
    } catch (error) {
      sendError(res, "task-export", error);
    }
  });

  /**
   * @openapi
   * /pixel/tasks/{taskId}/accounts/{accountId}/cancel-queue:
   *   post:
   *     summary: 取消仍在排队的账号
   *     description: 只有 pending 账号可以取消；已取消的重复请求返回成功（幂等），已开始处理的返回 409。
   *     parameters:
   *       - in: path
   *         name: taskId
   *         required: true
   *         schema:
   *           type: string
   *       - in: path
   *         name: accountId
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: 取消结果
   *       400:
   *         description: 账号标识非法
   *       401:
   *         description: 未登录
   *       404:
   *         description: 任务或账号不存在
   *       409:
   *         description: 账号已在处理中，无法取消
   *       502:
   *         description: 取消结果不确定
   */
  router.post("/tasks/:taskId/accounts/:accountId/cancel-queue", async (req, res) => {
    const userId = currentUserId(req);
    if (!userId) {
      res.status(401).json({ success: false, error: "请先登录。", code: "PIXEL_UNAUTHENTICATED" });
      return;
    }
    try {
      const data = await deps.tasks.cancelQueuedAccount(
        userId,
        req.params.taskId,
        req.params.accountId,
        requestIdOf(req),
      );
      res.json({ success: true, data });
    } catch (error) {
      sendError(res, "cancel-queue", error);
    }
  });

  /**
   * @openapi
   * /pixel/export:
   *   get:
   *     summary: 导出本人的 Pixel 数据副本
   *     description: 只含任务归属与脱敏溯源；账号文本、密码、辅助邮箱、2FA 秘钥与卡密明文从不入库，因此不在副本里。
   *     responses:
   *       200:
   *         description: 数据副本
   *       401:
   *         description: 未登录
   */
  router.get("/export", async (req, res) => {
    const userId = currentUserId(req);
    if (!userId) {
      res.status(401).json({ success: false, error: "请先登录。", code: "PIXEL_UNAUTHENTICATED" });
      return;
    }
    try {
      res.json({ success: true, data: await deps.tasks.exportUserPixelData(userId) });
    } catch (error) {
      sendError(res, "export-user-data", error);
    }
  });

  return router;
}

export default createPixelRouter({ cards: pixelCardService, tasks: pixelTaskService });
