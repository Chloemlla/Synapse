import { Router, type Request, type Response } from "express";
import { authenticateAdmin, authenticateSuperAdmin } from "../../middleware/auth";
import { auditLog } from "../../middleware/auditLog";
import { ClientTelemetryEventModel } from "../../models/clientTelemetryModel";
import {
  getClientTelemetryStats,
  getClientTraceReplay,
  queryClientTelemetry,
} from "../../services/clientTelemetryService";
import logger from "../../utils/logger";

/**
 * 客户端遥测管理端（页面 /admin/client-errors）。
 *
 * 读接口要求 admin 角色 + adminScope 页面授权（页面 key 登记在 src/config/adminPages.ts）；
 * 删除单条属于写操作，收窄到超管并留审计。
 *
 * 与操作审计的分工：审计回答「这个追踪码对应的请求是谁发的、结果如何」，
 * 这里回答「那一刻浏览器控制台报了什么错、人机验证为什么没过」。
 */
const router = Router();

const guard = [authenticateAdmin] as const;

// GET /api/admin/client-errors?traceId=&level=&kind=&path=&keyword=&since=&until=&page=&pageSize=
router.get("/", ...guard, async (req: Request, res: Response) => {
  try {
    const q = req.query as Record<string, unknown>;
    const stringOf = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
    const result = await queryClientTelemetry({
      traceId: stringOf(q.traceId),
      kind: stringOf(q.kind),
      level: stringOf(q.level),
      path: stringOf(q.path),
      keyword: stringOf(q.keyword),
      since: stringOf(q.since),
      until: stringOf(q.until),
      page: Number(q.page),
      pageSize: Number(q.pageSize),
    });
    res.json({ success: true, ...result });
  } catch (error) {
    logger.error("[ClientTelemetryAdmin] list failed", {
      errorType: error instanceof Error ? error.name : "unknown",
    });
    res.status(500).json({ success: false, error: "暂时无法读取客户端遥测。", code: "CLIENT_TELEMETRY_LIST_FAILED" });
  }
});

// GET /api/admin/client-errors/stats —— 最近 24 小时按类型/级别/路径聚合
router.get("/stats", ...guard, async (_req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await getClientTelemetryStats() });
  } catch (error) {
    logger.error("[ClientTelemetryAdmin] stats failed", {
      errorType: error instanceof Error ? error.name : "unknown",
    });
    res.status(500).json({ success: false, error: "暂时无法读取遥测统计。", code: "CLIENT_TELEMETRY_STATS_FAILED" });
  }
});

// GET /api/admin/client-errors/trace/:traceId —— 按问题追踪码复盘（验证链路 + 浏览器报错）
router.get("/trace/:traceId", ...guard, async (req: Request, res: Response) => {
  try {
    const traceId = String(req.params.traceId ?? "").trim();
    const replay = await getClientTraceReplay(traceId);
    if (!replay) {
      res.status(400).json({ success: false, error: "追踪码格式不正确。", code: "CLIENT_TELEMETRY_TRACE_INVALID" });
      return;
    }
    res.json({ success: true, ...replay });
  } catch (error) {
    logger.error("[ClientTelemetryAdmin] trace replay failed", {
      errorType: error instanceof Error ? error.name : "unknown",
    });
    res.status(500).json({ success: false, error: "暂时无法复盘该追踪码。", code: "CLIENT_TELEMETRY_TRACE_FAILED" });
  }
});

// DELETE /api/admin/client-errors/:id —— 单条清理（超管 + 审计）
router.delete(
  "/:id",
  authenticateSuperAdmin,
  auditLog({
    module: "system",
    action: "clientTelemetry.delete",
    extractTarget: (req) => ({ targetId: String(req.params.id ?? "") }),
  }),
  async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id ?? "").trim();
      if (!/^[0-9a-fA-F]{24}$/.test(id)) {
        res.status(400).json({ success: false, error: "记录 ID 不正确。", code: "CLIENT_TELEMETRY_ID_INVALID" });
        return;
      }
      const result = await ClientTelemetryEventModel.deleteOne({ _id: id }); // soft-delete-exempt: 运维诊断数据（非用户内容，30 天 TTL 到期也会被自动清理），超管手动清理单条，操作已由上方 auditLog 留痕
      if (!result.deletedCount) {
        res.status(404).json({ success: false, error: "记录不存在或已被清理。", code: "CLIENT_TELEMETRY_NOT_FOUND" });
        return;
      }
      res.json({ success: true });
    } catch (error) {
      logger.error("[ClientTelemetryAdmin] delete failed", {
        errorType: error instanceof Error ? error.name : "unknown",
      });
      res.status(500).json({ success: false, error: "删除失败，请稍后重试。", code: "CLIENT_TELEMETRY_DELETE_FAILED" });
    }
  },
);

export default router;
