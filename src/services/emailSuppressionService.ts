import crypto from "node:crypto";
import { startupConfig } from "../config/config";
import { escapeRegexLiteral } from "../utils/regexEscape";
import {
  EmailSuppressionModel,
  type EmailSuppressionDoc,
  type EmailSuppressionReason,
} from "../models/emailSuppressionModel";
import logger from "../utils/logger";
import { cacheService } from "./cacheService";
import { mongoose } from "./mongoService";

/**
 * 邮件抑制名单服务（EM-1 / EM-2）。
 *
 * 三层判据，从快到慢：进程/Redis 缓存 → Mongo 集合。缓存只加速，Mongo 是权威。
 * 读取失败时按「未抑制」放行但打 error 日志：抑制主要影响送达率与退订合规，而本仓库的
 * 邮件包含验证码/找回密码这类不可中断的事务邮件，宁可放行也不能整体阻断发送。
 * 写入（入名单）则必须落 Mongo 成功才算数——不能只写缓存，否则重启即失效。
 */

const CACHE_TTL_SUPPRESSED_MS = 6 * 60 * 60 * 1000;
const CACHE_TTL_CLEAR_MS = 5 * 60 * 1000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface EmailSuppressionSummary {
  email: string;
  reason: EmailSuppressionReason;
  source: string;
  detail: string;
  expiresAt: string | null;
  permanent: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface AddSuppressionInput {
  email: string;
  reason: EmailSuppressionReason;
  source?: string;
  detail?: string;
  /** 省略/null 表示永久抑制。 */
  expiresAt?: Date | null;
}

export function normalizeEmail(input: unknown): string {
  if (typeof input !== "string") return "";
  const trimmed = input.trim().toLowerCase();
  if (!trimmed || trimmed.length > 254 || !EMAIL_PATTERN.test(trimmed)) return "";
  return trimmed;
}

function cacheKey(email: string): string {
  // 缓存 key 不用明文邮箱：避免缓存后端（Redis / 日志）直接暴露收件人地址。
  const digest = crypto.createHash("sha256").update(email).digest("hex").slice(0, 32);
  return cacheService.buildKey("email", "suppress", digest);
}

function toSummary(doc: EmailSuppressionDoc & { createdAt?: Date; updatedAt?: Date }): EmailSuppressionSummary {
  const expiresAt = doc.expiresAt ? new Date(doc.expiresAt) : null;
  return {
    email: doc.email,
    reason: doc.reason,
    source: doc.source || "system",
    detail: doc.detail || "",
    expiresAt: expiresAt ? expiresAt.toISOString() : null,
    permanent: !expiresAt,
    createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : null,
    updatedAt: doc.updatedAt ? new Date(doc.updatedAt).toISOString() : null,
  };
}

function activeFilter(email?: string) {
  const now = new Date();
  // 用 any 而不是 Record<string, unknown>：mongoose 的 FilterQuery 映射类型不接受
  // 宽索引签名（属性会被判成 unknown 而不匹配 Condition<T>），宽物件只能靠 any 通过。
  const filter: any = {
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }, { expiresAt: { $exists: false } }],
  };
  if (email) filter.email = email;
  return filter;
}

/**
 * 单个地址是否被抑制。读路径永不抛错。
 */
export async function isEmailSuppressed(emailInput: unknown): Promise<boolean> {
  const email = normalizeEmail(emailInput);
  if (!email) return false;

  const key = cacheKey(email);
  const cached = await cacheService.get<"1" | "0">(key);
  if (cached === "1") return true;
  if (cached === "0") return false;

  if (mongoose.connection.readyState !== 1) {
    logger.error("[EmailSuppression] Mongo 不可用，抑制名单判定按未抑制放行", { email });
    return false;
  }

  try {
    const doc = await EmailSuppressionModel.findOne({ email, ...activeFilter() })
      .lean()
      .exec();
    const suppressed = Boolean(doc);
    await cacheService.set(key, suppressed ? "1" : "0", suppressed ? CACHE_TTL_SUPPRESSED_MS : CACHE_TTL_CLEAR_MS);
    return suppressed;
  } catch (error) {
    logger.error("[EmailSuppression] 查询抑制名单失败，按未抑制放行", {
      email,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * 批量判定，供批量发送前置过滤使用（一次查询而不是 N 次）。
 */
export async function filterSuppressedEmails(emails: string[]): Promise<{
  allowed: string[];
  suppressed: string[];
}> {
  const normalized = emails.map((email) => normalizeEmail(email)).filter(Boolean);
  if (normalized.length === 0) return { allowed: [], suppressed: [] };
  if (mongoose.connection.readyState !== 1) {
    logger.error("[EmailSuppression] Mongo 不可用，批量抑制判定按未抑制放行", { count: normalized.length });
    return { allowed: normalized, suppressed: [] };
  }

  try {
    const docs = await EmailSuppressionModel.find({ email: { $in: normalized }, ...activeFilter() })
      .select({ email: 1 })
      .lean()
      .exec();
    const suppressedSet = new Set(docs.map((doc) => doc.email));
    return {
      allowed: normalized.filter((email) => !suppressedSet.has(email)),
      suppressed: normalized.filter((email) => suppressedSet.has(email)),
    };
  } catch (error) {
    logger.error("[EmailSuppression] 批量查询失败，按未抑制放行", {
      count: normalized.length,
      error: error instanceof Error ? error.message : String(error),
    });
    return { allowed: normalized, suppressed: [] };
  }
}

/**
 * 写入抑制名单（幂等 upsert）。返回 null 表示邮箱非法或 Mongo 不可用。
 * 已存在时只升级/刷新原因，不会因为重复事件把永久抑制改成带到期时间。
 */
export async function addSuppression(input: AddSuppressionInput): Promise<EmailSuppressionSummary | null> {
  const email = normalizeEmail(input.email);
  if (!email) return null;
  if (mongoose.connection.readyState !== 1) {
    logger.error("[EmailSuppression] Mongo 不可用，无法写入抑制名单", { email, reason: input.reason });
    return null;
  }

  try {
    // 注意：$set 与 $setOnInsert 不能同时命中同一字段（Mongo 会报 path conflict），
    // 所以 expiresAt 只在其中一侧出现。createdAt/updatedAt 交给 schema 的 timestamps 维护。
    const doc = await EmailSuppressionModel.findOneAndUpdate(
      { email },
      {
        $set: {
          reason: input.reason,
          source: input.source || "system",
          detail: (input.detail || "").slice(0, 500),
          ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
        },
        $setOnInsert: { ...(input.expiresAt ? {} : { expiresAt: null }) },
      },
      { upsert: true, returnDocument: "after" },
    )
      .lean()
      .exec();
    await cacheService.set(cacheKey(email), "1", CACHE_TTL_SUPPRESSED_MS);
    logger.info("[EmailSuppression] 已加入抑制名单", { email, reason: input.reason, source: input.source });
    return doc ? toSummary(doc as EmailSuppressionDoc & { createdAt?: Date; updatedAt?: Date }) : null;
  } catch (error) {
    logger.error("[EmailSuppression] 写入抑制名单失败", {
      email,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function removeSuppression(emailInput: unknown): Promise<boolean> {
  const email = normalizeEmail(emailInput);
  if (!email || mongoose.connection.readyState !== 1) return false;
  try {
    const result = await EmailSuppressionModel.deleteOne({ email }).exec();
    await cacheService.del(cacheKey(email));
    return (result?.deletedCount ?? 0) > 0;
  } catch (error) {
    logger.error("[EmailSuppression] 移除抑制记录失败", {
      email,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function listSuppressions(params: {
  page?: number;
  pageSize?: number;
  q?: string;
  reason?: string;
  activeOnly?: boolean;
}): Promise<{ items: EmailSuppressionSummary[]; total: number; page: number; pageSize: number; hasMore: boolean }> {
  const page = Number.isFinite(Number(params.page)) ? Math.max(1, Math.min(1000, Number(params.page))) : 1;
  const pageSize = Number.isFinite(Number(params.pageSize))
    ? Math.max(1, Math.min(200, Number(params.pageSize)))
    : 50;
  const query: any = {};
  if (params.activeOnly) {
    Object.assign(query, activeFilter());
  }
  if (params.reason && ["bounce", "complaint", "unsubscribe", "manual"].includes(params.reason)) {
    query.reason = params.reason;
  }
  const q = typeof params.q === "string" ? params.q.trim() : "";
  if (q) {
    query.email = { $regex: escapeRegexLiteral(q), $options: "i" };
  }

  const [items, total] = await Promise.all([
    EmailSuppressionModel.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .lean()
      .exec(),
    EmailSuppressionModel.countDocuments(query).exec(),
  ]);

  return {
    items: items.map((doc) => toSummary(doc as EmailSuppressionDoc & { createdAt?: Date; updatedAt?: Date })),
    total,
    page,
    pageSize,
    hasMore: page * pageSize < total,
  };
}

export async function getSuppressionStats(): Promise<{
  total: number;
  active: number;
  permanent: number;
  byReason: Array<{ reason: string; total: number }>;
  last7d: number;
  last24h: number;
}> {
  const now = new Date();
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const since7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // aggregate 的 pipeline 类型在 mongoose 里极窄，$facet/$group 的组合常误报；
  // 真伪由 CI 的集成测试与线上行为判定，这里不做类型体操。
  const [facet] = await EmailSuppressionModel.aggregate([
    {
      $facet: {
        total: [{ $count: "count" }],
        active: [{ $match: activeFilter() }, { $count: "count" }],
        permanent: [{ $match: { $or: [{ expiresAt: null }, { expiresAt: { $exists: false } }] } }, { $count: "count" }],
        byReason: [{ $group: { _id: "$reason", total: { $sum: 1 } } }, { $sort: { total: -1 } }],
        last24h: [{ $match: { createdAt: { $gte: since24h } } }, { $count: "count" }],
        last7d: [{ $match: { createdAt: { $gte: since7d } } }, { $count: "count" }],
      },
    },
  ] as any).exec();

  return {
    total: facet?.total?.[0]?.count ?? 0,
    active: facet?.active?.[0]?.count ?? 0,
    permanent: facet?.permanent?.[0]?.count ?? 0,
    byReason: (facet?.byReason ?? []).map((row: any) => ({ reason: row._id ?? "unknown", total: row.total })),
    last24h: facet?.last24h?.[0]?.count ?? 0,
    last7d: facet?.last7d?.[0]?.count ?? 0,
  };
}

// ==================== 退订 token（EM-2） ====================

function unsubscribeSecret(): string {
  const secret = (process.env.EMAIL_UNSUBSCRIBE_SECRET || startupConfig.jwtSecret || "").trim();
  if (!secret) {
    // 生产环境 JWT_SECRET 是启动必需项，这里只是防御性兜底：缺密钥时不生成/不接受 token，
    // 由调用方决定是否降级为「联系管理员退订」。
    throw new Error("未配置退订签名密钥（EMAIL_UNSUBSCRIBE_SECRET / JWT_SECRET）");
  }
  return secret;
}

function signUnsubscribeEmail(email: string): string {
  return crypto.createHmac("sha256", unsubscribeSecret()).update(email).digest("base64url");
}

/** 生成退订链接用的 token：`<base64url(email)>.<hmac>`，无状态、可校验、不可伪造。 */
export function buildUnsubscribeToken(emailInput: unknown): string | null {
  const email = normalizeEmail(emailInput);
  if (!email) return null;
  try {
    const payload = Buffer.from(email, "utf8").toString("base64url");
    return `${payload}.${signUnsubscribeEmail(email)}`;
  } catch (error) {
    logger.error("[EmailSuppression] 生成退订 token 失败", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** 校验退订 token，返回邮箱；无效/被篡改返回 null。 */
export function verifyUnsubscribeToken(token: unknown): string | null {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  let email: string;
  try {
    email = Buffer.from(payload, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const normalized = normalizeEmail(email);
  if (!normalized) return null;

  let expected: string;
  try {
    expected = signUnsubscribeEmail(normalized);
  } catch {
    return null;
  }
  const provided = Buffer.from(signature);
  const computed = Buffer.from(expected);
  if (provided.length !== computed.length) return null;
  if (!crypto.timingSafeEqual(provided, computed)) return null;
  return normalized;
}

/**
 * 由投递事件自动入名单（EM-1）。返回入名单的地址数量。
 * 软退信给 30 天观察期，硬退信/投诉永久。
 */
export async function suppressFromDeliveryEvent(params: {
  type: string;
  recipients: string[];
  detail?: string;
}): Promise<number> {
  const type = (params.type || "").toLowerCase();
  const isBounce = type.includes("bounce") || type.includes("delivery_delayed") || type.includes("failed");
  const isComplaint = type.includes("complaint") || type.includes("spam");
  if (!isBounce && !isComplaint) return 0;

  const detail = params.detail || "";
  const soft = /soft/i.test(detail) || type.includes("delivery_delayed");
  const expiresAt = isBounce && soft ? new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) : null;
  const reason: EmailSuppressionReason = isComplaint ? "complaint" : "bounce";

  let added = 0;
  for (const recipient of params.recipients) {
    const summary = await addSuppression({
      email: recipient,
      reason,
      source: "resend-webhook",
      detail,
      expiresAt,
    });
    if (summary) added += 1;
  }
  return added;
}
