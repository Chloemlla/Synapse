import type { NextFunction, Request, Response } from "express";
import { PolicyConsent } from "../../models/policyConsentModel";
import { mongoose } from "../../services/mongoService";
import {
  CONSENT_VALIDITY_DAYS,
  CURRENT_POLICY_VERSION,
  POLICY_AGREEMENT_KEYS,
} from "../../services/policyConsentService";

/**
 * 隐私政策同意记录只读面板的数据源（超级管理员专用，全部 GET）。
 *
 * 挂载点：/api/admin（src/routes/admin/index.ts）。数据源是 policy_consents 集合，
 * 由 policyConsentService.writePolicyConsent 单点写入（登录 / 注册 / TTS 门禁）。
 * 面板要回答的四个问题：库里现在存了多少条有效/过期/已撤销同意、按版本与来源怎么分布、
 * 每一条记录归属哪个设备指纹与 IP、勾选了哪几份文件、什么时候到期、同意的是哪份条文。
 *
 * 两条硬约束（沿用同目录 proxycheck 面板的口径）：
 *   1. 绝不在请求路径 connectMongo()：Mongo 未就绪回 503，不隐式建连。
 *   2. checksum / documentHash 是记录未被外部改写的服务端标记，对运维只需「有没有」即可，
 *      因此只回前 12 位预览，不整段下发。
 */

type LooseDoc = Record<string, unknown>;

const DAY_MS = 24 * 60 * 60 * 1000;
const COLLECTION_NAME = "policy_consents";
/** 版本 / 来源分布聚合的护栏：正常只有个位数的版本与来源取值。 */
const MAX_GROUP_ROWS = 100;
const CHECKSUM_PREVIEW_LEN = 12;
/** 导出上限：面板是运维对账工具，不需要把整库（可能有几十万行）拉成 CSV。 */
const EXPORT_MAX_ROWS = 5000;
/** 趋势窗口默认与上限（天） */
const DEFAULT_TREND_DAYS = 7;
const MAX_TREND_DAYS = 90;

function isMongoReady(): boolean {
  return mongoose.connection.readyState === 1;
}

function respondMongoUnavailable(res: Response): void {
  res.status(503).json({ success: false, message: "数据库未连接，无法读取同意记录" });
}

function readRawString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function toIso(value: unknown): string | null {
  return readDate(value)?.toISOString() ?? null;
}

function toLooseDocs(docs: unknown): LooseDoc[] {
  return Array.isArray(docs) ? (docs as LooseDoc[]) : [];
}

/** 分页参数：limit 收敛到 [1,200]，offset 非负。 */
function parsePaging(query: Record<string, unknown>): { limit: number; offset: number } {
  const rawLimit = Number(query.limit);
  const rawOffset = Number(query.offset);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.trunc(rawLimit), 1), 200) : 50;
  const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.trunc(rawOffset) : 0;
  return { limit, offset };
}

/** 指纹/IP 精确匹配用；只接受非空短字符串，避免把整段正则塞进查询。 */
function parseExactMatch(value: unknown, maxLen: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLen) return null;
  return trimmed;
}

type ConsentState = "valid" | "expired" | "all";

function parseState(value: unknown): ConsentState {
  return value === "expired" || value === "all" ? value : "valid";
}

/** 趋势窗口：默认 7 天，收敛到 [1, 90]。 */
function parseTrendDays(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_TREND_DAYS;
  return Math.min(Math.max(Math.trunc(parsed), 1), MAX_TREND_DAYS);
}

/**
 * `from` / `to` 支持 ISO 与 YYYY-MM-DD（后者按当天边界取整）。
 * 解析失败一律忽略而不是报 400：这是查询型接口，多余参数不应该让整张表打不开。
 */
function parseDateBound(value: unknown, endOfDay: boolean): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const raw = value.trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const parsed = new Date(dateOnly && endOfDay ? `${raw}T23:59:59.999Z` : raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** 逐条记录筛选条件（列表与导出共用，保证「导出的是什么就是看到的什么」）。 */
interface ConsentFilters {
  state: ConsentState;
  fingerprint: string | null;
  ipAddress: string | null;
  version: string | null;
  source: string | null;
  from: Date | null;
  to: Date | null;
  agreementsIncomplete: boolean;
}

function parseConsentFilters(query: Record<string, unknown>, defaultState: ConsentState): ConsentFilters {
  return {
    state: parseState(query.state ?? defaultState),
    fingerprint: parseExactMatch(query.fingerprint, 100),
    ipAddress: parseExactMatch(query.ip, 64),
    version: parseExactMatch(query.version, 50),
    source: parseExactMatch(query.source, 32),
    from: parseDateBound(query.from, false),
    to: parseDateBound(query.to, true),
    agreementsIncomplete: query.agreementsIncomplete === "true" || query.agreementsIncomplete === "1",
  };
}

function buildConsentFilter(filters: ConsentFilters, now: Date): any {
  const filter: Record<string, any> = { ...buildStateFilter(filters.state, now) };
  if (filters.fingerprint) filter.fingerprint = filters.fingerprint;
  if (filters.ipAddress) filter.ipAddress = filters.ipAddress;
  if (filters.version) filter.version = filters.version;
  if (filters.source) filter.source = filters.source;

  if (filters.from || filters.to) {
    const recordedAt: Record<string, Date> = {};
    if (filters.from) recordedAt.$gte = filters.from;
    if (filters.to) recordedAt.$lte = filters.to;
    filter.recordedAt = recordedAt;
  }

  if (filters.agreementsIncomplete) {
    // 勾选不完整：缺 agreements 字段（agreements 引入前的老记录），或没有覆盖全部四份文件。
    // 这类记录不会被门禁当作有效同意（见 hasValidPolicyConsent），面板需要能一眼筛出来。
    filter.$and = [
      {
        $or: [
          { agreements: { $exists: false } },
          { agreements: { $not: { $all: [...POLICY_AGREEMENT_KEYS] } } },
        ],
      },
    ];
  }

  return filter;
}

interface ConsentRow {
  id: string;
  version: string;
  fingerprint: string;
  ipAddress: string;
  userAgent: string;
  source: string;
  agreements: string[];
  /** 是否勾满 POLICY_AGREEMENT_KEYS 全部四项（老记录可能没有 agreements 字段）。 */
  agreementsComplete: boolean;
  isValid: boolean;
  expired: boolean;
  checksumPreview: string;
  /** 同意时的条文指纹前 12 位（与当前条文对账用） */
  documentHashPreview: string;
  /** 未勾选的文件键名（空数组 = 四份齐全） */
  missingAgreements: string[];
  revokedAt: string | null;
  revokedIP: string;
  revokedReason: string;
  recordedAt: string | null;
  expiresAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

function toConsentRow(doc: LooseDoc, now: Date): ConsentRow {
  const expiresAt = readDate(doc.expiresAt);
  const rawAgreements = Array.isArray(doc.agreements)
    ? (doc.agreements as unknown[]).filter((item): item is string => typeof item === "string")
    : [];
  const checksum = readRawString(doc.checksum);

  return {
    id: readRawString(doc.id) || String(doc._id ?? ""),
    version: readRawString(doc.version),
    fingerprint: readRawString(doc.fingerprint),
    ipAddress: readRawString(doc.ipAddress),
    userAgent: readRawString(doc.userAgent),
    source: readRawString(doc.source),
    agreements: rawAgreements,
    agreementsComplete: POLICY_AGREEMENT_KEYS.every((key) => rawAgreements.includes(key)),
    missingAgreements: POLICY_AGREEMENT_KEYS.filter((key) => !rawAgreements.includes(key)),
    isValid: doc.isValid === true,
    expired: expiresAt === null || expiresAt.getTime() <= now.getTime(),
    checksumPreview: checksum ? checksum.slice(0, CHECKSUM_PREVIEW_LEN) : "",
    documentHashPreview: readRawString(doc.documentHash).slice(0, CHECKSUM_PREVIEW_LEN),
    revokedAt: toIso(doc.revokedAt),
    revokedIP: readRawString(doc.revokedIP),
    revokedReason: readRawString(doc.revokedReason),
    recordedAt: toIso(doc.recordedAt),
    expiresAt: toIso(doc.expiresAt),
    createdAt: toIso(doc.createdAt),
    updatedAt: toIso(doc.updatedAt),
  };
}

/** state → mongo 过滤：valid = isValid 且未过期；expired = 已过期或已置无效。 */
function buildStateFilter(state: ConsentState, now: Date): Record<string, unknown> {
  if (state === "valid") return { isValid: true, expiresAt: { $gt: now } };
  if (state === "expired") return { $or: [{ isValid: false }, { expiresAt: { $lte: now } }] };
  return {};
}

interface GroupRow {
  key: string;
  count: number;
}

function normalizeGroupRows(docs: unknown): GroupRow[] {
  return toLooseDocs(docs).map((doc) => ({
    key: readRawString(doc._id) || "(未知)",
    count: readFiniteNumber(doc.count, 0),
  }));
}

/** CSV 单元格转义：含分隔符 / 引号 / 换行时加引号并把内部引号翻倍。 */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export class PolicyConsentLogController {
  /** GET /api/admin/policy-consents/overview —— 计数 + 版本/来源分布 + 趋势（窗口由 days 控制）。 */
  static async getOverview(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!isMongoReady()) {
        respondMongoUnavailable(res);
        return;
      }

      const now = new Date();
      const trendDays = parseTrendDays((req.query as Record<string, unknown>).days);
      const trendSince = new Date(now.getTime() - trendDays * DAY_MS);

      const [total, valid, expired, revoked, versionGroups, sourceGroups, recentTrend, collectionInfo] =
        await Promise.all([
          PolicyConsent.countDocuments({}).exec(),
          PolicyConsent.countDocuments({ isValid: true, expiresAt: { $gt: now } }).exec(),
          PolicyConsent.countDocuments({
            $or: [{ isValid: false }, { expiresAt: { $lte: now } }],
          }).exec(),
          // 已撤销（含被重新同意顶替前的手动撤回）：revokedAt 现在真会落库（schema 已声明）
          PolicyConsent.countDocuments({ revokedAt: { $ne: null } }).exec(),
          PolicyConsent.aggregate([
            { $group: { _id: "$version", count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: MAX_GROUP_ROWS },
          ]).exec(),
          PolicyConsent.aggregate([
            { $group: { _id: "$source", count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: MAX_GROUP_ROWS },
          ]).exec(),
          PolicyConsent.aggregate([
            { $match: { recordedAt: { $gte: trendSince } } },
            {
              $group: {
                _id: { $dateToString: { format: "%Y-%m-%d", date: "$recordedAt" } },
                count: { $sum: 1 },
              },
            },
            { $sort: { _id: 1 } },
          ]).exec(),
          readCollectionInfo(),
        ]);

      res.setHeader("Cache-Control", "no-store");
      res.json({
        success: true,
        currentVersion: CURRENT_POLICY_VERSION,
        validityDays: CONSENT_VALIDITY_DAYS,
        agreementKeys: [...POLICY_AGREEMENT_KEYS],
        counts: { total, valid, expired, revoked },
        versions: normalizeGroupRows(versionGroups),
        sources: normalizeGroupRows(sourceGroups),
        trendDays,
        recentTrend: toLooseDocs(recentTrend).map((doc) => ({
          date: readRawString(doc._id),
          count: readFiniteNumber(doc.count, 0),
        })),
        collection: collectionInfo,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/admin/policy-consents —— 逐条同意记录
   * （分页 + 指纹/IP/版本/来源/状态/时间范围/勾选完整性 筛选）。
   */
  static async listConsents(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!isMongoReady()) {
        respondMongoUnavailable(res);
        return;
      }

      const query = req.query as Record<string, unknown>;
      const { limit, offset } = parsePaging(query);
      const now = new Date();
      const filters = parseConsentFilters(query, "valid");
      const filter = buildConsentFilter(filters, now);

      const [docs, total] = await Promise.all([
        PolicyConsent.find(filter)
          .sort({ recordedAt: -1 })
          .skip(offset)
          .limit(limit)
          .lean()
          .exec(),
        PolicyConsent.countDocuments(filter).exec(),
      ]);

      const consents = toLooseDocs(docs).map((doc) => toConsentRow(doc, now));

      res.setHeader("Cache-Control", "no-store");
      res.json({
        success: true,
        consents,
        total,
        limit,
        offset,
        filters: {
          fingerprint: filters.fingerprint,
          ip: filters.ipAddress,
          version: filters.version,
          source: filters.source,
          state: filters.state,
          from: filters.from ? filters.from.toISOString() : null,
          to: filters.to ? filters.to.toISOString() : null,
          agreementsIncomplete: filters.agreementsIncomplete,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/admin/policy-consents/export —— 按与列表相同的筛选导出 CSV（上限 5000 行）。
   * 导出内容含设备指纹与 IP，因此：superadmin 专属 + 路由上挂审计留痕 + 单次行数封顶。
   * 默认 state=all（导出就是要把过期/已撤销一并带走，否则合规对账会漏样本）。
   */
  static async exportConsents(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!isMongoReady()) {
        respondMongoUnavailable(res);
        return;
      }

      const query = req.query as Record<string, unknown>;
      const now = new Date();
      const filters = parseConsentFilters(query, "all");
      const filter = buildConsentFilter(filters, now);

      // 多取一行用于判定「是否被上限截断」，避免与 countDocuments 再打一次库
      const docs = await PolicyConsent.find(filter)
        .sort({ recordedAt: -1 })
        .limit(EXPORT_MAX_ROWS + 1)
        .lean()
        .exec();

      const rows = toLooseDocs(docs);
      const truncated = rows.length > EXPORT_MAX_ROWS;
      const rowsToWrite = truncated ? rows.slice(0, EXPORT_MAX_ROWS) : rows;

      const header = [
        "同意时间",
        "状态",
        "版本",
        "来源",
        "设备指纹",
        "IP",
        "已勾选文件",
        "缺失文件",
        "到期时间",
        "撤回时间",
        "撤回IP",
        "撤回原因",
        "条文指纹",
        "checksum",
        "User-Agent",
      ];

      const lines = [header.map(csvCell).join(",")];
      for (const doc of rowsToWrite) {
        const row = toConsentRow(doc, now);
        const state = !row.isValid ? "已失效" : row.expired ? "已过期" : "有效";
        lines.push(
          [
            row.recordedAt ?? "",
            state,
            row.version,
            row.source,
            row.fingerprint,
            row.ipAddress,
            row.agreements.join("|"),
            row.missingAgreements.join("|"),
            row.expiresAt ?? "",
            row.revokedAt ?? "",
            row.revokedIP,
            row.revokedReason,
            row.documentHashPreview ? `${row.documentHashPreview}…` : "",
            row.checksumPreview ? `${row.checksumPreview}…` : "",
            row.userAgent,
          ]
            .map(csvCell)
            .join(","),
        );
      }

      const stamp = now.toISOString().replace(/[:.]/g, "-");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="policy-consents-${stamp}.csv"`);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Export-Rows", String(rowsToWrite.length));
      res.setHeader("X-Export-Truncated", truncated ? "true" : "false");
      // BOM：Excel 直接打开 UTF-8 CSV 时不至于把中文显示成乱码
      res.send(`\uFEFF${lines.join("\r\n")}\r\n`);
    } catch (error) {
      next(error);
    }
  }
}

interface CollectionInfo {
  name: string;
  indexes: string[];
  exists: boolean;
}

/** 索引名 + TTL / unique 标记，与 proxycheck 面板同口径：运维需要「有没有 TTL」这个信息。 */
function describeIndex(index: unknown): string {
  const info = (index ?? {}) as Record<string, unknown>;
  const name = readRawString(info.name);
  if (!name) return "";
  const markers: string[] = [];
  if (typeof info.expireAfterSeconds === "number") markers.push(`TTL=${info.expireAfterSeconds}s`);
  if (info.unique === true) markers.push("unique");
  return markers.length ? `${name} (${markers.join(", ")})` : name;
}

async function readCollectionInfo(): Promise<CollectionInfo> {
  const db = mongoose.connection.db;
  if (!db) return { name: COLLECTION_NAME, indexes: [], exists: false };
  try {
    const indexes = await db.collection(COLLECTION_NAME).listIndexes().toArray();
    return {
      name: COLLECTION_NAME,
      indexes: indexes.map(describeIndex).filter((entry) => entry.length > 0),
      exists: true,
    };
  } catch {
    return { name: COLLECTION_NAME, indexes: [], exists: false };
  }
}
