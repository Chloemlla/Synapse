import { Router, type Request, type Response } from "express";
import { isSuperAdmin } from "../../middleware/auth";
import { adminMongoExportLimiter, adminMongoLimiter } from "../../middleware/routeLimiters";
import { AuditLogService } from "../../services/auditLogService";
import {
  exportMongoAdminDocuments,
  getMongoAdminCollectionDetail,
  getMongoAdminOverview,
  listMongoAdminCollections,
  listMongoAdminDocuments,
  parseBooleanFlag,
} from "../../services/mongoAdminService";
import logger from "../../utils/logger";
import { firstString } from "../../utils/httpParam";
import { assertSecuritySessionBinding, hasValidSecuritySession } from "../../utils/securitySession";

/**
 * 管理端「MongoDB 在库数据浏览器」（`/api/admin/system/mongo/*`）。
 *
 * 三层保护与 Redis 浏览器保持一致（缺一不可）：
 *   1. 挂载级认证 + 管理员范围守卫：`/api/admin/system` 没有登记给普通管理员，必然 403；
 *   2. 本文件内 `isSuperAdmin`：即使将来放开页面范围，这里仍然只认超管；
 *   3. 全站统一的安全会话（`hasValidSecuritySession` + 环境绑定判定）。
 *
 * 只读：没有写入、删除、建索引入口。审计由本文件显式写，且**只记集合名与规模**，
 * 不记过滤条件正文与文档内容 —— 文档是用户 PII，抄进审计等于多留一份副本。
 *
 * 脱敏开关：默认**原样返回**（这里已经强制超管 + 安全会话，即管理员当场验过一次身份）；
 * 传 `redact=1` 时按账户导出同一套规则把凭据类字段替换成 `[redacted]`，供截图/共享场景使用。
 */
const router = Router();

function ensureSuperAdmin(req: Request, res: Response): boolean {
  if (isSuperAdmin(req)) return true;
  res.status(403).json({ success: false, error: "需要超级管理员权限", code: "SUPERADMIN_REQUIRED" });
  return false;
}

async function ensureSecuritySession(req: Request, res: Response): Promise<boolean> {
  if (!hasValidSecuritySession(req)) {
    logger.warn("[MongoAdmin] 安全会话校验失败", {
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
  if (!(await assertSecuritySessionBinding(req))) {
    res.status(403).json({
      success: false,
      error: "登录环境发生变化，请重新建立安全会话",
      code: "SECURITY_SESSION_BINDING_CHANGED",
    });
    return false;
  }
  return true;
}

/** 只记「谁、什么时候、看了哪个集合的多少条」，绝不记文档内容。 */
function auditMongoAdmin(
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

function auditCollectionName(value: unknown): string | undefined {
  return typeof value === "string" && value ? value.slice(0, 200) : undefined;
}

/**
 * @openapi
 * /api/admin/system/mongo/overview:
 *   get:
 *     summary: MongoDB 在库数据浏览概览（连接 / 库名 / 集合数 / 体量）
 *     responses:
 *       200:
 *         description: 概览
 *       403:
 *         description: 需要超级管理员 + 有效安全会话
 */
router.get("/overview", adminMongoLimiter, async (req, res) => {
  if (!ensureSuperAdmin(req, res) || !(await ensureSecuritySession(req, res))) return;
  try {
    const overview = await getMongoAdminOverview();
    auditMongoAdmin(req, res, "system.mongo.overview", {
      connected: overview.connected,
      collections: overview.collections,
    });
    return res.json({ success: true, overview });
  } catch (error) {
    logger.error("[MongoAdmin] 读取概览失败", { error });
    return res.status(500).json({ success: false, error: "读取 MongoDB 概览失败" });
  }
});

/**
 * @openapi
 * /api/admin/system/mongo/collections:
 *   get:
 *     summary: 列出数据库中的集合与估算文档数（只读元数据）
 *     responses:
 *       200:
 *         description: 集合列表
 */
router.get("/collections", adminMongoLimiter, async (req, res) => {
  if (!ensureSuperAdmin(req, res) || !(await ensureSecuritySession(req, res))) return;
  try {
    const collections = await listMongoAdminCollections();
    auditMongoAdmin(req, res, "system.mongo.collections", { listed: collections.length });
    return res.json({ success: true, collections });
  } catch (error) {
    logger.error("[MongoAdmin] 列出集合失败", { error });
    return res.status(500).json({ success: false, error: "列出集合失败" });
  }
});

/**
 * @openapi
 * /api/admin/system/mongo/collections/{name}/documents:
 *   get:
 *     summary: 分页读取集合文档（服务端脱敏）
 *     parameters:
 *       - in: path
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: pageSize
 *         schema:
 *           type: integer
 *       - in: query
 *         name: filter
 *         description: 受限 JSON 查询对象（不允许 $where / $function / $accumulator）
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: 文档分页
 *       400:
 *         description: 过滤条件无效
 *       404:
 *         description: 集合不存在
 */
router.get("/collections/:name/documents", adminMongoLimiter, async (req, res) => {
  if (!ensureSuperAdmin(req, res) || !(await ensureSecuritySession(req, res))) return;
  const collectionName = firstString(req.params.name);
  try {
    const result = await listMongoAdminDocuments({
      collection: collectionName,
      page: req.query.page,
      pageSize: req.query.pageSize,
      filter: req.query.filter,
      sortField: req.query.sortField,
      sortOrder: req.query.sortOrder,
      redact: req.query.redact,
    });
    if (!result.ok) {
      const status = result.code === "MONGO_COLLECTION_NOT_FOUND" ? 404 : 400;
      auditMongoAdmin(req, res, "system.mongo.documents", {
        collection: auditCollectionName(collectionName),
        error: result.error,
      }, "failure", result.error);
      return res.status(status).json({ success: false, code: result.code, error: result.error });
    }
    auditMongoAdmin(req, res, "system.mongo.documents", {
      collection: result.page.collection,
      page: result.page.page,
      pageSize: result.page.pageSize,
      returned: result.page.documents.length,
      hasMore: result.page.hasMore,
      hasFilter: Boolean(firstString(req.query.filter)),
      redacted: result.page.redacted,
    });
    return res.json({ success: true, ...result.page });
  } catch (error) {
    logger.error("[MongoAdmin] 读取文档失败", { error });
    return res.status(500).json({ success: false, error: "读取集合文档失败" });
  }
});

/**
 * @openapi
 * /api/admin/system/mongo/collections/{name}/detail:
 *   get:
 *     summary: 读取集合的索引与选项（不返回 validator 正文）
 *     responses:
 *       200:
 *         description: 集合结构
 */
router.get("/collections/:name/detail", adminMongoLimiter, async (req, res) => {
  if (!ensureSuperAdmin(req, res) || !(await ensureSecuritySession(req, res))) return;
  const collectionName = firstString(req.params.name);
  try {
    const result = await getMongoAdminCollectionDetail(collectionName);
    if (!result.ok) {
      auditMongoAdmin(req, res, "system.mongo.collectionDetail", {
        collection: auditCollectionName(collectionName),
        error: result.error,
      }, "failure", result.error);
      return res.status(404).json({ success: false, code: result.code, error: result.error });
    }
    auditMongoAdmin(req, res, "system.mongo.collectionDetail", {
      collection: result.detail.collection,
      indexes: result.detail.indexes.length,
    });
    return res.json({ success: true, ...result.detail });
  } catch (error) {
    logger.error("[MongoAdmin] 读取集合结构失败", { error });
    return res.status(500).json({ success: false, error: "读取集合结构失败" });
  }
});

/**
 * @openapi
 * /api/admin/system/mongo/export:
 *   get:
 *     summary: 流式导出集合文档（NDJSON，服务端脱敏）
 *     responses:
 *       200:
 *         description: NDJSON 流
 */
router.get("/export", adminMongoExportLimiter, async (req, res) => {
  if (!ensureSuperAdmin(req, res) || !(await ensureSecuritySession(req, res))) return;

  const collectionName = firstString(req.query.collection);
  if (!collectionName) {
    return res.status(400).json({ success: false, error: "缺少 collection 参数" });
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeName = collectionName.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80) || "collection";
  res.status(200);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  // 大导出经反代时不要缓冲，否则客户端要等整份文件在代理里攒满。
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Content-Disposition", `attachment; filename="synapse-mongo-${safeName}-${stamp}.ndjson"`);

  let exported = 0;
  let failure: string | undefined;
  const aborted = () => Boolean(req.destroyed) || res.writableEnded;

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
    for await (const record of exportMongoAdminDocuments({
      collection: collectionName,
      filter: req.query.filter,
      sortField: req.query.sortField,
      sortOrder: req.query.sortOrder,
      maxDocs: req.query.maxDocs,
      redact: req.query.redact,
    })) {
      if (record.kind === "document") exported += 1;
      if (record.kind === "error") failure = String(record.error ?? "导出失败");
      if (!(await writeRecord(record))) break;
    }
  } catch (error) {
    logger.error("[MongoAdmin] 导出失败", { error });
    failure = "导出过程中发生错误";
    await writeRecord({ kind: "error", code: "EXPORT_FAILED", error: failure });
  } finally {
    if (!res.writableEnded) res.end();
    auditMongoAdmin(
      req,
      res,
      "system.mongo.export",
      {
        collection: auditCollectionName(collectionName),
        exported,
        hasFilter: Boolean(firstString(req.query.filter)),
        redacted: parseBooleanFlag(req.query.redact),
      },
      failure ? "failure" : "success",
      failure,
    );
  }
});

export default router;
