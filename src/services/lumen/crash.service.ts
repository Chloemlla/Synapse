import crypto from "node:crypto";
import { lumenTtlExpireAt } from "../../config/lumenRetention.js";
import { CrashReport, AdminCrashReport } from "../../models/lumen/index.js";
import { ApiError } from "./errors.js";

// ── Constants ───────────────────────────────────────────────────────────
const MAX_CRASHES_PER_HOUR = 20;
const CRASH_WINDOW_MS = 60 * 60 * 1000;

/**
 * 净化「不透明标识」型入参（reportId / 安装 ID）：允许 UUID/十六进制/常见的 `.-_:@+` 分隔符，
 * 限长、去掉控制字符与空白。返回空串表示形状不合法，调用方应 400。
 */
function normalizeOpaqueId(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (!/^[A-Za-z0-9._:@+-]+$/.test(trimmed)) return "";
  return trimmed.slice(0, maxLength);
}
const STACK_LINES = 12;
const LINE_MAX_LENGTH = 200;
const MAX_STACK_TRACE_CHARS = 64 * 1024;
const MAX_SYSTEM_INFO_CHARS = 8 * 1024;
const MAX_RECENT_EVENTS = 20;
const MAX_RECENT_EVENT_CHARS = 512;
const MAX_DEVICES_PER_GROUP = 10000;

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Record a crash report.
 *
 * Validates deviceInstallationId and reportId, enforces a 20/hour rate limit,
 * checks idempotency by userId+reportId, computes a groupKey from the clean
 * stack trace, persists the full report losslessly, and updates the
 * AdminCrashReport aggregation.
 */
export async function recordCrashReport(
  userId: string,
  request: {
    deviceInstallationId?: string;
    reportId?: string;
    packageName?: string;
    versionCode?: number;
    crashedAtMillis?: number;
    crashedAtText?: string;
    exceptionType?: string;
    rootCause?: string;
    threadName?: string;
    processName?: string;
    systemInfo?: string;
    stackTrace?: string;
    recentEvents?: string[];
    kind?: string;
    durationMillis?: number;
    authorName?: string;
    authorUrl?: string;
    authorFingerprint?: string;
  },
) {
  // ── Validate required fields ──────────────────────────────────────────
  if (!request.deviceInstallationId || typeof request.deviceInstallationId !== "string") {
    throw ApiError.badRequest("deviceInstallationId is required");
  }
  if (!request.reportId || typeof request.reportId !== "string") {
    throw ApiError.badRequest("reportId is required");
  }

  // 入口处**一次性净化**成“形状确定的本地常量”，后续所有查询只用它：
  // 这类值会被当成 Mongo 查询值（甚至拼进聚合管道），固定形状后静态扫描与人工审阅都好判，
  // 也顺手挡掉超长/控制字符把查询对象撑大的浪费。允许 UUID / 十六进制 / 常见的 `.-_:@+` 分隔符。
  const reportId = normalizeOpaqueId(request.reportId, 200);
  if (!reportId) {
    throw ApiError.badRequest("reportId must be a 1-200 char opaque id");
  }

  // Retries of an already accepted report do not consume the new-report quota.
  const existing = await CrashReport.findOne({ userId: { $eq: userId }, reportId: { $eq: reportId } })
    .select({ receivedAt: 1 })
    .lean()
    .exec();
  if (existing) {
    return { accepted: true, id: reportId, duplicate: true, receivedAt: existing.receivedAt };
  }

  // ── Rate limit: 20 per hour per user ──────────────────────────────────
  // G7-26: keyed on userId (server-authenticated), not the client-supplied
  // deviceInstallationId which a client could rotate to reset the window.
  const windowStart = Date.now() - CRASH_WINDOW_MS;
  const recentCount = await CrashReport.countDocuments({
    userId,
    receivedAt: { $gte: windowStart },
  }).exec();

  if (recentCount >= MAX_CRASHES_PER_HOUR) {
    throw ApiError.tooManyRequests("Crash report rate limit exceeded (20/hour)");
  }

  // ── Compute groupKey from clean stack ─────────────────────────────────
  const stackTrace = request.stackTrace || "";
  const nonBlankLines = stackTrace
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const cleanStackLines = nonBlankLines
    .slice(0, STACK_LINES)
    .map((l) => l.slice(0, LINE_MAX_LENGTH));
  const cleanStackJoined = cleanStackLines.join("\n").toLowerCase();
  // versionCode 来自客户端 JSON，可能是对象/数组等查询操作符，必须先归一化为有限整数
  const versionCode = Number.isFinite(Number(request.versionCode))
    ? Math.trunc(Number(request.versionCode))
    : 0;
  const groupKey = crypto
    .createHash("sha256")
    .update(cleanStackJoined + "|" + versionCode)
    .digest("hex");

  const now = Date.now();

  // G7-26: hard limits on unbounded client fields — a single crash report must
  // not be able to approach the 16MB BSON limit. Truncate rather than reject so
  // the crash is still ingested for triage.
  const persistedStackTrace = (request.stackTrace || "").slice(0, MAX_STACK_TRACE_CHARS);
  const systemInfo = (request.systemInfo || "").slice(0, MAX_SYSTEM_INFO_CHARS);
  const recentEvents = (request.recentEvents ?? [])
    .filter((e): e is string => typeof e === "string")
    .slice(0, MAX_RECENT_EVENTS)
    .map((e) => e.slice(0, MAX_RECENT_EVENT_CHARS));

  // ── Persist the crash report ──────────────────────────────────────────
  let duplicateReceivedAt: number | undefined;
  await CrashReport.create({
    _id: `crash_${crypto.createHash("sha256").update(JSON.stringify([userId, request.reportId])).digest("hex")}`,
    userId,
    deviceInstallationId: request.deviceInstallationId,
    reportId: request.reportId,
    packageName: request.packageName ?? "",
    versionCode,
    crashedAtMillis: request.crashedAtMillis ?? 0,
    crashedAtText: request.crashedAtText ?? "",
    exceptionType: request.exceptionType ?? "",
    rootCause: request.rootCause ?? "",
    threadName: request.threadName ?? "",
    processName: request.processName ?? "",
    systemInfo,
    stackTrace: persistedStackTrace,
    recentEvents,
    kind: request.kind ?? "crash",
    durationMillis: request.durationMillis ?? 0,
    authorName: request.authorName ?? "",
    authorUrl: request.authorUrl ?? "",
    authorFingerprint: request.authorFingerprint ?? "",
    groupKey,
    cleanStack: cleanStackLines,
    receivedAt: now,
    ttlExpireAt: lumenTtlExpireAt("crashReport", now),
  }).catch(async (error: unknown) => {
    if ((error as { code?: number })?.code !== 11000) throw error;
    // reportId 已在入口按 `typeof !== "string"` 强制为字符串（见本文件上的输入校验），
    // 对象形态（如 {$ne: null}）在到达此处前已 400；仍额外限定 userId，不可能跨用户取文档。
    // reportId 已在入口净化成形状固定的本地常量（normalizeOpaqueId）且额外限定 userId；
    // 这里用显式 $eq 再强调一次“这是等值过滤值，不是操作符”。
    const winner = await CrashReport.findOne({ userId: { $eq: userId }, reportId: { $eq: reportId } })
      .select({ receivedAt: 1 }).lean().exec();
    if (!winner) throw error;
    duplicateReceivedAt = winner.receivedAt;
  });
  if (duplicateReceivedAt !== undefined) {
    return { accepted: true, id: request.reportId, duplicate: true, receivedAt: duplicateReceivedAt };
  }

  // ── Update AdminCrashReport aggregation ───────────────────────────────
  const groupTtlExpireAt = lumenTtlExpireAt("adminCrashReport", now);
  // G7-27: the `devices` array must not grow without bound (a single document
  // could hit the 16MB cap and stop aggregating). Cap it, and read back only
  // the fields needed for risk computation instead of the whole document.
  const updated = await AdminCrashReport.findOneAndUpdate(
    { groupKey: { $eq: groupKey }, versionCode: { $eq: versionCode } },
    [
      {
        $set: {
          count: { $add: [{ $ifNull: ["$count", 0] }, 1] },
          devices: {
            $cond: [
              { $lt: [{ $size: { $ifNull: ["$devices", []] } }, MAX_DEVICES_PER_GROUP] },
              { $setUnion: [{ $ifNull: ["$devices", []] }, [request.deviceInstallationId]] },
              { $ifNull: ["$devices", []] },
            ],
          },
          groupKey,
          versionCode,
          cleanStack: cleanStackLines,
          lastSeenAt: now,
          // Refreshed on every ingest, so an actively crashing group keeps outliving its TTL.
          ...(groupTtlExpireAt ? { ttlExpireAt: groupTtlExpireAt } : {}),
        },
      },
    ] as any,
    { upsert: true, new: true, projection: { _id: 1, devices: 1, count: 1 }, updatePipeline: true },
  ).exec();

  const affectedUsers = updated!.devices.length;
  const count = updated!.count;
  let risk = "low";
  if (count >= 50 || affectedUsers >= 20) risk = "high";
  else if (count >= 10 || affectedUsers >= 5) risk = "medium";

  // Persist the derived fields. (The findOneAndUpdate above only projected
  // _id/devices/count, so the risk/affectedUsers update is issued unconditionally.)
  await AdminCrashReport.updateOne(
    { _id: updated!._id },
    { $set: { affectedUsers, risk } },
  ).exec();

  return {
    accepted: true,
    id: request.reportId,
    duplicate: false,
    receivedAt: now,
  };
}
