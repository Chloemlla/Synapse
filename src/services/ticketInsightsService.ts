import { TicketModel } from "../models/ticketModel";
import { TICKET_SLA_HOURS } from "./ticketWorkflowService";

/**
 * 工单质量与 SLA 的只读聚合（页面 `/admin/tickets` 的「质量与 SLA」「客服工作量」页签）。
 *
 * 为什么单独成文件而不是塞进 `ticketWorkflowService`：那个文件负责**写路径**（状态机、
 * 事件、批量补丁），已经很大；这里的逻辑全是只读聚合，且只在管理端面板被调用。
 * 唯一共用的常量是 `TICKET_SLA_HOURS`，从写路径那边 import，避免两处各写一个 24。
 *
 * 三条口径：
 *   1. **分位用 Mongo 8 的 `$percentile`**（与 Pixel 的 `usageLogService.metrics()` 同口径）。
 *      取不到时返回 `null`，不返回 0 —— 0 会被读成「首响只要 0 小时」，那是错误结论而不是缺数据。
 *   2. **SLA 只算「最后一条是用户发言且未关闭」的工单**：客服已经回了的工单不该继续计时。
 *      逾期阈值等于 `TICKET_SLA_HOURS`，临近阈值为其 75%（面板上标「即将逾期」）。
 *   3. **趋势按 Asia/Shanghai 切天**：容器默认 UTC，不写时区会把晚上 8 点后的工单算到前一天的格子。
 */

export interface TicketInsights {
  windowDays: number;
  firstResponse: { p50Hours: number | null; p90Hours: number | null; p95Hours: number | null; samples: number };
  resolution: { p50Hours: number | null; p90Hours: number | null; p95Hours: number | null; samples: number };
  sla: { breached: number; atRisk: number; evaluated: number; slaHours: number };
  csat: { average: number | null; count: number; low: number; distribution: Record<string, number> };
  volumeByService: Record<string, number>;
  volumeByCategory: Record<string, number>;
  trend: Array<{ date: string; created: number; resolved: number }>;
  slaBreachTop: Array<{
    id: string;
    title: string;
    status: string;
    priority: string;
    assigneeName: string | null;
    waitingHours: number | null;
    createdAt: string | null;
  }>;
  lowCsatTop: Array<{
    id: string;
    title: string;
    status: string;
    csatRating: number | null;
    csatComment: string | null;
    assigneeName: string | null;
    resolvedAt: string | null;
  }>;
  assignees: Array<{
    assigneeId: string;
    assigneeName: string | null;
    open: number;
    awaitingReply: number;
    resolvedInWindow: number;
    avgFirstResponseHours: number | null;
    csatAverage: number | null;
    csatCount: number;
  }>;
}

/**
 * 分位计算：优先 `$percentile`（MongoDB 7+），失败时回退到「取样本数组在应用层算」。
 *
 * 为什么需要回退：`$percentile` 在老服务端上会让整条 pipeline 解析失败
 * （同 `$nin` 那类 `InvalidPipelineOperator`），面板会整块 500。
 * 回退路径把样本上限压到 5000 条，按 `$sort` 后取数组算线性插值分位 ——
 * 精度足够回答「P50 大概几小时」，且不会拖垮内存。
 */
const PERCENTILE_FALLBACK_SAMPLES = 5000;

async function computePercentiles(
  matchStage: Record<string, unknown>,
  hoursExpression: Record<string, unknown>,
  fractions: number[],
): Promise<{ samples: number; values: Array<number | null> }> {
  try {
    const rows = await TicketModel.aggregate([
      { $match: matchStage },
      { $project: { hours: hoursExpression } },
      { $match: { hours: { $gte: 0 } } },
      {
        $group: {
          _id: null,
          samples: { $sum: 1 },
          p: { $percentile: { input: "$hours", p: fractions, method: "approximate" } },
        },
      },
    ]).exec();
    const row = rows[0] as { samples?: number; p?: unknown } | undefined;
    return {
      samples: Number(row?.samples) || 0,
      values: fractions.map((_, index) => readPercentile(row, index)),
    };
  } catch {
    // 老服务端不认识 $percentile：降级成「样本在应用层排序后取分位」。
    const rows = await TicketModel.aggregate([
      { $match: matchStage },
      { $project: { hours: hoursExpression } },
      { $match: { hours: { $gte: 0 } } },
      { $sort: { hours: 1 } },
      { $limit: PERCENTILE_FALLBACK_SAMPLES },
      { $group: { _id: null, samples: { $sum: 1 }, values: { $push: "$hours" } } },
    ]).exec();
    const row = rows[0] as { samples?: number; values?: unknown } | undefined;
    const values = Array.isArray(row?.values)
      ? (row.values as unknown[]).filter((value): value is number => typeof value === "number" && Number.isFinite(value))
      : [];
    return {
      samples: Number(row?.samples) || values.length,
      values: values.length === 0 ? fractions.map(() => null) : fractions.map((fraction) => interpolate(values, fraction)),
    };
  }
}

/** 线性插值分位（与 `$percentile` 的 method:"approximate" 同量级精度）。输入需已升序。 */
function interpolate(sorted: number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const weight = position - lower;
  const value = sorted[lower]! + (sorted[upper]! - sorted[lower]!) * weight;
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function readPercentile(row: unknown, index: number): number | null {
  if (!row || typeof row !== "object") return null;
  const values = (row as { p?: unknown }).p;
  if (!Array.isArray(values)) return null;
  const value = values[index];
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) / 100 : null;
}

function toIso(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  return null;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100;
}

/** 只读聚合入口；`windowDays` 钳在 1..180（默认 30）。 */
export async function computeTicketInsights(options: { windowDays?: number } = {}): Promise<TicketInsights> {
  const windowDays = Math.min(Math.max(Math.floor(Number(options.windowDays) || 30), 1), 180);
  const now = new Date();
  const since = new Date(now.getTime() - windowDays * 24 * 3600 * 1000);
  const slaCutoff = new Date(now.getTime() - TICKET_SLA_HOURS * 3600 * 1000);
  const atRiskCutoff = new Date(now.getTime() - Math.floor(TICKET_SLA_HOURS * 0.75) * 3600 * 1000);

  const [firstResponseStats, resolutionStats, slaRows, csatRows, serviceAgg, categoryAgg, trendRows, facetRows, assigneeRows] =
    await Promise.all([
      computePercentiles(
        { firstResponseAt: { $ne: null }, createdAt: { $gte: since } },
        { $divide: [{ $subtract: ["$firstResponseAt", "$createdAt"] }, 3_600_000] },
        [0.5, 0.9, 0.95],
      ),
      computePercentiles(
        { resolvedAt: { $ne: null }, createdAt: { $gte: since } },
        { $divide: [{ $subtract: ["$resolvedAt", "$createdAt"] }, 3_600_000] },
        [0.5, 0.9, 0.95],
      ),
      TicketModel.aggregate([
        { $match: { status: { $ne: "closed" }, createdAt: { $gte: since } } },
        { $addFields: { tail: { $arrayElemAt: ["$messages", -1] } } },
        {
          $group: {
            _id: null,
            evaluated: { $sum: 1 },
            breached: {
              $sum: {
                $cond: [
                  { $and: [{ $eq: ["$tail.senderRole", "user"] }, { $lt: ["$tail.createdAt", slaCutoff] }] },
                  1,
                  0,
                ],
              },
            },
            atRisk: {
              $sum: {
                $cond: [
                  {
                    $and: [
                      { $eq: ["$tail.senderRole", "user"] },
                      { $gte: ["$tail.createdAt", slaCutoff] },
                      { $lt: ["$tail.createdAt", atRiskCutoff] },
                    ],
                  },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ]),
      TicketModel.aggregate([
        { $match: { csatRating: { $ne: null }, createdAt: { $gte: since } } },
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            avg: { $avg: "$csatRating" },
            low: { $sum: { $cond: [{ $lte: ["$csatRating", 2] }, 1, 0] } },
            r1: { $sum: { $cond: [{ $eq: ["$csatRating", 1] }, 1, 0] } },
            r2: { $sum: { $cond: [{ $eq: ["$csatRating", 2] }, 1, 0] } },
            r3: { $sum: { $cond: [{ $eq: ["$csatRating", 3] }, 1, 0] } },
            r4: { $sum: { $cond: [{ $eq: ["$csatRating", 4] }, 1, 0] } },
            r5: { $sum: { $cond: [{ $eq: ["$csatRating", 5] }, 1, 0] } },
          },
        },
      ]),
      TicketModel.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: "$relatedService", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      TicketModel.aggregate([
        { $match: { createdAt: { $gte: since } } },
        { $group: { _id: "$category", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),
      TicketModel.aggregate([
        { $match: { $or: [{ createdAt: { $gte: since } }, { resolvedAt: { $gte: since } }] } },
        {
          $project: {
            createdDay: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: "Asia/Shanghai" } },
            resolvedDay: {
              $cond: [
                { $and: [{ $ne: ["$resolvedAt", null] }, { $gte: ["$resolvedAt", since] }] },
                { $dateToString: { format: "%Y-%m-%d", date: "$resolvedAt", timezone: "Asia/Shanghai" } },
                null,
              ],
            },
          },
        },
        { $group: { _id: null, created: { $push: "$createdDay" }, resolved: { $push: "$resolvedDay" } } },
      ]),
      TicketModel.aggregate([
        {
          $facet: {
            slaBreachTop: [
              { $match: { status: { $ne: "closed" } } },
              { $addFields: { tail: { $arrayElemAt: ["$messages", -1] } } },
              { $match: { "tail.senderRole": "user", "tail.createdAt": { $lt: slaCutoff } } },
              { $sort: { "tail.createdAt": 1 } },
              { $limit: 10 },
              {
                $project: {
                  id: "$_id",
                  title: 1,
                  status: 1,
                  priority: 1,
                  assigneeName: 1,
                  waitingFrom: "$tail.createdAt",
                  createdAt: 1,
                },
              },
            ],
            lowCsatTop: [
              { $match: { csatRating: { $ne: null, $lte: 2 } } },
              { $sort: { resolvedAt: -1 } },
              { $limit: 10 },
              {
                $project: { id: "$_id", title: 1, status: 1, csatRating: 1, csatComment: 1, assigneeName: 1, resolvedAt: 1 },
              },
            ],
          },
        },
      ]),
      TicketModel.aggregate([
        { $match: { assigneeId: { $nin: [null, ""] } } },
        { $addFields: { tail: { $arrayElemAt: ["$messages", -1] } } },
        {
          $group: {
            _id: "$assigneeId",
            assigneeName: { $last: "$assigneeName" },
            // 聚合表达式里没有 `$nin`（那是查询操作符，服务端会回
            // "Unrecognized expression '$nin'"）；等价的写法是 $not + $in。
            open: { $sum: { $cond: [{ $not: [{ $in: ["$status", ["resolved", "closed"]] }] }, 1, 0] } },
            awaitingReply: {
              $sum: {
                $cond: [{ $and: [{ $ne: ["$status", "closed"] }, { $eq: ["$tail.senderRole", "user"] }] }, 1, 0],
              },
            },
            resolvedInWindow: {
              $sum: {
                $cond: [{ $and: [{ $ne: ["$resolvedAt", null] }, { $gte: ["$resolvedAt", since] }] }, 1, 0],
              },
            },
            firstResponseHours: {
              $push: {
                $cond: [
                  { $and: [{ $ne: ["$firstResponseAt", null] }, { $gte: ["$createdAt", since] }] },
                  { $divide: [{ $subtract: ["$firstResponseAt", "$createdAt"] }, 3_600_000] },
                  "$$REMOVE",
                ],
              },
            },
            csatRatings: {
              $push: {
                $cond: [
                  { $and: [{ $ne: ["$csatRating", null] }, { $gte: ["$createdAt", since] }] },
                  "$csatRating",
                  "$$REMOVE",
                ],
              },
            },
          },
        },
        { $sort: { open: -1, awaitingReply: -1 } },
        { $limit: 50 },
      ]),
    ]);

  const slaRow = (slaRows[0] || {}) as { evaluated?: number; breached?: number; atRisk?: number };
  const csatRow = (csatRows[0] || {}) as Record<string, number | undefined>;

  const asCounts = (rows: unknown[], fallback: string): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const raw of rows) {
      const row = raw as { _id?: unknown; count?: number };
      const key = typeof row._id === "string" && row._id ? row._id : fallback;
      out[key] = (out[key] || 0) + (row.count || 0);
    }
    return out;
  };

  const trendRaw = (trendRows[0] || {}) as { created?: unknown[]; resolved?: unknown[] };
  const createdCounts = new Map<string, number>();
  const resolvedCounts = new Map<string, number>();
  for (const day of Array.isArray(trendRaw.created) ? trendRaw.created : []) {
    if (typeof day === "string") createdCounts.set(day, (createdCounts.get(day) || 0) + 1);
  }
  for (const day of Array.isArray(trendRaw.resolved) ? trendRaw.resolved : []) {
    if (typeof day === "string") resolvedCounts.set(day, (resolvedCounts.get(day) || 0) + 1);
  }
  const trend: TicketInsights["trend"] = [];
  for (let index = windowDays - 1; index >= 0; index -= 1) {
    const day = new Date(now.getTime() - index * 24 * 3600 * 1000).toLocaleDateString("sv-SE", {
      timeZone: "Asia/Shanghai",
    });
    trend.push({ date: day, created: createdCounts.get(day) || 0, resolved: resolvedCounts.get(day) || 0 });
  }

  const facet = (facetRows[0] || {}) as {
    slaBreachTop?: Array<Record<string, unknown>>;
    lowCsatTop?: Array<Record<string, unknown>>;
  };

  const assignees = (assigneeRows as Array<Record<string, unknown>>).map((row) => {
    const hours = Array.isArray(row.firstResponseHours)
      ? (row.firstResponseHours as unknown[]).filter(
          (value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0,
        )
      : [];
    const ratings = Array.isArray(row.csatRatings)
      ? (row.csatRatings as unknown[]).filter((value): value is number => typeof value === "number" && Number.isFinite(value))
      : [];
    return {
      assigneeId: String(row._id ?? ""),
      assigneeName: typeof row.assigneeName === "string" ? row.assigneeName : null,
      open: Number(row.open) || 0,
      awaitingReply: Number(row.awaitingReply) || 0,
      resolvedInWindow: Number(row.resolvedInWindow) || 0,
      avgFirstResponseHours: average(hours),
      csatAverage:
        ratings.length > 0
          ? Math.round((ratings.reduce((sum, value) => sum + value, 0) / ratings.length) * 10) / 10
          : null,
      csatCount: ratings.length,
    };
  });

  return {
    windowDays,
    firstResponse: {
      p50Hours: firstResponseStats.values[0] ?? null,
      p90Hours: firstResponseStats.values[1] ?? null,
      p95Hours: firstResponseStats.values[2] ?? null,
      samples: firstResponseStats.samples,
    },
    resolution: {
      p50Hours: resolutionStats.values[0] ?? null,
      p90Hours: resolutionStats.values[1] ?? null,
      p95Hours: resolutionStats.values[2] ?? null,
      samples: resolutionStats.samples,
    },
    sla: {
      breached: Number(slaRow.breached) || 0,
      atRisk: Number(slaRow.atRisk) || 0,
      evaluated: Number(slaRow.evaluated) || 0,
      slaHours: TICKET_SLA_HOURS,
    },
    csat: {
      average: typeof csatRow.avg === "number" ? Math.round(csatRow.avg * 10) / 10 : null,
      count: Number(csatRow.count) || 0,
      low: Number(csatRow.low) || 0,
      distribution: {
        "1": Number(csatRow.r1) || 0,
        "2": Number(csatRow.r2) || 0,
        "3": Number(csatRow.r3) || 0,
        "4": Number(csatRow.r4) || 0,
        "5": Number(csatRow.r5) || 0,
      },
    },
    volumeByService: asCounts(serviceAgg as unknown[], "other"),
    volumeByCategory: asCounts(categoryAgg as unknown[], "other"),
    trend,
    slaBreachTop: (facet.slaBreachTop ?? []).map((row) => ({
      id: String(row.id ?? ""),
      title: String(row.title ?? ""),
      status: String(row.status ?? ""),
      priority: String(row.priority ?? ""),
      assigneeName: typeof row.assigneeName === "string" ? row.assigneeName : null,
      waitingHours:
        row.waitingFrom instanceof Date
          ? Math.round(((now.getTime() - row.waitingFrom.getTime()) / 3_600_000) * 100) / 100
          : null,
      createdAt: toIso(row.createdAt),
    })),
    lowCsatTop: (facet.lowCsatTop ?? []).map((row) => ({
      id: String(row.id ?? ""),
      title: String(row.title ?? ""),
      status: String(row.status ?? ""),
      csatRating: typeof row.csatRating === "number" ? row.csatRating : null,
      csatComment: typeof row.csatComment === "string" ? row.csatComment : null,
      assigneeName: typeof row.assigneeName === "string" ? row.assigneeName : null,
      resolvedAt: toIso(row.resolvedAt),
    })),
    assignees,
  };
}
