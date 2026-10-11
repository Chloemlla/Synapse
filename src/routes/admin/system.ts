import { Router, type Request, type Response } from "express";
import { isSuperAdmin } from "../../middleware/auth";
import { adminRedisExportLimiter, adminRedisLimiter } from "../../middleware/routeLimiters";
import { AuditLogService } from "../../services/auditLogService";
import {
  exportRedisAdminSnapshot,
  getRedisAdminOverview,
  readRedisAdminKey,
  scanRedisAdminKeys,
} from "../../services/redisAdminService";
import logger from "../../utils/logger";
import { hasValidSecuritySession } from "../../utils/securitySession";

/**
 * 管理端「Redis 在库数据浏览器」（`/api/admin/system/redis/*`）。
 *
 * 三层保护，缺一不可：
 *   1. 挂载级认证 + 管理员范围守卫（`/api/admin` 的 adminLimiter + adminAuthMiddleware）：
 *      普通管理员在 `adminPages.ts` 里没有 `/api/admin/system` 的页面范围，必然 403；
 *   2. 本文件内 `isSuperAdmin`：即使将来有人给普通管理员放开了页面，这里仍然只认超管；
 *   3. 全站统一的安全会话（`hasValidSecuritySession`，TTL 由 securitySession.ttlSeconds 运行时决定）：明文数据必须先二次验证身份。
 *
 * 能力是**纯只读**：没有删除、写入、flush 入口。审计由本文件显式写（`auditRedisAdmin`），
 * 因为通用 `auditLog` 中间件会把响应体写进审计 —— 那等于把在库明文再抄一份进审计库。
 */

const router = Router();

function ensureSuperAdmin(req: Request, res: Response): boolean {
  if (isSuperAdmin(req)) return true;
  res.status(403).json({ success: false, error: "需要超级管理员权限", code: "SUPERADMIN_REQUIRED" });
  return false;
}

function ensureSecuritySession(req: Request, res: Response): boolean {
  if (hasValidSecuritySession(req)) return true;
  logger.warn("[RedisAdmin] 安全会话校验失败", {
    userId: req.user?.id,
    path: (req.originalUrl || req.path).split("?")[0],
  });
  res.status(403).json({
    success: false,
    error: "安全会话无效或已过期，请先建立安全会话",
    code: "SECURITY_SESSION_REQUIRED",
  });
  return false;
}

/**
 * 只记「谁、什么时候、看了多少」，**不记键值内容**：
 * detail 由调用方显式给出，且刻意不含响应体，避免明文在审计库里留下第二份副本。
 */
function auditRedisAdmin(
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
    module: "system",
    result,
    errorMessage,
    detail: { ...detail, statusCode: res.statusCode },
    ip: req.ip || req.socket?.remoteAddress || "unknown",
    userAgent: req.headers["user-agent"],
    path: (req.originalUrl || req.path).split("?")[0],
    method: req.method,
  }).catch(() => {});
}

/** 键名进审计可接受（定位取证需要），但一律截断，避免超长键名污染审计记录。 */
function auditKeyName(value: unknown): string | undefined {
  return typeof value === "string" && value ? value.slice(0, 200) : undefined;
}

/**
 * @openapi
 * /api/admin/system/redis/overview:
 *   get:
 *     summary: Redis 在库数据浏览概览（连接状态 / 体量 / 命名空间范围）
 *     responses:
 *       200:
 *         description: 概览
 *       403:
 *         description: 需要超级管理员 + 有效安全会话
 */
router.get("/redis/overview", adminRedisLimiter, async (req, res) => {
  if (!ensureSuperAdmin(req, res) || !ensureSecuritySession(req, res)) return;
  try {
    const overview = await getRedisAdminOverview();
    auditRedisAdmin(req, res, "system.redis.overview", { available: overview.status.available });
    return res.json({ success: true, overview });
  } catch (error) {
    logger.error("[RedisAdmin] 读取概览失败", { error });
    return res.status(500).json({ success: false, error: "读取 Redis 概览失败" });
  }
});

/**
 * @openapi
 * /api/admin/system/redis/keys:
 *   get:
 *     summary: 分页列出当前服务在库的 Redis 键（SCAN，不使用 KEYS）
 *     responses:
 *       200:
 *         description: 键列表
 */
router.get("/redis/keys", adminRedisLimiter, async (req, res) => {
  if (!ensureSuperAdmin(req, res) || !ensureSecuritySession(req, res)) return;
  try {
    const result = await scanRedisAdminKeys({
      cursor: req.query.cursor,
      namespace: req.query.namespace,
      filter: req.query.filter,
      limit: req.query.limit,
    });
    if (!result.ok) {
      const status = result.code === "REDIS_UNAVAILABLE" ? 503 : 400;
      return res.status(status).json({ success: false, code: result.code, error: result.error });
    }
    auditRedisAdmin(req, res, "system.redis.keys", {
      listed: result.keys.length,
      scanned: result.scanned,
      outOfScope: result.outOfScope,
      namespace: result.namespace,
      hasFilter: result.hasFilter,
      done: result.done,
    });
    return res.json({ success: true, ...result });
  } catch (error) {
    logger.error("[RedisAdmin] 列出键失败", { error });
    return res.status(500).json({ success: false, error: "列出 Redis 键失败" });
  }
});

/**
 * @openapi
 * /api/admin/system/redis/value:
 *   post:
 *     summary: 读取单个 Redis 键的类型、TTL 与明文内容（有界截断）
 *     responses:
 *       200:
 *         description: 键内容
 */
router.post("/redis/value", adminRedisLimiter, async (req, res) => {
  if (!ensureSuperAdmin(req, res) || !ensureSecuritySession(req, res)) return;
  const body = (req.body ?? {}) as { key?: unknown; maxValueChars?: unknown; maxEntries?: unknown };
  try {
    const result = await readRedisAdminKey(body.key, {
      maxValueChars: body.maxValueChars,
      maxEntries: body.maxEntries,
    });
    if (!result.ok) {
      const status =
        result.code === "REDIS_UNAVAILABLE"
          ? 503
          : result.code === "REDIS_KEY_NOT_FOUND"
            ? 404
            : result.code === "REDIS_KEY_OUT_OF_SCOPE"
              ? 403
              : 400;
      return res.status(status).json({ success: false, code: result.code, error: result.error });
    }
    auditRedisAdmin(req, res, "system.redis.value", {
      key: auditKeyName(result.key),
      type: result.content.type,
      ttlMs: result.content.ttlMs,
      truncated: result.content.truncated,
      totalEntries: result.content.totalEntries,
      stringLength: result.content.stringLength,
    });
    return res.json({ success: true, ...result });
  } catch (error) {
    logger.error("[RedisAdmin] 读取键内容失败", { error });
    return res.status(500).json({ success: false, error: "读取 Redis 键内容失败" });
  }
});

/**
 * @openapi
 * /api/admin/system/redis/export:
 *   get:
 *     summary: 流式导出当前服务在库快照（NDJSON，逐键 DUMP + PTTL）
 *     responses:
 *       200:
 *         description: NDJSON 流
 *       501:
 *         description: RDB 文件导出不可用（需宿主机侧执行）
 */
router.get("/redis/export", adminRedisExportLimiter, async (req, res) => {
  if (!ensureSuperAdmin(req, res) || !ensureSecuritySession(req, res)) return;

  const format = typeof req.query.format === "string" ? req.query.format.trim().toLowerCase() : "ndjson";
  if (format === "rdb" || format === "dump") {
    // 真实的 RDB 在 Redis 服务器数据目录里：应用进程看不到那个目录，node-redis 也不支持 PSYNC 拉流。
    // 与其产出一份假的 .rdb，不如直接指向宿主机上已有的真备份脚本。
    return res.status(501).json({
      success: false,
      code: "REDIS_RDB_NOT_AVAILABLE",
      error:
        "RDB 文件只能在 Redis 服务器所在宿主机导出（本仓部署脚本 deploy/openresty/backup-redis.sh 已做 BGSAVE + 真空加载校验）；此处只提供 DUMP 逻辑快照（format=ndjson）。",
    });
  }
  if (format !== "ndjson") {
    return res.status(400).json({ success: false, error: "仅支持 format=ndjson" });
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  res.status(200);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  // 让 nginx/OpenResty 不要缓冲：否则大快照会先在代理里攒满才吐给浏览器（甚至直接超时）。
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Content-Disposition", `attachment; filename="synapse-redis-snapshot-${stamp}.ndjson"`);

  let exported = 0;
  let truncated = false;
  let failure: string | undefined;

  const aborted = () => Boolean(req.destroyed) || res.writableEnded;
  /**
   * 写一条记录并尊重回压：`res.write` 返回 false 说明底层缓冲已满，
   * 此时继续生产会让一份大快照全抱在内存里（客户端慢的时候最明显）。
   * drain 与 close 同时等：客户端中途断开时 drain 永不会来。
   */
  const writeRecord = async (record: unknown): Promise<boolean> => {
    if (aborted()) return false;
    if (res.write(`${JSON.stringify(record)}\n`)) return true;
    await new Promise<void>((resolve) => {
      const finish = () => {
        res.off("drain", finish);
        res.off("close", finish);
        resolve();
      };
      res.on("drain", finish);
      res.on("close", finish);
    });
    return !aborted();
  };

  try {
    for await (const record of exportRedisAdminSnapshot({
      namespace: req.query.namespace,
      filter: req.query.filter,
      maxKeys: req.query.maxKeys,
    })) {
      if (record.kind === "key") exported += 1;
      if (record.kind === "summary") truncated = record.truncated;
      if (record.kind === "error") failure = record.error;
      // 客户端中途关掉页面/取消下载时停止生成，别让服务端继续空转扫全库。
      if (!(await writeRecord(record))) break;
    }
  } catch (error) {
    logger.error("[RedisAdmin] 导出快照失败", { error });
    failure = "导出过程中发生错误";
    await writeRecord({ kind: "error", code: "EXPORT_FAILED", error: failure });
  } finally {
    if (!res.writableEnded) res.end();
    auditRedisAdmin(
      req,
      res,
      "system.redis.export",
      { format, exported, truncated, failure },
      failure ? "failure" : "success",
      failure,
    );
  }
});

export default router;
