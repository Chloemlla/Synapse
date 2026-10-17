import type { NextFunction, Request, Response } from "express";
import { isSuperAdmin } from "../../middleware/auth";
import logger from "../../utils/logger";
// 安全会话守卫统一走 utils/securitySession：它带异步 UA/IP 绑定判定与稳定 code，
// 本地再写一份同步版本会让「绑定校验」在这条法律动作链上静默失效。
export { requireSecuritySession } from "../../utils/securitySession";
import {
  LegalHoldValidationError,
  createLegalHold,
  listLegalHoldsPage,
  releaseLegalHoldById,
} from "../../services/legalHoldService";
import {
  EXPORT_LIMIT_EXCEEDED,
  ForensicExportLimitError,
  ForensicExportRequestError,
  actorFromUser,
  approveForensicExportRequest,
  assertDownloadable,
  assertWithinExportCap,
  countForensicExportRows,
  createForensicExportRequest,
  finalizeForensicExport,
  getForensicExportRequest,
  listForensicAuditPage,
  recordForensicEvent,
  requestMeta,
  streamForensicExport,
} from "../../services/forensicAuditService";
import { runLegalHoldAwareCleanup } from "../../services/legalHoldCleanupService";

/**
 * 法律保留与取证管理端（RC-22 / RC-35 / RC-58）。
 *
 * 权限分档（与 adminPages 的登记一致）：
 *  - 读取 hold 列表：`admin`（页面授权控制普通管理员可见性）；
 *  - 登记/解除 hold、取证审计、导出：`superadmin` + 安全会话 + 拒绝 API Key。
 *
 * 为什么写操作还要拒绝 API Key：API Key 是**程序身份**，不是自然人。法律保留与
 * 取证导出要求“谁做的、谁批准的”可追溯，且 D10 明确不支持 API Key 触发。
 */


function sendError(res: Response, error: unknown, fallback: string): void {
  if (error instanceof ForensicExportLimitError) {
    res.status(413).json({
      success: false,
      error: error.message,
      code: EXPORT_LIMIT_EXCEEDED,
      maxRows: error.maxRows,
      totalRows: error.totalRows,
      // 明确告诉调用方：这不是“只给了前 N 行”，而是一条都没导出。
      truncated: false,
    });
    return;
  }
  if (error instanceof ForensicExportRequestError) {
    res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
    return;
  }
  if (error instanceof LegalHoldValidationError) {
    res.status(error.statusCode).json({ success: false, error: error.message, code: error.code });
    return;
  }
  logger.error("[LegalHoldAdmin] 请求处理失败", {
    error: error instanceof Error ? error.message : String(error),
  });
  res.status(500).json({ success: false, error: fallback, code: "LEGAL_HOLD_INTERNAL_ERROR" });
}

/**
 * 普通管理员只看到「有这条 hold」与案件编号，不看到被保留对象的完整标识
 * （RC-22.4：软删除/取证数据默认对普通管理员隐藏）。超级管理员看全量。
 */
function maskSubjectValue(value: string): string {
  const text = String(value || "");
  if (text.length <= 4) return "***";
  return `${text.slice(0, 1)}***${text.slice(-3)}`;
}

function readBody(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? (req.body as Record<string, unknown>)
    : {};
}

function parseOptionalDate(value: unknown): Date | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * 写操作的人机校验：拒绝 API Key / OAuth 令牌，要求 superadmin。
 * `authenticateSuperAdmin` 已保证角色；这里补的是“不是程序身份”。
 */
export function requireHumanSuperAdmin(req: Request, res: Response, next: NextFunction): void {
  const reqWithCredentials = req as Request & { apiKey?: unknown; oauthToken?: unknown };
  if (reqWithCredentials.apiKey || reqWithCredentials.oauthToken) {
    res.status(403).json({
      success: false,
      error: "法律保留与取证导出不能用 API Key 触发，请使用超级管理员的安全会话操作",
      code: "FORENSIC_EXPORT_API_KEY_FORBIDDEN",
    });
    return;
  }
  if (!isSuperAdmin(req)) {
    res.status(403).json({ success: false, error: "需要超级管理员权限", code: "SUPERADMIN_REQUIRED" });
    return;
  }
  next();
}

/** 全站统一安全会话（Passkey/TOTP/密码二次验证）。 */

export class LegalHoldAdminController {
  /** 读取 hold 列表（游标分页，RC-58）。 */
  static async list(req: Request, res: Response): Promise<void> {
    try {
      const page = await listLegalHoldsPage({
        includeReleased: req.query.includeReleased === "true",
        scope:
          req.query.scope === "user" || req.query.scope === "ip" || req.query.scope === "fingerprint"
            ? req.query.scope
            : undefined,
        caseRef: typeof req.query.caseRef === "string" ? req.query.caseRef : undefined,
        limit: Number(req.query.limit),
        cursor: typeof req.query.cursor === "string" ? req.query.cursor : undefined,
      });

      // 查看 hold 也是取证访问：写普通审计 + 不设 TTL 的取证审计。
      const audit = await recordForensicEvent({
        action: "legal_hold.list",
        actor: actorFromUser(req.user),
        detail: { returned: page.holds.length, includeReleased: req.query.includeReleased === "true" },
        request: requestMeta(req),
      });

      const canSeeFullSubject = req.user?.role === "superadmin";
      res.json({
        success: true,
        holds: page.holds.map((hold) => ({
          id: String(hold._id ?? ""),
          scope: hold.scope,
          value: canSeeFullSubject ? hold.value : maskSubjectValue(hold.value),
          valueMasked: !canSeeFullSubject,
          caseRef: hold.caseRef,
          reason: hold.reason,
          issuedBy: hold.issuedBy,
          issuedAt: hold.issuedAt,
          expiresAt: hold.expiresAt,
          releasedBy: hold.releasedBy,
          releasedAt: hold.releasedAt,
          releaseReason: hold.releaseReason,
        })),
        limit: page.limit,
        nextCursor: page.nextCursor,
        auditWarning: audit.auditLogged && audit.forensicLogged ? undefined : "审计写入失败，请联系运维核对",
      });
    } catch (error) {
      sendError(res, error, "读取法律保留列表失败");
    }
  }

  /** 登记 hold：理由 + 案件编号必填；写入普通审计与取证审计。 */
  static async create(req: Request, res: Response): Promise<void> {
    try {
      const body = readBody(req);
      const expiresAt = parseOptionalDate(body.expiresAt);
      if (expiresAt === undefined) {
        throw new LegalHoldValidationError("LEGAL_HOLD_EXPIRES_INVALID", "保留到期时间格式不正确");
      }

      const actor = actorFromUser(req.user);
      const meta = requestMeta(req);
      const hold = await createLegalHold({
        scope: body.scope as "user" | "ip" | "fingerprint",
        value: String(body.value ?? ""),
        caseRef: String(body.caseRef ?? ""),
        reason: String(body.reason ?? ""),
        issuedBy: actor.username,
        expiresAt: expiresAt ?? null,
        // 服务层统一写普通审计 + 取证审计（Pixel 保全也走同一入口，避免漏痕）。
        audit: {
          actorId: actor.id,
          actorUsername: actor.username,
          actorRole: actor.role,
          ip: meta.ip,
          userAgent: meta.userAgent,
          path: meta.path,
          method: meta.method,
        },
      });
      if (!hold) {
        throw new LegalHoldValidationError("LEGAL_HOLD_CREATE_FAILED", "法律保留登记失败", 503);
      }

      res.status(201).json({
        success: true,
        hold: {
          id: String(hold._id ?? ""),
          scope: hold.scope,
          value: hold.value,
          caseRef: hold.caseRef,
          reason: hold.reason,
          issuedBy: hold.issuedBy,
          issuedAt: hold.issuedAt,
          expiresAt: hold.expiresAt,
        },
      });
    } catch (error) {
      sendError(res, error, "登记法律保留失败");
    }
  }

  /** 解除 hold：hold id + 案件编号 + 解除理由三者都必填。 */
  static async release(req: Request, res: Response): Promise<void> {
    try {
      const body = readBody(req);
      const holdId = String(req.params.holdId ?? body.holdId ?? "");
      const actor = actorFromUser(req.user);
      const meta = requestMeta(req);
      const hold = await releaseLegalHoldById({
        holdId,
        caseRef: String(body.caseRef ?? ""),
        releasedBy: actor.username,
        releaseReason: String(body.releaseReason ?? ""),
        audit: {
          actorId: actor.id,
          actorUsername: actor.username,
          actorRole: actor.role,
          ip: meta.ip,
          userAgent: meta.userAgent,
          path: meta.path,
          method: meta.method,
        },
      });
      if (!hold) {
        throw new LegalHoldValidationError("LEGAL_HOLD_NOT_FOUND", "保留记录不存在", 404);
      }

      res.json({
        success: true,
        hold: {
          id: String(hold._id ?? holdId),
          scope: hold.scope,
          value: hold.value,
          caseRef: hold.caseRef,
          releasedBy: hold.releasedBy,
          releasedAt: hold.releasedAt,
          releaseReason: hold.releaseReason,
        },
      });
    } catch (error) {
      sendError(res, error, "解除法律保留失败");
    }
  }

  /** 手工触发一轮应用层清理（默认 dryRun，避免误删）。 */
  static async runCleanup(req: Request, res: Response): Promise<void> {
    try {
      const body = readBody(req);
      const report = await runLegalHoldAwareCleanup({ dryRun: body.dryRun !== false });
      await recordForensicEvent({
        action: "legal_hold.cleanup",
        actor: actorFromUser(req.user),
        detail: {
          dryRun: report.dryRun,
          totalDeleted: report.totalDeleted,
          totalSkippedHeld: report.totalSkippedHeld,
          targets: report.targets,
        },
        request: requestMeta(req),
      });
      res.json({ success: true, report });
    } catch (error) {
      sendError(res, error, "执行清理任务失败");
    }
  }

  /** 取证审计（不设 TTL）：游标分页。 */
  static async listForensicAudit(req: Request, res: Response): Promise<void> {
    try {
      const page = await listForensicAuditPage({
        action: typeof req.query.action === "string" ? req.query.action : undefined,
        caseRef: typeof req.query.caseRef === "string" ? req.query.caseRef : undefined,
        subjectValue: typeof req.query.subjectValue === "string" ? req.query.subjectValue : undefined,
        limit: Number(req.query.limit),
        cursor: typeof req.query.cursor === "string" ? req.query.cursor : undefined,
      });
      res.json({ success: true, events: page.events, limit: page.limit, nextCursor: page.nextCursor });
    } catch (error) {
      sendError(res, error, "读取取证审计失败");
    }
  }

  /** 发起导出申请（双人确认的第一步）。 */
  static async createExport(req: Request, res: Response): Promise<void> {
    try {
      const body = readBody(req);
      const result = await createForensicExportRequest({
        actor: actorFromUser(req.user),
        caseRef: body.caseRef,
        reason: body.reason,
        scope: body.scope,
        value: body.value,
        from: body.from,
        to: body.to,
        request: requestMeta(req),
      });
      res.status(201).json({
        success: true,
        request: result.request,
        potentialRows: result.rowCount,
        message: "导出申请已创建，需由另一位超级管理员批准后才能下载",
        auditWarning: result.audit.auditLogged && result.audit.forensicLogged ? undefined : "审计写入失败",
      });
    } catch (error) {
      sendError(res, error, "发起取证导出失败");
    }
  }

  /** 批准（双人确认的第二步；发起人不能批准自己的申请）。 */
  static async approveExport(req: Request, res: Response): Promise<void> {
    try {
      const result = await approveForensicExportRequest({
        actor: actorFromUser(req.user),
        requestId: req.params.requestId,
        request: requestMeta(req),
      });
      res.json({
        success: true,
        request: result.request,
        auditWarning: result.audit.auditLogged && result.audit.forensicLogged ? undefined : "审计写入失败",
      });
    } catch (error) {
      sendError(res, error, "批准取证导出失败");
    }
  }

  /** 流式下载 NDJSON 归档，最后一行是带 SHA-256 的 manifest。 */
  static async downloadExport(req: Request, res: Response): Promise<void> {
    try {
      const actor = actorFromUser(req.user);
      const requestId = String(req.params.requestId ?? "");
      const request = await getForensicExportRequest(requestId);
      if (!request) {
        throw new ForensicExportRequestError("FORENSIC_EXPORT_REQUEST_NOT_FOUND", "导出申请不存在", 404);
      }
      assertDownloadable(request, actor);

      const rowCount = await countForensicExportRows({
        scope: request.scope,
        value: request.subjectValue,
        from: request.from ? new Date(request.from) : null,
        to: request.to ? new Date(request.to) : null,
      });
      assertWithinExportCap(rowCount);

      const safeCaseRef = String(request.caseRef || "case").replace(/[^\w.-]+/g, "_").slice(0, 64);
      res.status(200);
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="forensic-${safeCaseRef}-${request.requestId}.ndjson"`,
      );

      const result = await streamForensicExport(res, request);
      await finalizeForensicExport({
        actor,
        request,
        result,
        requestMeta: requestMeta(req),
      });
    } catch (error) {
      if (res.headersSent) {
        // 流已经开写：不能再用 JSON 错误污染归档，只能中断连接让接收方看到“不完整”。
        logger.error("[LegalHoldAdmin] 流式导出中断", {
          error: error instanceof Error ? error.message : String(error),
          aborted: true,
        });
        res.destroy(error instanceof Error ? error : undefined);
        return;
      }
      sendError(res, error, "下载取证导出失败");
    }
  }
}

