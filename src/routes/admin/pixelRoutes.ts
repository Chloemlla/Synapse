import express, { type Request, type Response } from "express";
import { authenticateAdmin, authenticateSuperAdmin } from "../../middleware/auth";
import { pixelCdkMappingService } from "../../pixel/cdkMappingService";
import { getPixelAdminDashboard } from "../../pixel/dashboardService";
import {
  getPixelIntegrationConfigView,
  resetPixelIntegrationConfig,
  savePixelIntegrationConfig,
} from "../../pixel/integrationConfigService";
import { pixelUsageLogService } from "../../pixel/usageLogService";
import {
  createPixelEvidenceHold,
  listPixelEvidenceHolds,
  releasePixelEvidenceHold,
} from "../../pixel/evidenceHoldService";
import {
  createEvidenceApproval,
  listEvidenceApprovals,
  listPixelEvidence,
  readPixelEvidence,
  revokeEvidenceApproval,
} from "../../pixel/evidenceService";
import {
  assertReencryptLimit,
  canRetirePreviousMasterKey,
  getPixelKeyRotationStatus,
  reencryptPixelSecretsWithCurrentKey,
} from "../../pixel/reencryptService";
import { assertSecuritySessionBinding, hasValidSecuritySession } from "../../utils/securitySession";
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
    reset: typeof resetPixelIntegrationConfig;
  };
  dashboard: () => Promise<PixelAdminDashboardView>;
  /** 法律保全：登记（快照）/列表/解除。 */
  holds: {
    create: typeof createPixelEvidenceHold;
    list: typeof listPixelEvidenceHolds;
    release: typeof releasePixelEvidenceHold;
  };
  /** 内容级取证：按审批开启、逐次审计读取。 */
  evidence: {
    createApproval: typeof createEvidenceApproval;
    listApprovals: typeof listEvidenceApprovals;
    revokeApproval: typeof revokeEvidenceApproval;
    listEvidence: typeof listPixelEvidence;
    readEvidence: typeof readPixelEvidence;
  };
  /** 主密钥轮换的体检与重加密迁移。 */
  keyRotation: {
    status: typeof getPixelKeyRotationStatus;
    reencrypt: typeof reencryptPixelSecretsWithCurrentKey;
    canRetire: typeof canRetirePreviousMasterKey;
  };
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
      // 原样交给 service：allowlist（只允许四个可写字段）必须在服务层生效，
      // 否则「禁止受保护字段」只会在路由这一层被悄悄过滤掉，等于没有拦截。
      const view = await deps.config.save(body, actorOf(req));
      res.json({ success: true, data: view });
      audit(req, res, {
        module: "config",
        action: "pixel.config.update",
        // 记「启用了没有 / 主机数」，不记地址本体以外的东西；地址本身是运维定位必要信息。
        detail: { enabled: view.enabled, hostCount: view.allowedHosts.length, source: view.source },
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
   * /api/admin/pixel/configs:
   *   delete:
   *     summary: 恢复默认上游集成配置（仅超级管理员）
   *     description: 删除数据库记录，回到「环境变量 > 内置默认」的来源。默认没有上游地址，删除后所有上游调用继续 fail-closed。
   *     responses:
   *       200:
   *         description: 恢复后的配置视图（含 source/overridden/reload）
   *       403:
   *         description: 需要超级管理员权限
   */
  // codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter); in-router copy would split quota
  router.delete("/pixel/configs", authenticateSuperAdmin, async (req, res) => {
    try {
      const view = await deps.config.reset();
      res.json({ success: true, data: view });
      audit(req, res, {
        module: "config",
        action: "pixel.config.reset",
        // 只记录恢复到哪个来源；不记录被删除的具体地址。
        detail: { source: view.source },
      });
    } catch (error) {
      audit(req, res, {
        module: "config",
        action: "pixel.config.reset",
        result: "failure",
        errorMessage: error instanceof Error ? error.name : "unknown",
      });
      sendError(res, "reset-config", error);
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

  /**
   * @openapi
   * /api/admin/pixel/legal-holds:
   *   get:
   *     summary: 列出法律保全（受法律程序约束的账号）
   *     description: 只返回保全元数据与快照行数，不返回快照明细。
   *     responses:
   *       200:
   *         description: 保全列表
   *   post:
   *     summary: 登记法律保全并快照证据（仅超级管理员）
   *     description: 案件编号与法律依据必填。登记后该账号的物理清理一律跳过，快照不带 TTL。
   *     responses:
   *       201:
   *         description: 已登记
   *       400:
   *         description: 缺案件编号或法律依据
   *       403:
   *         description: 需要超级管理员权限
   */
  // codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter); in-router copy would split quota
  router.get("/pixel/legal-holds", authenticateAdmin, async (req, res) => {
    try {
      const includeReleased = String(req.query.includeReleased ?? "") === "1";
      res.json({ success: true, data: { items: await deps.holds.list({ includeReleased }) } });
    } catch (error) {
      sendError(res, "list-holds", error);
    }
  });

  // codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter); in-router copy would split quota
  router.post("/pixel/legal-holds", authenticateSuperAdmin, async (req, res) => {
    const body = jsonBody(req);
    try {
      const created = await deps.holds.create({
        userId: String(body.userId ?? ""),
        caseRef: String(body.caseRef ?? ""),
        legalBasis: String(body.legalBasis ?? ""),
        reason: typeof body.reason === "string" ? body.reason : "",
        actor: actorOf(req),
      });
      // 审计里必须能回答「凭哪个案件、由谁、何时冻结了谁」：legalBasis 是法律程序的依据文本，不是敏感数据。
      audit(req, res, {
        module: "user",
        action: "pixel.legal-hold.create",
        targetId: created.holdId,
        detail: {
          caseRef: created.caseRef,
          legalBasis: created.legalBasis,
          taskAccessRows: created.taskAccessCount,
          usageLogRows: created.usageLogCount,
          truncated: created.truncated,
        },
      });
      res.status(201).json({ success: true, data: created });
    } catch (error) {
      audit(req, res, {
        module: "user",
        action: "pixel.legal-hold.create",
        result: "failure",
        errorMessage: error instanceof Error ? error.name : "unknown",
      });
      sendError(res, "create-hold", error);
    }
  });

  /**
   * @openapi
   * /api/admin/pixel/legal-holds/{holdId}/release:
   *   post:
   *     summary: 解除法律保全（仅超级管理员）
   *     description: 解除后快照再保留一段时间（默认 30 天）后由 TTL 自动回收。
   *     responses:
   *       200:
   *         description: 已解除
   *       404:
   *         description: 保全记录不存在
   */
  // codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter); in-router copy would split quota
  router.post("/pixel/legal-holds/:holdId/release", authenticateSuperAdmin, async (req, res) => {
    const body = jsonBody(req);
    const holdId = String(req.params.holdId ?? "");
    try {
      const released = await deps.holds.release({
        holdId,
        releaseReason: typeof body.releaseReason === "string" ? body.releaseReason : "",
        purgeDelayDays: typeof body.purgeDelayDays === "number" ? body.purgeDelayDays : undefined,
        actor: actorOf(req),
      });
      audit(req, res, {
        module: "user",
        action: "pixel.legal-hold.release",
        targetId: holdId,
        detail: { caseRef: released.caseRef, purgeAfter: released.purgeAfter, releaseReason: released.releaseReason },
      });
      res.json({ success: true, data: released });
    } catch (error) {
      audit(req, res, {
        module: "user",
        action: "pixel.legal-hold.release",
        targetId: holdId,
        result: "failure",
        errorMessage: error instanceof Error ? error.name : "unknown",
      });
      sendError(res, "release-hold", error);
    }
  });

  /**
   * @openapi
   * /api/admin/pixel/evidence-approvals:
   *   get:
   *     summary: 列出内容级取证审批
   *     responses:
   *       200:
   *         description: 审批列表
   *   post:
   *     summary: 开启内容级取证审批（仅超级管理员）
   *     description: 必须写明案件编号与法律依据；仅对该账号、在有效期内留取账号内容，到期自动清除。
   *     responses:
   *       201:
   *         description: 已开启
   *       400:
   *         description: 缺案件编号或法律依据
   */
  // codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter); in-router copy would split quota
  router.get("/pixel/evidence-approvals", authenticateAdmin, async (req, res) => {
    try {
      const includeRevoked = String(req.query.includeRevoked ?? "") === "1";
      res.json({ success: true, data: { items: await deps.evidence.listApprovals({ includeRevoked }) } });
    } catch (error) {
      sendError(res, "list-approvals", error);
    }
  });

  // codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter); in-router copy would split quota
  router.post("/pixel/evidence-approvals", authenticateSuperAdmin, async (req, res) => {
    const body = jsonBody(req);
    try {
      const created = await deps.evidence.createApproval({
        userId: String(body.userId ?? ""),
        caseRef: String(body.caseRef ?? ""),
        legalBasis: String(body.legalBasis ?? ""),
        reason: typeof body.reason === "string" ? body.reason : "",
        validDays: typeof body.validDays === "number" ? body.validDays : undefined,
        actor: actorOf(req),
      });
      audit(req, res, {
        module: "user",
        action: "pixel.evidence-approval.create",
        targetId: created.approvalId,
        detail: { caseRef: created.caseRef, legalBasis: created.legalBasis, expiresAt: created.expiresAt },
      });
      res.status(201).json({ success: true, data: created });
    } catch (error) {
      audit(req, res, {
        module: "user",
        action: "pixel.evidence-approval.create",
        result: "failure",
        errorMessage: error instanceof Error ? error.name : "unknown",
      });
      sendError(res, "create-approval", error);
    }
  });

  /**
   * @openapi
   * /api/admin/pixel/evidence-approvals/{approvalId}/revoke:
   *   post:
   *     summary: 撤销内容级取证审批（仅超级管理员）
   *     responses:
   *       200:
   *         description: 已撤销
   */
  // codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter); in-router copy would split quota
  router.post("/pixel/evidence-approvals/:approvalId/revoke", authenticateSuperAdmin, async (req, res) => {
    const body = jsonBody(req);
    const approvalId = String(req.params.approvalId ?? "");
    try {
      const revoked = await deps.evidence.revokeApproval({
        approvalId,
        reason: typeof body.reason === "string" ? body.reason : "",
        actor: actorOf(req),
      });
      audit(req, res, {
        module: "user",
        action: "pixel.evidence-approval.revoke",
        targetId: approvalId,
        detail: { caseRef: revoked.caseRef, revokeReason: revoked.revokeReason },
      });
      res.json({ success: true, data: revoked });
    } catch (error) {
      audit(req, res, {
        module: "user",
        action: "pixel.evidence-approval.revoke",
        targetId: approvalId,
        result: "failure",
        errorMessage: error instanceof Error ? error.name : "unknown",
      });
      sendError(res, "revoke-approval", error);
    }
  });

  /**
   * @openapi
   * /api/admin/pixel/evidence:
   *   get:
   *     summary: 列出内容级取证记录（只有元数据）
   *     description: 默认只回元数据（案件、时间、账号数、访问次数、到期时间）；读取内容走单独的读取端点，且逐次进审计。
   *     responses:
   *       200:
   *         description: 取证元数据列表
   */
  // codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter); in-router copy would split quota
  router.get("/pixel/evidence", authenticateSuperAdmin, async (req, res) => {
    try {
      const items = await deps.evidence.listEvidence({
        caseRef: typeof req.query.caseRef === "string" ? req.query.caseRef : undefined,
        userId: typeof req.query.userId === "string" ? req.query.userId : undefined,
        limit: typeof req.query.limit === "string" ? Number(req.query.limit) : undefined,
      });
      res.json({ success: true, data: { items } });
    } catch (error) {
      sendError(res, "list-evidence", error);
    }
  });

  /**
   * @openapi
   * /api/admin/pixel/evidence/{evidenceId}/read:
   *   post:
   *     summary: 读取一条取证内容（仅超级管理员，逐次审计）
   *     description: 必须带 caseRef 且与记录一致。每次读取都会写一条含案件编号、经办人与证据 id 的审计。
   *     responses:
   *       200:
   *         description: 解密后的账号内容（不回显到其它任何地方）
   *       400:
   *         description: 未带案件编号或与记录不符
   *       404:
   *         description: 取证记录不存在
   *       410:
   *         description: 已过期
   */
  // codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter); in-router copy would split quota
  router.post("/pixel/evidence/:evidenceId/read", authenticateSuperAdmin, async (req, res) => {
    // 响应体里是账号内容：必须让全局审计对本次请求「不捕获载荷」，否则一份明文会落到审计库。
    suppressAuditPayloadCapture(req);
    const body = jsonBody(req);
    const evidenceId = String(req.params.evidenceId ?? "");
    try {
      const result = await deps.evidence.readEvidence(evidenceId);
      const requestedCaseRef = String(body.caseRef ?? "").trim();
      if (!requestedCaseRef || requestedCaseRef !== result.meta.caseRef) {
        // 案件不匹配时不返回内容：避免有人用一次审批去翻别的案子。
        audit(req, res, {
          module: "user",
          action: "pixel.evidence.read.denied",
          targetId: evidenceId,
          result: "failure",
          errorMessage: "case-ref-mismatch",
          detail: { evidenceCaseRef: result.meta.caseRef },
        });
        res.status(400).json({ success: false, error: "案件编号与记录不一致，已拒绝。", code: "PIXEL_EVIDENCE_CASE_MISMATCH" });
        return;
      }
      audit(req, res, {
        module: "user",
        action: "pixel.evidence.read",
        targetId: evidenceId,
        detail: {
          caseRef: result.meta.caseRef,
          legalBasis: result.meta.legalBasis,
          accountCount: result.meta.accountCount,
          byteSize: result.meta.byteSize,
          accessCount: result.meta.accessCount,
        },
      });
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.json({ success: true, data: { meta: result.meta, accountsText: result.accountsText } });
    } catch (error) {
      audit(req, res, {
        module: "user",
        action: "pixel.evidence.read",
        targetId: evidenceId,
        result: "failure",
        errorMessage: error instanceof Error ? error.name : "unknown",
      });
      sendError(res, "read-evidence", error);
    }
  });

  /**
   * @openapi
   * /api/admin/pixel/key-rotation:
   *   get:
   *     summary: 主密钥轮换体检（指纹 + 两处密文的迁移进度）
   *     description: 只回来源名与指纹，从不回密钥本身；用于轮换前后核对“是不是同一把钥匙”。
   *     responses:
   *       200:
   *         description: 轮换状态与迁移进度
   *       403:
   *         description: 需要管理员权限
   */
  // codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter); in-router copy would split quota
  router.get("/pixel/key-rotation", authenticateAdmin, async (_req, res) => {
    try {
      const status = await deps.keyRotation.status();
      const retire = await deps.keyRotation.canRetire();
      res.json({ success: true, data: { ...status, retirePreviousKey: retire } });
    } catch (error) {
      sendError(res, "key-rotation-status", error);
    }
  });

  /**
   * @openapi
   * /api/admin/pixel/key-rotation/reencrypt:
   *   post:
   *     summary: 把 Pixel 存量密文重加密为当前主密钥（仅超级管理员 + 安全会话）
   *     description: 默认只扫描报告（apply=false）；apply=true 才写。分批处理，反复调用到 needsReencrypt=0 后才能退役 AES_KEY_PREV。
   *     responses:
   *       200:
   *         description: 本次扫描/重加密计数
   *       400:
   *         description: 批次大小非法
   *       403:
   *         description: 需要超级管理员权限与有效安全会话
   */
  // codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter); in-router copy would split quota
  router.post("/pixel/key-rotation/reencrypt", authenticateSuperAdmin, async (req, res) => {
    // 与 /admin/envs/rotate-aes-key 同级：主密钥相关操作额外要求有效安全会话。
    if (!hasValidSecuritySession(req)) {
      res.status(403).json({ success: false, error: "安全会话无效或已过期，请先建立安全会话。", code: "SECURITY_SESSION_REQUIRED" });
      return;
    }
    // RC-41：主密钥重加密属于高危控制面操作，跟随统一的环境绑定判定。
    if (!(await assertSecuritySessionBinding(req))) {
      audit(req, res, {
        module: "config",
        action: "pixel.key-rotation.reencrypt",
        result: "failure",
        errorMessage: "SECURITY_SESSION_BINDING_CHANGED",
      });
      res.status(403).json({
        success: false,
        error: "登录环境发生变化，请重新建立安全会话",
        code: "SECURITY_SESSION_BINDING_CHANGED",
      });
      return;
    }
    const body = jsonBody(req);
    try {
      assertReencryptLimit(body.limit);
      const result = await deps.keyRotation.reencrypt({
        apply: body.apply === true,
        limit: typeof body.limit === "number" ? body.limit : undefined,
      });
      audit(req, res, {
        module: "config",
        action: "pixel.key-rotation.reencrypt",
        detail: {
          apply: result.apply,
          scanned: result.scanned,
          reencrypted: result.reencrypted,
          pending: result.pending,
          undecryptable: result.undecryptable,
        },
      });
      res.json({ success: true, data: result });
    } catch (error) {
      audit(req, res, {
        module: "config",
        action: "pixel.key-rotation.reencrypt",
        result: "failure",
        errorMessage: error instanceof Error ? error.name : "unknown",
      });
      sendError(res, "key-rotation-reencrypt", error);
    }
  });

  return router;
}

export default createPixelAdminRouter({
  mappings: pixelCdkMappingService,
  usage: pixelUsageLogService,
  config: {
    getView: getPixelIntegrationConfigView,
    save: savePixelIntegrationConfig,
    reset: resetPixelIntegrationConfig,
  },
  dashboard: getPixelAdminDashboard,
  holds: { create: createPixelEvidenceHold, list: listPixelEvidenceHolds, release: releasePixelEvidenceHold },
  evidence: {
    createApproval: createEvidenceApproval,
    listApprovals: listEvidenceApprovals,
    revokeApproval: revokeEvidenceApproval,
    listEvidence: listPixelEvidence,
    readEvidence: readPixelEvidence,
  },
  keyRotation: {
    status: getPixelKeyRotationStatus,
    reencrypt: reencryptPixelSecretsWithCurrentKey,
    canRetire: canRetirePreviousMasterKey,
  },
});
