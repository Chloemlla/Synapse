import type { Request, Response } from "express";
import { isAdminRole, isSuperAdmin } from "../middleware/auth";
import {
  listBilibiliCookieReports,
  removeBilibiliCookieReport,
  reportBilibiliCookie,
  resolveReportDeviceId,
  revealBilibiliCookieReports,
} from "../services/bilibiliCookieReportService";
import { listBilibiliAccountsForAdmin, revealBilibiliAccountCredentials } from "../services/bilibiliAccountService";
import { BilibiliSyncError } from "../services/bilibiliSyncService";
import { AuditLogService } from "../services/auditLogService";
import logger from "../utils/logger";

function reportError(res: Response, error: unknown): void {
  if (error instanceof BilibiliSyncError) {
    res.status(error.statusCode).json({ success: false, error: error.message, code: error.code, ...error.details });
    return;
  }
  logger.error("[Bilibili Cookie Report] request failed", error);
  res.status(500).json({
    success: false,
    error: "Bilibili 凭据上报服务暂时不可用",
    code: "BILIBILI_COOKIE_REPORT_INTERNAL_ERROR",
  });
}

function headerText(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  if (typeof value === "string") return value.trim() || undefined;
  if (Array.isArray(value)) return value[0]?.trim() || undefined;
  return undefined;
}

/**
 * Login report sink. There is deliberately no Synapse session here: the
 * reporter identifies itself with the device id it generated on first launch,
 * and the server only accepts data it can verify against Bilibili.
 *
 * The cookie is request-scoped: verified, encrypted, and dropped. It is never
 * echoed back, logged, or written to any non-encrypted field.
 */
export async function reportCookie(req: Request, res: Response): Promise<void> {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const clientId = (typeof body.client_id === "string" && body.client_id.trim()) || headerText(req, "x-synapse-client-id");
    const deviceId = resolveReportDeviceId(
      body.device_id,
      headerText(req, "x-device-id") ?? headerText(req, "x-synapse-device-id"),
    );

    const data = await reportBilibiliCookie({
      clientId,
      deviceId,
      uid: body.uid,
      cookie: body.cookie,
      isPrimary: body.isPrimary,
      device: body.device,
      permissions: body.permissions,
      client: body.client,
    });

    res.json({ success: true, data });
  } catch (error) {
    reportError(res, error);
  }
}

/** Admin read surface: metadata only, the archive never leaves as ciphertext. */
export async function listReports(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user || !isAdminRole(req.user.role)) {
      res.status(403).json({ success: false, error: "需要管理员权限" });
      return;
    }
    const result = await listBilibiliCookieReports({
      search: req.query.search,
      page: req.query.page,
      limit: req.query.limit,
    });
    res.json({
      success: true,
      data: result.reports,
      pagination: {
        page: result.page,
        limit: result.limit,
        total: result.total,
        totalPages: Math.ceil(result.total / result.limit),
      },
    });
  } catch (error) {
    reportError(res, error);
  }
}

/**
 * Admin erasure surface.
 *
 * 为什么必须有：这份存档是隐私敏感的（B 站登录凭据密文 + 设备/账号元数据），但之前只有读取接口，
 * 服务层的 `removeBilibiliCookieReport` 是**死代码**。用户提出删除请求、或发现设备 id 被冒用，
 * 管理员无任何手段处理。这里只按 (clientId, deviceId, uid) 三元组精确删除，不提供通配批量删。
 * 三元组缺失/形态非法时由服务层的 normalizer 抛错，不会变成“删了半张表”。
 */
export async function deleteBilibiliCookieReport(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user || !isSuperAdmin(req)) {
      res.status(403).json({ success: false, error: "需要超级管理员权限" });
      return;
    }

    const result = await removeBilibiliCookieReport(req.params.clientId, req.params.deviceId, req.params.uid);
    if (!result.removed) {
      res.status(404).json({ success: false, error: "未找到匹配的上报记录" });
      return;
    }

    // 只记标识与结果，不记任何凭据字段（存档从未以明文出库）。
    logger.info("[Bilibili Cookie Report] 管理员删除上报记录", {
      deviceId: req.params.deviceId,
      uid: req.params.uid,
      operator: req.user.id,
    });
    res.json({ success: true, data: { removed: true } });
  } catch (error) {
    reportError(res, error);
  }
}

/** Admin read surface for the multi-account bindings: metadata only. */
export async function listAccountBindings(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user || !isAdminRole(req.user.role)) {
      res.status(403).json({ success: false, error: "需要管理员权限" });
      return;
    }
    const result = await listBilibiliAccountsForAdmin({
      search: req.query.search,
      page: req.query.page,
      limit: req.query.limit,
    });
    res.json({
      success: true,
      data: result.accounts,
      pagination: {
        page: result.page,
        limit: result.limit,
        total: result.total,
        totalPages: Math.ceil(result.total / result.limit),
      },
    });
  } catch (error) {
    reportError(res, error);
  }
}

/**
 * 「解密查看」的审计：只记「谁在什么时候解了多少条、哪几条打不开」，**绝不记明文 Cookie**。
 *
 * 为什么不用通用 `auditLog` 中间件：它会把 resBody 写进审计（`AUDIT_LOG_CAPTURE_PAYLOADS=true` 时），
 * 而这个响应体的正文就是解密后的 Cookie —— 等于把明文抄一份进 60 天保留期的审计库。
 * 因此路由层先 `suppressAuditPayloadCapture(req)` 掐掉全局审计的载荷捕获，再由这里显式落一条
 * 只含计数与标识的审计（与 routes/admin/pixelRoutes.ts 的卡密分发同一处理方式）。
 */
function auditReveal(
  req: Request,
  res: Response,
  action: string,
  detail: Record<string, unknown>,
  result: "success" | "failure" = "success",
  errorMessage?: string,
): void {
  void AuditLogService.log({
    requestId: req.requestId,
    userId: req.user?.id || "unknown",
    username: req.user?.username || "unknown",
    role: req.user?.role || "unknown",
    action,
    module: "privacy",
    result,
    errorMessage,
    detail: { ...detail, statusCode: res.statusCode },
    ip: req.ip || req.socket?.remoteAddress || "unknown",
    userAgent: req.headers["user-agent"],
    path: (req.originalUrl || req.path).split("?")[0],
    method: req.method,
  }).catch(() => {});
}

/** 审计里只放标识（定位取证必需），并统一截断到 200 字符。 */
function shortId(value: unknown): string | undefined {
  return typeof value === "string" && value ? value.slice(0, 200) : undefined;
}

function revealSummary(rows: Array<{ error?: string }>): Record<string, unknown> {
  return {
    requested: rows.length,
    revealed: rows.filter((row) => !row.error).length,
    undecryptable: rows.filter((row) => row.error === "undecryptable").length,
    notFound: rows.filter((row) => row.error === "not-found").length,
  };
}

/**
 * 超管「解密查看」登录上报存档（POST + 安全会话）。
 *
 * 为什么是 POST 而不是 GET：被解密的记录集合写在请求体里（一次最多 50 条），
 * GET 会把设备 id / UID 拼进 URL —— URL 会进访问日志、浏览器历史、代理与 Referer，
 * 而全局审计的 `detail.query` 还是**无条件**捕获的。凭据类操作不能走 query。
 *
 * 每一层都为「明文只在这一刻、这一屏存在」服务：超管角色 + 安全会话（二次验证）
 * + `Cache-Control: no-store` + 审计只留计数。
 */
export async function revealReportCredentials(req: Request, res: Response): Promise<void> {
  const rawItems = (req.body as { items?: unknown } | undefined)?.items;
  const items = Array.isArray(rawItems) ? rawItems : [];
  try {
    const rows = await revealBilibiliCookieReports(rawItems);
    res.setHeader("Cache-Control", "no-store");
    res.json({ success: true, data: rows });
    auditReveal(req, res, "privacy.bilibiliReportReveal", {
      ...revealSummary(rows),
      keys: items
        .map((item) => {
          const record = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
          return {
            clientId: shortId(record.clientId),
            deviceId: shortId(record.deviceId),
            uid: shortId(record.uid),
          };
        })
        .slice(0, 50),
    });
  } catch (error) {
    reportError(res, error);
    auditReveal(
      req,
      res,
      "privacy.bilibiliReportReveal",
      { requested: items.length },
      "failure",
      error instanceof BilibiliSyncError ? error.code : "unknown",
    );
  }
}

/** 超管「解密查看」多账号绑定凭据（POST + 安全会话），契约同 `revealReportCredentials`。 */
export async function revealAccountCredentials(req: Request, res: Response): Promise<void> {
  const rawItems = (req.body as { items?: unknown } | undefined)?.items;
  const items = Array.isArray(rawItems) ? rawItems : [];
  try {
    const rows = await revealBilibiliAccountCredentials(rawItems);
    res.setHeader("Cache-Control", "no-store");
    res.json({ success: true, data: rows });
    auditReveal(req, res, "privacy.bilibiliAccountReveal", {
      ...revealSummary(rows),
      keys: items
        .map((item) => {
          const record = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
          return { userId: shortId(record.userId), uid: shortId(record.uid) };
        })
        .slice(0, 50),
    });
  } catch (error) {
    reportError(res, error);
    auditReveal(
      req,
      res,
      "privacy.bilibiliAccountReveal",
      { requested: items.length },
      "failure",
      error instanceof BilibiliSyncError ? error.code : "unknown",
    );
  }
}
