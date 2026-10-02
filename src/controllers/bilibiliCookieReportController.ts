import type { Request, Response } from "express";
import { isAdminRole, isSuperAdmin } from "../middleware/auth";
import {
  listBilibiliCookieReports,
  removeBilibiliCookieReport,
  reportBilibiliCookie,
  resolveReportDeviceId,
} from "../services/bilibiliCookieReportService";
import { listBilibiliAccountsForAdmin } from "../services/bilibiliAccountService";
import { BilibiliSyncError } from "../services/bilibiliSyncService";
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
