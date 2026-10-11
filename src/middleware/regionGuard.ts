import type { NextFunction, Request, Response } from "express";
import { config } from "../config/config";
import { getCachedIpRisk } from "../services/ipRiskService";
import { manualBanIp } from "../services/turnstile/ipBan";
import { getClientIP, isLocalIP } from "../utils/ipUtils";
import logger from "../utils/logger";

/**
 * 地区限制闸门（RC-13）。
 *
 * 背景：`supported-regions` 此前只是注册页上的一个勾选项（政策文本），服务端**从不读请求地区**。
 * 本中间件把「哪些地区能用」变成可执行策略，并且：
 * - **不新增外呼**：国家取自已有的 IP 风险缓存（proxycheck 的 `country`/`isocode`）；
 * - **取不到就按 `failOpen` 决定**（默认放行）——上游挂了不能把全站锁死；
 * - 命中时回稳定 `code`（`REGION_RESTRICTED`），前端才能讲清“为什么打不开”而不是一个裸 403；
 * - `block` 模式额外写 IP 封禁，用于已经确认的大规模滥用来源；
 * - 本地/内网地址直接放行（开发与探测存活性不能被地区策略拦下）。
 */

/** 命中判定：黑名单优先于白名单；两份名单都空 ⇒ 不判定（策略未配置）。 */
export function evaluateRegionPolicy(
  policy: { mode: "off" | "challenge" | "block"; allowedCountries: string[]; blockedCountries: string[]; failOpen: boolean },
  countryCode: string | null,
): { restricted: boolean; reason: string } {
  if (policy.mode === "off") return { restricted: false, reason: "policy_off" };
  const normalized = (countryCode || "").trim().toUpperCase();
  if (!normalized) {
    return policy.failOpen
      ? { restricted: false, reason: "region_unknown_fail_open" }
      : { restricted: true, reason: "region_unknown_fail_closed" };
  }
  if (policy.blockedCountries.includes(normalized)) {
    return { restricted: true, reason: `blocked_country:${normalized}` };
  }
  if (policy.allowedCountries.length > 0 && !policy.allowedCountries.includes(normalized)) {
    return { restricted: true, reason: `not_in_allowed_countries:${normalized}` };
  }
  return { restricted: false, reason: "allowed" };
}

/** 哪些路径不需要过地区判定：存活性、验证引导自身、内网探测。 */
const REGION_BYPASS_PREFIXES = ["/health", "/api/health", "/api/status"];

function shouldSkipRegionCheck(req: Request): boolean {
  const path = req.path || req.url || "";
  return REGION_BYPASS_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export async function regionGuard(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const policy = config.regionPolicy;
    if (!policy || policy.mode === "off") {
      next();
      return;
    }
    if (shouldSkipRegionCheck(req)) {
      next();
      return;
    }

    const ip = getClientIP(req);
    if (!ip || ip === "unknown" || isLocalIP(ip)) {
      next();
      return;
    }

    const cached = await getCachedIpRisk(ip).catch(() => null);
    const verdict = evaluateRegionPolicy(policy, cached?.isocode || cached?.country || null);
    if (!verdict.restricted) {
      next();
      return;
    }

    logger.warn("[RegionGuard] 地区限制命中", { ip, country: cached?.isocode || cached?.country, reason: verdict.reason });

    if (policy.mode === "block") {
      await manualBanIp(ip, 24, `地区限制（${verdict.reason}）`, "auto").catch(() => undefined);
    }

    res.status(403).json({
      success: false,
      error: "当前所在地区暂不支持访问本服务",
      code: "REGION_RESTRICTED",
      supportEmail: "support@chloemlla.com",
    });
  } catch (error) {
    // 判定异常按放行处理：地区策略是限制面，一次读缓存失败不该把全站打成 403（与 failOpen 同口径）。
    logger.error("[RegionGuard] 判定异常，本次放行", {
      error: error instanceof Error ? error.message : String(error),
    });
    next();
  }
}
