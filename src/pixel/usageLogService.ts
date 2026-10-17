import PixelUsageLogModel, { type IPixelUsageLog } from "../models/pixelUsageLogModel";
import { maskSecret, newPixelId } from "./runtime";
import {
  PixelDomainError,
  type PixelUsageErrorMetrics,
  type PixelUsageLatencyMetrics,
  type PixelUsageLogView,
  type PixelUsageOutcome,
  type PixelUsageSizeMetrics,
} from "./types";

/**
 * 脱敏溯源日志（PIX-12）。
 *
 * 写入端的唯一入口，因此「什么能进库」只在这里判：
 *   · 卡密**在这个函数里**遮罩——调用方传明文（它本来就在同一次请求的内存里），但库里只有
 *     `masked`；把遮罩放在写入点而不是调用点，少一个「忘了遮罩」就会泄漏完整卡密的地方。
 *   · path 在这里去 query：query 里可能有用户参数，默认不入库（PRD 6.1.3）。
 *   · 没有任何字段能承载请求体/响应体/邮箱/IP/UA，调用方想写也写不进去。
 *   · 写日志是 best-effort：溯源失败不该把已经成功的上游操作变成错误响应。
 */

export interface PixelUsageEntry {
  userId: string;
  mappingId: string | null;
  matchedMapping: boolean;
  /** 本次请求带的卡密（明文）；写入时立即遮罩，不落库。 */
  requestedCdk: string | null;
  method: string;
  path: string;
  serviceType?: string | null;
  accountCount?: number | null;
  requestBytes: number;
  responseBytes?: number | null;
  upstreamStatus?: number | null;
  outcome: PixelUsageOutcome;
  durationMs: number;
  /** 同一次 HTTP 请求内的多次上游调用共享同一个 requestId（便于串起来看）。 */
  requestId?: string;
}

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

function stripQuery(path: string): string {
  const value = String(path || "");
  const cut = value.split("?")[0].split("#")[0];
  return cut.slice(0, 200);
}

function clampLimit(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return DEFAULT_LIST_LIMIT;
  return Math.min(Math.max(parsed, 1), MAX_LIST_LIMIT);
}

function toView(doc: unknown): PixelUsageLogView {
  const value = doc as IPixelUsageLog;
  return {
    logId: String(value.logId),
    requestId: String(value.requestId),
    userId: String(value.userId),
    mappingId: value.mappingId ? String(value.mappingId) : null,
    requestedCdkMasked: String(value.requestedCdkMasked ?? ""),
    matchedMapping: Boolean(value.matchedMapping),
    method: String(value.method),
    path: String(value.path),
    serviceType: value.serviceType ? String(value.serviceType) : null,
    accountCount: typeof value.accountCount === "number" ? value.accountCount : null,
    requestBytes: Number(value.requestBytes ?? 0),
    responseBytes: typeof value.responseBytes === "number" ? value.responseBytes : null,
    upstreamStatus: typeof value.upstreamStatus === "number" ? value.upstreamStatus : null,
    outcome: value.outcome,
    durationMs: Number(value.durationMs ?? 0),
    createdAt: new Date(value.createdAt).toISOString(),
  };
}

export interface PixelUsageQuery {
  userId?: string;
  mappingId?: string;
  /**
   * 按卡密过滤：只接受**遮罩值**（列表里显示的那个），与库里存的 `requestedCdkMasked` 精确匹配。
   * 为什么不接受完整卡密：管理端的查询串会被全局审计无条件写进 `detail.query`，
   * 完整卡密一旦进了 URL 就等于默认落库一份（见 src/pixel/requestAudit.ts 的说明）。
   */
  cdkMask?: string;
  limit?: unknown;
  /** 翻页游标：上一页最后一条的 createdAt（ISO）。 */
  cursor?: unknown;
}

export interface PixelUsageMetrics {
  total: number;
  errors: PixelUsageErrorMetrics | null;
  latency: PixelUsageLatencyMetrics | null;
  requestSize: PixelUsageSizeMetrics | null;
  unavailableReasons: {
    errors: string | null;
    latency: string | null;
    requestSize: string | null;
  };
}

const NO_SAMPLES_REASON = "还没有可核对的调用记录（溯源表为空或已过保留期）。";

function round(value: unknown, digits = 0): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  const factor = 10 ** digits;
  return Math.round(numeric * factor) / factor;
}

export const pixelUsageLogService = {
  async record(entry: PixelUsageEntry): Promise<void> {
    try {
      await PixelUsageLogModel.create({
        logId: newPixelId("pxl"),
        requestId: entry.requestId ? String(entry.requestId).slice(0, 80) : newPixelId("pxr"),
        userId: entry.userId,
        mappingId: entry.mappingId || null,
        requestedCdkMasked: maskSecret(entry.requestedCdk ?? ""),
        matchedMapping: entry.matchedMapping,
        method: String(entry.method || "POST").slice(0, 10),
        path: stripQuery(entry.path),
        serviceType: entry.serviceType ? String(entry.serviceType).slice(0, 40) : null,
        accountCount: typeof entry.accountCount === "number" ? entry.accountCount : null,
        requestBytes: Number(entry.requestBytes ?? 0),
        responseBytes: typeof entry.responseBytes === "number" ? entry.responseBytes : null,
        upstreamStatus: typeof entry.upstreamStatus === "number" ? entry.upstreamStatus : null,
        outcome: entry.outcome,
        durationMs: Math.max(0, Math.trunc(entry.durationMs)),
        createdAt: new Date(),
      });
    } catch {
      // best-effort：溯源写不进去不能影响已经发生的上游调用结果
    }
  },

  async list(query: PixelUsageQuery): Promise<{ items: PixelUsageLogView[]; nextCursor: string | null }> {
    // 显式声明过滤条件类型（不用 Record<string, unknown>）：mongo 的 FilterQuery 对每个字段有
    // 自己的条件形状，用宽泛字典会失去类型校验。
    const filter: {
      userId?: string;
      mappingId?: string;
      requestedCdkMasked?: string;
      createdAt?: { $lt: Date };
    } = {};
    if (query.userId) filter.userId = query.userId;
    if (query.mappingId) filter.mappingId = query.mappingId;
    if (query.cdkMask) filter.requestedCdkMasked = query.cdkMask;
    const cursor = typeof query.cursor === "string" ? query.cursor.trim() : "";
    if (cursor) {
      const at = new Date(cursor);
      if (!Number.isNaN(at.getTime())) filter.createdAt = { $lt: at };
    }

    const limit = clampLimit(query.limit);
    const docs = await PixelUsageLogModel.find(filter).sort({ createdAt: -1 }).limit(limit + 1).lean();
    const items = docs.slice(0, limit).map(toView);
    const nextCursor = docs.length > limit
      ? new Date((docs[limit - 1] as unknown as IPixelUsageLog).createdAt).toISOString()
      : null;
    return { items, nextCursor };
  },

  async get(logId: string): Promise<PixelUsageLogView | null> {
    if (!logId) return null;
    const doc = await PixelUsageLogModel.findOne({ logId }).lean();
    return doc ? toView(doc) : null;
  },

  async listForUser(userId: string, limit = 200): Promise<PixelUsageLogView[]> {
    const docs = await PixelUsageLogModel.find({ userId })
      .sort({ createdAt: -1 })
      .limit(Math.min(Math.max(1, Math.floor(limit) || 200), 500))
      .lean();
    return docs.map(toView);
  },

  /** 账号注销：溯源日志是纯遥测且带 TTL，直接删除（不留置已注销用户的行为记录）。 */
  async deleteForUser(userId: string): Promise<number> {
    const result = await PixelUsageLogModel.deleteMany({ userId }).exec();
    return Number(result.deletedCount ?? 0);
  },

  async stats(): Promise<{ total: number; last24h: number; last7d: number; lastAt: string | null }> {
    const now = Date.now();
    const since24h = new Date(now - 24 * 60 * 60 * 1000);
    const since7d = new Date(now - 7 * 24 * 60 * 60 * 1000);
    const [total, last24h, last7d, latest] = await Promise.all([
      PixelUsageLogModel.countDocuments({}).exec(),
      PixelUsageLogModel.countDocuments({ createdAt: { $gte: since24h } }).exec(),
      PixelUsageLogModel.countDocuments({ createdAt: { $gte: since7d } }).exec(),
      PixelUsageLogModel.findOne({}).sort({ createdAt: -1 }).select("createdAt").lean(),
    ]);
    const latestAt = latest ? new Date((latest as unknown as { createdAt: Date }).createdAt) : null;
    return {
      total,
      last24h,
      last7d,
      lastAt: latestAt ? latestAt.toISOString() : null,
    };
  },
  /**
   * PIX-14：错误/延迟/请求大小的可核对聚合。
   *
   * 数字只来自 `pixel_usage_logs`（脱敏溯源）：outcome 分类、durationMs、requestBytes。
   * 没有样本时返回 null 并给出原因，而不是「0 ms / 0%」这种看起来正常、实际没有依据的值。
   * 分位用 MongoDB 7+ 的 `$percentile`（近似法）：比把所有行拉进内存排序便宜，也避免
   * 在管理端刷新时把整张溯源表读一遍。
   */
  async metrics(): Promise<PixelUsageMetrics> {
    // `$percentile` 是 MongoDB 7+ 的聚合累加器；Mongoose 的类型表尚未收录它，
    // 因此显式断言成 PipelineStage[]，而不是为了类型去改写成内存排序。
    const pipeline = [
      {
        $facet: {
          outcomes: [{ $group: { _id: "$outcome", count: { $sum: 1 } } }],
          latency: [{
            $group: {
              _id: null,
              samples: { $sum: 1 },
              avgMs: { $avg: "$durationMs" },
              maxMs: { $max: "$durationMs" },
              p: { $percentile: { input: "$durationMs", p: [0.95, 0.99], method: "approximate" } },
            },
          }],
          size: [{
            $group: {
              _id: null,
              samples: { $sum: 1 },
              avgBytes: { $avg: "$requestBytes" },
              maxBytes: { $max: "$requestBytes" },
              p: { $percentile: { input: "$requestBytes", p: [0.95], method: "approximate" } },
            },
          }],
        },
      },
    ] as unknown as Parameters<typeof PixelUsageLogModel.aggregate>[0];
    const rows = await PixelUsageLogModel.aggregate<{
      outcomes: Array<{ _id: string; count: number }>;
      latency: Array<{ samples: number; avgMs: number; maxMs: number; p: number[] }>;
      size: Array<{ samples: number; avgBytes: number; maxBytes: number; p: number[] }>;
    }>(pipeline).exec();

    const facet = rows[0] ?? { outcomes: [], latency: [], size: [] };
    const total = facet.outcomes.reduce((sum, entry) => sum + Number(entry.count ?? 0), 0);
    const byOutcome: Record<string, number> = {};
    for (const entry of facet.outcomes) byOutcome[String(entry._id ?? "unknown")] = Number(entry.count ?? 0);
    const failed = total - Number(byOutcome.success ?? 0);
    const latencySample = facet.latency[0] ?? null;
    const sizeSample = facet.size[0] ?? null;

    return {
      total,
      errors: total > 0
        ? {
            total,
            failed,
            rate: round(failed / total, 4),
            byOutcome,
          }
        : null,
      latency: total > 0 && latencySample
        ? {
            samples: Number(latencySample.samples ?? total),
            avgMs: round(latencySample.avgMs, 1),
            p95Ms: round(latencySample.p?.[0] ?? 0, 1),
            p99Ms: round(latencySample.p?.[1] ?? 0, 1),
            maxMs: round(latencySample.maxMs, 1),
          }
        : null,
      requestSize: total > 0 && sizeSample
        ? {
            samples: Number(sizeSample.samples ?? total),
            avgBytes: round(sizeSample.avgBytes, 1),
            p95Bytes: round(sizeSample.p?.[0] ?? 0, 1),
            maxBytes: round(sizeSample.maxBytes, 1),
          }
        : null,
      unavailableReasons: {
        errors: total > 0 ? null : NO_SAMPLES_REASON,
        latency: total > 0 ? null : NO_SAMPLES_REASON,
        requestSize: total > 0 ? null : NO_SAMPLES_REASON,
      },
    };
  },
};

/**
 * 把领域错误归到溯源结果分类（只影响管理端聚合统计，不影响用户响应）。
 * 未识别的错误按 upstream_error 计：宁可让运维看到「上游有问题」，也不要默默算成业务拒绝。
 */
export function pixelOutcomeFromError(error: unknown): PixelUsageOutcome {
  if (error instanceof PixelDomainError) {
    if (error.code === "PIXEL_UPSTREAM_TIMEOUT") return "timeout";
    if (error.code === "PIXEL_UPSTREAM_RATE_LIMITED") return "rate_limited";
    if (error.code === "PIXEL_UPSTREAM_TARGET_BLOCKED") return "blocked";
    if (error.status === 502 || error.status === 503 || error.status === 504) return "upstream_error";
    if (error.status >= 400 && error.status < 500) return "client_error";
  }
  return "upstream_error";
}

/** 从映射后的领域错误里取回上游状态码（mapUpstreamFailure 会把它放进 details），没有就返回 null。 */
export function pixelUpstreamStatusFromError(error: unknown): number | null {
  if (error instanceof PixelDomainError) {
    const value = error.details?.upstreamStatus;
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}
