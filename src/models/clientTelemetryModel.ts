import { mongoose } from "../services/mongoService";

/**
 * 客户端遥测事件（前端控制台报错 / 未捕获异常 / 首访验证结果）。
 *
 * 为什么单独一张表、而不是塞进 data_collections 或 crash_reports：
 *  - `data_collections` 是外部脚本的通用收集箱，没有 traceId 索引，按「问题追踪码」复盘会变成全表扫描；
 *  - `crash_reports` 归属 lumen-crash-core（安卓 SDK），字段是 Java 栈与进程信息，语义不同。
 * 这里只回答一个问题：**用户报给管理员的追踪码，对应那一刻浏览器与验证链路发生了什么**。
 *
 * 隐私口径：
 *  - 不存原始 IP / 设备指纹，只存 sha256 短摘要（可关联、不可回放）；
 *  - 不存请求体、query、cookie、localStorage；
 *  - 栈与消息有长度上限，服务端写入前再脱敏一次（不信任客户端）。
 */
export interface IClientTelemetryEvent {
  eventId: string;
  /** 10 分钟桶 + 内容摘要：同一页面同一错误在窗口内合并计数，避免刷爆写入 */
  dedupeKey: string;
  kind:
    | "console"
    | "window-error"
    | "unhandled-rejection"
    | "resource"
    | "security-policy"
    | "network"
    | "verification"
    | "performance"
    | "navigation"
    | "lifecycle"
    | "manual";
  level: "error" | "warn" | "info" | "debug";
  source: string;
  message: string;
  stack: string;
  /** 发生页面的 pathname（已去掉 query 与 hash） */
  path: string;
  /** 用户看到/报给管理员的问题追踪码（服务端 requestId） */
  traceId: string;
  /** 人机验证供应商自己的溯源 id（24 位 hex），用于跳到 shc_traces 看评分明细 */
  providerTraceId: string;
  /** 一次验证的结果：success / 失败 reason / 签发方式 / 是否封禁 */
  outcome: string;
  /** 结构化补充信息（已脱敏、已限长） */
  context: Record<string, unknown>;
  appVersion: string;
  buildSha: string;
  userAgent: string;
  deviceHash: string;
  ipHash: string;
  count: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  receivedAt: Date;
}

const ClientTelemetryEventSchema = new mongoose.Schema<IClientTelemetryEvent>(
  {
    eventId: { type: String, required: true, maxlength: 80 },
    dedupeKey: { type: String, required: true, maxlength: 80 },
    kind: {
      type: String,
      required: true,
      enum: [
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
      ],
      index: true,
    },
    level: { type: String, required: true, enum: ["error", "warn", "info", "debug"], index: true },
    source: { type: String, default: "", maxlength: 120 },
    message: { type: String, default: "", maxlength: 2_000 },
    stack: { type: String, default: "", maxlength: 8_000 },
    path: { type: String, default: "", maxlength: 300 },
    traceId: { type: String, default: "", maxlength: 128 },
    providerTraceId: { type: String, default: "", maxlength: 64 },
    outcome: { type: String, default: "", maxlength: 120 },
    context: { type: Object, default: {} },
    appVersion: { type: String, default: "", maxlength: 40 },
    buildSha: { type: String, default: "", maxlength: 40 },
    userAgent: { type: String, default: "", maxlength: 300 },
    deviceHash: { type: String, default: "", maxlength: 64 },
    ipHash: { type: String, default: "", maxlength: 64 },
    count: { type: Number, default: 1, min: 1 },
    firstSeenAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
    // TTL 锚点必须是 Date；同时保留 receivedAt 便于管理端按时间排序。
    receivedAt: { type: Date, required: true },
  },
  { collection: "client_telemetry_events", versionKey: false },
);

// 主查询形状：先按追踪码，再按时间倒序。
ClientTelemetryEventSchema.index({ traceId: 1, receivedAt: -1 });
ClientTelemetryEventSchema.index({ receivedAt: -1 });
ClientTelemetryEventSchema.index({ kind: 1, level: 1, receivedAt: -1 });
ClientTelemetryEventSchema.index({ path: 1, receivedAt: -1 });
// 摄取端的幂等键：同一 10 分钟窗口内的同一错误只写一条，后续只 $inc count。
ClientTelemetryEventSchema.index({ dedupeKey: 1 }, { unique: true });
// 与 crash_reports / audit log 一致的留存口径：30 天后自动清理（运维诊断数据，不含同意/审计结论）。
ClientTelemetryEventSchema.index({ receivedAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

export const ClientTelemetryEventModel =
  (mongoose.models.ClientTelemetryEvent as mongoose.Model<IClientTelemetryEvent>) ||
  mongoose.model<IClientTelemetryEvent>("ClientTelemetryEvent", ClientTelemetryEventSchema);
