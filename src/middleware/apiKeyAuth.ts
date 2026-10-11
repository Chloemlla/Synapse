import type { NextFunction, Request, Response } from "express";
import { recordUsage, setApiKeyPenalty, validateApiKey } from "../services/apiKeyService";
import { persistApiUsageFlags, recordApiUsageSample } from "../services/apiUsageWindowService";
import { getClientIP } from "../utils/ipUtils";
import logger from "../utils/logger";
import { UserStorage } from "../utils/userStorage";
import { attachApiKeyBillingFinalizer, preauthorizeApiKeyBilling } from "../services/apiKeyBillingService";
import { apiKeyRateLimiter, SharedRateLimitUnavailableError } from "../services/apiKeyRateLimitService";
import { oauthTokenAuth } from "./oauthTokenAuth";
import type { AuthenticatedRequest } from "../types/authRequest";

// 验证前的按 IP 粗限流：校验 API Key 走慢哈希路径前先按 IP 掐流量，
// 避免匿名请求用随机 X-API-Key 无限触发验证成本。
const PRE_AUTH_WINDOW_MS = 60_000;
const PRE_AUTH_MAX = 30;
const PRE_AUTH_MAX_TRACKED_IPS = 5_000;
const preAuthIpLimiter = new Map<string, { count: number; resetAt: number }>();

function checkPreAuthIpLimit(ip: string): boolean {
  const now = Date.now();
  const entry = preAuthIpLimiter.get(ip);
  if (!entry || now >= entry.resetAt) {
    preAuthIpLimiter.set(ip, { count: 1, resetAt: now + PRE_AUTH_WINDOW_MS });
    // 超限时按插入顺序淘汰最旧的一条，把内存上界钉在 PRE_AUTH_MAX_TRACKED_IPS。
    if (preAuthIpLimiter.size > PRE_AUTH_MAX_TRACKED_IPS) {
      const oldest = preAuthIpLimiter.keys().next().value;
      if (oldest !== undefined) preAuthIpLimiter.delete(oldest);
    }
    return true;
  }
  if (entry.count >= PRE_AUTH_MAX) return false;
  entry.count++;
  return true;
}

/**
 * API Key 认证中间件工厂
 * @param requiredPermission 该路由需要的权限标识，如 'tts'
 * @param opts.required 无任何凭据时是否拒绝请求。默认 true（无 API Key / OAuth Bearer / JWT 会话即 401）。
 *   只有当下游还有另一道鉴权/人机验证闸门时才应显式传 `{ required: false }`（如 IPFS 上传靠 Turnstile）。
 */
export function apiKeyAuth(requiredPermission: string, opts: { required?: boolean } = {}) {
  const { required = true } = opts;
  // 当 required 为 true 时，OAuth Bearer 缺失即 401；否则沿用历史"可选"语义放行给下游链路。
  const oauthAuth = oauthTokenAuth(requiredPermission, { optional: !required });

  return async (req: Request, res: Response, next: NextFunction) => {
    const authReq = req as AuthenticatedRequest;
    // 如果已经通过 JWT 认证（req.user 存在），直接放行
    if (authReq.user) return next();

    const header = req.headers["x-api-key"] as string | undefined;
    if (!header) return oauthAuth(req, res, next); // 没有 API Key 时尝试 OAuth Bearer，仍没有则交给后续链路

    // 粗 IP 限流提到验证之前：拒绝超频来源，避免每次都被迫做验证/哈希。
    const requestIp = getClientIP(req);
    if (!checkPreAuthIpLimit(requestIp)) {
      return res.status(429).json({ error: "请求过于频繁，请稍后再试" });
    }

    try {
      const doc = await validateApiKey(header);
      if (!doc) {
        return res.status(401).json({ error: "API Key 无效或已过期" });
      }

      const owner = await UserStorage.getUserById(doc.userId);
      if (!owner) {
        return res.status(401).json({ error: "API Key 所属用户不存在" });
      }
      if ((owner as any).disabled || (owner as any).accountStatus === "suspended") {
        return res.status(403).json({ error: "API Key 所属账户不可用" });
      }

      // RC-19：三态分派。先判 suspended（带稳定 code，否则前端/客户端只能靠文案猜），
      // 再看 throttled（额度打到 10% 并带 Retry-After）——处罚归因一并回传，便于用户申诉与排查。
      const keyStatus = doc.status ?? "active";
      const penaltyExpired =
        doc.penaltyUntil instanceof Date ? doc.penaltyUntil.getTime() <= Date.now() : doc.penaltyUntil == null;

      if (keyStatus === "suspended" && !penaltyExpired) {
        const retryAfterSeconds = doc.penaltyUntil
          ? Math.max(1, Math.ceil((doc.penaltyUntil.getTime() - Date.now()) / 1000))
          : undefined;
        if (retryAfterSeconds !== undefined) res.setHeader("Retry-After", String(retryAfterSeconds));
        return res.status(403).json({
          error: "此 API Key 已被暂停使用",
          code: "API_KEY_SUSPENDED",
          ...(doc.penaltyReason ? { reason: doc.penaltyReason } : {}),
          ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
        });
      }

      // 过期的处罚自动失效（不写库，避免每次请求都产生一次写）：按正常状态继续。
      const throttled = keyStatus === "throttled" && !penaltyExpired;
      const baseLimit = Math.max(1, Number(doc.rateLimit) || 60);
      const effectiveLimit = throttled
        ? Math.max(1, Math.floor(Number(doc.effectiveRateLimit) || baseLimit * 0.1))
        : baseLimit;

      // 权限检查
      if (!doc.permissions.includes(requiredPermission) && !doc.permissions.includes("*")) {
        return res.status(403).json({ error: `此 API Key 无 "${requiredPermission}" 权限` });
      }

      // 使用 Redis/MongoDB 共享计数器，确保多实例对同一 API Key 的动态限额一致。
      // 共享后端均不可用时 fail closed，避免每个进程各自放宽限额。
      const rateLimit = await apiKeyRateLimiter.consume(doc.keyId, effectiveLimit);
      res.setHeader("RateLimit-Limit", String(rateLimit.limit));
      if (throttled) {
        // 降速必须让客户端知道“多久之后可以再试”，否则它会立刻重试并把队列打满。
        const retryAfterSeconds = doc.penaltyUntil
          ? Math.max(1, Math.ceil((doc.penaltyUntil.getTime() - Date.now()) / 1000))
          : 60;
        res.setHeader("Retry-After", String(retryAfterSeconds));
      }
      res.setHeader("RateLimit-Remaining", String(Math.max(0, rateLimit.limit - rateLimit.totalHits)));
      res.setHeader("RateLimit-Reset", String(Math.ceil(rateLimit.resetTime.getTime() / 1000)));
      if (!rateLimit.allowed) {
        return res.status(429).json({ error: "此 API Key 请求过于频繁，请稍后再试" });
      }

      const billingContext = await preauthorizeApiKeyBilling(doc, requiredPermission, req);
      attachApiKeyBillingFinalizer(billingContext, res);

      // 记录使用
      const ip = getClientIP(req);
      recordUsage(doc.keyId, ip).catch(() => {}); // fire-and-forget

      // RC-18：记录调用样本并（异步）判定突发/爬虫节奏。
      // 判定落到 `throttled`（降速）而不是直接封禁 —— 先给“自己跟自己的基线比”的判据一点容错，
      // 归因写进 penaltySource（auto:SPIKE / auto:ROBOTIC_CADENCE），用户申诉时说得清。
      void recordApiUsageSample({ keyId: doc.keyId, userId: doc.userId }).then(async (usageFlags) => {
        if (usageFlags.length === 0) return;
        await persistApiUsageFlags(doc.keyId, usageFlags);
        await setApiKeyPenalty({
          keyId: doc.keyId,
          status: "throttled",
          reason: usageFlags.includes("ROBOTIC_CADENCE") ? "请求节奏高度规整（疑似脚本轮询）" : "请求量远超自身基线",
          source: `auto:${usageFlags.join("+")}`,
          durationHours: 1,
        });
      });

      // 注入用户信息，使下游中间件/控制器可用
      // API Key 路径历史上不继承管理员角色，保持兼容。
      const apiKeyUser = {
        id: doc.userId,
        username: owner.username || `apikey:${doc.keyId}`,
        role: "user" as const,
      } as typeof owner;
      authReq.user = apiKeyUser;
      authReq.apiKey = doc;
      authReq.auth = { kind: "apiKey", user: apiKeyUser, apiKey: doc };

      next();
    } catch (err) {
      if (err instanceof SharedRateLimitUnavailableError) {
        logger.error("[ApiKeyAuth] 共享限流后端不可用，拒绝 API Key 请求", { error: err.message });
        res.setHeader("Retry-After", "60");
        return res.status(503).json({ error: "API Key 限流服务暂不可用，请稍后再试" });
      }
      const statusCode = typeof (err as any)?.statusCode === "number" ? (err as any).statusCode : 500;
      if (statusCode !== 500) {
        return res.status(statusCode).json({ error: err instanceof Error ? err.message : "API Key 计费失败" });
      }
      logger.error("[ApiKeyAuth] 验证失败", err);
      return res.status(500).json({ error: "API Key 验证失败" });
    }
  };
}
