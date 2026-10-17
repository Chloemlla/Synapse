import { Router } from "express";
import { clientTelemetryLimiter } from "../middleware/routeLimiters";
import { recordClientTelemetryEvents } from "../services/clientTelemetryService";
import { getClientIP } from "../utils/ipUtils";
import logger from "../utils/logger";

const router = Router();

/**
 * 浏览器遥测上报（匿名、尽力而为）。
 *
 * 谁在调：前端 `utils/clientTelemetry.ts` 在前端出现未捕获异常 / console.error 时批量上报，
 * 并带上当前页面最后看到的问题追踪码（服务端 requestId），使管理员能用用户报的那串码复盘现场。
 *
 * 为什么匿名：首访验证页是「没有账号、还被闸门挡着」的场景，恰恰最需要遥测；
 * 因此本路由在 route module 里声明了 ipVerification bypass，并与 data-collection 一样只收结构化事件。
 *
 * 安全边界：
 *  - 限流按 IP + 设备指纹双桶（createLimiter 的匿名判据）；
 *  - 单批事件数、字段长度、URL、字符集全部由 service 再收敛一次，不信任客户端校验；
 *  - 原始 IP / 设备指纹只落 sha256 短摘要；响应体永远不包含其它客户端的任何数据。
 */
router.post("/report", clientTelemetryLimiter, async (req, res) => {
  try {
    if (process.env.CLIENT_TELEMETRY_ENABLED === "false") {
      res.status(202).json({ accepted: 0, disabled: true });
      return;
    }
    const body = (req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? req.body
      : {}) as Record<string, unknown>;
    const events = Array.isArray(body.events) ? body.events : [];
    if (events.length === 0) {
      res.status(202).json({ accepted: 0 });
      return;
    }
    const result = await recordClientTelemetryEvents(events, {
      userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined,
      ipAddress: getClientIP(req),
      deviceId: typeof body.deviceId === "string" ? body.deviceId : undefined,
      traceId: typeof body.traceId === "string" ? body.traceId : undefined,
    });
    res.status(202).json(result);
  } catch (error) {
    // 遥测是尽力而为：上报失败返回 202（客户端不重试、不弹错），只留服务端日志。
    logger.warn("[ClientTelemetry] 上报处理失败", {
      errorType: error instanceof Error ? error.name : "unknown",
    });
    res.status(202).json({ accepted: 0 });
  }
});

export default router;
