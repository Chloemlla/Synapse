import { IpBanModel } from "../../models/ipBanModel";
import logger from "../../utils/logger";
import { escapeRegexLiteral } from "../../utils/regexEscape";
import { isConnected, mongoose } from "../mongoService";
import { redisService } from "../redisService";
import { clearIPBanCache } from "../../middleware/ipBanCheck";
import { BAN_DURATION, MAX_VIOLATIONS, VIOLATION_COOLDOWN } from "./constants";
import { sanitizeString, validateIpAddress } from "./validators";

export async function isIpBanned(
  ipAddress: string,
): Promise<{ banned: boolean; reason?: string; expiresAt?: Date }> {
  try {
    const validatedIp = validateIpAddress(ipAddress);
    if (!validatedIp) {
      return { banned: false };
    }

    if (!isConnected()) {
      return { banned: false };
    }

    const banDoc = await IpBanModel.findOne({
      ipAddress: validatedIp,
      expiresAt: { $gt: new Date() },
      violationCount: { $gte: MAX_VIOLATIONS },
    })
      .lean()
      .exec();

    if (banDoc) {
      return {
        banned: true,
        reason: banDoc.reason,
        expiresAt: banDoc.expiresAt,
      };
    }

    return { banned: false };
  } catch (error) {
    logger.error("检查IP封禁状态失败", error);
    return { banned: false };
  }
}

export async function recordViolation(
  ipAddress: string,
  reason: string,
  fingerprint?: string,
  userAgent?: string,
): Promise<boolean> {
  try {
    const validatedIp = validateIpAddress(ipAddress);
    if (!validatedIp) {
      return false;
    }

    if (mongoose.connection.readyState !== 1) {
      return false;
    }

    // G7-28: atomic increment + upsert. The previous read-modify-write
    // (`findOne` → `+= 1` → `save()`) dropped concurrent increments, so a
    // sustained burst of failures could keep violationCount pinned under the
    // ban threshold. `findOneAndUpdate` with `$inc` makes every concurrent
    // failure count.
    const now = new Date();
    const banDoc = await IpBanModel.findOneAndUpdate(
      { ipAddress: validatedIp },
      {
        $inc: { violationCount: 1 },
        $set: { reason },
        $setOnInsert: {
          ipAddress: validatedIp,
          fingerprint,
          userAgent,
          bannedAt: now,
          expiresAt: new Date(now.getTime() + VIOLATION_COOLDOWN),
        },
      },
      { upsert: true, new: true },
    ).exec();

    const banned = banDoc.violationCount >= MAX_VIOLATIONS;
    const expiresAt = banned
      ? new Date(now.getTime() + BAN_DURATION)
      : new Date(now.getTime() + VIOLATION_COOLDOWN);
    await IpBanModel.updateOne(
      { ipAddress: validatedIp },
      { $set: { expiresAt } },
    ).exec();

    logger.warn(`IP ${validatedIp} 违规次数增加到 ${banDoc.violationCount}`, {
      reason,
      fingerprint: `${fingerprint?.substring(0, 8)}...`,
      banned,
    });

    return banned;
  } catch (error) {
    logger.error("记录违规失败", error);
    return false;
  }
}

export async function cleanupExpiredIpBans(): Promise<number> {
  try {
    if (mongoose.connection.readyState !== 1) {
      return 0;
    }

    const result = await IpBanModel.deleteMany({ expiresAt: { $lt: new Date() } });

    if (result.deletedCount > 0) {
      logger.info(`清理了 ${result.deletedCount} 条过期IP封禁记录`);
    }

    return result.deletedCount;
  } catch (error) {
    logger.error("清理过期IP封禁记录失败", error);
    return 0;
  }
}

export type IpBanStatusFilter = "all" | "active" | "expired";
export type IpBanSortField = "bannedAt" | "expiresAt" | "violationCount" | "ipAddress";

export interface IpBanListQuery {
  page?: unknown;
  pageSize?: unknown;
  keyword?: unknown;
  status?: unknown;
  sort?: unknown;
  order?: unknown;
}

export interface IpBanListEntry {
  ipAddress: string;
  reason: string;
  violationCount: number;
  bannedAt: Date | null;
  expiresAt: Date | null;
  fingerprint?: string;
  userAgent?: string;
  /** manual = 管理员手工封；auto = 违规计数到阈值自动封。 */
  source: "manual" | "auto";
  /** 当前是否仍生效（服务端算，避免前端时区/时钟偏差造成口径不一）。 */
  active: boolean;
}

export interface IpBanListResult {
  bans: IpBanListEntry[];
  total: number;
  page: number;
  pageSize: number;
  summary: { total: number; active: number; expired: number; manual: number; automatic: number };
}

const SORT_FIELD_WHITELIST: Record<IpBanSortField, string> = {
  bannedAt: "bannedAt",
  expiresAt: "expiresAt",
  violationCount: "violationCount",
  ipAddress: "ipAddress",
};

const MAX_PAGE_SIZE = 100;

function toIpBanEntry(doc: Record<string, unknown>, now: Date): IpBanListEntry {
  const expiresAt = doc.expiresAt instanceof Date ? doc.expiresAt : doc.expiresAt ? new Date(String(doc.expiresAt)) : null;
  const bannedAt = doc.bannedAt instanceof Date ? doc.bannedAt : doc.bannedAt ? new Date(String(doc.bannedAt)) : null;
  const rawSource = typeof doc.source === "string" ? doc.source : "";
  return {
    ipAddress: String(doc.ipAddress ?? ""),
    reason: String(doc.reason ?? ""),
    violationCount: typeof doc.violationCount === "number" ? doc.violationCount : 0,
    bannedAt: bannedAt && !Number.isNaN(bannedAt.getTime()) ? bannedAt : null,
    expiresAt: expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt : null,
    fingerprint: typeof doc.fingerprint === "string" && doc.fingerprint ? doc.fingerprint : undefined,
    userAgent: typeof doc.userAgent === "string" && doc.userAgent ? doc.userAgent : undefined,
    // 存量文档没有 source 字段：默认当自动封（旧的手工封记录会被显示成 auto，属已知取舍，
    // 比反过来把自动封误标成“管理员干的”更保守）。
    source: rawSource === "manual" ? "manual" : "auto",
    active: Boolean(expiresAt && expiresAt.getTime() > now.getTime()),
  };
}

/**
 * 封禁名单（分页 + 关键词 + 状态筛选 + 白名单排序）。
 *
 * 为什么必须有这个接口：`getIpBanStats` 只能给出 4 个数字，封禁因此是“只写不读”的：
 * 误封了哪个网段、批量粘贴时哪一行格式错了、某个 IP 是自动判的还是手工封的、什么时候到期，
 * 管理员全看不到，只能再次输入同一个 IP 试解封来反推。
 */
export async function listIpBans(query: IpBanListQuery = {}): Promise<IpBanListResult> {
  const page = Math.max(1, Math.floor(Number(query.page) || 1));
  const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(Number(query.pageSize) || 20)));
  const keyword = typeof query.keyword === "string" ? query.keyword.trim().slice(0, 120) : "";
  const status: IpBanStatusFilter =
    query.status === "active" || query.status === "expired" ? query.status : "all";
  const sortKey = (typeof query.sort === "string" ? query.sort : "") as IpBanSortField;
  const sortField = SORT_FIELD_WHITELIST[sortKey] ?? "bannedAt";
  const direction: 1 | -1 = query.order === "asc" ? 1 : -1;

  const emptySummary = { total: 0, active: 0, expired: 0, manual: 0, automatic: 0 };
  if (mongoose.connection.readyState !== 1) {
    return { bans: [], total: 0, page, pageSize, summary: emptySummary };
  }

  try {
    const now = new Date();
    const filter: Record<string, unknown> = {};
    if (status === "active") filter.expiresAt = { $gt: now };
    else if (status === "expired") filter.expiresAt = { $lte: now };

    if (keyword) {
      // 关键词当字面量：IP 里的 `.` 不转义时会变成任意字符，搜 `10.0.0.1` 会连
      // `10x0y0z1` 一起命中；病态模式还能把 mongod 打满。
      const pattern = escapeRegexLiteral(keyword);
      filter.$or = [
        { ipAddress: { $regex: pattern, $options: "i" } },
        { reason: { $regex: pattern, $options: "i" } },
        { fingerprint: { $regex: pattern, $options: "i" } },
      ];
    }

    const [docs, filteredTotal, activeCount, sourceGroups] = await Promise.all([
      IpBanModel.find(filter)
        .sort({ [sortField]: direction })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean(),
      IpBanModel.countDocuments(filter),
      IpBanModel.countDocuments({ expiresAt: { $gt: now } }),
      IpBanModel.aggregate<{ _id?: string; count: number }>([
        { $group: { _id: "$source", count: { $sum: 1 } } },
      ]),
    ]);

    let manual = 0;
    let automatic = 0;
    let all = 0;
    for (const group of sourceGroups) {
      const count = typeof group.count === "number" ? group.count : 0;
      all += count;
      if (group._id === "manual") manual += count;
      else automatic += count;
    }

    return {
      bans: (docs as unknown as Record<string, unknown>[]).map((doc) => toIpBanEntry(doc, now)),
      total: filteredTotal,
      page,
      pageSize,
      summary: {
        total: all,
        active: activeCount,
        expired: Math.max(0, all - activeCount),
        manual,
        automatic,
      },
    };
  } catch (error) {
    logger.error("获取IP封禁名单失败", error);
    return { bans: [], total: 0, page, pageSize, summary: emptySummary };
  }
}

export async function getIpBanStats(): Promise<{ total: number; active: number; expired: number }> {
  try {
    if (mongoose.connection.readyState !== 1) {
      return { total: 0, active: 0, expired: 0 };
    }

    const now = new Date();
    const [total, active, expired] = await Promise.all([
      IpBanModel.countDocuments(),
      IpBanModel.countDocuments({ expiresAt: { $gt: now } }),
      IpBanModel.countDocuments({ expiresAt: { $lte: now } }),
    ]);

    return { total, active, expired };
  } catch (error) {
    logger.error("获取IP封禁统计失败", error);
    return { total: 0, active: 0, expired: 0 };
  }
}

export async function manualBanIp(
  ipAddress: string,
  reason: string,
  durationMinutes: number = 60,
  fingerprint?: string,
  userAgent?: string,
): Promise<{ success: boolean; error?: string; expiresAt?: Date; bannedAt?: Date }> {
  try {
    const validatedIp = validateIpAddress(ipAddress);
    if (!validatedIp) {
      return { success: false, error: "IP地址格式无效" };
    }

    const sanitizedReason = sanitizeString(reason, 500);
    if (!sanitizedReason) {
      return { success: false, error: "封禁原因无效" };
    }

    let validDuration = 60;

    if (durationMinutes !== undefined && durationMinutes !== null) {
      const duration = Number(durationMinutes);

      if (Number.isNaN(duration) || !Number.isFinite(duration)) {
        return { success: false, error: "封禁时长必须是有效的数字" };
      }

      validDuration = Math.min(Math.max(duration, 1), 24 * 60);
    }

    if (mongoose.connection.readyState !== 1) {
      return { success: false, error: "数据库连接不可用" };
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + validDuration * 60 * 1000);

    const existingBan = await IpBanModel.findOne({ ipAddress: validatedIp });

    let bannedAt = now;

    if (existingBan) {
      bannedAt = existingBan.bannedAt;
      existingBan.expiresAt = expiresAt;
      existingBan.reason = sanitizedReason;
      // 手动封禁强制达到阈值，确保 isIpBanned 立即命中
      existingBan.violationCount = MAX_VIOLATIONS;
      // 名单里要把「管理员干的」和「违规计数自动触发的」分开，否则两者都是
      // violationCount >= MAX_VIOLATIONS，事后无法归因。
      existingBan.source = "manual";

      if (fingerprint) {
        const sanitizedFingerprint = sanitizeString(fingerprint, 200);
        if (sanitizedFingerprint) {
          existingBan.fingerprint = sanitizedFingerprint;
        }
      }
      if (userAgent) {
        const sanitizedUserAgent = sanitizeString(userAgent, 500);
        if (sanitizedUserAgent) {
          existingBan.userAgent = sanitizedUserAgent;
        }
      }

      await existingBan.save();

      logger.info(`更新IP封禁: ${validatedIp}, 原因: ${sanitizedReason}, 新过期时间: ${expiresAt}`);
    } else {
      const banRecord = new IpBanModel({
        ipAddress: validatedIp,
        reason: sanitizedReason,
        violationCount: MAX_VIOLATIONS,
        bannedAt: now,
        expiresAt,
        source: "manual",
        fingerprint: fingerprint ? sanitizeString(fingerprint, 200) : undefined,
        userAgent: userAgent ? sanitizeString(userAgent, 500) : undefined,
      });

      await banRecord.save();

      logger.info(`手动封禁IP: ${validatedIp}, 原因: ${sanitizedReason}, 时长: ${validDuration}分钟`);
    }

    try {
      if (redisService?.isAvailable()) {
        await redisService.banIP(validatedIp, sanitizedReason, validDuration, {
          fingerprint: fingerprint ? sanitizeString(fingerprint, 200) || undefined : undefined,
          userAgent: userAgent ? sanitizeString(userAgent, 500) || undefined : undefined,
        });
        logger.info(`✅ IP封禁已同步到Redis: ${validatedIp}`);
      }
    } catch (redisError) {
      logger.warn(`同步IP封禁到Redis失败，但MongoDB已更新`, { error: redisError });
    }

    try {
      if (clearIPBanCache) {
        clearIPBanCache(validatedIp);
      }
    } catch (cacheError) {
      logger.warn(`清除IP缓存失败，但封禁已生效`, { error: cacheError });
    }

    return { success: true, expiresAt, bannedAt };
  } catch (error) {
    logger.error("手动封禁IP失败", error);
    return { success: false, error: error instanceof Error ? error.message : "未知错误" };
  }
}

export async function unbanIp(ipAddress: string): Promise<boolean> {
  try {
    const validatedIp = validateIpAddress(ipAddress);
    if (!validatedIp) {
      logger.warn(`解封IP失败：IP地址格式无效`, { ipAddress });
      return false;
    }

    if (mongoose.connection.readyState !== 1) {
      logger.warn("解封IP失败：MongoDB连接不可用");
      return false;
    }

    let mongoDeleted = false;
    let redisDeleted = false;

    const mongoResult = await IpBanModel.deleteOne({ ipAddress: validatedIp });
    mongoDeleted = mongoResult.deletedCount > 0;

    try {
      if (redisService?.isAvailable()) {
        redisDeleted = await redisService.unbanIP(validatedIp);
      }
    } catch (redisError) {
      logger.warn(`从Redis删除IP封禁失败，继续执行`, { error: redisError });
    }

    try {
      if (clearIPBanCache) {
        clearIPBanCache(validatedIp);
      }
    } catch (cacheError) {
      logger.warn(`清除IP缓存失败，继续执行`, { error: cacheError });
    }

    if (mongoDeleted || redisDeleted) {
      logger.info(`✅ 手动解除IP封禁: ${validatedIp}`, {
        mongoDeleted,
        redisDeleted,
        source: mongoDeleted && redisDeleted ? "both" : mongoDeleted ? "mongodb" : "redis",
      });
      return true;
    }

    logger.warn(`⚠️ IP未在封禁列表中: ${validatedIp}`);
    return false;
  } catch (error) {
    logger.error("手动解除IP封禁失败", error);
    return false;
  }
}
