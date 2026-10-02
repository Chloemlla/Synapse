import type { IncomingHttpHeaders } from "node:http";
import mongoose, { Schema } from "mongoose";
import { escapeRegexLiteral } from "../utils/regexEscape";

// WebhookEvent document interface
interface WebhookEventDoc {
  provider?: string;
  routeKey?: string;
  eventId?: string;
  type: string;
  title?: string;
  content?: string;
  renderedContent?: string;
  created_at?: Date;
  to?: any;
  subject?: string;
  status?: string;
  data?: any;
  raw?: any;
  receivedAt: Date;
  updatedAt: Date;
  /** WH-1：同一事件被重复投递的次数（Svix 重试会自增）。首次插入为 1。 */
  deliveryCount?: number;
  /** 首次到达时间（重投不覆盖）。 */
  firstReceivedAt?: Date;
  /** 最近一次投递时间。 */
  lastReceivedAt?: Date;
}

const WebhookEventSchema = new Schema<WebhookEventDoc>(
  {
    provider: { type: String, default: "resend" },
    routeKey: { type: String },
    eventId: { type: String },
    type: { type: String, required: true },
    title: { type: String },
    content: { type: String },
    renderedContent: { type: String },
    created_at: { type: Date },
    to: { type: Schema.Types.Mixed },
    subject: { type: String },
    status: { type: String },
    data: { type: Schema.Types.Mixed },
    raw: { type: Schema.Types.Mixed },
    receivedAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
    deliveryCount: { type: Number, default: 1 },
    firstReceivedAt: { type: Date },
    lastReceivedAt: { type: Date },
  },
  { collection: "webhook_events" },
);

// WH-1：幂等键。不设 unique：历史集合可能已有重复 (provider,routeKey,eventId)，
// 建唯一索引会失败；写入走 upsert，并且只依赖 eventId 存在时才做去重。
WebhookEventSchema.index({ provider: 1, routeKey: 1, eventId: 1 }, { unique: false });
WebhookEventSchema.index({ routeKey: 1, receivedAt: -1 });
WebhookEventSchema.index({ type: 1, status: 1, receivedAt: -1 });
WebhookEventSchema.pre("save", function (this: WebhookEventDoc) {
  this.updatedAt = new Date();
});

export const WebhookEventModel = mongoose.models.WebhookEvent || mongoose.model("WebhookEvent", WebhookEventSchema);

const WEBHOOK_EVENT_FIELDS = new Set([
  "provider",
  "routeKey",
  "eventId",
  "type",
  "title",
  "content",
  "renderedContent",
  "created_at",
  "to",
  "subject",
  "status",
  "data",
  "raw",
  "receivedAt",
  "updatedAt",
  "deliveryCount",
  "firstReceivedAt",
  "lastReceivedAt",
]);

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeRouteKey(value: unknown): string | undefined {
  const trimmed = asString(value);
  if (!trimmed || trimmed === "null") return undefined;
  return trimmed;
}

// 关键词当字面量（统一实现见 utils/regexEscape）。
const escapeRegex = escapeRegexLiteral;

function toPlain<T = any>(doc: any): T {
  if (doc && typeof doc.toObject === "function") {
    return doc.toObject();
  }
  return doc;
}

function parseWebhookDate(value: unknown): Date | undefined {
  if (value == null || value === "") return undefined;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;
  if (typeof value === "number") {
    const date = new Date(value < 1e12 ? value * 1000 : value);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const numeric = Number(trimmed);
    const date = Number.isFinite(numeric)
      ? new Date(numeric < 1e12 ? numeric * 1000 : numeric)
      : new Date(trimmed);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  return undefined;
}

function sanitizeEventDocument(input: any, { partial = false }: { partial?: boolean } = {}) {
  const safe: any = {};
  if (input && typeof input === "object") {
    for (const [key, value] of Object.entries(input)) {
      if (!WEBHOOK_EVENT_FIELDS.has(key)) continue;
      if ((key === "created_at" || key === "receivedAt" || key === "updatedAt") && value) {
        const date = parseWebhookDate(value);
        if (date) safe[key] = date;
        continue;
      }
      if (key === "routeKey") {
        safe.routeKey = normalizeRouteKey(value) ?? null;
        continue;
      }
      safe[key] = value;
    }
  }

  if (!partial) {
    safe.type = asString(safe.type) || "manual";
    safe.provider = asString(safe.provider) || "manual";
    if (!safe.receivedAt) safe.receivedAt = new Date();
  }
  if (safe.type != null) safe.type = String(safe.type).trim() || (partial ? undefined : "manual");
  if (safe.provider != null) safe.provider = String(safe.provider).trim() || (partial ? undefined : "manual");
  if (safe.eventId != null) safe.eventId = String(safe.eventId).trim() || undefined;
  if (safe.status != null) safe.status = String(safe.status).trim() || undefined;
  return safe;
}

/**
 * 将 content 中的 {{value}} 占位符按顺序替换为 values 数组中的值。
 */
export function renderWebhookContent(content: string, values?: any[]): string {
  if (!content || !Array.isArray(values) || values.length === 0) return content || "";
  let index = 0;
  return content.replace(/\{\{value\}\}/g, () => {
    if (index < values.length) {
      return String(values[index++]);
    }
    return "{{value}}";
  });
}

export function normalizeGenericWebhookEvent(body: any, source?: string) {
  const payload = body && typeof body === "object" ? body : { raw: body };
  const type = asString(payload.type) || asString(payload.event) || asString(payload.action) || "generic";
  const eventId = asString(payload.id) || asString(payload.event_id) || asString(payload.eventId);
  const title = asString(payload.title);
  const content = asString(payload.content);
  const values = Array.isArray(payload.values) ? payload.values : undefined;
  const renderedContent = content ? renderWebhookContent(content, values) : undefined;
  const createdAt = parseWebhookDate(payload.created_at ?? payload.timestamp);
  const routeKey = normalizeRouteKey(source);

  return sanitizeEventDocument({
    provider: routeKey || "generic",
    routeKey,
    eventId,
    type,
    title,
    content,
    renderedContent,
    created_at: createdAt,
    to: payload.to || payload.recipient || payload.email || undefined,
    subject: title || payload.subject || payload.message || undefined,
    status: payload.status || "received",
    data: payload,
    raw: payload,
  });
}

// 存储 Resend/Webhook 密钥的集合（优先从 DB 读取，回退到环境变量）
const WebhookSecretSchema = new Schema(
  {
    provider: { type: String, default: "resend" }, // 预留多提供商
    key: { type: String, default: "DEFAULT" }, // 路由后缀（大写），默认 DEFAULT
    secret: { type: String, required: true }, // 可为 base64 或明文
    updatedAt: { type: Date, default: Date.now },
  },
  { collection: "webhook_settings" },
);
WebhookSecretSchema.index({ provider: 1, key: 1 }, { unique: true });
export const WebhookSecretModel = mongoose.models.WebhookSecret || mongoose.model("WebhookSecret", WebhookSecretSchema);

async function getResendSecretFromDb(routeKey?: string): Promise<string | null> {
  if (mongoose.connection.readyState !== 1) return null;
  const key = (routeKey ? String(routeKey).trim().toUpperCase() : "DEFAULT") || "DEFAULT";
  const candidates = key === "DEFAULT" ? ["DEFAULT"] : [key, "DEFAULT"];
  for (const k of candidates) {
    const doc = await WebhookSecretModel.findOne({ provider: "resend", key: k }).lean();
    if (doc && typeof (doc as any).secret === "string" && (doc as any).secret.trim()) {
      return (doc as any).secret.trim();
    }
  }
  return null;
}

export const WebhookEventService = {
  async create(doc: any) {
    const created = await WebhookEventModel.create(sanitizeEventDocument(doc));
    // Handle both single document and array of documents
    if (Array.isArray(created)) {
      return created.map((item) => toPlain(item));
    }
    return toPlain(created);
  },
  async createGeneric(source: string | undefined, body: any, overrides: any = {}) {
    const event = normalizeGenericWebhookEvent(body, source);
    return this.create({ ...event, ...sanitizeEventDocument(overrides, { partial: true }) });
  },
  /**
   * WH-1：幂等写入。`eventId` 存在时按 (provider, routeKey, eventId) upsert，重复投递
   * 只累加 `deliveryCount` 并刷新 `lastReceivedAt`，不再造新记录；`eventId` 缺失时退化为普通插入。
   * 返回 `duplicate` 供 HTTP 层区分「新事件」与「重投」。
   */
  async ingest(doc: any): Promise<{ item: any; duplicate: boolean }> {
    const safe = sanitizeEventDocument(doc);
    const eventId = asString(safe.eventId);
    if (!eventId) {
      const created = await this.create(doc);
      return { item: created, duplicate: false };
    }

    const now = safe.receivedAt instanceof Date ? safe.receivedAt : new Date();
    const provider = asString(safe.provider) || "resend";
    const routeKey = normalizeRouteKey(safe.routeKey) ?? null;
    // any：FilterQuery 的映射类型不接受 Record 索引签名，宽筛选对象只能走 any。
    const filter: any = { provider, routeKey, eventId };

    const updated = await WebhookEventModel.findOneAndUpdate(
      filter,
      {
        // 首次插入写全量字段；重复投递只刷新时间戳与状态，保留首次到达时间。
        $setOnInsert: { ...safe, provider, routeKey, eventId, receivedAt: now, firstReceivedAt: now },
        $set: {
          lastReceivedAt: now,
          updatedAt: now,
          ...(safe.status ? { status: safe.status } : {}),
        },
        $inc: { deliveryCount: 1 },
      },
      { upsert: true, returnDocument: "after" },
    ).lean();

    const deliveryCount = Number((updated as any)?.deliveryCount) || 1;
    return { item: updated, duplicate: deliveryCount > 1 };
  },

  async list({
    page = 1,
    pageSize = 20,
    routeKey,
    provider,
    eventId,
    type,
    status,
    q,
    receivedFrom,
    receivedTo,
  }: {
    page?: number;
    pageSize?: number;
    routeKey?: string | null;
    provider?: string;
    eventId?: string;
    type?: string;
    status?: string;
    q?: string;
    receivedFrom?: string;
    receivedTo?: string;
  }) {
    // Normalize and cap pagination to prevent abuse.
    // WH-6：page 也要封顶——无上限的深分页会让 skip 随页码线性变贵。
    const p = Number.isFinite(Number(page)) ? Math.min(1000, Math.max(1, Number(page))) : 1;
    const ps = Number.isFinite(Number(pageSize)) ? Math.min(100, Math.max(1, Number(pageSize))) : 20;
    const skip = (p - 1) * ps;

    const query: any = {};
    if (typeof routeKey === "string") query.routeKey = routeKey;
    if (routeKey === null) query.routeKey = { $in: [null, undefined] };
    if (typeof provider === "string" && provider) query.provider = provider;
    if (typeof eventId === "string" && eventId) query.eventId = eventId;
    if (typeof type === "string" && type) query.type = type;
    if (typeof status === "string" && status) query.status = status;
    const receivedAt: any = {};
    const fromDate = parseWebhookDate(receivedFrom);
    const toDate = parseWebhookDate(receivedTo);
    if (fromDate) receivedAt.$gte = fromDate;
    if (toDate) receivedAt.$lte = toDate;
    if (Object.keys(receivedAt).length > 0) query.receivedAt = receivedAt;
    if (typeof q === "string" && q.trim()) {
      const regex = new RegExp(escapeRegex(q.trim()), "i");
      query.$or = [
        { provider: regex },
        { routeKey: regex },
        { eventId: regex },
        { type: regex },
        { title: regex },
        { subject: regex },
        { status: regex },
      ];
    }

    const [items, total] = await Promise.all([
      WebhookEventModel.find(query).sort({ receivedAt: -1 }).skip(skip).limit(ps).lean(),
      WebhookEventModel.countDocuments(query),
    ]);
    return { items, total, page: p, pageSize: ps, hasMore: p * ps < total };
  },

  /**
   * WH-4：端点级健康视图。按 routeKey 聚合 24h/7d 量、失败量、最近事件，
   * 并标注该 routeKey 是否已配置密钥（DB 优先，不读 ENV 原文）。
   */
  async health(): Promise<{
    since: string;
    routes: Array<{
      routeKey: string | null;
      total7d: number;
      total24h: number;
      failed7d: number;
      failureRate: number;
      lastReceivedAt: string | null;
      secretConfigured: boolean;
    }>;
    secretKeys: string[];
  }> {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const failureStatuses = ["failed", "error", "bounced", "complained", "delivery_delayed"];

    const rows = await WebhookEventModel.aggregate([
      { $match: { receivedAt: { $gte: since7d } } },
      {
        $group: {
          _id: "$routeKey",
          total7d: { $sum: 1 },
          total24h: { $sum: { $cond: [{ $gte: ["$receivedAt", since24h] }, 1, 0] } },
          failed7d: { $sum: { $cond: [{ $in: ["$status", failureStatuses] }, 1, 0] } },
          lastReceivedAt: { $max: "$receivedAt" },
        },
      },
      { $sort: { total7d: -1 } },
    ] as any);

    const secretDocs = await WebhookSecretModel.find({ provider: "resend" })
      .select({ key: 1 })
      .lean()
      .exec();
    const secretKeys = secretDocs.map((doc: any) => String(doc.key || "DEFAULT").toUpperCase());

    return {
      since: since7d.toISOString(),
      routes: rows.map((row: any) => {
        const routeKey = (row._id ?? null) as string | null;
        const key = (routeKey ? String(routeKey).toUpperCase() : "DEFAULT") || "DEFAULT";
        return {
          routeKey,
          total7d: row.total7d ?? 0,
          total24h: row.total24h ?? 0,
          failed7d: row.failed7d ?? 0,
          failureRate: row.total7d > 0 ? Number(((row.failed7d ?? 0) / row.total7d).toFixed(4)) : 0,
          lastReceivedAt: row.lastReceivedAt ? new Date(row.lastReceivedAt).toISOString() : null,
          secretConfigured: secretKeys.includes(key),
        };
      }),
      secretKeys,
    };
  },

  /** WH-3：按保留期清理历史事件。默认 dryRun，避免误删。 */
  async prune(
    days: number,
    options: { provider?: string; routeKey?: string; dryRun?: boolean } = {},
  ): Promise<{ matched: number; deleted: number; dryRun: boolean; cutoff: string }> {
    const retentionDays = Number.isFinite(Number(days)) ? Math.min(3650, Math.max(1, Math.floor(Number(days)))) : 90;
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const filter: any = { receivedAt: { $lt: cutoff } };
    if (options.provider) filter.provider = options.provider;
    if (options.routeKey) filter.routeKey = options.routeKey;

    const matched = await WebhookEventModel.countDocuments(filter);
    if (options.dryRun !== false) {
      return { matched, deleted: 0, dryRun: true, cutoff: cutoff.toISOString() };
    }
    const result = await WebhookEventModel.deleteMany(filter);
    return { matched, deleted: result.deletedCount ?? 0, dryRun: false, cutoff: cutoff.toISOString() };
  },
  async groups() {
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const rows = await WebhookEventModel.aggregate([
      { $match: { receivedAt: { $gte: since7d } } },
      {
        $group: {
          _id: { routeKey: "$routeKey" },
          total: { $sum: 1 },
        },
      },
      { $sort: { total: -1 } },
    ]);
    return rows.map((r: any) => ({ routeKey: r._id.routeKey ?? null, total: r.total }));
  },
  async stats() {
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const failureStatuses = ["failed", "error", "bounced", "complained", "delivery_delayed"];

    const [facetResult] = await WebhookEventModel.aggregate([
      { $match: { receivedAt: { $gte: since7d } } },
      {
        $facet: {
          total: [{ $count: "count" }],
          last24h: [{ $match: { receivedAt: { $gte: since24h } } }, { $count: "count" }],
          failed: [{ $match: { status: { $in: failureStatuses } } }, { $count: "count" }],
          byStatus: [{ $group: { _id: "$status", total: { $sum: 1 } } }, { $sort: { total: -1 } }],
          byProvider: [{ $group: { _id: "$provider", total: { $sum: 1 } } }, { $sort: { total: -1 } }],
          byRouteKey: [{ $group: { _id: "$routeKey", total: { $sum: 1 } } }, { $sort: { total: -1 } }],
          byType: [{ $group: { _id: "$type", total: { $sum: 1 } } }, { $sort: { total: -1 } }, { $limit: 10 }],
        },
      },
    ]);

    const mapRows = (rows: any[]) => rows.map((row) => ({ key: row._id ?? null, total: row.total }));
    return {
      total: facetResult.total[0]?.count ?? 0,
      last24h: facetResult.last24h[0]?.count ?? 0,
      failed: facetResult.failed[0]?.count ?? 0,
      byStatus: mapRows(facetResult.byStatus),
      byProvider: mapRows(facetResult.byProvider),
      byRouteKey: mapRows(facetResult.byRouteKey),
      byType: mapRows(facetResult.byType),
    };
  },
  async get(id: string) {
    if (!mongoose.isValidObjectId(id)) {
      throw new Error("无效的 ID");
    }
    return WebhookEventModel.findById(id).lean();
  },
  async update(id: string, patch: any) {
    if (!mongoose.isValidObjectId(id)) {
      throw new Error("无效的 ID");
    }
    // Whitelist fields to avoid arbitrary query injection
    const allowed: Record<string, boolean> = {
      provider: true,
      routeKey: true,
      eventId: true,
      type: true,
      title: true,
      content: true,
      renderedContent: true,
      created_at: true,
      to: true,
      subject: true,
      status: true,
      data: true,
      raw: true,
    };
    const safePatch: any = {};
    if (patch && typeof patch === "object") {
      for (const [k, v] of Object.entries(patch)) {
        if (allowed[k]) {
          Object.assign(safePatch, sanitizeEventDocument({ [k]: v }, { partial: true }));
        }
      }
    }
    return WebhookEventModel.findByIdAndUpdate(
      id,
      { $set: { ...safePatch, updatedAt: new Date() } },
      { returnDocument: "after" },
    ).lean();
  },
  async updateStatus(id: string, status: string) {
    const normalizedStatus = asString(status);
    if (!normalizedStatus) {
      throw new Error("状态不能为空");
    }
    return this.update(id, { status: normalizedStatus });
  },
  async bulkUpdateStatus(ids: string[], status: string) {
    const normalizedStatus = asString(status);
    if (!normalizedStatus) {
      throw new Error("状态不能为空");
    }
    const validIds = ids.filter((id) => mongoose.isValidObjectId(id));
    if (validIds.length === 0) {
      throw new Error("未提供有效的 ID");
    }
    const result: any = await WebhookEventModel.updateMany(
      { _id: { $in: validIds } },
      { $set: { status: normalizedStatus, updatedAt: new Date() } },
    );
    return {
      matchedCount: result?.matchedCount ?? result?.n ?? validIds.length,
      modifiedCount: result?.modifiedCount ?? result?.nModified ?? validIds.length,
    };
  },
  async bulkRemove(ids: string[]) {
    const validIds = ids.filter((id) => mongoose.isValidObjectId(id));
    if (validIds.length === 0) {
      throw new Error("未提供有效的 ID");
    }
    const result: any = await WebhookEventModel.deleteMany({ _id: { $in: validIds } });
    return { deletedCount: result?.deletedCount ?? 0 };
  },
  async replay(id: string, options: { status?: string; note?: string } = {}) {
    const original: any = await this.get(id);
    if (!original) return null;

    const now = new Date();
    const replayData =
      original.data && typeof original.data === "object" && !Array.isArray(original.data)
        ? { ...original.data }
        : { value: original.data };
    replayData.replay = {
      sourceEventId: id,
      replayedAt: now.toISOString(),
      note: asString(options.note),
    };

    return this.create({
      provider: original.provider || "manual",
      routeKey: original.routeKey ?? undefined,
      eventId: `${original.eventId || id}:replay:${now.getTime()}`,
      type: original.type || "manual.replay",
      title: original.title,
      content: original.content,
      renderedContent: original.renderedContent,
      created_at: original.created_at,
      to: original.to,
      subject: original.subject,
      status: asString(options.status) || "replayed",
      data: replayData,
      raw: {
        replayedFrom: id,
        replayedAt: now.toISOString(),
        original: original.raw ?? original.data ?? original,
      },
      receivedAt: now,
    });
  },
  async remove(id: string) {
    if (!mongoose.isValidObjectId(id)) {
      throw new Error("无效的 ID");
    }
    await WebhookEventModel.findByIdAndDelete(id);
    return { success: true };
  },

  /**
   * WH-2：只读列出已配置的 Resend webhook 密钥（只回掩码，绝不回原文）。
   * 与 adminController 的 set/delete 共用同一 collection。
   */
  async listResendWebhookSecrets(): Promise<
    Array<{ key: string; secretPreview: string; updatedAt: string | null }>
  > {
    const docs = await WebhookSecretModel.find({ provider: "resend" }).sort({ key: 1 }).lean().exec();
    return docs.map((doc: any) => {
      const secret = typeof doc.secret === "string" ? doc.secret : "";
      const secretPreview = secret.length > 8 ? `${secret.slice(0, 2)}***${secret.slice(-4)}` : "***";
      return {
        key: String(doc.key || "DEFAULT").toUpperCase(),
        secretPreview,
        updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
      };
    });
  },
};

/**
 * 获取 Resend Webhook 密钥（DB 优先，ENV 回退）
 */
export async function getResendSecret(routeKey?: string): Promise<string> {
  const dbSecret = await getResendSecretFromDb(routeKey);
  if (dbSecret && typeof dbSecret === "string" && dbSecret.trim()) {
    return dbSecret.trim();
  }
  const keySuffix = routeKey ? String(routeKey).trim().toUpperCase() : "";
  const candidates = [
    keySuffix ? `RESEND_WEBHOOK_SECRET_${keySuffix}` : "",
    keySuffix ? `WEBHOOK_SECRET_${keySuffix}` : "",
    "RESEND_WEBHOOK_SECRET",
    "WEBHOOK_SECRET",
  ].filter(Boolean) as string[];
  for (const envName of candidates) {
    const v = process.env[envName];
    if (v && typeof v === "string" && v.trim()) {
      return v.trim();
    }
  }
  throw new Error(`RESEND_WEBHOOK_SECRET 未配置${keySuffix ? `（键：${keySuffix}）` : ""}`);
}

/**
 * 使用提供的密钥执行 Svix 验证
 *
 * svix 2.x 是纯 ESM 包，后端编译产物是 CommonJS，只能动态 import。
 */
export async function verifyResendPayload(payload: string, headers: IncomingHttpHeaders, rawSecret: string) {
  // Resend 文档要求：先 base64 解码（若解码失败则按明文处理）
  let secret: string;
  try {
    secret = Buffer.from(rawSecret, "base64").toString("utf-8");
  } catch {
    secret = rawSecret;
  }
  const svixHeaders = {
    "svix-id": String(headers["svix-id"] || ""),
    "svix-timestamp": String(headers["svix-timestamp"] || ""),
    "svix-signature": String(headers["svix-signature"] || ""),
  };
  if (!svixHeaders["svix-id"] || !svixHeaders["svix-timestamp"] || !svixHeaders["svix-signature"]) {
    throw new Error("缺少 Svix 签名头");
  }
  const { Webhook } = await import("svix");
  const wh = new Webhook(secret);
  return wh.verify(payload, svixHeaders as any);
}

/**
 * 兼容旧用法：仅从 ENV 中解析密钥，不走 DB
 */
export function verifyResendWebhook(payload: string, headers: IncomingHttpHeaders, key?: string) {
  // 支持多路由多密钥：优先使用 DB（webhook_settings），回退到 RESEND_WEBHOOK_SECRET_<KEY> / WEBHOOK_SECRET_<KEY>
  const keySuffix = key ? String(key).trim().toUpperCase() : "";
  const candidates = [
    keySuffix ? `RESEND_WEBHOOK_SECRET_${keySuffix}` : "",
    keySuffix ? `WEBHOOK_SECRET_${keySuffix}` : "",
    "RESEND_WEBHOOK_SECRET",
    "WEBHOOK_SECRET",
  ].filter(Boolean) as string[];

  let rawSecret = "";
  // 仅 ENV（同步）
  for (const envName of candidates) {
    const v = process.env[envName];
    if (v && typeof v === "string" && v.trim()) {
      rawSecret = v;
      break;
    }
  }
  if (!rawSecret) {
    throw new Error(`RESEND_WEBHOOK_SECRET 未配置${keySuffix ? `（键：${keySuffix}）` : ""}`);
  }
  return verifyResendPayload(payload, headers, rawSecret);
}
