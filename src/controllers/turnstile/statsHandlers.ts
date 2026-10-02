import type { Request, Response } from "express";
import { TurnstileService } from "../../services/turnstileService";
import { requireAdmin, requireSuperAdmin } from "./_helpers";

export async function cleanupExpiredFingerprints(req: Request, res: Response) {
  try {
    if (!requireSuperAdmin(req, res)) return;

    const deletedCount = await TurnstileService.cleanupExpiredFingerprints();

    res.json({
      success: true,
      deletedCount,
      message: `清理了 ${deletedCount} 条过期指纹记录`,
    });
  } catch (error) {
    console.error("清理过期指纹失败:", error);
    res.status(500).json({ success: false, error: "服务器内部错误" });
  }
}

export async function getFingerprintStats(req: Request, res: Response) {
  try {
    if (!requireAdmin(req, res)) return;

    const stats = await TurnstileService.getTempFingerprintStats();

    res.json({ success: true, stats });
  } catch (error) {
    console.error("获取指纹统计失败:", error);
    res.status(500).json({ success: false, error: "服务器内部错误" });
  }
}

export async function getIpBanStats(req: Request, res: Response) {
  try {
    if (!requireAdmin(req, res)) return;

    const stats = await TurnstileService.getIpBanStats();

    res.json({ success: true, stats });
  } catch (error) {
    console.error("获取IP封禁统计失败:", error);
    res.status(500).json({ success: false, error: "服务器内部错误" });
  }
}

/**
 * 封禁名单。与同页其他读接口同口径（adminLimiter + authenticateAdmin + requireAdminScope），
 * 不额外开新写权限。
 */
export async function listBannedIps(req: Request, res: Response) {
  try {
    if (!requireAdmin(req, res)) return;

    const query = (req.query ?? {}) as Record<string, unknown>;
    const result = await TurnstileService.listIpBans({
      page: query.page,
      pageSize: query.pageSize,
      keyword: query.keyword,
      status: query.status,
      sort: query.sort,
      order: query.order,
    });

    res.json({
      success: true,
      data: {
        bans: result.bans,
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
      },
      summary: result.summary,
    });
  } catch (error) {
    console.error("获取IP封禁名单失败:", error);
    res.status(500).json({ success: false, error: "服务器内部错误" });
  }
}
