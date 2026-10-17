import crypto from "node:crypto";
import { ClientTelemetryEventModel, type IClientTelemetryEvent } from "../models/clientTelemetryModel";
import { mongoose } from "./mongoService";
import logger from "../utils/logger";

// 客户端遥测的写入与读取。写入路径必须对客户端数据保持不信任：
// 长度、枚举、URL、正则字符集全部在服务端重新收敛，Mongo 只接受收敛后的值。
//
// 与 audit log 的分工：审计记录「谁对哪个接口做了什么」，这里记录「浏览器/验证链路当时出了什么错」。
// 两者用同一个追踪码（服务端 requestId）串起来，管理员先查审计确认请求，再查这里看现场。

export const CLIENT_TELEMETRY_KINDS = [
  "console",
  "window-error",
  "unhandled-rejection",
  "resource",
  "security-policy",
  "network",
  "verification",
  "performance",
  "navigation",
  "lifecycle",
  "manual",
] as const;
export const CLIENT_TELEMETRY_LEVELS = ["error", "warn", "info", "debug"] as const;
export type ClientTelemetryKind = (typeof CLIENT_TELEMETRY_KINDS)[number];
export type ClientTelemetryLevel = (typeof CLIENT_TELEMETRY_LEVELS)[number];

export interface ClientTelemetryEventInput {
  kind?: unknown;
  level?: unknown;
  source?: unknown;
  message?: unknown;
  stack?: unknown;
  path?: unknown;
  traceId?: unknown;
  providerTraceId?: unknown;
  outcome?: unknown;
  context?: unknown;
  appVersion?: unknown;
  buildSha?: unknown;
  time?: unknown;
}

export interface ClientTelemetryReportMeta {
  userAgent?: string;
  ipAddress?: string;
  deviceId?: string;
  traceId?: string;
}

/** 单次上报的事件数上限：前端正常批量是 5～10 条，超量一律截断而不是拒绝整批。 */
export const MAX_EVENTS_PER_REPORT = 30;
const MAX_MESSAGE = 2_000;
const MAX_STACK = 8_000;
const MAX_CONTEXT_BYTES = 8 * 1024;
const DEDUPE_BUCKET_MS = 10 * 60_000;

const TRACE_ID_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/;
const PROVIDER_TRACE_PATTERN = /^[A-Za-z0-9-]{8,64}$/;
const VERSION_PATTERN = /^[A-Za-z0-9._+-]{0,40}$/;

/** 日志/遥测里不该出现的凭据形态：JWT、Bearer、常见云厂商 key、带 cookie 的赋值。 */
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, "[jwt]"],
  [/Bearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, "Bearer [redacted]"],
  [/\b(sk|pk|rk|re|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}/gi, "[secret]"],
  [/((?:password|passwd|secret|token|api[_-]?key|authorization|cookie)\s*[:=]\s*)["']?[^\s"',;]{4,}/gi, "$1[redacted]"],
  [/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, "[telegram-token]"],
];

export function redactTelemetryText(value: string, maxLength: number): string {
  let text = value;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text.slice(0, maxLength);
}

function sanitizeText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? redactTelemetryText(value.trim(), maxLength) : "";
}

/** 只接受路径本身：query 与 hash 既不进索引，也不该进遥测（可能带 token）。 */
export function sanitizeTelemetryPath(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "";
  const withoutQuery = raw.split(/[?#]/)[0] || "";
  const collapsed = withoutQuery.replace(/\/{2,}/g, "/").slice(0, 300);
  return collapsed.startsWith("/") ? collapsed : `/${collapsed}`;
}

function sanitizeContext(value: unknown, depth = 0): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 2) return {};
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!key || key.length > 60 || key.startsWith("$") || key.includes(".")) continue;
    if (/^(password|passwd|secret|token|authorization|cookie|credential|apikey|api_key)$/i.test(key)) continue;
    if (item === null || typeof item === "boolean" || typeof item === "number") {
      out[key] = item;
    } else if (typeof item === "string") {
      out[key] = redactTelemetryText(item, 300);
    } else if (Array.isArray(item)) {
      out[key] = item.slice(0, 10).map((entry) =>
        typeof entry === "string" ? redactTelemetryText(entry, 200) : typeof entry === "number" || typeof entry === "boolean" ? entry : null,
      );
    } else if (typeof item === "object") {
      const nested = sanitizeContext(item, depth + 1);
      if (Object.keys(nested).length > 0) out[key] = nested;
    }
  }
  let serialized = "";
  try {
    serialized = JSON.stringify(out);
  } catch {
    return {};
  }
  if (serialized.length > MAX_CONTEXT_BYTES) return {};
  return out;
}

function hashIdentity(value: unknown): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 32);
}

function normalizeKind(value: unknown): ClientTelemetryKind {
  return (CLIENT_TELEMETRY_KINDS as readonly string[]).includes(String(value))
    ? (String(value) as ClientTelemetryKind)
    : "console";
}

function normalizeLevel(value: unknown): ClientTelemetryLevel {
  return (CLIENT_TELEMETRY_LEVELS as readonly string[]).includes(String(value))
    ? (String(value) as ClientTelemetryLevel)
    : "error";
}

function bucketOf(date: Date): number {
  return Math.floor(date.getTime() / DEDUPE_BUCKET_MS);
}

function dedupeKeyFor(input: {
  kind: string;
  level: string;
  source: string;
  message: string;
  path: string;
  traceId: string;
  bucket: number;
}): string {
  return crypto
    .createHash("sha1")
    .update([input.kind, input.level, input.source, input.path, input.traceId, input.message.slice(0, 400), input.bucket].join("|"))
    .digest("hex")
    .slice(0, 40);
}

/**
 * 写入一批客户端事件。合并窗口内的重复项（$inc count），
 * 单条写入失败不影响其它条；整体失败只记日志，绝不把异常抛给客户端。
 */
export async function recordClientTelemetryEvents(
  events: unknown[],
  meta: ClientTelemetryReportMeta,
): Promise<{ accepted: number }> {
  if (mongoose.connection.readyState !== 1) return { accepted: 0 };
  const now = new Date();
  const userAgent = sanitizeText(meta.userAgent, 300);
  const deviceHash = hashIdentity(meta.deviceId);
  const ipHash = hashIdentity(meta.ipAddress);
  const fallbackTraceId = typeof meta.traceId === "string" && TRACE_ID_PATTERN.test(meta.traceId) ? meta.traceId : "";

  // 逐条收敛再收集：用显式循环而不是 map + 类型谓词过滤，
  // 后者在 strict 下会把「对象字面量 | null」的联合类型判成谓词不可赋值（TS2677）。
  const sanitized: IClientTelemetryEvent[] = [];
  for (const raw of events.slice(0, MAX_EVENTS_PER_REPORT)) {
    const event = (raw && typeof raw === "object" ? raw : {}) as ClientTelemetryEventInput;
    const kind = normalizeKind(event.kind);
    const level = normalizeLevel(event.level);
    const source = sanitizeText(event.source, 120);
    const message = sanitizeText(event.message, MAX_MESSAGE);
    const stack = sanitizeText(event.stack, MAX_STACK);
    const path = sanitizeTelemetryPath(event.path);
    const rawTraceId = typeof event.traceId === "string" && TRACE_ID_PATTERN.test(event.traceId)
      ? event.traceId
      : fallbackTraceId;
    const providerTraceId = typeof event.providerTraceId === "string" && PROVIDER_TRACE_PATTERN.test(event.providerTraceId)
      ? event.providerTraceId
      : "";
    const outcome = sanitizeText(event.outcome, 120);
    // 完全空的事件没有诊断价值，直接丢弃（避免客户端发空数组刷额度）。
    if (!message && !stack && !outcome) continue;
    sanitized.push({
      eventId: crypto.randomUUID(),
      dedupeKey: dedupeKeyFor({ kind, level, source, message, path, traceId: rawTraceId, bucket: bucketOf(now) }),
      kind,
      level,
      source,
      message,
      stack,
      path,
      traceId: rawTraceId,
      providerTraceId,
      outcome,
      context: sanitizeContext(event.context),
      appVersion: typeof event.appVersion === "string" && VERSION_PATTERN.test(event.appVersion) ? event.appVersion : "",
      buildSha: typeof event.buildSha === "string" && VERSION_PATTERN.test(event.buildSha) ? event.buildSha : "",
      userAgent,
      deviceHash,
      ipHash,
      count: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      receivedAt: now,
    });
  }

  if (sanitized.length === 0) return { accepted: 0 };

  // 同一批里的重复项（不同 trace 除外）也要先合并，避免 unique 索引在 bulkWrite 内部互相冲突。
  const merged = new Map<string, IClientTelemetryEvent>();
  for (const entry of sanitized) {
    const existing = merged.get(entry.dedupeKey);
    if (existing) {
      existing.count += 1;
      existing.lastSeenAt = entry.lastSeenAt;
    } else {
      merged.set(entry.dedupeKey, entry);
    }
  }

  try {
    await ClientTelemetryEventModel.bulkWrite(
      [...merged.values()].map((entry) => ({
        updateOne: {
          filter: { dedupeKey: entry.dedupeKey },
          update: {
            // count / lastSeenAt 不能同时出现在 $setOnInsert 与 $set/$inc 里（Mongo 会判路径冲突），
            // 因此插入时由 $inc / $set 各自写入：新文档 count 从 0 加到本批合并数。
            $setOnInsert: {
              eventId: entry.eventId,
              dedupeKey: entry.dedupeKey,
              kind: entry.kind,
              level: entry.level,
              source: entry.source,
              message: entry.message,
              stack: entry.stack,
              path: entry.path,
              traceId: entry.traceId,
              providerTraceId: entry.providerTraceId,
              outcome: entry.outcome,
              context: entry.context,
              appVersion: entry.appVersion,
              buildSha: entry.buildSha,
              userAgent: entry.userAgent,
              deviceHash: entry.deviceHash,
              ipHash: entry.ipHash,
              firstSeenAt: entry.firstSeenAt,
              receivedAt: entry.receivedAt,
            },
            $set: { lastSeenAt: entry.lastSeenAt },
            $inc: { count: entry.count },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    );
    return { accepted: sanitized.length };
  } catch (error) {
    logger.warn("[ClientTelemetry] 写入遥测事件失败", {
      count: sanitized.length,
      errorType: error instanceof Error ? error.name : "unknown",
    });
    return { accepted: 0 };
  }
}

/** 记录一条服务端产生的事件（首访验证结果），与浏览器事件同表、同追踪码。 */
export async function recordServerTelemetryEvent(input: {
  kind?: ClientTelemetryKind;
  level?: ClientTelemetryLevel;
  source: string;
  message: string;
  outcome?: string;
  traceId?: string;
  providerTraceId?: string;
  path?: string;
  context?: Record<string, unknown>;
  deviceId?: string;
  ipAddress?: string;
  userAgent?: string;
}): Promise<void> {
  if (process.env.CLIENT_TELEMETRY_ENABLED === "false") return;
  try {
    await recordClientTelemetryEvents(
      [{
        kind: input.kind ?? "verification",
        level: input.level ?? "info",
        source: input.source,
        message: input.message,
        outcome: input.outcome,
        traceId: input.traceId,
        providerTraceId: input.providerTraceId,
        path: input.path,
        context: input.context,
      }],
      {
        userAgent: input.userAgent,
        ipAddress: input.ipAddress,
        deviceId: input.deviceId,
        traceId: input.traceId,
      },
    );
  } catch {
    // 遥测永远不能影响验证主流程。
  }
}

export interface ClientTelemetryQuery {
  traceId?: string;
  kind?: string;
  level?: string;
  path?: string;
  keyword?: string;
  since?: string;
  until?: string;
  page?: number;
  pageSize?: number;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function queryClientTelemetry(params: ClientTelemetryQuery) {
  const page = Math.max(1, Math.trunc(Number(params.page) || 1));
  const pageSize = Math.min(100, Math.max(1, Math.trunc(Number(params.pageSize) || 30)));
  const filter: Record<string, unknown> = {};

  if (typeof params.traceId === "string" && TRACE_ID_PATTERN.test(params.traceId.trim())) {
    filter.traceId = params.traceId.trim();
  }
  if ((CLIENT_TELEMETRY_KINDS as readonly string[]).includes(String(params.kind))) filter.kind = params.kind;
  if ((CLIENT_TELEMETRY_LEVELS as readonly string[]).includes(String(params.level))) filter.level = params.level;
  if (typeof params.path === "string" && params.path.trim()) {
    filter.path = sanitizeTelemetryPath(params.path);
  }
  if (typeof params.keyword === "string" && params.keyword.trim()) {
    const keyword = params.keyword.trim().slice(0, 80);
    filter.$or = [
      { message: { $regex: escapeRegex(keyword), $options: "i" } },
      { source: { $regex: escapeRegex(keyword), $options: "i" } },
      { outcome: { $regex: escapeRegex(keyword), $options: "i" } },
    ];
  }
  const since = params.since ? new Date(params.since) : null;
  const until = params.until ? new Date(params.until) : null;
  if (since && !Number.isNaN(since.getTime())) filter.receivedAt = { ...(filter.receivedAt as object), $gte: since };
  if (until && !Number.isNaN(until.getTime())) filter.receivedAt = { ...(filter.receivedAt as object), $lte: until };

  const [total, items] = await Promise.all([
    ClientTelemetryEventModel.countDocuments(filter),
    ClientTelemetryEventModel.find(filter)
      .sort({ receivedAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean(),
  ]);
  return { total, page, pageSize, items };
}

export async function getClientTelemetryStats() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [total, byKind, byLevel, topPaths] = await Promise.all([
    ClientTelemetryEventModel.countDocuments({ receivedAt: { $gte: since } }),
    ClientTelemetryEventModel.aggregate<{ _id: string; count: number }>([
      { $match: { receivedAt: { $gte: since } } },
      { $group: { _id: "$kind", count: { $sum: "$count" } } },
      { $sort: { count: -1 } },
    ]),
    ClientTelemetryEventModel.aggregate<{ _id: string; count: number }>([
      { $match: { receivedAt: { $gte: since } } },
      { $group: { _id: "$level", count: { $sum: "$count" } } },
    ]),
    ClientTelemetryEventModel.aggregate<{ _id: string; count: number }>([
      { $match: { receivedAt: { $gte: since }, kind: { $ne: "verification" } } },
      { $group: { _id: "$path", count: { $sum: "$count" } } },
      { $sort: { count: -1 } },
      { $limit: 10 },
    ]),
  ]);
  return {
    windowHours: 24,
    total,
    byKind: Object.fromEntries(byKind.map((entry) => [String(entry._id ?? "unknown"), Number(entry.count ?? 0)])),
    byLevel: Object.fromEntries(byLevel.map((entry) => [String(entry._id ?? "unknown"), Number(entry.count ?? 0)])),
    topPaths: topPaths.map((entry) => ({ path: String(entry._id ?? ""), count: Number(entry.count ?? 0) })),
  };
}

/** 按追踪码一次取回「验证链路 + 浏览器报错」，这是管理员复盘的主要入口。 */
export async function getClientTraceReplay(traceId: string) {
  if (!TRACE_ID_PATTERN.test(traceId)) return null;
  const items = await ClientTelemetryEventModel.find({ traceId })
    .sort({ receivedAt: -1 })
    .limit(100)
    .lean();
  const verification = items.filter((item) => item.kind === "verification");
  const browser = items.filter((item) => item.kind !== "verification");
  return {
    traceId,
    found: items.length > 0,
    verification,
    browser,
    providerTraceIds: [...new Set(items.map((item) => item.providerTraceId).filter(Boolean))],
  };
}
