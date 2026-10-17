import type { Response } from "express";
import { type ITicketRelation, TicketModel } from "../models/ticketModel";
import { isAdminRole } from "../middleware/auth";
import { firstString } from "../utils/httpParam";
import { escapeRegexLiteral } from "../utils/regexEscape";
import { asTicketRelatedService, asTicketType } from "../utils/ticketFields";
import { mongoose } from "./mongoService";
import { RuntimeConfigService } from "./runtimeConfigService";

/**
 * 工单工作流服务：把「可单测的纯判定」与「批量写库」从控制器里抽出来。
 *
 * 为什么单独成文件：
 * - `ticketController.ts` 已接近 1500 行硬上限，新能力必须先有归属；
 * - 首响 / 解决时间 / 事件构造是单条与批量共用的规则，分散在控制器里早晚漂移；
 * - 这里刻意不发邮件、不推 WebSocket：副作用留在控制器，服务层才能被单测。
 */

export const TICKET_EVENT_TYPES = [
  "created",
  "status",
  "priority",
  "category",
  "assignee",
  "type",
  "service",
  "csat",
] as const;
export type TicketEventType = (typeof TICKET_EVENT_TYPES)[number];

export const TICKET_EVENT_ACTOR_ROLES = ["user", "admin", "superadmin", "ai", "system"] as const;
export type TicketEventActorRole = (typeof TICKET_EVENT_ACTOR_ROLES)[number];

/** 事件数组上限：超出时 `$slice` 只保留最近 N 条。 */
export const TICKET_EVENTS_LIMIT = 100;

export const VALID_TICKET_STATUSES = ["open", "in-progress", "resolved", "closed"] as const;
export const VALID_TICKET_PRIORITIES = ["low", "medium", "high"] as const;
export const VALID_TICKET_CATEGORIES = ["bug", "feature", "account", "billing", "other"] as const;
export type TicketCategoryValue = (typeof VALID_TICKET_CATEGORIES)[number];
export type TicketPriorityValue = (typeof VALID_TICKET_PRIORITIES)[number];
export type TicketStatusValue = (typeof VALID_TICKET_STATUSES)[number];

/** 管理端「逾期未回复」阈值（小时）：列表与统计共用，避免两处口径不同。 */
export const TICKET_SLA_HOURS = 24;

export function asTicketCategory(value: unknown): TicketCategoryValue | null {
  return typeof value === "string" && (VALID_TICKET_CATEGORIES as readonly string[]).includes(value)
    ? (value as TicketCategoryValue)
    : null;
}

/** 把 JWT/用户记录里的角色收敛到事件枚举；未知角色按属主处理（最小权限）。 */
export function normalizeActorRole(role: unknown): TicketEventActorRole {
  return role === "admin" || role === "superadmin" || role === "ai" || role === "system" ? role : "user";
}

export interface TicketEventInput {
  type: TicketEventType;
  actorId?: string | null;
  actorName?: string | null;
  actorRole: TicketEventActorRole;
  from?: string | null;
  to?: string | null;
  note?: string | null;
  createdAt?: Date;
}

/**
 * 构造事件子文档。缺省字段统一落成 null（而不是 undefined），
 * 这样 Mongo 里的数组元素形状一致，管理端时间线不必判断字段是否存在。
 */
export function buildTicketEvent(input: TicketEventInput): Record<string, unknown> {
  const event: Record<string, unknown> = {
    type: input.type,
    actorRole: input.actorRole,
    from: input.from ?? null,
    to: input.to ?? null,
    note: input.note ?? null,
    createdAt: input.createdAt ?? new Date(),
  };
  if (input.actorId != null) event.actorId = String(input.actorId);
  if (input.actorName != null) event.actorName = String(input.actorName);
  return event;
}

/** `$push` 事件的标准写法：一次推入本轮的变更，并把数组裁到最近 100 条。 */
function buildEventPush(events: Array<Record<string, unknown>>) {
  return { events: { $each: events, $slice: -TICKET_EVENTS_LIMIT } };
}

export type NormalizeCsatResult =
  | { ok: true; rating: number; comment: string | null }
  | { ok: false; error: string };

const CSAT_COMMENT_MAX_LENGTH = 500;

/**
 * 满意度输入校验：rating 必须是 1–5 的整数，comment 可选、trim 后 ≤500 字。
 *
 * 只接受 number 或纯数字字符串：`true`、空串、数组都会被 `Number()` 转成 0/1，
 * 若直接复用会变成「布尔值也能打星」的漏洞。
 */
export function normalizeCsatInput(input: unknown): NormalizeCsatResult {
  const source = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const rawRating = source.rating;
  const rating =
    typeof rawRating === "number"
      ? rawRating
      : typeof rawRating === "string" && rawRating.trim() !== ""
        ? Number(rawRating)
        : Number.NaN;
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return { ok: false, error: "评分必须是 1 到 5 的整数" };
  }

  const rawComment = source.comment;
  if (rawComment !== undefined && rawComment !== null && typeof rawComment !== "string") {
    return { ok: false, error: "评价内容格式不正确" };
  }
  const comment = typeof rawComment === "string" ? rawComment.trim() : "";
  if (comment.length > CSAT_COMMENT_MAX_LENGTH) {
    return { ok: false, error: `评价内容不能超过 ${CSAT_COMMENT_MAX_LENGTH} 字` };
  }

  return { ok: true, rating, comment: comment || null };
}

export interface TicketListQuery {
  limit: number;
  page: number;
  skip: number;
  summary: boolean;
}

/** 列表分页：默认 50、上限 200 —— 单次不把全部工单（含全文）拉进内存。 */
export const TICKET_LIST_DEFAULT_LIMIT = 50;
export const TICKET_LIST_MAX_LIMIT = 200;

export function parseTicketListQuery(query: unknown): TicketListQuery {
  const source = (query && typeof query === "object" ? query : {}) as Record<string, unknown>;
  const rawLimit = Number.parseInt(String(source.limit ?? ""), 10);
  const rawPage = Number.parseInt(String(source.page ?? ""), 10);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, TICKET_LIST_MAX_LIMIT) : TICKET_LIST_DEFAULT_LIMIT;
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  return {
    limit,
    page,
    skip: (page - 1) * limit,
    summary: source.summary === "1" || source.summary === "true",
  };
}

/**
 * 分页元信息走响应头，响应体仍是数组：既有调用方（不传 limit/page）行为不变，
 * 新调用方靠 `X-Total-Count` / `X-Has-More` 就能实现「加载更多」。
 */
export function setTicketListHeaders(res: Response, total: number, page: number, limit: number): void {
  res.setHeader("X-Total-Count", String(total));
  res.setHeader("X-Page", String(page));
  res.setHeader("X-Page-Size", String(limit));
  res.setHeader("X-Has-More", String(page * limit < total));
}

/**
 * 解析关联工单：校验存在性 + 归属，并把标题快照下来。
 *
 * 归属默认必须与工单属主一致 —— 否则等于给了一个「用关联工单把别人的工单标题/ID 拉到自己页面」
 * 的越权读取入口。superadmin 的管理端操作显式放开（`allowAnyOwner`），因为客服本来就能看全部工单。
 */
export async function resolveRelatedTickets(
  ids: string[],
  ownerUserId: string,
  allowAnyOwner: boolean,
): Promise<{ ok: true; relations: ITicketRelation[] } | { ok: false; error: string }> {
  if (ids.length === 0) return { ok: true, relations: [] };
  const tickets = await TicketModel.find({ _id: { $in: ids } })
    .select("_id title userId")
    .lean<any[]>();
  if (tickets.length !== ids.length) return { ok: false, error: "关联工单中有不存在的工单" };
  const byId = new Map(tickets.map((ticket: any) => [String(ticket._id), ticket]));
  for (const id of ids) {
    const found = byId.get(id);
    if (!found) return { ok: false, error: "关联工单中有不存在的工单" };
    if (!allowAnyOwner && String(found.userId) !== String(ownerUserId)) {
      return { ok: false, error: "只能关联自己名下的工单" };
    }
  }
  // 保持调用方给定的顺序（用户拖动/选择顺序就是展示顺序）。
  return {
    ok: true,
    relations: ids.map((id) => ({ ticketId: id, title: String(byId.get(id)?.title || "未命名工单") })),
  };
}

/**
 * 通知收件人：一律优先账号邮箱，只在账号没有邮箱时才用票面填写的联系邮箱兜底。
 *
 * 反向（优先联系邮箱）等于把本站的通知通道变成一个「可以改寄到任意地址」的入口：
 * 用户填什么就发给什么，成本只有一次工单提交。
 */
export function resolveTicketNotifyEmail(accountEmail: unknown, contactEmail: unknown): string {
  const own = typeof accountEmail === "string" ? accountEmail.trim() : "";
  if (own) return own;
  return typeof contactEmail === "string" ? contactEmail.trim() : "";
}

/**
 * 普通用户是否可以上传附件文件。
 *
 * 三个来源，任一成立即放行：
 * 1. 管理员/超管 —— 他们本来就能改工单内容，不受此开关限制；
 * 2. 全站开关（`TICKET_ATTACHMENTS.userUploadEnabled`）打开；
 * 3. **单独授权**：用户 ID 在 `userUploadAllowedUserIds` 里。
 *
 * 单独授权是在「默认关闭」这条默认线之上开的口子：附件是用户上传的任意二进制，
 * 白名单与体积上限挡不住「类型对但内容是恶意文件」，所以不轻易全站放开。
 * 注意比较用的是 `String(user.id)`：JWT 载荷里的 id 可能是数字形态，
 * 而配置里存的一律是字符串，不做归一化会让授权静默失效。
 */
export function resolveAttachmentUploadPermission(input: {
  role?: string;
  userId?: unknown;
  globalEnabled: boolean;
  grantedUserIds: readonly string[] | undefined;
}): boolean {
  if (isAdminRole(input.role)) return true;
  if (input.globalEnabled === true) return true;
  const userId =
    typeof input.userId === "string" || typeof input.userId === "number" ? String(input.userId) : "";
  if (!userId) return false;
  return Array.isArray(input.grantedUserIds) && input.grantedUserIds.includes(userId);
}

export function canUserUploadAttachmentFiles(user: { id?: unknown; role?: string } | undefined): boolean {
  const config = RuntimeConfigService.getCachedConfig().ticketAttachments;
  return resolveAttachmentUploadPermission({
    role: user?.role,
    userId: user?.id,
    globalEnabled: config.userUploadEnabled === true,
    grantedUserIds: config.userUploadAllowedUserIds,
  });
}

export function describeAttachmentUploadPolicy(user: { id?: unknown; role?: string } | undefined): string {
  if (isAdminRole(user?.role)) return "管理端不受附件上传开关限制";
  // 不透露「谁被单独授权」：这里只描述当前用户自己的状态与出路。
  return "附件上传暂未对普通用户开放：请在上方「附件链接」里提交截图或文件的地址，或联系管理员为你的账号单独开放附件上传。";
}

export interface TicketListFilterSpec {
  filter: Record<string, any>;
  sort: Record<string, 1 | -1>;
}

function querySource(query: unknown): Record<string, unknown> {
  return (query && typeof query === "object" ? query : {}) as Record<string, unknown>;
}

/** 用户列表筛选：只在自己的工单里按关键词 / 状态过滤并选择排序。 */
export function buildUserTicketFilter(query: unknown, userId: string): TicketListFilterSpec {
  const source = querySource(query);
  const filter: Record<string, unknown> = { userId };

  // 状态筛选：非法值忽略而不是 400 —— 分享出去的链接里多一个参数不该让页面白屏。
  const status = firstString(source.status);
  if (status && (VALID_TICKET_STATUSES as readonly string[]).includes(status)) filter.status = status;

  // 关键词只匹配标题/正文，且正则转义 + 截断到 120 字：用户输入不是模式。
  const keyword = firstString(source.q);
  if (keyword) {
    const pattern = new RegExp(escapeRegexLiteral(keyword.slice(0, 120)), "i");
    filter.$or = [{ title: pattern }, { description: pattern }];
  }

  const sortKey = firstString(source.sort);
  return {
    filter,
    sort: sortKey === "created" ? { createdAt: -1 } : sortKey === "oldest" ? { updatedAt: 1 } : { updatedAt: -1 },
  };
}

/**
 * 管理端列表筛选：关键词（标题/正文/用户名/受理人/工单 ID）、状态、优先级、分类、
 * 类型、相关服务、受理人、日期、待回复、未读、低满意度与排序。
 *
 * 尾消息类条件（awaitingReply/unread）必须下推到 `$expr`：`messages` 是数组，
 * 普通查询表达不了「最后一条的 senderRole」。
 */
export function buildAdminTicketFilter(query: unknown, viewerId: string): TicketListFilterSpec {
  const source = querySource(query);
  const filter: Record<string, any> = {};
  const status = firstString(source.status);
  const priority = firstString(source.priority);
  if (status && (VALID_TICKET_STATUSES as readonly string[]).includes(status)) filter.status = status;
  if (priority && (VALID_TICKET_PRIORITIES as readonly string[]).includes(priority)) filter.priority = priority;

  // 关键词：标题 / 描述 / 用户名 / 受理人名；合法 ObjectId 同时匹配工单 _id，
  // 让客服能把用户贴来的工单 ID 直接粘进搜索框。正则一律转义。
  const keyword = firstString(source.q);
  if (keyword) {
    const trimmed = keyword.trim();
    const pattern = new RegExp(escapeRegexLiteral(trimmed.slice(0, 120)), "i");
    const orConditions: any[] = [
      { title: pattern },
      { description: pattern },
      { username: pattern },
      { assigneeName: pattern },
    ];
    // 只认 24 位十六进制：ObjectId.isValid 也接受 12 字节字符串，但那不是用户会粘贴的形态，
    // 按 _id 搜索会静默查不到。
    if (/^[a-fA-F0-9]{24}$/.test(trimmed)) {
      orConditions.push({ _id: new mongoose.Types.ObjectId(trimmed) });
    }
    filter.$or = orConditions;
  }

  // 低满意度视图：只筛已评价且 ≤2 星；未评价（null / 缺字段）不算。
  if (firstString(source.csat) === "low") filter.csatRating = { $ne: null, $lte: 2 };

  // 创建时间区间（用于「本周新工单」这类巡检）
  const from = firstString(source.from);
  const to = firstString(source.to);
  const createdAt: Record<string, Date> = {};
  if (from) {
    const parsed = new Date(from);
    if (!Number.isNaN(parsed.getTime())) createdAt.$gte = parsed;
  }
  if (to) {
    const parsed = new Date(to);
    if (!Number.isNaN(parsed.getTime())) createdAt.$lte = parsed;
  }
  if (Object.keys(createdAt).length > 0) filter.createdAt = createdAt;

  const category = asTicketCategory(firstString(source.category));
  if (category) filter.category = category;

  // 类型与相关服务：给出默认值时也要把「字段不存在的老工单」一起算进来，
  // 否则按「咨询 / 其他」筛选会看不到任何历史工单（default 只在写入时生效）。
  const typeFilter = asTicketType(firstString(source.type));
  if (typeFilter) filter.type = typeFilter === "inquiry" ? { $in: ["inquiry", null] } : typeFilter;
  const serviceFilter = asTicketRelatedService(firstString(source.service));
  if (serviceFilter) filter.relatedService = serviceFilter === "other" ? { $in: ["other", null] } : serviceFilter;

  const assignee = firstString(source.assignee);
  if (assignee === "me") filter.assigneeId = viewerId;
  else if (assignee === "unassigned") filter.assigneeId = null;
  else if (assignee) filter.assigneeId = assignee;

  const expressions: any[] = [];
  if (firstString(source.awaitingReply) === "1") {
    expressions.push({ $eq: [{ $arrayElemAt: ["$messages.senderRole", -1] }, "user"] });
    filter.status = filter.status || { $ne: "closed" };
  }
  if (firstString(source.unread) === "1") {
    expressions.push({ $eq: [{ $arrayElemAt: ["$messages.senderRole", -1] }, "user"] });
    expressions.push({
      $or: [
        { $eq: ["$adminLastReadAt", null] },
        { $lt: ["$adminLastReadAt", { $arrayElemAt: ["$messages.createdAt", -1] }] },
      ],
    });
  }
  if (expressions.length > 0) filter.$expr = expressions.length === 1 ? expressions[0] : { $and: expressions };

  // 排序：不提供 priority 排序 —— 它是字符串枚举，字典序不等于紧急度。
  const sortKey = firstString(source.sort);
  return {
    filter,
    sort: sortKey === "created" ? { createdAt: -1 } : sortKey === "oldest" ? { updatedAt: 1 } : { updatedAt: -1 },
  };
}

export interface TicketActor {
  id: string;
  name: string;
  role: string;
}

export interface BulkTicketPatch {
  status?: string;
  priority?: string;
  category?: string;
  assigneeId?: string | null;
  assigneeName?: string | null;
}

export interface BuildBulkTicketUpdateArgs {
  ticket: {
    _id?: unknown;
    status?: string;
    priority?: string;
    category?: string;
    assigneeId?: string | null;
    assigneeName?: string | null;
    firstResponseAt?: Date | null;
    resolvedAt?: Date | null;
  };
  patch: BulkTicketPatch;
  actor: TicketActor;
  now: Date;
}

export interface BulkTicketUpdateResult {
  changed: boolean;
  $set: Record<string, unknown>;
  $push?: { events: { $each: Array<Record<string, unknown>>; $slice: number } };
}

function isResolvedStatus(status: string | undefined): boolean {
  return status === "resolved" || status === "closed";
}

/**
 * 批量更新构造器：只写真正变化的字段，并为每个变化追加一条事件。
 *
 * 首响时间刻意不在这里写：批量改状态 / 受理人不是「回复」，把它们算成首响会让
 * 平均首响失真。`firstResponseAt` 只由消息写入路径（人工 / AI 回复）负责。
 */
export function buildBulkTicketUpdate(args: BuildBulkTicketUpdateArgs): BulkTicketUpdateResult {
  const { ticket, patch, actor, now } = args;
  const $set: Record<string, unknown> = {};
  const events: Array<Record<string, unknown>> = [];
  const actorRole = normalizeActorRole(actor.role);
  const pushEvent = (type: TicketEventType, from: string | null, to: string | null): void => {
    events.push(
      buildTicketEvent({
        type,
        actorId: actor.id,
        actorName: actor.name,
        actorRole,
        from,
        to,
        createdAt: now,
      }),
    );
  };

  if (patch.status !== undefined && patch.status !== ticket.status) {
    $set.status = patch.status;
    pushEvent("status", ticket.status ?? null, patch.status);
    // resolvedAt 表示「最近一次进入终态」的时间：只在首次进入时写，重新打开时清空。
    if (isResolvedStatus(patch.status)) {
      if (ticket.resolvedAt == null) $set.resolvedAt = now;
    } else if (ticket.resolvedAt != null) {
      $set.resolvedAt = null;
    }
  }

  if (patch.priority !== undefined && patch.priority !== ticket.priority) {
    $set.priority = patch.priority;
    pushEvent("priority", ticket.priority ?? null, patch.priority);
  }

  if (patch.category !== undefined && patch.category !== ticket.category) {
    $set.category = patch.category;
    pushEvent("category", ticket.category ?? null, patch.category);
  }

  if (patch.assigneeId !== undefined) {
    const currentId = ticket.assigneeId ?? null;
    const nextId = patch.assigneeId ?? null;
    if (String(currentId ?? "") !== String(nextId ?? "")) {
      const currentName = ticket.assigneeName ?? null;
      const nextName = patch.assigneeName !== undefined ? patch.assigneeName : nextId === null ? null : currentName;
      $set.assigneeId = nextId;
      $set.assigneeName = nextName;
      pushEvent("assignee", currentName, nextName ?? null);
    }
  }

  return {
    changed: Object.keys($set).length > 0,
    $set,
    ...(events.length > 0 ? { $push: buildEventPush(events) } : {}),
  };
}

export interface BulkTicketChange {
  _id: string;
  userId: string;
  title: string;
  status: string;
  statusChanged: boolean;
}

export interface ApplyBulkTicketPatchResult {
  matched: number;
  updated: number;
  changed: BulkTicketChange[];
}

/**
 * 应用批量更新：先读出选中字段构造每条工单的 `$set/$push`，再一次 `bulkWrite` 落库。
 *
 * 逐条构造而不是 `updateMany`：事件必须知道每条工单的旧值（from），且只对真实变化的
 * 工单追加事件；`updateMany` 无法表达「按文档当前值决定是否写」。
 */
export async function applyBulkTicketPatch(args: {
  ids: string[];
  patch: BulkTicketPatch;
  actor: TicketActor;
  now?: Date;
}): Promise<ApplyBulkTicketPatchResult> {
  const now = args.now ?? new Date();
  if (args.ids.length === 0) return { matched: 0, updated: 0, changed: [] };

  const tickets = await TicketModel.find({ _id: { $in: args.ids } })
    .select("userId title status priority category assigneeId assigneeName firstResponseAt resolvedAt")
    .lean<any[]>();

  const operations: any[] = [];
  const changed: BulkTicketChange[] = [];
  for (const ticket of tickets) {
    const built = buildBulkTicketUpdate({
      ticket: {
        _id: ticket._id,
        status: ticket.status,
        priority: ticket.priority,
        category: ticket.category,
        assigneeId: ticket.assigneeId ?? null,
        assigneeName: ticket.assigneeName ?? null,
        firstResponseAt: ticket.firstResponseAt ?? null,
        resolvedAt: ticket.resolvedAt ?? null,
      },
      patch: args.patch,
      actor: args.actor,
      now,
    });
    if (!built.changed) continue;

    const update: Record<string, unknown> = { $set: built.$set };
    if (built.$push) update.$push = built.$push;
    operations.push({ updateOne: { filter: { _id: ticket._id }, update } });
    changed.push({
      _id: String(ticket._id),
      userId: String(ticket.userId),
      title: String(ticket.title || ""),
      status: String(built.$set.status ?? ticket.status ?? "open"),
      statusChanged: built.$set.status !== undefined,
    });
  }

  if (operations.length === 0) return { matched: tickets.length, updated: 0, changed };

  const result = await TicketModel.bulkWrite(operations);
  return { matched: tickets.length, updated: result.modifiedCount ?? 0, changed };
}

export interface TicketStats {
  total: number;
  status: Record<string, number>;
  priority: Record<string, number>;
  category: Record<string, number>;
  type: Record<string, number>;
  service: Record<string, number>;
  awaitingReply: number;
  slaBreached: number;
  oldestAwaitingHours: number;
  slaHours: number;
  awaitingMine: number;
  mineOpen: number;
  unassigned: number;
  createdToday: number;
  resolvedToday: number;
  avgFirstResponseHours: number;
  csatAverage: number | null;
  csatCount: number;
}

/** 本地时区（进程启动时固定 Asia/Shanghai）的当天零点。 */
function startOfLocalDay(now: Date): Date {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start;
}

function asMap(rows: Array<{ _id?: string; count?: number }>): Record<string, number> {
  return rows.reduce<Record<string, number>>((acc, row) => {
    if (typeof row?._id === "string") acc[row._id] = row.count || 0;
    return acc;
  }, {});
}

/** 同 asMap，但把 `_id: null`（老文档缺字段）归到默认值，保证分组求和 = 总数。 */
function asMapWithDefault(
  rows: Array<{ _id?: string | null; count?: number }>,
  fallbackKey: string,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const row of rows) {
    const key = typeof row?._id === "string" && row._id ? row._id : fallbackKey;
    result[key] = (result[key] || 0) + (row.count || 0);
  }
  return result;
}

/**
 * 管理端统计：存量分组 + 分诊待办 + 今日吞吐 + 最近 30 天平均首响 + 满意度。
 *
 * 全部聚合并行发出（`Promise.all`）：管理端概览是高频页面，串行等待会把首屏拖到数秒。
 * 首响窗口限定 30 天是为了让「最近表现」不被半年前的历史工单稀释。
 */
export async function computeTicketStats(viewerId: string): Promise<TicketStats> {
  const now = new Date();
  const slaCutoff = new Date(now.getTime() - TICKET_SLA_HOURS * 3600 * 1000);
  const todayStart = startOfLocalDay(now);
  const firstResponseCutoff = new Date(now.getTime() - 30 * 24 * 3600 * 1000);

  const [
    total,
    statusAgg,
    priorityAgg,
    categoryAgg,
    typeAgg,
    serviceAgg,
    awaitingAgg,
    awaitingMineAgg,
    mineOpen,
    unassigned,
    createdToday,
    resolvedToday,
    firstResponseAgg,
    csatAgg,
  ] = await Promise.all([
    TicketModel.countDocuments({}),
    TicketModel.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
    TicketModel.aggregate([{ $group: { _id: "$priority", count: { $sum: 1 } } }]),
    TicketModel.aggregate([{ $group: { _id: "$category", count: { $sum: 1 } } }]),
    // 类型 / 相关服务：老工单没有这两个字段，`_id` 会是 null —— 统一归到默认值，
    // 否则概览数会与总数对不上。
    TicketModel.aggregate([{ $group: { _id: "$type", count: { $sum: 1 } } }]),
    TicketModel.aggregate([{ $group: { _id: "$relatedService", count: { $sum: 1 } } }]),
    TicketModel.aggregate([
      { $addFields: { tail: { $arrayElemAt: ["$messages", -1] } } },
      { $match: { "tail.senderRole": "user", status: { $ne: "closed" } } },
      {
        $group: {
          _id: null,
          awaitingReply: { $sum: 1 },
          slaBreached: { $sum: { $cond: [{ $lt: ["$tail.createdAt", slaCutoff] }, 1, 0] } },
          oldest: { $min: "$tail.createdAt" },
        },
      },
    ]),
    // 我的待办：我名下、未关闭、且最后一条是用户发言（真的需要我回）。
    TicketModel.aggregate([
      { $match: { assigneeId: viewerId, status: { $ne: "closed" } } },
      { $addFields: { tail: { $arrayElemAt: ["$messages", -1] } } },
      { $match: { "tail.senderRole": "user" } },
      { $count: "count" },
    ]),
    TicketModel.countDocuments({ assigneeId: viewerId, status: { $nin: ["resolved", "closed"] } }),
    TicketModel.countDocuments({ assigneeId: null, status: { $ne: "closed" } }),
    TicketModel.countDocuments({ createdAt: { $gte: todayStart } }),
    TicketModel.countDocuments({ resolvedAt: { $gte: todayStart } }),
    TicketModel.aggregate([
      { $match: { firstResponseAt: { $ne: null }, createdAt: { $gte: firstResponseCutoff } } },
      { $project: { hours: { $divide: [{ $subtract: ["$firstResponseAt", "$createdAt"] }, 3_600_000] } } },
      { $match: { hours: { $gte: 0 } } },
      { $group: { _id: null, avg: { $avg: "$hours" } } },
    ]),
    TicketModel.aggregate([
      { $match: { csatRating: { $ne: null } } },
      { $group: { _id: null, avg: { $avg: "$csatRating" }, count: { $sum: 1 } } },
    ]),
  ]);

  const awaiting = (awaitingAgg[0] || {}) as { awaitingReply?: number; slaBreached?: number; oldest?: Date };
  const oldest = awaiting.oldest ? new Date(awaiting.oldest) : null;
  const rawFirstResponse = (firstResponseAgg[0] || {}) as { avg?: number };
  const rawCsat = (csatAgg[0] || {}) as { avg?: number; count?: number };
  const csatCount = rawCsat.count || 0;

  return {
    total,
    status: asMap(statusAgg as Array<{ _id?: string; count?: number }>),
    priority: asMap(priorityAgg as Array<{ _id?: string; count?: number }>),
    category: asMap(categoryAgg as Array<{ _id?: string; count?: number }>),
    type: asMapWithDefault(typeAgg as Array<{ _id?: string | null; count?: number }>, "inquiry"),
    service: asMapWithDefault(serviceAgg as Array<{ _id?: string | null; count?: number }>, "other"),
    awaitingReply: awaiting.awaitingReply || 0,
    slaBreached: awaiting.slaBreached || 0,
    oldestAwaitingHours: oldest ? Math.round(((now.getTime() - oldest.getTime()) / 3_600_000) * 100) / 100 : 0,
    slaHours: TICKET_SLA_HOURS,
    awaitingMine: (awaitingMineAgg[0] as { count?: number } | undefined)?.count || 0,
    mineOpen,
    unassigned,
    createdToday,
    resolvedToday,
    avgFirstResponseHours:
      typeof rawFirstResponse.avg === "number" ? Math.round(rawFirstResponse.avg * 100) / 100 : 0,
    csatAverage: csatCount > 0 && typeof rawCsat.avg === "number" ? Math.round(rawCsat.avg * 10) / 10 : null,
    csatCount,
  };
}
