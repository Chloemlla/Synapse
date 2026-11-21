import type { NextFunction, Request, Response } from "express";
import { AuthSessionModel } from "../models/authSessionModel";
import { MobileClientTokenModel } from "../models/mobileClientTokenModel";
import { LINEAGE_MAX_GENERATIONS } from "../services/mobileTokenLineageAlertService";
import { mongoose } from "../services/mongoService";
import { escapeRegexLiteral } from "../utils/regexEscape";

/**
 * `sml_` 客户端登录令牌血缘的只读后台面板数据源（超级管理员专用，全部 GET）。
 *
 * 回答三个问题：一条血缘怎么一代代推进（时间线）、哪些旧代超宽限期被重放触发了整链
 * 吊销（MOBILE_TOKEN_REUSED 看板）、某个用户/设备下签了多少代（代次查询）。
 *
 * 两条硬约束（与同目录 ipRiskLogs 面板一致）：
 *   1. 绝不在请求路径 connectMongo()：Mongo 未就绪回 503。
 *   2. 令牌明文永不出库（库里本就只有 SHA-256 哈希），哈希、deviceId、IP 一律掩码，
 *      属地（geo）取会话台账已算好的粗粒度值，不额外发归属地查询、不回明文令牌。
 */

type LooseDoc = Record<string, unknown>;

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
/** 血缘时间线最多回多少代：正常一条链一天一代，一年也就 ~365，给足上限即可。 */
const MAX_LINEAGE_ROWS = 500;

function isMongoReady(): boolean {
  return mongoose.connection.readyState === 1;
}

function respondMongoUnavailable(res: Response): void {
  res.status(503).json({ success: false, message: "数据库未连接，无法读取令牌血缘" });
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toIso(value: unknown): string | null {
  const ms = readNumber(value);
  if (ms === null) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toLooseDocs(docs: unknown): LooseDoc[] {
  return Array.isArray(docs) ? (docs as LooseDoc[]) : [];
}

/** 哈希只回前 10 位 + 省略号：够管理员在几条链之间对上号，又不泄露完整查表键。 */
function maskHash(value: unknown): string | null {
  const hash = readString(value);
  if (!hash) return null;
  return hash.length > 12 ? `${hash.slice(0, 10)}…` : "***";
}

/** 客户端自报的 deviceId（UUID），只回头尾。 */
function maskDeviceId(value: unknown): string | null {
  const id = readString(value);
  if (!id) return null;
  return id.length > 8 ? `${id.slice(0, 4)}…${id.slice(-2)}` : "***";
}

/** IPv4 保留前两段，IPv6 保留前两组，其余掩掉；查不到回 null。 */
function maskIp(value: unknown): string | null {
  const ip = readString(value).trim();
  if (!ip || ip === "unknown") return null;
  if (ip.includes(".")) {
    const parts = ip.split(".");
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.*.*`;
  }
  if (ip.includes(":")) {
    const groups = ip.split(":").filter((g) => g.length > 0);
    if (groups.length >= 2) return `${groups[0]}:${groups[1]}::*`;
  }
  return "***";
}

function parseLimit(value: unknown): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const num = Number(raw);
  if (!Number.isFinite(num)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(num), 1), MAX_LIMIT);
}

function parseOffset(value: unknown): number {
  const raw = Array.isArray(value) ? value[0] : value;
  const num = Number(raw);
  if (!Number.isFinite(num) || num < 0) return 0;
  return Math.trunc(num);
}

function parseParam(value: unknown): string {
  const raw = Array.isArray(value) ? value[0] : value;
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * 全量代次列表的状态过滤值。语义与 `toGenerationRow` 的 `current` 口径保持一致，
 * 否则「按状态筛出来的行」和「行上显示的状态徽标」会自相矛盾。
 */
const TOKEN_STATUS_VALUES = new Set(["all", "current", "superseded", "revoked", "expired", "reused"]);
/** 全量列表的排序口径：最近签发 / 最早签发 / 最近活动。 */
const TOKEN_SORT_VALUES = new Set(["recent", "oldest", "activity"]);

function parseTokenStatus(value: unknown): string {
  const raw = parseParam(value).toLowerCase();
  return TOKEN_STATUS_VALUES.has(raw) ? raw : "all";
}

function parseTokenSort(value: unknown): string {
  const raw = parseParam(value).toLowerCase();
  return TOKEN_SORT_VALUES.has(raw) ? raw : "recent";
}

/** 一代令牌交给前端的形状：哈希/设备/IP 掩码，属地取自会话，时间统一 ISO。 */
function toGenerationRow(doc: LooseDoc, ipLocation: string | null): Record<string, unknown> {
  const supersededAt = readNumber(doc.supersededAt);
  const revokedAt = readNumber(doc.revokedAt);
  const expiresAt = readNumber(doc.expiresAt);
  const now = Date.now();
  const current =
    supersededAt === null && revokedAt === null && (expiresAt === null || expiresAt > now);

  return {
    /** 归属用户：全量列表跨用户，行上必须能看出「这张令牌是谁的」。 */
    userId: readString(doc.userId) || null,
    rotationIndex: readNumber(doc.rotationIndex) ?? 0,
    tokenHash: maskHash(doc.tokenHash),
    lineageId: maskHash(doc.lineageId ?? doc.tokenHash),
    rotatedFrom: maskHash(doc.rotatedFrom),
    supersededTo: maskHash(doc.supersededTo),
    deviceId: maskDeviceId(doc.deviceId),
    deviceName: readString(doc.deviceName) || null,
    deviceFingerprint: maskHash(doc.deviceFingerprint),
    createdAt: toIso(doc.createdAt),
    expiresAt: toIso(doc.expiresAt),
    lastUsedAt: toIso(doc.lastUsedAt),
    supersededAt: toIso(doc.supersededAt),
    revokedAt: toIso(doc.revokedAt),
    reusedAt: toIso(doc.reusedAt),
    lastUsedIp: maskIp(doc.lastUsedIp),
    rotatedIp: maskIp(doc.rotatedIp),
    reusedIp: maskIp(doc.reusedIp),
    verificationPending: doc.verificationPending === true,
    riskSignals: Array.isArray(doc.riskSignals) ? (doc.riskSignals as string[]) : [],
    ipLocation: ipLocation && ipLocation.trim() ? ipLocation : null,
    current,
  };
}

/**
 * 全量列表专用：不限定 userId，一次把当页所有 tokenHash 的属地拉回来。
 * tokenHash 全局唯一（模型上是 unique 索引），所以跨用户批量取不会串号。
 */
async function loadIpLocationByTokenHashAcrossUsers(tokenHashes: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (tokenHashes.length === 0) return map;
  const sessions = await AuthSessionModel.find({ clientTokenHash: { $in: tokenHashes } })
    .select("clientTokenHash ipLocation lastActivityAt")
    .sort({ lastActivityAt: 1 })
    .lean()
    .exec();
  for (const session of toLooseDocs(sessions)) {
    const hash = readString(session.clientTokenHash);
    const location = readString(session.ipLocation);
    if (hash && location) map.set(hash, location);
  }
  return map;
}

/** 按 tokenHash 批量取会话台账里已算好的属地，避免逐代查询归属地。 */
async function loadIpLocationByTokenHash(
  userId: string,
  tokenHashes: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (tokenHashes.length === 0) return map;
  const sessions = await AuthSessionModel.find({
    userId,
    clientTokenHash: { $in: tokenHashes },
  })
    .select("clientTokenHash ipLocation lastActivityAt")
    .sort({ lastActivityAt: 1 })
    .lean()
    .exec();
  for (const session of toLooseDocs(sessions)) {
    const hash = readString(session.clientTokenHash);
    const location = readString(session.ipLocation);
    if (hash && location) map.set(hash, location);
  }
  return map;
}

export class MobileTokenAdminController {
  /** GET /api/admin/mobile-token/overview —— 令牌血缘总量 + 近期复用断链事件概览。 */
  static async getOverview(_req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!isMongoReady()) {
        respondMongoUnavailable(res);
        return;
      }

      const now = Date.now();
      const since = now - DAY_MS;
      const [totalTokens, activeTokens, supersededTokens, revokedTokens, reuseTotal, reuse24h, lineages] =
        await Promise.all([
          MobileClientTokenModel.countDocuments({}).exec(),
          MobileClientTokenModel.countDocuments({
            revokedAt: null,
            supersededAt: null,
            expiresAt: { $gt: now },
          }).exec(),
          MobileClientTokenModel.countDocuments({ supersededAt: { $ne: null } }).exec(),
          MobileClientTokenModel.countDocuments({ revokedAt: { $ne: null } }).exec(),
          MobileClientTokenModel.countDocuments({ reusedAt: { $ne: null } }).exec(),
          MobileClientTokenModel.countDocuments({ reusedAt: { $gte: since } }).exec(),
          MobileClientTokenModel.distinct("lineageId", { lineageId: { $ne: null } }).exec(),
        ]);

      const recentReuseDocs = await MobileClientTokenModel.find({ reusedAt: { $ne: null } })
        .sort({ reusedAt: -1 })
        .limit(10)
        .lean()
        .exec();

      const recentReuse = toLooseDocs(recentReuseDocs).map((doc) => ({
        userId: readString(doc.userId),
        lineageId: maskHash(doc.lineageId ?? doc.tokenHash),
        rotationIndex: readNumber(doc.rotationIndex) ?? 0,
        deviceId: maskDeviceId(doc.deviceId),
        deviceName: readString(doc.deviceName) || null,
        reusedAt: toIso(doc.reusedAt),
        reusedIp: maskIp(doc.reusedIp),
      }));

      // P5-②：代次数越线的血缘。正常一条链一天一代，越线基本只能是脚本在刷，
      // 或是一条被反复轮换却从没人管的链——两种都值得摆到面板最上面。
      const overCapDocs = toLooseDocs(
        await MobileClientTokenModel.find({ rotationIndex: { $gte: LINEAGE_MAX_GENERATIONS - 1 } })
          .select("userId lineageId tokenHash rotationIndex deviceId deviceName createdAt")
          .sort({ rotationIndex: -1 })
          .limit(50)
          .lean()
          .exec(),
      );
      const alertsByLineage = new Map<string, Record<string, unknown>>();
      for (const doc of overCapDocs) {
        const key = readString(doc.lineageId) || readString(doc.tokenHash);
        if (alertsByLineage.has(key)) continue; // 已按 rotationIndex 倒序，首条即该链最高代
        const rotationIndex = readNumber(doc.rotationIndex) ?? 0;
        alertsByLineage.set(key, {
          userId: readString(doc.userId),
          lineageId: maskHash(key),
          rotationIndex,
          generationCount: rotationIndex + 1,
          deviceId: maskDeviceId(doc.deviceId),
          deviceName: readString(doc.deviceName) || null,
          createdAt: toIso(doc.createdAt),
        });
      }

      res.setHeader("Cache-Control", "no-store");
      res.json({
        success: true,
        counts: {
          totalTokens,
          activeTokens,
          supersededTokens,
          revokedTokens,
          lineages: Array.isArray(lineages) ? lineages.length : 0,
          reuseTotal,
          reuse24h,
        },
        recentReuse,
        lineageAlerts: [...alertsByLineage.values()],
        lineageAlertThreshold: LINEAGE_MAX_GENERATIONS,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/admin/mobile-token/lineage?lineageId=... 或 ?userId=...
   * 一条血缘（或某用户全部血缘）的代际时间线，按 createdAt 升序，属地取自会话台账。
   */
  static async listLineage(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!isMongoReady()) {
        respondMongoUnavailable(res);
        return;
      }

      const lineageId = parseParam(req.query.lineageId);
      const userId = parseParam(req.query.userId);
      if (!lineageId && !userId) {
        res.status(400).json({ success: false, message: "需要提供 lineageId 或 userId" });
        return;
      }

      const filter: Record<string, unknown> = {};
      if (lineageId) filter.lineageId = lineageId;
      if (userId) filter.userId = userId;

      const docs = toLooseDocs(
        await MobileClientTokenModel.find(filter)
          .sort({ createdAt: 1 })
          .limit(MAX_LINEAGE_ROWS)
          .lean()
          .exec(),
      );

      const ownerId = userId || readString(docs[0]?.userId);
      const tokenHashes = docs.map((doc) => readString(doc.tokenHash)).filter((hash) => hash.length > 0);
      const locationByHash = ownerId
        ? await loadIpLocationByTokenHash(ownerId, tokenHashes)
        : new Map<string, string>();

      const generations = docs.map((doc) =>
        toGenerationRow(doc, locationByHash.get(readString(doc.tokenHash)) ?? null),
      );

      res.setHeader("Cache-Control", "no-store");
      res.json({
        success: true,
        generations,
        total: generations.length,
        truncated: generations.length >= MAX_LINEAGE_ROWS,
        filters: { lineageId: lineageId || null, userId: userId || null },
      });
    } catch (error) {
      next(error);
    }
  }

  /** GET /api/admin/mobile-token/reuse —— 复用断链（MOBILE_TOKEN_REUSED）事件看板，按 reusedAt 倒序。 */
  static async listReuse(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!isMongoReady()) {
        respondMongoUnavailable(res);
        return;
      }

      const limit = parseLimit(req.query.limit);
      const offset = parseOffset(req.query.offset);
      const userId = parseParam(req.query.userId);
      const filter: Record<string, unknown> = { reusedAt: { $ne: null } };
      if (userId) filter.userId = userId;

      const [docs, total] = await Promise.all([
        MobileClientTokenModel.find(filter)
          .sort({ reusedAt: -1 })
          .skip(offset)
          .limit(limit)
          .lean()
          .exec(),
        MobileClientTokenModel.countDocuments(filter).exec(),
      ]);

      const rows = toLooseDocs(docs).map((doc) => ({
        userId: readString(doc.userId),
        lineageId: maskHash(doc.lineageId ?? doc.tokenHash),
        rotationIndex: readNumber(doc.rotationIndex) ?? 0,
        tokenHash: maskHash(doc.tokenHash),
        deviceId: maskDeviceId(doc.deviceId),
        deviceName: readString(doc.deviceName) || null,
        deviceFingerprint: maskHash(doc.deviceFingerprint),
        supersededAt: toIso(doc.supersededAt),
        reusedAt: toIso(doc.reusedAt),
        reusedIp: maskIp(doc.reusedIp),
        riskSignals: Array.isArray(doc.riskSignals) ? (doc.riskSignals as string[]) : [],
      }));

      res.setHeader("Cache-Control", "no-store");
      res.json({
        success: true,
        events: rows,
        total,
        limit,
        offset,
        filters: { userId: userId || null },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/admin/mobile-token/tokens?search=&status=&sort=&limit=&offset=
   *
   * 全量代次列表：不需要先知道 userId / lineageId 就能看到「库里到底有哪些代」。
   * 之前只有 `listGenerations`（必须带 userId）与 `listLineage`（必须带 lineageId 或 userId），
   * 于是面板实际上要求管理员**先猜一个 ID** 才能看到任何数据 —— 与 `/admin/client-errors`
   * 那种「进来就是一张可筛可分页的全量表」相差一个入口。这里补的就是这个入口。
   *
   * 仍然只读、仍然掩码：搜索词只做字面量前缀/子串匹配（`escapeRegexLiteral` 防病态回溯），
   * 不新增任何明文回显字段。
   */
  static async listTokens(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!isMongoReady()) {
        respondMongoUnavailable(res);
        return;
      }

      const limit = parseLimit(req.query.limit);
      const offset = parseOffset(req.query.offset);
      const search = parseParam(req.query.search);
      const status = parseTokenStatus(req.query.status);
      const sort = parseTokenSort(req.query.sort);

      const now = Date.now();
      const filter: Record<string, unknown> = {};
      if (status === "current") {
        filter.revokedAt = null;
        filter.supersededAt = null;
        filter.expiresAt = { $gt: now };
      } else if (status === "superseded") {
        filter.supersededAt = { $ne: null };
      } else if (status === "revoked") {
        filter.revokedAt = { $ne: null };
      } else if (status === "reused") {
        filter.reusedAt = { $ne: null };
      } else if (status === "expired") {
        filter.revokedAt = null;
        filter.supersededAt = null;
        filter.expiresAt = { $lte: now };
      }

      if (search) {
        // 关键词进 `$regex` 前必须当字面量：`.`/`*` 会变通配符，病态模式会打满 mongod（坑 33 同源）。
        const keyword = escapeRegexLiteral(search);
        filter.$or = [
          { userId: { $regex: keyword, $options: "i" } },
          { deviceId: { $regex: keyword, $options: "i" } },
          { deviceName: { $regex: keyword, $options: "i" } },
          { tokenHash: { $regex: keyword, $options: "i" } },
          { lineageId: { $regex: keyword, $options: "i" } },
        ];
      }

      const sortSpec: Record<string, 1 | -1> =
        sort === "oldest" ? { createdAt: 1 } : sort === "activity" ? { lastUsedAt: -1, createdAt: -1 } : { createdAt: -1 };

      const [docs, total] = await Promise.all([
        MobileClientTokenModel.find(filter).sort(sortSpec).skip(offset).limit(limit).lean().exec(),
        MobileClientTokenModel.countDocuments(filter).exec(),
      ]);

      const pageDocs = toLooseDocs(docs);
      const tokenHashes = pageDocs.map((doc) => readString(doc.tokenHash)).filter((hash) => hash.length > 0);
      const locationByHash = await loadIpLocationByTokenHashAcrossUsers(tokenHashes);
      const generations = pageDocs.map((doc) =>
        toGenerationRow(doc, locationByHash.get(readString(doc.tokenHash)) ?? null),
      );

      res.setHeader("Cache-Control", "no-store");
      res.json({
        success: true,
        generations,
        total,
        limit,
        offset,
        filters: { search: search || null, status, sort },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/admin/mobile-token/generations?userId=...&deviceFingerprint=...
   * 某用户（可再按设备）名下的令牌代次列表 + 汇总，用来看"这个账号/设备到底签了多少代"。
   */
  static async listGenerations(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!isMongoReady()) {
        respondMongoUnavailable(res);
        return;
      }

      const userId = parseParam(req.query.userId);
      if (!userId) {
        res.status(400).json({ success: false, message: "需要提供 userId" });
        return;
      }
      const deviceFingerprint = parseParam(req.query.deviceFingerprint);
      const limit = parseLimit(req.query.limit);
      const offset = parseOffset(req.query.offset);

      const filter: Record<string, unknown> = { userId };
      if (deviceFingerprint) filter.deviceFingerprint = deviceFingerprint;

      const [docs, total, lineageIds] = await Promise.all([
        MobileClientTokenModel.find(filter)
          .sort({ createdAt: -1 })
          .skip(offset)
          .limit(limit)
          .lean()
          .exec(),
        MobileClientTokenModel.countDocuments(filter).exec(),
        MobileClientTokenModel.distinct("lineageId", filter).exec(),
      ]);

      const pageDocs = toLooseDocs(docs);
      const tokenHashes = pageDocs.map((doc) => readString(doc.tokenHash)).filter((hash) => hash.length > 0);
      const locationByHash = await loadIpLocationByTokenHash(userId, tokenHashes);
      const generations = pageDocs.map((doc) =>
        toGenerationRow(doc, locationByHash.get(readString(doc.tokenHash)) ?? null),
      );

      res.setHeader("Cache-Control", "no-store");
      res.json({
        success: true,
        generations,
        total,
        limit,
        offset,
        summary: { lineages: Array.isArray(lineageIds) ? lineageIds.length : 0 },
        filters: { userId, deviceFingerprint: deviceFingerprint || null },
      });
    } catch (error) {
      next(error);
    }
  }
}
