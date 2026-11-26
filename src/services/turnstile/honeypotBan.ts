import { IpBanModel } from "../../models/ipBanModel";
import { SecurityEvent } from "../../models/securityEventModel";
import logger from "../../utils/logger";
import { isLocalIP, isValidIP } from "../../utils/ipUtils";
import { AuditLogService } from "../auditLogService";
import { mongoose } from "../mongoService";
import { shouldExemptFromRiskControl } from "../riskExemption";
import {
  HONEYPOT_BAN_DURATION_MINUTES,
  HONEYPOT_BAN_REASON_PREFIX,
  HONEYPOT_REPEAT_THRESHOLD,
  HONEYPOT_REPEAT_WINDOW_MS,
} from "./constants";
import { manualBanIp } from "./ipBan";
import { buildHoneypotRepeatQuery, honeypotRepeatWindowStart } from "./honeypotQuery";

/**
 * 蜜罐连续命中 → 自动封禁（owner 2026-11-26 裁决）。
 *
 * 旧口径（`docs/audit/10-10.md` RC-42）是「只留痕不封禁」，理由是管理员工具/旧客户端可能误入
 * `/api/debug/*`。本次 owner 明确要求处置，误伤兜底改为四条：
 * 1. **阈值 ≥2 次**（单次误入不处置）；
 * 2. **回环/私网地址永不自动封**（NAT 后整段内网会连坐）；
 * 3. **只统计匿名命中**：`SecurityEvent.userId` 存在的命中不计入阈值 —— 带令牌访问
 *    `/api/debug/*` 的管理员工具与旧客户端属于“已登录的已知主体”，归账户风险处置，
 *    不靠 IP 封禁（这也是 RC-42 当时担心的那个误伤面）；
 * 4. **名单页可溯源 + 一键解封**（解封走已有审计 `ipban.unban`）。
 *
 * 判据与证据同源：统计的是 `SecurityEvent` 里的 `HONEYPOT_HIT`（调用方先 `await` 落库本次命中，
 * 再调本函数），因此后台「为什么被封」看到的行就是判据算过的行，不存在两份数据对不上。
 */

export interface HoneypotHitContext {
  /** 已解析的真实出口 IP（`getClientIP`）。 */
  ip: string;
  /** 命中类型（`path_prefix` 等，来自命中事件）。 */
  kind: string;
  /** 命中的路径（含 query，已截断）。 */
  path: string;
  method?: string;
  userAgent?: string;
  fingerprint?: string;
  /** 已登录命中的 userId / role（蜜罐中间件远在鉴权之前，通常为空）。 */
  userId?: string;
  role?: string;
}

export type HoneypotBanSkipReason =
  | "invalid-ip"
  | "local-ip"
  | "db-unavailable"
  | "risk-exempt"
  | "below-threshold"
  | "already-banned";

export interface HoneypotBanDecision {
  /** 是否真正执行了封禁写入。 */
  banned: boolean;
  /** 窗口内（含本次）的**匿名**命中次数；已登录命中不计入。 */
  hitsInWindow: number;
  /** 窗口内该 IP 的全部命中次数（含已登录），用于解释“为什么没封”。 */
  totalHitsInWindow: number;
  threshold: number;
  windowMs: number;
  /** 未封禁时给出可读原因（写日志 + 便于测试断言）。 */
  skippedReason?: HoneypotBanSkipReason;
  /** 窗口内最近一次命中的路径，用于封禁原因文本。 */
  latestPath?: string;
  reason?: string;
  expiresAt?: Date;
  error?: string;
}

/** 统计窗口内最多读多少条命中：超过阈值即够用，取 50 是为了一次查询同时给出证据摘要。 */
const WINDOW_EVENT_READ_LIMIT = 50;

function buildReason(hitsInWindow: number, hit: HoneypotHitContext): string {
  const windowMinutes = Math.round(HONEYPOT_REPEAT_WINDOW_MS / 60000);
  const target = `${hit.method || "GET"} ${hit.path || "/"}`.slice(0, 180);
  return `${HONEYPOT_BAN_REASON_PREFIX}：${windowMinutes} 分钟内 ${hitsInWindow} 次（最近 ${target}）`;
}

/**
 * 判定并（必要时）执行自动封禁。**不抛异常**：蜜罐路径不能因为风控链路故障变成 500。
 */
export async function evaluateHoneypotRepeatBan(hit: HoneypotHitContext): Promise<HoneypotBanDecision> {
  const base = {
    hitsInWindow: 0,
    totalHitsInWindow: 0,
    threshold: HONEYPOT_REPEAT_THRESHOLD,
    windowMs: HONEYPOT_REPEAT_WINDOW_MS,
  };

  const ip = typeof hit.ip === "string" ? hit.ip.trim() : "";
  if (!ip || !isValidIP(ip)) {
    return { ...base, banned: false, skippedReason: "invalid-ip" };
  }
  // 开发/内网/反代回环一律不自动封：NAT 后的整段内网共用出口时，封一个 IP 会连坐所有人。
  if (isLocalIP(ip)) {
    return { ...base, banned: false, skippedReason: "local-ip" };
  }
  // RC-44：自动强制类风控统一走同一个豁免判据（超管不能被自己的风控锁在平台外）。
  // 蜜罐中间件在鉴权之前，所以这里通常拿不到 role，真正的误伤兜底是上面两条 + 只统计匿名命中。
  if (shouldExemptFromRiskControl({ id: hit.userId, role: hit.role }, "honeypot", { ip, path: hit.path })) {
    return { ...base, banned: false, skippedReason: "risk-exempt" };
  }
  if (mongoose.connection.readyState !== 1) {
    return { ...base, banned: false, skippedReason: "db-unavailable" };
  }

  try {
    const now = new Date();
    const windowStart = honeypotRepeatWindowStart(now);

    const [anonymousHits, hits] = await Promise.all([
      SecurityEvent.countDocuments(buildHoneypotRepeatQuery(ip, windowStart)),
      SecurityEvent.find({
        eventType: "HONEYPOT_HIT",
        ipAddress: ip,
        createdAt: { $gte: windowStart },
      })
        .sort({ createdAt: -1 })
        .limit(WINDOW_EVENT_READ_LIMIT)
        .lean()
        .exec(),
    ]);

    const hitsInWindow = anonymousHits;
    const totalHitsInWindow = hits.length;
    const latest = hits[0] as unknown as Record<string, unknown> | undefined;
    const latestData = (latest?.eventData ?? {}) as Record<string, unknown>;
    const latestPath =
      typeof latestData.path === "string" ? latestData.path : hit.path;

    if (hitsInWindow < HONEYPOT_REPEAT_THRESHOLD) {
      return {
        ...base,
        hitsInWindow,
        totalHitsInWindow,
        latestPath,
        banned: false,
        skippedReason: "below-threshold",
      };
    }

    // 幂等：已有生效封禁（手工或上一轮自动判定）就不再改写，避免每次再命中都把到期时间往后推、
    // 把「首次判定的原因」覆盖成最后一次命中的路径。
    const existing = await IpBanModel.findOne({ ipAddress: ip, expiresAt: { $gt: now } })
      .lean()
      .exec();
    if (existing) {
      return {
        ...base,
        hitsInWindow,
        totalHitsInWindow,
        latestPath,
        banned: false,
        skippedReason: "already-banned",
        expiresAt: existing.expiresAt instanceof Date ? existing.expiresAt : undefined,
        reason: typeof existing.reason === "string" ? existing.reason : undefined,
      };
    }

    const reason = buildReason(hitsInWindow, hit);
    const result = await manualBanIp(ip, reason, HONEYPOT_BAN_DURATION_MINUTES, {
      source: "auto",
      fingerprint: hit.fingerprint,
      userAgent: hit.userAgent,
    });

    if (!result.success) {
      logger.warn("[Honeypot] 自动封禁未生效", { ip, hitsInWindow, error: result.error });
      return { ...base, hitsInWindow, totalHitsInWindow, latestPath, banned: false, error: result.error };
    }

    logger.warn("[Honeypot] 蜜罐连续命中，已自动封禁", {
      ip,
      hitsInWindow,
      windowMinutes: HONEYPOT_REPEAT_WINDOW_MS / 60000,
      durationMinutes: HONEYPOT_BAN_DURATION_MINUTES,
      expiresAt: result.expiresAt,
    });

    // 审计：自动处置同样要有「谁判的、依据是什么」，否则事后只能看到一条来源为 auto 的封禁记录。
    try {
      await AuditLogService.log({
        userId: "system",
        username: "system:honeypot",
        role: "system",
        action: "ipban.autoHoneypotBan",
        module: "ipban",
        targetId: ip,
        targetName: ip,
        result: "success",
        detail: {
          ipAddress: ip,
          reason,
          hitsInWindow,
          totalHitsInWindow,
          windowMinutes: Math.round(HONEYPOT_REPEAT_WINDOW_MS / 60000),
          threshold: HONEYPOT_REPEAT_THRESHOLD,
          durationMinutes: HONEYPOT_BAN_DURATION_MINUTES,
          hitPaths: hits
            .slice(0, 10)
            .map((event) => {
              const data = (event.eventData ?? {}) as Record<string, unknown>;
              return typeof data.path === "string" ? data.path : "";
            })
            .filter(Boolean),
        },
        ip,
        userAgent: hit.userAgent,
        path: hit.path,
        method: "AUTO",
      });
    } catch (auditError) {
      logger.warn("[Honeypot] 自动封禁审计写入失败", {
        ip,
        error: auditError instanceof Error ? auditError.message : String(auditError),
      });
    }

    return {
      ...base,
      hitsInWindow,
      totalHitsInWindow,
      latestPath,
      banned: true,
      reason,
      expiresAt: result.expiresAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("[Honeypot] 自动封禁判定失败", { ip, error: message });
    return { ...base, banned: false, error: message };
  }
}
