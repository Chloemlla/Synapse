import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { IAuditLog } from "../models/auditLogModel";
import { AuditLogService, type AuditEntry } from "../services/auditLogService";

/**
 * Pixel 子树的审计策略：**审计留痕，但审计载荷零内容**。
 *
 * 为什么需要这道守卫（两条独立的泄漏路径，都指向同一件事：审计库不能出现账号凭据）：
 *
 *   1) `AuditLogService.globalAuditMiddleware()`（挂在全站安全流水线里）在
 *      `AUDIT_LOG_CAPTURE_PAYLOADS=true` 时会**原样捕获 `req.body` 与 `resBody`**（只按字段名做
 *      一次 `isSensitiveAuditField` 前缀匹配）。本域的请求体里有账号文本（邮箱/密码/辅助邮箱/
 *      2FA 秘钥）与卡密，响应体里有账号邮箱与完整结果链接；`accountsText` / `card` / `email` /
 *      `resultLink` 这些字段名**都不在** `utils/auditRedaction.ts` 的脱敏名单里。也就是说，
 *      运维一旦打开载荷捕获（一个环境变量），这些凭据就会进 60 天保留、可 CSV 导出的审计库。
 *   2) `detail.query` 是**无条件**捕获的（不受那两个开关影响），所以「把完整卡密放进查询串」
 *      本身就是一条会默认落库的泄漏路径——本域因此不接受卡密作为 query 参数（见
 *      routes/admin/pixelRoutes.ts 的 cdkMask 说明）。
 *
 * 处理方式沿用 `routes/admin/system.ts` 的既有结论（那里同样显式写审计，而不用通用中间件）：
 * 用 `__routeAuditEnabled` 让全局中间件对整棵子树「去重」（`AUDIT_LOG_DEDUP_ROUTE_LOGS` 默认开），
 * 再自己写一条**只有 method/path/status/耗时**的审计。这样：
 *   · 每个请求仍然有审计留痕（谁在什么时候调了哪个端点、结果如何）；
 *   · 审计库永远不含请求体/响应体/查询串，凭据无从泄漏；
 *   · 更细的调用上下文（映射命中、账号数、上游状态码、耗时）在 `pixel_usage_logs` 里，
 *     那份是**按字段白名单构造**的脱敏溯源，而不是对请求/响应的整体拷贝。
 *
 * 副作用与取舍：本子树不再有全局审计那条记录（被去重），审计里的 `action` 因此是本文件生成的
 * `pixel.*` 命名，而不是全局的 `post /api/pixel/...`。这是有意的：让「Pixel 的审计口径」只有一处。
 */
export function suppressAuditPayloadCapture(req: Request): void {
  (req as Request & { __routeAuditEnabled?: boolean }).__routeAuditEnabled = true;
}

function actorOf(req: Request): { userId: string; username: string; role: string } {
  const user = (req as Request & { user?: { id?: unknown; username?: unknown; role?: unknown } }).user;
  return {
    userId: String(user?.id ?? "unknown"),
    username: String(user?.username ?? "unknown"),
    role: String(user?.role ?? "unknown"),
  };
}

export interface PixelAuditGuardOptions {
  /** 审计模块分类（IAuditLog.module 的取值）。 */
  module: AuditEntry["module"];
  /** action 前缀，最终形如 `pixel.user.post`。 */
  actionPrefix: string;
}

/**
 * 子树级守卫：抑制全局审计的载荷捕获，并为每个请求写一条不含载荷的审计。
 * 挂在 router 最前面（认证之后即可，审计里的 userId 依赖 req.user）。
 */
export function createPixelAuditGuard(options: PixelAuditGuardOptions): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    suppressAuditPayloadCapture(req);
    const startedAt = Date.now();
    let written = false;

    const write = (result: "success" | "failure"): void => {
      if (written) return;
      written = true;
      const actor = actorOf(req);
      void AuditLogService.log({
        requestId: (req as Request & { requestId?: string }).requestId,
        userId: actor.userId,
        username: actor.username,
        role: actor.role,
        action: `${options.actionPrefix}.${String(req.method || "").toLowerCase()}`.slice(0, 100),
        module: options.module,
        result,
        // 只有状态码与耗时：没有 body、没有 query、没有响应体。
        detail: { statusCode: res.statusCode, durationMs: Date.now() - startedAt },
        // path 去掉 query（查询串里可能有用户参数；本域也不接受卡密出现在 query 里）。
        path: (req.originalUrl || req.path || "").split("?")[0].slice(0, 300),
        method: req.method,
        ip: req.ip || req.socket?.remoteAddress || "unknown",
        userAgent: req.headers["user-agent"],
      }).catch(() => undefined);
    };

    res.on("finish", () => write(res.statusCode < 400 ? "success" : "failure"));
    // 客户端中途断开：连接关掉时 finish 不会来，按失败留痕（与全局中间件的 close 采样同一意图，
    // 但本域不做采样——这里的目标是「那次调用有没有发生」，不是访问统计）。
    res.on("close", () => {
      if (!res.writableEnded) write("failure");
    });
    next();
  };
}
