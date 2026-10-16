import express, { type Request, type Response } from "express";
import { authenticateAdmin, authenticateSuperAdmin } from "../../middleware/auth";
import { pixelCdkMappingService } from "../../pixel/cdkMappingService";
import { getPixelAdminDashboard } from "../../pixel/dashboardService";
import {
  getPixelIntegrationConfigView,
  savePixelIntegrationConfig,
} from "../../pixel/integrationConfigService";
import { pixelUsageLogService } from "../../pixel/usageLogService";
import { suppressAuditPayloadCapture } from "../../pixel/requestAudit";
import { PixelDomainError, type PixelAdminDashboardView } from "../../pixel/types";
import { AuditLogService, type AuditEntry } from "../../services/auditLogService";
import logger from "../../utils/logger";

/**
 * Pixel 管理端（`/api/admin/pixel/*`，PIX-11/PIX-12/PIX-13/PIX-14 的 Phase 4 子集）。
 *
 * 挂载点：/api/admin（src/routes/admin/index.ts，`router.use(pixelAdminRouter)`），
 * 页面前缀 /admin/pixel。读接口要求 admin 角色 + adminScope 页面授权（页面 key 需登记到
 * src/config/adminPages.ts，apiPrefixes 为 ["/api/admin/pixel"]）；**写接口一律 superadmin**
 * （上游 CDK、上游地址都是能改上游行为的凭据）。
 *
 * 为什么不用通用 `auditLog` 中间件：它会把 `resBody` 一起写进审计（middleware/auditLog.ts 的
 * `resBody: sanitizePayload(resBody)`），而创建映射的响应里**刻意包含一次**分发卡密明文
 * （管理员要当场复制给用户）。用通用中间件等于把完整卡密抄一份进审计库，直接违反 PRD 6.1.3。
 * 因此这里显式调 AuditLogService.log，detail 里只放非敏感字段；同时用
 * `suppressAuditPayloadCapture` 把全局审计（`AuditLogService.globalAuditMiddleware`）也按
 * “只看不留痕”处理：它在 `AUDIT_LOG_CAPTURE_PAYLOADS=true` 时会原样捕获 req.body/resBody。
 * 这是把「审计库不能出现上游 CDK」从「默认配置下的巧合」变成「任何配置下的保证」。
 *
 * 另：溯源列表用 `cdkMask`（列表里显示的遮罩值）而不是完整卡密——全局审计的 `detail.query` 是
 * **无条件**捕获的（不受载荷开关影响），把完整卡密放进 URL 等于默认就会落库一份。
 */

export interface PixelAdminRouterDeps {
  mappings: Pick<typeof pixelCdkMappingService, "create" | "list" | "remove">;
  usage: Pick<typeof pixelUsageLogService, "list" | "get">;
  config: {
    getView: typeof getPixelIntegrationConfigView;
    save: typeof savePixelIntegrationConfig;
  };
  dashboard: () => Promise<PixelAdminDashboardView>;
  /** 注入点：单测不连 Mongo；默认 fire-and-forget 写审计。 */
  audit?: (entry: AuditEntry) => void | Promise<void>;
}

function jsonBody(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>)
    : {};
}

function actorOf(req: Request): { userId: string; username: string } {
  const user = (req as Request & { user?: { id?: unknown; username?: unknown } }).user;
  return {
    userId: String(user?.id ?? "unknown"),
    username: String(user?.username ?? "unknown"),
  };
}

function sendError(res: Response, action: string, error: unknown): void {
  if (error instanceof PixelDomainError) {
    res.status(error.status).json({
      success: false,
      error: error.message,
      code: error.code,
      ...(error.details ? { details: error.details } : {}),
    });
    return;
  }
  logger.error("[PixelAdmin] 请求失败", {
    action,
    errorType: error instanceof Error ? error.name : "unknown",
  });
  res.status(500).json({ success: false, error: "请求暂时无法完成，请稍后重试。", code: "PIXEL_ADMIN_ERROR" });
}

export function createPixelAdminRouter(deps: PixelAdminRouterDeps): express.Router {
  const router = express.Router();
  const auditFn = deps.audit ?? ((entry: AuditEntry) => {
    void AuditLogService.log(entry).catch(() => undefined);
  });

  /**
   * 显式审计：只记「谁、什么时候、对哪条映射做了什么、结果如何」。
   * detail 由调用方显式给出，**不含请求体/响应体**——分发卡密与上游 CDK 因此不会进审计库。
   */
  function audit(
    req: Request,
    res: Response,
    input: {
      module: AuditEntry["module"];
      action: string;
      targetId?: string;
      detail?: Record<string, unknown>;
      result?: "success" | "failure";
      errorMessage?: string;
    },
  ): void {
    const actor = actorOf(req);
    void auditFn({
      requestId: (req as Request & { requestId?: string }).requestId,
      userId: actor.userId,
      username: actor.username,
      role: String((req as Request & { user?: { role?: unknown } }).user?.role ?? "unknown"),
      action: input.action,
      module: input.module,
      targetId: input.targetId,
      result: input.result ?? "success",
      errorMessage: input.errorMessage,
      detail: { ...input.detail, statusCode: res.statusCode },
      // path 去掉 query：管理端列表带参数，但审计只需定位到端点。
      path: (req.originalUrl || req.path).split("?")[0],
      method: req.method,
      ip: req.ip || req.socket?.remoteAddress || "unknown",
      userAgent: req.headers["user-agent"],
    });
  }

  /**
   * @openapi
   * /api/admin/pixel/cdks:
   *   get:
   *     summary: 列出分发卡密映射（上游 CDK 只回遮罩值）
   *     responses:
   *       200:
   *         description: 映射列表
   *       401:
   *         description: 未登录
   *       403:
   *         description: 需要管理员权限
   *   post:
   *     summary: 创建分发卡密映射（响应里只返回一次分发卡密明文）
   *     description: 分发卡密可自填或留空自动生成；上游 CDK 必填，加密存储且只回遮罩值。重复分发卡密返回 409。
   *     responses:
   *       201:
   *         description: 已创建
   *       400:
   *         description: 入参非法
   *       403:
   *         description: 需要超级管理员权限
   *       409:
   *         description: 分发卡密已存在
   */
  // codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter); in-router copy would split quota
  router.get("/pixel/cdks", authenticateAdmin, async (_req, res) => {
    try {
      const items = await deps.mappings.list();
      res.json({ success: true, data: { items } });
    } catch (error) {
      sendError(res, "list-cdks", error);
    }
  });

  // codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter); in-router copy would split quota
  router.post("/pixel/cdks", authenticateSuperAdmin, async (req, res) => {
    // 请求体（上游 CDK、可选的分发卡密）与响应体（一次性明文分发卡密）都不能进审计载荷。
    suppressAuditPayloadCapture(req);
    const body = jsonBody(req);
    try {
      const created = await deps.mappings.create(
        { distributionCdk: body.distributionCdk, upstreamCdk: body.upstreamCdk, note: body.note },
        actorOf(req),
      );
      res.status(201).json({ success: true, data: created });
      // 审计写在响应之后：这样记录到的 statusCode 是真实状态码（审计条目在写时读取 res.statusCode）。
      audit(req, res, {
        module: "cdk",
        action: "pixel.cdk.create",
        targetId: created.mapping.mappingId,
        detail: {
          // 只记「有没有备注」「是否启用」这类非敏感状态，绝不记卡密（无论明文还是遮罩都无必要）。
          hasNote: Boolean(created.mapping.note),
          enabled: created.mapping.enabled,
        },
      });
    } catch (error) {
      // 同上：先把状态码落到 res，再记审计（否则失败审计会记成 200）。
      sendError(res, "create-cdk", error);
      audit(req, res, {
        module: "cdk",
        action: "pixel.cdk.create",
        result: "failure",
        errorMessage: error instanceof Error ? error.name : "unknown",
      });
    }
  });

  /**
   * @openapi
   * /api/admin/pixel/cdks/{id}:
   *   delete:
   *     summary: 删除分发卡密映射
   *     description: 删除后该卡密不再能验证/提交；已提交的任务仍可按 taskId 查询（归属记录保留）。
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: 已删除
   *       403:
   *         description: 需要超级管理员权限
   *       404:
   *         description: 映射不存在
   */
  // codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter); in-router copy would split quota
  router.delete("/pixel/cdks/:id", authenticateSuperAdmin, async (req, res) => {
    try {
      await deps.mappings.remove(String(req.params.id ?? ""));
      res.json({ success: true, data: { deleted: true } });
      audit(req, res, { module: "cdk", action: "pixel.cdk.delete", targetId: String(req.params.id ?? "") });
    } catch (error) {
      sendError(res, "delete-cdk", error);
      audit(req, res, {
        module: "cdk",
        action: "pixel.cdk.delete",
        targetId: String(req.params.id ?? ""),
        result: "failure",
        errorMessage: error instanceof Error ? error.name : "unknown",
      });
    }
  });

  /**
   * @openapi
   * /api/admin/pixel/cdk-usage:
   *   get:
   *     summary: 列出脱敏调用溯源
   *     description: 默认 50 条、上限 200；可按 mappingId 或 cdkMask（列表里显示的遮罩值）过滤。不接受完整卡密——查询串会被无条件写进全局审计。不返回账号内容、明文卡密或上游原文。
   *     parameters:
   *       - in: query
   *         name: mappingId
   *         schema:
   *           type: string
   *       - in: query
   *         name: cdkMask
   *         schema:
   *           type: string
   *       - in: query
   *         name: limit
   *         schema:
   *           type: integer
   *       - in: query
   *         name: cursor
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: 溯源列表
   *       403:
   *         description: 需要管理员权限
   */
  // codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter); in-router copy would split quota
  router.get("/pixel/cdk-usage", authenticateAdmin, async (req, res) => {
    try {
      const query = req.query as Record<string, unknown>;
      const data = await deps.usage.list({
        mappingId: typeof query.mappingId === "string" ? query.mappingId : undefined,
        cdkMask: typeof query.cdkMask === "string" ? query.cdkMask : undefined,
        limit: query.limit,
        cursor: query.cursor,
      });
      res.json({ success: true, data });
    } catch (error) {
      sendError(res, "list-usage", error);
    }
  });

  /**
   * @openapi
   * /api/admin/pixel/cdk-usage/{id}:
   *   get:
   *     summary: 读取单条溯源详情
   *     responses:
   *       200:
   *         description: 溯源详情
   *       403:
   *         description: 需要管理员权限
   *       404:
   *         description: 记录不存在
   */
  // codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter); in-router copy would split quota
  router.get("/pixel/cdk-usage/:id", authenticateAdmin, async (req, res) => {
    try {
      const item = await deps.usage.get(String(req.params.id ?? ""));
      if (!item) {
        res.status(404).json({ success: false, error: "溯源记录不存在。", code: "PIXEL_USAGE_NOT_FOUND" });
        return;
      }
      res.json({ success: true, data: { item } });
    } catch (error) {
      sendError(res, "get-usage", error);
    }
  });

  /**
   * @openapi
   * /api/admin/pixel/configs:
   *   get:
   *     summary: 读取上游集成配置
   *     description: 只在管理端展示上游地址与允许主机清单；用户侧接口从不返回上游 host。
   *     responses:
   *       200:
   *         description: 配置视图
   *       403:
   *         description: 需要管理员权限
   *   put:
   *     summary: 保存上游集成配置（仅超级管理员）
   *     description: 地址必须 HTTPS 且主机在允许清单内；未配置时所有上游调用一律失败（fail-closed，没有默认地址）。
   *     responses:
   *       200:
   *         description: 保存后的配置视图
   *       400:
   *         description: 地址或主机清单非法
   *       403:
   *         description: 需要超级管理员权限
   */
  // codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter); in-router copy would split quota
  router.get("/pixel/configs", authenticateAdmin, async (_req, res) => {
    try {
      res.json({ success: true, data: await deps.config.getView() });
    } catch (error) {
      sendError(res, "get-config", error);
    }
  });

  // codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter); in-router copy would split quota
  router.put("/pixel/configs", authenticateSuperAdmin, async (req, res) => {
    // 集成配置写操作的 body 里可能有上游地址/主机清单：审计只需「改没改、改成什么开关」，不需要载荷。
    suppressAuditPayloadCapture(req);
    const body = jsonBody(req);
    try {
      const view = await deps.config.save(
        {
          upstreamBaseUrl: body.upstreamBaseUrl,
          allowedHosts: body.allowedHosts,
          enabled: body.enabled,
          requestTimeoutMs: body.requestTimeoutMs,
        },
        actorOf(req),
      );
      res.json({ success: true, data: view });
      audit(req, res, {
        module: "config",
        action: "pixel.config.update",
        // 记「启用了没有 / 主机数」，不记地址本体以外的东西；地址本身是运维定位必要信息。
        detail: { enabled: view.enabled, hostCount: view.allowedHosts.length },
      });
    } catch (error) {
      sendError(res, "save-config", error);
      audit(req, res, {
        module: "config",
        action: "pixel.config.update",
        result: "failure",
        errorMessage: error instanceof Error ? error.name : "unknown",
      });
    }
  });

  /**
   * @openapi
   * /api/admin/pixel/dashboard:
   *   get:
   *     summary: Pixel 运行总览
   *     description: 映射计数、脱敏溯源计数与最近调用时间、按本地提交状态的任务计数、上游是否已配置。没有数据源就报未配置/0，不虚构指标。
   *     responses:
   *       200:
   *         description: 总览
   *       403:
   *         description: 需要管理员权限
   */
  // codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter); in-router copy would split quota
  router.get("/pixel/dashboard", authenticateAdmin, async (_req, res) => {
    try {
      res.json({ success: true, data: await deps.dashboard() });
    } catch (error) {
      sendError(res, "dashboard", error);
    }
  });

  return router;
}

export default createPixelAdminRouter({
  mappings: pixelCdkMappingService,
  usage: pixelUsageLogService,
  config: { getView: getPixelIntegrationConfigView, save: savePixelIntegrationConfig },
  dashboard: getPixelAdminDashboard,
});
