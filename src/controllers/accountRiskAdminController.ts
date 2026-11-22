import type { NextFunction, Request, Response } from "express";
import { AccountIpSignal } from "../models/accountIpSignalModel";
import { SecurityEvent } from "../models/securityEventModel";
import { mongoose } from "../services/mongoService";
import { RuntimeConfigService } from "../services/runtimeConfigService";
import { UserModel } from "../services/userService";
import {
  ACCOUNT_ABUSE_EVENT_PREFIX,
  AUTOMATION_TRACE_EVENT,
} from "../services/accountRiskService";
import {
  ACCOUNT_RESTRICTED_CODE,
  ACCOUNT_RISK_SUPPORT_EMAIL,
  ACCOUNT_RISK_TIER_ORDER,
  ANONYMOUS_ABUSE_MAX_SCORE,
  PROBE_EXIT_MISMATCH_SCORE,
  resolveAccountRiskChannelDecision,
  type AccountRiskChannel,
  type AccountRiskTier,
} from "../utils/accountRiskScoring";
import { redactLogPayload } from "../utils/auditRedaction";
import { activeUserFilter } from "../utils/softDeleteState";
import { escapeRegexLiteral } from "../utils/regexEscape";
import logger from "../utils/logger";

/**
 * 账户风险与自动化信号的管理端只读数据源（页面 `/admin/account-risk`）。
 *
 * 为什么需要它：RC-14 / RC-15 / RC-20 / RC-26 / RC-38 / RC-56 / RC-57 与 RC-07 的处置出口
 * 都已经落地在后端，但此前只能从「用户列表」逐个人点开看，无法回答
 * 「今天有哪些账户因为 IDC 出口被升档」「某个 IP 被多少个账户共用」这类排查问题。
 *
 * 三条硬约束：
 *   1. 本文件**只读**。所有处置仍走 `applyAccountRiskAction` 这一个出口，
 *      面板不提供第二套写路径（页面里的处置动作调用的是用户管理页已有的批量动作）。
 *   2. 绝不在请求路径 `connectMongo()`：Mongo 未就绪回 503，不阻塞启动。
 *   3. PII 一律打码：IP 只留前两段、指纹只留前 12 位、`eventData` 递归过
 *      `redactLogPayload`（与日志同一份敏感字段名单）。原始值不随列表下发。
 *
 * 与审计模块的分工：这里只读 `security_events` 与 `account_ip_signals`，
 * 不依赖 `audit_logs` 的查询形状（审计模块正在独立演进）。
 */

type LooseDoc = Record<string, unknown>;

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;
/** 聚合查询的时间窗上限：超过半年的账户风险排查已不影响处置判断。 */
const MAX_SINCE_DAYS = 180;

const TIER_VALUES = new Set<string>([...ACCOUNT_RISK_TIER_ORDER]);
const ACCOUNT_STATUS_VALUES = new Set(["active", "suspended"]);
const ACCOUNT_SORT_VALUES = new Set(["risk_desc", "recent", "created"]);
const SIGNAL_SORT_VALUES = new Set(["recent", "oldest"]);

/** 处置记录类事件：与 `applyAccountRiskAction` 里的写入口径一一对应。 */
const RISK_ACTION_EVENTS = ["ACCOUNT_RISK_ACTION", "ACCOUNT_RISK_TIER_CHANGED"] as const;

const CHANNEL_VALUES: readonly AccountRiskChannel[] = [
  "tts_generate",
  "transcribe",
  "cdk_redeem",
  "file_upload",
  "librechat",
  "ticket",
];

function isMongoReady(): boolean {
  return mongoose.connection.readyState === 1;
}

function respondMongoUnavailable(res: Response): void {
  res.status(503).json({
    success: false,
    error: "数据库未连接，暂时无法读取账户风险数据。",
    code: "ACCOUNT_RISK_ADMIN_DB_UNAVAILABLE",
  });
}

/** 读查询参数：数组取首个，去空白。 */
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

function readBoolean(value: unknown): boolean {
  const raw = readParam(value).toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * 时间下界：接受 ISO 字符串或 `YYYY-MM-DD`；非法值返回 null（= 不设下界），
 * 但**永远**再按 `MAX_SINCE_DAYS` 收口，避免一次查询扫全表。
 */
function readSince(value: unknown): Date | null {
  const raw = readParam(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return null;
  const floor = Date.now() - MAX_SINCE_DAYS * DAY_MS;
  return new Date(Math.max(parsed, floor));
}

function readUntil(value: unknown): Date | null {
  const raw = readParam(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : new Date(parsed);
}

/** IPv4 保留前两段，IPv6 保留前两组；查不到返回 null（不返回空串，前端据此显示「-」）。 */
function maskIp(value: unknown): string | null {
  const ip = typeof value === "string" ? value.trim() : "";
  if (!ip || ip === "unknown") return null;
  if (ip.includes(".")) {
    const parts = ip.split(".");
    return parts.length === 4 ? `${parts[0]}.${parts[1]}.*.*` : "***";
  }
  if (ip.includes(":")) {
    const groups = ip.split(":").filter((group) => group.length > 0);
    return groups.length >= 2 ? `${groups[0]}:${groups[1]}::*` : "***";
  }
  return "***";
}

/** 设备指纹 / 哈希：只回前 12 位。 */
function maskHash(value: unknown): string | null {
  const hash = typeof value === "string" ? value.trim() : "";
  if (!hash) return null;
  return hash.length > 12 ? `${hash.slice(0, 12)}…` : hash;
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

function normalizeTier(value: unknown): AccountRiskTier {
  const raw = readParam(value).toLowerCase();
  return (TIER_VALUES.has(raw) ? raw : "normal") as AccountRiskTier;
}

/** `eventData` 递归脱敏：与日志共用同一份敏感字段名单，深度超限整块打码。 */
function sanitizeEventData(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") return value;
  const redacted = redactLogPayload({ data: value });
  return redacted.data ?? null;
}

interface SignalRow {
  id: string;
  eventType: string;
  userId: string | null;
  ip: string | null;
  deviceFingerprint: string | null;
  riskScore: number | null;
  anonymous: boolean;
  createdAt: string | null;
  eventData: unknown;
}

function toSignalRow(doc: LooseDoc): SignalRow {
  const eventData = doc.eventData as Record<string, unknown> | undefined;
  return {
    id: String(doc._id ?? ""),
    eventType: readString(doc.eventType),
    userId: readString(doc.userId) || null,
    ip: maskIp(doc.ipAddress),
    deviceFingerprint: maskHash(doc.deviceFingerprint),
    riskScore: readNumber(doc.riskScore),
    anonymous: eventData?.anonymous === true,
    createdAt: toIso(doc.createdAt),
    eventData: sanitizeEventData(doc.eventData),
  };
}

/** 账户列表行：只含风险处置需要的字段，密码/令牌类字段不在投影里出现。 */
function toAccountRow(doc: LooseDoc): Record<string, unknown> {
  const stepUpUntil = readNumber(doc.stepUpUntil) ?? 0;
  return {
    id: readString(doc.id),
    username: readString(doc.username) || null,
    email: readString(doc.email) || null,
    role: readString(doc.role) || "user",
    riskTier: readString(doc.riskTier) || "normal",
    riskScore: readNumber(doc.riskScore) ?? 0,
    riskFlags: Array.isArray(doc.riskFlags) ? (doc.riskFlags as string[]) : [],
    riskUpdatedAt: toIso(doc.riskUpdatedAt),
    flaggedBy: readString(doc.flaggedBy) || null,
    flagReason: readString(doc.flagReason) || null,
    accountStatus: readString(doc.accountStatus) === "suspended" ? "suspended" : "active",
    stepUpUntil: stepUpUntil > 0 ? toIso(stepUpUntil) : null,
    stepUpMode: readString(doc.stepUpMode) || null,
    lastLoginIp: maskIp(doc.lastLoginIp),
    lastLoginAt: toIso(doc.lastLoginAt),
    createdAt: toIso(doc.createdAt),
  };
}

function toIpFactRow(doc: LooseDoc): Record<string, unknown> {
  return {
    id: String(doc._id ?? ""),
    userId: readString(doc.userId) || null,
    ip: maskIp(doc.ipAddress),
    ipLocation: readString(doc.ipLocation) || null,
    loginCount: readNumber(doc.loginCount) ?? 0,
    riskScore: readNumber(doc.riskScore),
    riskLevel: readString(doc.riskLevel) || null,
    flags: Array.isArray(doc.flags) ? (doc.flags as string[]) : [],
    networkType: readString(doc.networkType) || null,
    asn: readString(doc.asn) || null,
    organisation: readString(doc.organisation) || null,
    isDatacenter: doc.isDatacenter === true,
    source: readString(doc.source) || "unavailable",
    riskCheckedAt: toIso(doc.riskCheckedAt),
    firstSeenAt: toIso(doc.firstSeenAt),
    lastSeenAt: toIso(doc.lastSeenAt),
  };
}

/** 账户风险页依赖的索引清单（运维核对用；缺失时返回缺项而不是静默降级）。 */
const EXPECTED_USER_INDEXES = [
  "riskTier_1",
  "riskTier_1_riskUpdatedAt_-1",
  "riskScore_-1",
];

async function readUserIndexNames(): Promise<string[]> {
  try {
    const raw = await UserModel.collection.indexes();
    // 显式标注：`indexes()` 的返回类型依赖 mongoose 版本，不写死泛型避免升级后静默变 any。
    return raw.map((index: { name?: string }) => String(index.name ?? ""));
  } catch (error) {
    logger.warn("[AccountRiskAdmin] 读取 user_datas 索引失败", {
      errorType: error instanceof Error ? error.name : "unknown",
    });
    return [];
  }
}

/**
 * 账户风险配置视图：既给「当前生效值」，也给「评分权重」和「通道株连矩阵」。
 * 权重不是可在线修改的配置项（写在 `accountRiskScoring` 里），所以这里标注为常量。
 */
function buildConfigView() {
  const config = RuntimeConfigService.getCachedConfig().accountRisk;
  const channels = CHANNEL_VALUES.map((channel) => ({
    channel,
    byTier: ACCOUNT_RISK_TIER_ORDER.map((tier) => ({
      tier,
      ...resolveAccountRiskChannelDecision({ tier, channel, source: "account_risk" }),
    })),
  }));

  return {
    config,
    /** 评分权重：常量，改它们要改代码（见 utils/accountRiskScoring.ts）。 */
    weights: {
      anonymousAbuseMaxScore: ANONYMOUS_ABUSE_MAX_SCORE,
      probeExitMismatchScore: PROBE_EXIT_MISMATCH_SCORE,
      automationHintScore: 8,
      geoJumpScore: 10,
      note: "分数越高越危险；与账户安全摘要（越高越安全）方向相反，勿混用。",
    },
    channelMatrix: channels,
    restrictedCode: ACCOUNT_RESTRICTED_CODE,
    supportEmail: ACCOUNT_RISK_SUPPORT_EMAIL,
    /** 有哪些信号类型会被聚合：前端筛选下拉据此生成，避免两处清单漂移。 */
    eventPrefix: ACCOUNT_ABUSE_EVENT_PREFIX,
    automationEvent: AUTOMATION_TRACE_EVENT,
  };
}

export class AccountRiskAdminController {
  /** GET /api/admin/account-risk/overview —— 分布、24h 信号计数、Top 旗标、最近处置。 */
  static async getOverview(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!isMongoReady()) {
        respondMongoUnavailable(res);
        return;
      }

      const now = Date.now();
      const since = new Date(now - DAY_MS);
      const activeFilter = activeUserFilter();

      const [
        tierCounts,
        statusCounts,
        stepUpPending,
        signals24h,
        signalsByType,
        topFlags,
        recentActions,
        ipFactTotal,
        ipFactDatacenter,
        indexNames,
      ] = await Promise.all([
        UserModel.aggregate([
          { $match: activeFilter },
          { $group: { _id: "$riskTier", count: { $sum: 1 } } },
        ]).exec(),
        UserModel.aggregate([
          { $match: activeFilter },
          { $group: { _id: "$accountStatus", count: { $sum: 1 } } },
        ]).exec(),
        UserModel.countDocuments({ ...activeFilter, stepUpUntil: { $gt: now } }).exec(),
        SecurityEvent.countDocuments({ createdAt: { $gte: since } }).exec(),
        SecurityEvent.aggregate([
          { $match: { createdAt: { $gte: since } } },
          { $group: { _id: "$eventType", count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 20 },
        ]).exec(),
        UserModel.aggregate([
          { $match: { ...activeFilter, "riskFlags.0": { $exists: true } } },
          { $unwind: "$riskFlags" },
          { $group: { _id: "$riskFlags", count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 20 },
        ]).exec(),
        SecurityEvent.find({ eventType: { $in: [...RISK_ACTION_EVENTS] } })
          .sort({ createdAt: -1 })
          .limit(10)
          .lean()
          .exec(),
        AccountIpSignal.countDocuments({}).exec(),
        AccountIpSignal.countDocuments({ isDatacenter: true }).exec(),
        readUserIndexNames(),
      ]);

      const tiers = Object.fromEntries(ACCOUNT_RISK_TIER_ORDER.map((tier) => [tier, 0])) as Record<string, number>;
      for (const row of toLooseDocs(tierCounts)) {
        const key = readString(row._id) || "normal";
        tiers[key] = readNumber(row.count) ?? 0;
      }

      const statuses = { active: 0, suspended: 0 } as Record<string, number>;
      for (const row of toLooseDocs(statusCounts)) {
        const key = readString(row._id) || "active";
        statuses[key] = readNumber(row.count) ?? 0;
      }

      // 24 小时按具体事件类型的计数，缺项补 0（前端指标卡需要稳定字段，不靠 undefined 兜底）。
      const byType = new Map<string, number>();
      for (const row of toLooseDocs(signalsByType)) {
        byType.set(readString(row._id), readNumber(row.count) ?? 0);
      }
      const countOf = (type: string) => byType.get(type) ?? 0;

      const events24h = {
        total: signals24h,
        idcEgress: countOf(`${ACCOUNT_ABUSE_EVENT_PREFIX}_IDC_EGRESS`),
        geoJump: countOf(`${ACCOUNT_ABUSE_EVENT_PREFIX}_GEO_JUMP`),
        captchaFailed: countOf(`${ACCOUNT_ABUSE_EVENT_PREFIX}_CAPTCHA_FAILED`),
        automationTrace: countOf(AUTOMATION_TRACE_EVENT),
        riskActions: RISK_ACTION_EVENTS.reduce((sum, type) => sum + countOf(type), 0),
      };

      res.setHeader("Cache-Control", "no-store");
      res.json({
        success: true,
        generatedAt: new Date(now).toISOString(),
        accounts: {
          total: Object.values(tiers).reduce((sum, value) => sum + value, 0),
          tiers,
          statuses,
          stepUpPending,
        },
        events24h,
        signalsByType: toLooseDocs(signalsByType).map((row) => ({
          eventType: readString(row._id),
          count: readNumber(row.count) ?? 0,
        })),
        topFlags: toLooseDocs(topFlags).map((row) => ({
          flag: readString(row._id),
          count: readNumber(row.count) ?? 0,
        })),
        recentActions: toLooseDocs(recentActions).map((doc) => {
          const row = toSignalRow(doc);
          return {
            id: row.id,
            eventType: row.eventType,
            userId: row.userId,
            createdAt: row.createdAt,
            eventData: row.eventData,
          };
        }),
        ipFacts: {
          total: ipFactTotal,
          datacenter: ipFactDatacenter,
        },
        indexes: {
          names: indexNames,
          missing: EXPECTED_USER_INDEXES.filter((name) => !indexNames.includes(name)),
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /** GET /api/admin/account-risk/accounts —— 账户风险档列表（筛选/排序/分页全部下推 Mongo）。 */
  static async listAccounts(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!isMongoReady()) {
        respondMongoUnavailable(res);
        return;
      }

      const limit = readLimit(req.query.limit);
      const offset = readOffset(req.query.offset);
      const q = readParam(req.query.q);
      const tier = readParam(req.query.tier).toLowerCase();
      const status = readParam(req.query.status).toLowerCase();
      const flag = readParam(req.query.flag);
      const sortRaw = readParam(req.query.sort).toLowerCase();
      const sort = ACCOUNT_SORT_VALUES.has(sortRaw) ? sortRaw : "risk_desc";

      const match: Record<string, unknown> = { ...activeUserFilter() };
      if (TIER_VALUES.has(tier)) match.riskTier = tier;
      if (ACCOUNT_STATUS_VALUES.has(status)) {
        match.accountStatus = status === "suspended" ? "suspended" : { $in: ["active", null] };
      }
      if (flag) match.riskFlags = flag;
      if (q) {
        const pattern = new RegExp(escapeRegexLiteral(q), "i");
        match.$or = [{ username: pattern }, { email: pattern }, { id: q }];
      }

      const sortSpec: Record<string, 1 | -1> =
        sort === "recent"
          ? { riskUpdatedAt: -1, createdAt: -1 }
          : sort === "created"
            ? { createdAt: -1 }
            : { riskScore: -1, riskUpdatedAt: -1 };

      const [docs, total] = await Promise.all([
        UserModel.find(match)
          .select(
            "id username email role riskTier riskScore riskFlags riskUpdatedAt flaggedBy flagReason accountStatus stepUpUntil stepUpMode lastLoginIp lastLoginAt createdAt",
          )
          .sort(sortSpec)
          .skip(offset)
          .limit(limit)
          .lean()
          .exec(),
        UserModel.countDocuments(match).exec(),
      ]);

      res.setHeader("Cache-Control", "no-store");
      res.json({
        success: true,
        total,
        limit,
        offset,
        filters: { q, tier: TIER_VALUES.has(tier) ? tier : "", status: ACCOUNT_STATUS_VALUES.has(status) ? status : "", flag, sort },
        accounts: toLooseDocs(docs).map(toAccountRow),
      });
    } catch (error) {
      next(error);
    }
  }

  /** GET /api/admin/account-risk/signals —— 账户级信号（`security_events`）。 */
  static async listSignals(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!isMongoReady()) {
        respondMongoUnavailable(res);
        return;
      }

      const limit = readLimit(req.query.limit);
      const offset = readOffset(req.query.offset);
      const userId = readParam(req.query.userId);
      const eventType = readParam(req.query.eventType);
      const ip = readParam(req.query.ip);
      const since = readSince(req.query.since);
      const until = readUntil(req.query.until);
      const anonymousOnly = readBoolean(req.query.anonymous);
      const sortRaw = readParam(req.query.sort).toLowerCase();
      const sort = SIGNAL_SORT_VALUES.has(sortRaw) ? sortRaw : "recent";

      const match: Record<string, unknown> = {};
      if (userId) match.userId = userId;
      if (eventType) match.eventType = eventType;
      if (ip) match.ipAddress = ip;
      if (anonymousOnly) match["eventData.anonymous"] = true;
      if (since || until) {
        const range: Record<string, Date> = {};
        if (since) range.$gte = since;
        if (until) range.$lte = until;
        match.createdAt = range;
      }

      const [docs, total] = await Promise.all([
        SecurityEvent.find(match)
          .select("eventType userId ipAddress deviceFingerprint riskScore eventData createdAt")
          .sort({ createdAt: sort === "oldest" ? 1 : -1 })
          .skip(offset)
          .limit(limit)
          .lean()
          .exec(),
        SecurityEvent.countDocuments(match).exec(),
      ]);

      res.setHeader("Cache-Control", "no-store");
      res.json({
        success: true,
        total,
        limit,
        offset,
        filters: {
          userId,
          eventType,
          ip,
          anonymous: anonymousOnly,
          since: since ? since.toISOString() : null,
          until: until ? until.toISOString() : null,
          sort,
        },
        signals: toLooseDocs(docs).map(toSignalRow),
      });
    } catch (error) {
      next(error);
    }
  }

  /** GET /api/admin/account-risk/ip-facts —— 账户 × 登录 IP 事实（`account_ip_signals`）。 */
  static async listIpFacts(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!isMongoReady()) {
        respondMongoUnavailable(res);
        return;
      }

      const limit = readLimit(req.query.limit);
      const offset = readOffset(req.query.offset);
      const userId = readParam(req.query.userId);
      const ip = readParam(req.query.ip);
      const datacenter = readParam(req.query.datacenter).toLowerCase();
      const level = readParam(req.query.level);
      const since = readSince(req.query.since);

      const match: Record<string, unknown> = {};
      if (userId) match.userId = userId;
      if (ip) match.ipAddress = ip;
      if (datacenter === "true") match.isDatacenter = true;
      if (datacenter === "false") match.isDatacenter = { $ne: true };
      if (level) match.riskLevel = level;
      if (since) match.lastSeenAt = { $gte: since };

      const [docs, total] = await Promise.all([
        AccountIpSignal.find(match)
          .select(
            "userId ipAddress ipLocation loginCount riskScore riskLevel flags networkType asn organisation isDatacenter source riskCheckedAt firstSeenAt lastSeenAt",
          )
          .sort({ lastSeenAt: -1 })
          .skip(offset)
          .limit(limit)
          .lean()
          .exec(),
        AccountIpSignal.countDocuments(match).exec(),
      ]);

      res.setHeader("Cache-Control", "no-store");
      res.json({
        success: true,
        total,
        limit,
        offset,
        filters: { userId, ip, datacenter, level, since: since ? since.toISOString() : null },
        ipFacts: toLooseDocs(docs).map(toIpFactRow),
      });
    } catch (error) {
      next(error);
    }
  }

  /** GET /api/admin/account-risk/actions —— 处置记录（风险动作 + 档位变化）。 */
  static async listActions(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!isMongoReady()) {
        respondMongoUnavailable(res);
        return;
      }

      const limit = readLimit(req.query.limit);
      const offset = readOffset(req.query.offset);
      const userId = readParam(req.query.userId);
      const action = readParam(req.query.action);
      const operatorId = readParam(req.query.operatorId);
      const since = readSince(req.query.since);
      const until = readUntil(req.query.until);

      const match: Record<string, unknown> = { eventType: { $in: [...RISK_ACTION_EVENTS] } };
      if (userId) match.userId = userId;
      if (action) match["eventData.action"] = action;
      if (operatorId) match["eventData.operatorId"] = operatorId;
      if (since || until) {
        const range: Record<string, Date> = {};
        if (since) range.$gte = since;
        if (until) range.$lte = until;
        match.createdAt = range;
      }

      const [docs, total] = await Promise.all([
        SecurityEvent.find(match)
          .select("eventType userId ipAddress riskScore eventData createdAt")
          .sort({ createdAt: -1 })
          .skip(offset)
          .limit(limit)
          .lean()
          .exec(),
        SecurityEvent.countDocuments(match).exec(),
      ]);

      res.setHeader("Cache-Control", "no-store");
      res.json({
        success: true,
        total,
        limit,
        offset,
        filters: { userId, action, operatorId, since: since ? since.toISOString() : null, until: until ? until.toISOString() : null },
        actions: toLooseDocs(docs).map((doc) => {
          const row = toSignalRow(doc);
          const data = (row.eventData ?? {}) as Record<string, unknown>;
          return {
            id: row.id,
            eventType: row.eventType,
            userId: row.userId,
            createdAt: row.createdAt,
            action: readString(data.action) || null,
            fromTier: readString(data.fromTier) || null,
            toTier: readString(data.toTier) || readString(data.tier) || null,
            operatorId: readString(data.operatorId) || null,
            reason: readString(data.reason) || null,
            automatic: readString(data.operatorId) === "auto",
            eventData: row.eventData,
          };
        }),
      });
    } catch (error) {
      next(error);
    }
  }

  /** GET /api/admin/account-risk/config —— 运行时配置 + 权重常量 + 通道株连矩阵（只读）。 */
  static async getConfig(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      res.setHeader("Cache-Control", "no-store");
      res.json({ success: true, ...buildConfigView() });
    } catch (error) {
      next(error);
    }
  }

  /** GET /api/admin/account-risk/accounts/:id —— 单个账户的风险详情（含最近信号与 IP 事实）。 */
  static async getAccountDetail(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!isMongoReady()) {
        respondMongoUnavailable(res);
        return;
      }

      const userId = readParam(req.params.id);
      if (!userId) {
        res.status(400).json({ success: false, error: "缺少用户 ID", code: "ACCOUNT_RISK_USER_ID_REQUIRED" });
        return;
      }

      const since = new Date(Date.now() - 30 * DAY_MS);
      const [doc, signals, ipFacts, actions] = await Promise.all([
        UserModel.findOne({ id: userId, ...activeUserFilter() })
          .select(
            "id username email role riskTier riskScore riskFlags riskUpdatedAt flaggedBy flagReason accountStatus stepUpUntil stepUpMode lastLoginIp lastLoginAt createdAt",
          )
          .lean()
          .exec(),
        SecurityEvent.find({ userId, createdAt: { $gte: since } })
          .select("eventType userId ipAddress deviceFingerprint riskScore eventData createdAt")
          .sort({ createdAt: -1 })
          .limit(50)
          .lean()
          .exec(),
        AccountIpSignal.find({ userId })
          .select(
            "userId ipAddress ipLocation loginCount riskScore riskLevel flags networkType asn organisation isDatacenter source riskCheckedAt firstSeenAt lastSeenAt",
          )
          .sort({ lastSeenAt: -1 })
          .limit(50)
          .lean()
          .exec(),
        SecurityEvent.find({ userId, eventType: { $in: [...RISK_ACTION_EVENTS] } })
          .select("eventType userId eventData createdAt")
          .sort({ createdAt: -1 })
          .limit(30)
          .lean()
          .exec(),
      ]);

      if (!doc) {
        res.status(404).json({ success: false, error: "用户不存在或已被软删除", code: "ACCOUNT_RISK_USER_NOT_FOUND" });
        return;
      }

      const row = toAccountRow(doc as unknown as LooseDoc);
      const tier = normalizeTier(row.riskTier);
      res.setHeader("Cache-Control", "no-store");
      res.json({
        success: true,
        account: row,
        channels: CHANNEL_VALUES.map((channel) => ({
          channel,
          ...resolveAccountRiskChannelDecision({ tier, channel, source: "account_risk" }),
        })),
        signals: toLooseDocs(signals).map(toSignalRow),
        ipFacts: toLooseDocs(ipFacts).map(toIpFactRow),
        actions: toLooseDocs(actions).map((actionDoc) => {
          const raw = (actionDoc.eventData ?? {}) as Record<string, unknown>;
          return {
            id: String(actionDoc._id ?? ""),
            eventType: readString(actionDoc.eventType),
            createdAt: toIso(actionDoc.createdAt),
            action: readString(raw.action) || null,
            fromTier: readString(raw.fromTier) || null,
            toTier: readString(raw.toTier) || readString(raw.tier) || null,
            operatorId: readString(raw.operatorId) || null,
            reason: readString(raw.reason) || null,
          };
        }),
      });
    } catch (error) {
      next(error);
    }
  }
}
