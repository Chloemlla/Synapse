import logger from "../../utils/logger";
import type { Request, Response } from "express";
import { TurnstileService } from "../../services/turnstileService";
import { requireAdmin, isValidIpOrCidr, requireSuperAdmin } from "./_helpers";

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
    logger.error("清理过期指纹失败:", error);
    res.status(500).json({ success: false, error: "服务器内部错误" });
  }
}

export async function getFingerprintStats(req: Request, res: Response) {
  try {
    if (!requireAdmin(req, res)) return;

    const stats = await TurnstileService.getTempFingerprintStats();

    res.json({ success: true, stats });
  } catch (error) {
    logger.error("获取指纹统计失败:", error);
    res.status(500).json({ success: false, error: "服务器内部错误" });
  }
}

export async function getIpBanStats(req: Request, res: Response) {
  try {
    if (!requireAdmin(req, res)) return;

    const stats = await TurnstileService.getIpBanStats();

    res.json({ success: true, stats });
  } catch (error) {
    logger.error("获取IP封禁统计失败:", error);
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
    logger.error("获取IP封禁名单失败:", error);
    res.status(500).json({ success: false, error: "服务器内部错误" });
  }
}

/**
 * `GET /api/turnstile/ip-ban-trace?ip=1.2.3.4` —— 单 IP 封禁溯源。
 *
 * 只接受单个 IP（不接受 CIDR）：溯源是按 `ipAddress` 精确匹配事件与审计，传网段既算不准，
 * 也容易被当成「顺手导出全站审计」的入口。
 */
export async function traceBannedIp(req: Request, res: Response) {
  try {
    if (!requireAdmin(req, res)) return;

    const rawIp = typeof req.query.ip === "string" ? req.query.ip.trim() : "";
    if (!rawIp || !isValidIpOrCidr(rawIp) || rawIp.includes("/")) {
      return res.status(400).json({ success: false, error: "IP地址参数无效，需为单个 IP" });
    }

    const trace = await TurnstileService.getIpBanTrace(rawIp);
    res.json({ success: true, ...trace });
  } catch (error) {
    logger.error("获取IP封禁溯源失败:", error);
    res.status(500).json({ success: false, error: "服务器内部错误" });
  }
}
