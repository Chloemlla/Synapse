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
 * 面板要回答的三个问题：库里现在存了多少条有效/过期同意、按版本与来源怎么分布、
 * 每一条记录归属哪个设备指纹与 IP、勾选了哪几份文件、什么时候到期。
 *
 * 两条硬约束（沿用同目录 proxycheck 面板的口径）：
 *   1. 绝不在请求路径 connectMongo()：Mongo 未就绪回 503，不隐式建连。
 *   2. checksum 是记录未被外部改写的服务端签名，对运维只需「有没有」即可，
 *      因此只回前 12 位预览，不整段下发（签名盐不下发，全段也无从伪造，但没有展示价值）。
 */

type LooseDoc = Record<string, unknown>;

const DAY_MS = 24 * 60 * 60 * 1000;
const COLLECTION_NAME = "policy_consents";
/** 版本 / 来源分布聚合的护栏：正常只有个位数的版本与来源取值。 */
const MAX_GROUP_ROWS = 100;
const CHECKSUM_PREVIEW_LEN = 12;

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
    isValid: doc.isValid === true,
    expired: expiresAt === null || expiresAt.getTime() <= now.getTime(),
    checksumPreview: checksum ? checksum.slice(0, CHECKSUM_PREVIEW_LEN) : "",
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

export class PolicyConsentLogController {
  /** GET /api/admin/policy-consents/overview —— 计数 + 版本/来源分布 + 近 7 天趋势。 */
  static async getOverview(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!isMongoReady()) {
        respondMongoUnavailable(res);
        return;
      }

      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - 7 * DAY_MS);

      const [total, valid, expired, versionGroups, sourceGroups, recentTrend, collectionInfo] =
        await Promise.all([
          PolicyConsent.countDocuments({}).exec(),
          PolicyConsent.countDocuments({ isValid: true, expiresAt: { $gt: now } }).exec(),
          PolicyConsent.countDocuments({
            $or: [{ isValid: false }, { expiresAt: { $lte: now } }],
          }).exec(),
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
            { $match: { recordedAt: { $gte: sevenDaysAgo } } },
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
        counts: { total, valid, expired },
        versions: normalizeGroupRows(versionGroups),
        sources: normalizeGroupRows(sourceGroups),
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

  /** GET /api/admin/policy-consents —— 逐条同意记录（分页 + 指纹/IP/版本/来源/状态筛选）。 */
  static async listConsents(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!isMongoReady()) {
        respondMongoUnavailable(res);
        return;
      }

      const query = req.query as Record<string, unknown>;
      const { limit, offset } = parsePaging(query);
      const state = parseState(query.state);
      const now = new Date();

      const fingerprint = parseExactMatch(query.fingerprint, 100);
      const ipAddress = parseExactMatch(query.ip, 64);
      const version = parseExactMatch(query.version, 50);
      const source = parseExactMatch(query.source, 32);

      const filter: Record<string, unknown> = { ...buildStateFilter(state, now) };
      if (fingerprint) filter.fingerprint = fingerprint;
      if (ipAddress) filter.ipAddress = ipAddress;
      if (version) filter.version = version;
      if (source) filter.source = source;

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
          fingerprint: fingerprint || null,
          ip: ipAddress || null,
          version: version || null,
          source: source || null,
          state,
        },
      });
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
