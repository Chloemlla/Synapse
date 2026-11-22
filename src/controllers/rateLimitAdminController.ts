import type { NextFunction, Request, Response } from "express";
import { startupConfig } from "../config/config";
import { getBurstConcurrencySnapshot, getLimiterDefinitionSnapshot } from "../middleware/routeLimiters";
import { QuotaEventModel } from "../models/quotaEventModel";
import { mongoose } from "../services/mongoService";
import { UserModel } from "../services/userService";
import { LIBRECHAT_QUOTA_DEFAULTS } from "../services/libreChatQuotaService";
import { ttsStorage } from "../tts/tts.storage";
import { getRegisteredTtsQueue } from "../tts/tts.queueRegistry";
import { MEDIA_SANDBOX_DEFAULTS, resolveMediaSandboxLimits } from "../mediaTool/sandbox";
import { resolveWatchdogMode } from "../utils/processWatchdog";
import { docLimitsFromEnv } from "../docTool/types";
import { activeUserFilter } from "../utils/softDeleteState";
import { escapeRegexLiteral } from "../utils/regexEscape";
import logger from "../utils/logger";

/**
 * 限流、配额与资源闸门的管理端只读数据源（页面 `/admin/rate-limits`）。
 *
 * 覆盖十月十七日 RC-27 / RC-28 / RC-29 / RC-30 / RC-37 / RC-39 这几条「后端有、管理面没有」的交付：
 * 突发并发硬顶、80%/100% 配额事件、配额阶梯与封禁、TTS 每用户活跃上限、文件沙箱与子进程看门狗。
 *
 * 三条硬约束（与 ip-risk-logs / mobile-token 面板一致）：
 *   1. 全部只读。所有阈值仍由 env / 运行时配置决定，**页面不提供在线修改** ——
 *      阈值改动会改变全站行为，必须走 `/admin/env` 那条带审计与安全会话的链路。
 *   2. 不读任务正文：TTS 占用只回「用户 + 活跃数」，配额事件 detail 只回摘要。
 *   3. Mongo 未就绪时明确 503；进程内的并发快照与 TTS 队列不依赖 Mongo，照常返回并标注。
 */

type LooseDoc = Record<string, unknown>;

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

function isMongoReady(): boolean {
  return mongoose.connection.readyState === 1;
}

function readParam(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" ? raw.trim() : "";
}

function readLimit(value: unknown): number {
  const num = Number(readParam(value));
  if (!Number.isFinite(num)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(num), 1), MAX_LIMIT);
}

function readOffset(value: unknown): number {
  const num = Number(readParam(value));
  if (!Number.isFinite(num) || num < 0) return 0;
  return Math.trunc(num);
}

function toIso(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  return null;
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toLooseDocs(docs: unknown): LooseDoc[] {
  return Array.isArray(docs) ? (docs as LooseDoc[]) : [];
}

/** keyId 只回前 10 位：它本身是 Key 文档的 _id，完整值没有展示价值。 */
function maskId(value: unknown): string | null {
  const id = readString(value);
  if (!id) return null;
  return id.length > 12 ? `${id.slice(0, 10)}…` : id;
}

/** 存储后端：配了 REDIS_URL 且不是「静态资源类」时走共享档。 */
function describeStorage(): { redisConfigured: boolean; backend: "redis" | "memory" } {
  const configured = Boolean(startupConfig.redis?.url);
  return { redisConfigured: configured, backend: configured ? "redis" : "memory" };
}

/** 当前进程的 TTS 占用快照；队列未注册（只跑 HTTP 层的测试）时返回可读原因。 */
async function collectTtsOccupancy(topN: number) {
  const queue = getRegisteredTtsQueue();
  if (!queue) {
    return {
      available: false as const,
      reason: "当前进程没有注册 TTS 队列实例（通常只出现在测试环境或仅加载 HTTP 层时）。",
      global: null,
      perUserMaxActive: null,
      topOwners: [] as Array<{ userId: string; active: number }>,
    };
  }
  const global = queue.getOccupancy();
  let topOwners: Array<{ userId: string; active: number }> = [];
  try {
    topOwners = await ttsStorage.listActiveJobOwners(topN);
  } catch (error) {
    logger.warn("[RateLimitAdmin] 读取 TTS 活跃任务归属失败", {
      errorType: error instanceof Error ? error.name : "unknown",
    });
  }
  return {
    available: true as const,
    reason: null,
    global,
    perUserMaxActive: queue.getPerUserMaxActive(),
    topOwners,
  };
}

export class RateLimitAdminController {
  /** GET /api/admin/rate-limits/overview —— 并发 + 配额事件 + 封禁 + 占用的一屏结论。 */
  static async getOverview(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const burst = getBurstConcurrencySnapshot();
      const tts = await collectTtsOccupancy(10);
      const storage = describeStorage();

      let quota: {
        total24h: number;
        warning24h: number;
        exhausted24h: number;
        upstream24h: number;
        byResource: Array<{ resource: string; count: number }>;
      } | null = null;
      let ban: { total: number; active: number } | null = null;

      if (isMongoReady()) {
        const since = new Date(Date.now() - DAY_MS);
        const nowIso = new Date().toISOString();
        const [total24h, warning24h, exhausted24h, upstream24h, byResource, bannedTotal, bannedActive] =
          await Promise.all([
            QuotaEventModel.countDocuments({ createdAt: { $gte: since } }).exec(),
            QuotaEventModel.countDocuments({ createdAt: { $gte: since }, threshold: { $lt: 1 } }).exec(),
            QuotaEventModel.countDocuments({ createdAt: { $gte: since }, threshold: { $gte: 1 } }).exec(),
            QuotaEventModel.countDocuments({ createdAt: { $gte: since }, scope: "upstream" }).exec(),
            QuotaEventModel.aggregate([
              { $match: { createdAt: { $gte: since } } },
              { $group: { _id: "$resource", count: { $sum: 1 } } },
              { $sort: { count: -1 } },
              { $limit: 20 },
            ]).exec(),
            UserModel.countDocuments({ ...activeUserFilter(), libreChatBanCount: { $gt: 0 } }).exec(),
            UserModel.countDocuments({
              ...activeUserFilter(),
              libreChatBannedUntil: { $gt: nowIso },
            }).exec(),
          ]);
        quota = {
          total24h,
          warning24h,
          exhausted24h,
          upstream24h,
          byResource: toLooseDocs(byResource).map((row) => ({
            resource: readString(row._id),
            count: readNumber(row.count) ?? 0,
          })),
        };
        ban = { total: bannedTotal, active: bannedActive };
      }

      res.setHeader("Cache-Control", "no-store");
      res.json({
        success: true,
        generatedAt: new Date().toISOString(),
        burst: {
          totalActive: burst.totalActive,
          guards: Object.entries(burst.guards).map(([name, value]) => ({
            name,
            active: value.active,
            keys: value.keys,
            maxConcurrent: value.maxConcurrent,
            utilization: value.maxConcurrent > 0 ? Math.min(1, value.active / value.maxConcurrent) : 0,
          })),
        },
        quota: quota ?? { unavailableReason: "数据库未连接，配额事件与封禁计数不可用。" },
        tts,
        storage,
        limits: {
          docTool: docLimitsFromEnv(),
          mediaSandbox: resolveMediaSandboxLimits(),
          watchdogMode: resolveWatchdogMode(),
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /** GET /api/admin/rate-limits/burst —— 在途并发逐守卫/逐键快照。 */
  static async getBurst(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const snapshot = getBurstConcurrencySnapshot();
      res.setHeader("Cache-Control", "no-store");
      res.json({
        success: true,
        generatedAt: new Date().toISOString(),
        totalActive: snapshot.totalActive,
        guards: Object.entries(snapshot.guards).map(([name, value]) => ({
          name,
          active: value.active,
          keys: value.keys,
          maxConcurrent: value.maxConcurrent,
          utilization: value.maxConcurrent > 0 ? Math.min(1, value.active / value.maxConcurrent) : 0,
          overCap: value.active > value.maxConcurrent,
        })),
      });
    } catch (error) {
      next(error);
    }
  }

  /** GET /api/admin/rate-limits/quota-events —— `quota_events` 分页。 */
  static async listQuotaEvents(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!isMongoReady()) {
        res.status(503).json({ success: false, error: "数据库未连接，无法读取配额事件。", code: "RATE_LIMIT_ADMIN_DB_UNAVAILABLE" });
        return;
      }
      const limit = readLimit(req.query.limit);
      const offset = readOffset(req.query.offset);
      const scope = readParam(req.query.scope);
      const resource = readParam(req.query.resource);
      const threshold = readParam(req.query.threshold);
      const userId = readParam(req.query.userId);
      const sinceRaw = readParam(req.query.since);
      const since = sinceRaw && !Number.isNaN(Date.parse(sinceRaw)) ? new Date(sinceRaw) : null;

      const match: Record<string, unknown> = {};
      if (scope && ["key", "account", "upstream"].includes(scope)) match.scope = scope;
      if (resource) match.resource = resource;
      if (userId) match.userId = userId;
      if (threshold === "0.8") match.threshold = { $lt: 1 };
      if (threshold === "1") match.threshold = { $gte: 1 };
      if (since) match.createdAt = { $gte: since };

      const [docs, total] = await Promise.all([
        QuotaEventModel.find(match)
          .select("scope keyId userId resource threshold periodKey cycle code detail createdAt")
          .sort({ createdAt: -1 })
          .skip(offset)
          .limit(limit)
          .lean()
          .exec(),
        QuotaEventModel.countDocuments(match).exec(),
      ]);

      res.setHeader("Cache-Control", "no-store");
      res.json({
        success: true,
        total,
        limit,
        offset,
        events: toLooseDocs(docs).map((doc) => ({
          id: String(doc._id ?? ""),
          scope: readString(doc.scope),
          keyId: maskId(doc.keyId),
          userId: readString(doc.userId) || null,
          resource: readString(doc.resource),
          threshold: readNumber(doc.threshold),
          periodKey: readString(doc.periodKey),
          cycle: readNumber(doc.cycle) ?? 0,
          code: readString(doc.code),
          detail: doc.detail ?? null,
          createdAt: toIso(doc.createdAt),
        })),
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/admin/rate-limits/ladders —— 每用户配额阶梯视图。
   *
   * 只读 `user_datas` 上 LibreChat 阶梯的落库字段；数值口径与 `libreChatQuotaService` 一致
   * （`libreChatBanCount` 是**跨自然日累计**的封禁次数，警告计数按上海自然日归零）。
   */
  static async listLadders(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!isMongoReady()) {
        res.status(503).json({ success: false, error: "数据库未连接，无法读取配额阶梯。", code: "RATE_LIMIT_ADMIN_DB_UNAVAILABLE" });
        return;
      }
      const limit = readLimit(req.query.limit);
      const offset = readOffset(req.query.offset);
      const state = readParam(req.query.state).toLowerCase();
      const q = readParam(req.query.q);
      const nowIso = new Date().toISOString();

      const match: Record<string, unknown> = { ...activeUserFilter() };
      if (state === "banned") match.libreChatBannedUntil = { $gt: nowIso };
      if (state === "active") {
        match.$or = [{ libreChatBannedUntil: { $in: ["", null] } }, { libreChatBannedUntil: { $lte: nowIso } }];
      }
      if (q) {
        const pattern = new RegExp(escapeRegexLiteral(q), "i");
        match.$and = [{ $or: [{ username: pattern }, { email: pattern }, { id: q }] }];
      }

      const [docs, total] = await Promise.all([
        UserModel.find(match)
          .select(
            "id username email role libreChatDailyUsage libreChatUsageDay libreChatViolationCount libreChatBannedUntil libreChatBanCount",
          )
          .sort({ libreChatBanCount: -1, libreChatDailyUsage: -1 })
          .skip(offset)
          .limit(limit)
          .lean()
          .exec(),
        UserModel.countDocuments(match).exec(),
      ]);

      // LibreChat 阶梯额度是 env 参数（模块加载时读一次，随重启生效），不在运行时配置里：
      // 这里只回「生效值来自哪个 env」与默认值，避免面板展示与真实配额分叉。
      const ladderConfig = {
        defaults: LIBRECHAT_QUOTA_DEFAULTS,
        env: {
          dailyLimit: "LIBRECHAT_DAILY_LIMIT",
          maxWarnings: "LIBRECHAT_MAX_WARNINGS",
          banHours: "LIBRECHAT_BAN_HOURS",
          banHoursTable: "LIBRECHAT_BAN_HOURS_TABLE",
        },
        note: "封禁时长按累计封禁次数查表（默认 24h → 168h → 720h），跨自然日不清零；警告计数按上海自然日归零。数值随进程重启生效。",
      };

      res.setHeader("Cache-Control", "no-store");
      res.json({
        success: true,
        total,
        limit,
        offset,
        config: ladderConfig,
        ladders: toLooseDocs(docs).map((doc) => {
          const bannedUntil = readString(doc.libreChatBannedUntil);
          const banned = Boolean(bannedUntil) && bannedUntil > nowIso;
          return {
            userId: readString(doc.id),
            username: readString(doc.username) || null,
            email: readString(doc.email) || null,
            role: readString(doc.role) || "user",
            dailyUsage: readNumber(doc.libreChatDailyUsage) ?? 0,
            usageDay: readString(doc.libreChatUsageDay) || null,
            violationCount: readNumber(doc.libreChatViolationCount) ?? 0,
            banCount: readNumber(doc.libreChatBanCount) ?? 0,
            bannedUntil: bannedUntil || null,
            banned,
          };
        }),
      });
    } catch (error) {
      next(error);
    }
  }

  /** GET /api/admin/rate-limits/tts-occupancy —— 全局队列占用 + 占用 Top N 用户。 */
  static async getTtsOccupancy(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const topN = Math.min(Math.max(Number(readParam(req.query.top)) || 20, 1), 100);
      const tts = await collectTtsOccupancy(topN);
      res.setHeader("Cache-Control", "no-store");
      res.json({ success: true, generatedAt: new Date().toISOString(), ...tts });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/admin/rate-limits/tts-jobs —— 逐任务明细（排队 + 运行中）。
   *
   * 只回执行元数据（taskId / userId / provider / 时间），不回题词与产物 URL：
   * 「谁占着槽位」是运维问题，「他说了什么」不是。
   */
  static async listTtsJobs(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await ttsStorage.listActiveJobs({
        userId: readParam(req.query.userId),
        limit: Number(readParam(req.query.limit)) || 50,
        offset: Number(readParam(req.query.offset)) || 0,
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({
        success: true,
        generatedAt: new Date().toISOString(),
        ...result,
        note: "只含排队与运行中的任务；题词、语音参数与产物地址属用户内容，不在此视图内。",
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/admin/rate-limits/resources —— 资源闸门生效值。
   *
   * 每条都给出「env 名 / 生效值 / 默认值」三列：管理员看到的数字必须是**当前进程真的在用**的值，
   * 而不是 .env.example 里的示例值。
   */
  static async getResources(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const sandbox = resolveMediaSandboxLimits();
      const doc = docLimitsFromEnv();
      res.setHeader("Cache-Control", "no-store");
      res.json({
        success: true,
        generatedAt: new Date().toISOString(),
        mediaSandbox: {
          effective: sandbox,
          defaults: MEDIA_SANDBOX_DEFAULTS,
          env: {
            maxFileBytes: "MEDIA_TOOL_MAX_FILE_BYTES",
            maxFilesPerJob: "MEDIA_TOOL_MAX_FILES_PER_JOB",
            maxUserDirBytes: "MEDIA_TOOL_USER_DIR_MAX_BYTES",
            maxUserDirFiles: "MEDIA_TOOL_USER_DIR_MAX_FILES",
          },
          note: "四道硬顶：路径 / 大小 / 类型 / 数量。检查失败一律拒绝（fail-closed），不留孤儿文件。",
        },
        docTool: {
          effective: doc,
          env: {
            maxUploadBytes: "DOC_TOOL_MAX_UPLOAD_BYTES",
            maxActiveJobs: "DOC_TOOL_MAX_ACTIVE_JOBS",
          },
          note: "doc-tool 为串行队列；maxActiveJobs 是单个用户允许的排队+运行任务数。",
        },
        processWatchdog: {
          mode: resolveWatchdogMode(),
          env: {
            mode: "PROCESS_WATCHDOG_MODE",
            maxRssMb: "PROCESS_WATCHDOG_MAX_RSS_MB",
            maxDurationMs: "PROCESS_WATCHDOG_MAX_DURATION_MS",
          },
          note: "只对目标子进程树的 RSS 计量（读 /proc），绝不读全局 RSS；非 Linux 环境内存判据不可用，时长判据仍生效。",
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /** GET /api/admin/rate-limits/limiters —— 限流器清单（定义表快照，不参与运行判定）。 */
  static async listLimiters(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const storage = describeStorage();
      const limiters = getLimiterDefinitionSnapshot().map((item) => ({
        ...item,
        // shared 档在未配置 Redis 时会退化成进程内存档（有界），这里如实标注。
        effectiveStorage: item.storage === "memory" ? "memory" : storage.redisConfigured ? "redis" : "memory(fallback)",
      }));
      res.setHeader("Cache-Control", "no-store");
      res.json({ success: true, storage, total: limiters.length, limiters });
    } catch (error) {
      next(error);
    }
  }
}
