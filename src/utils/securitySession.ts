import type { NextFunction, Request, Response } from "express";
import { config } from "../config/config";
import {
  clearProfileVerificationSessions,
  type ProfileVerificationSession,
  validateProfileVerificationSession,
} from "../services/profileUpdateVerificationService";
import { getCachedIpLocation, lookupIpLocation } from "../services/ipTelemetryService";
import { revokeAllAuthSessions } from "../services/authSessionService";
import { SecurityEvent } from "../models/securityEventModel";
import { isGeoJump } from "../services/mobileTokenRiskService";
import { getClientIP } from "./ipUtils";
import logger from "./logger";
import { UserStorage } from "./userStorage";

/**
 * 全站统一的「安全会话」校验：所有需要二次验证（超级）管理员身份的敏感操作，
 * 都复用个人资料页建立的同一枚 verificationToken（见 profileUpdateVerificationService），
 * 而不再各自校验管理操作口令。
 *
 * token 从请求体 verificationToken 或请求头 x-verification-token 读取，按 req.user.id 校验，
 * 校验不消耗（同一会话在 TTL 内可用于多次敏感操作；TTL 由 `securitySession.ttlSeconds` 运行时决定，RC-40）。
 *
 * 绑定（RC-41 / 裁决二）：令牌里带着签发时的 UA 摘要与 IP ——
 * UA 不匹配在同步校验里**立即失效**；IP 变化只在高危控制面操作前由
 * `assertSecuritySessionBinding` 做异步属地判定（只跳国家/省才踢人）。
 */
export function requestVerificationToken(req: Request): string {
  const body = (req.body ?? {}) as { verificationToken?: unknown };
  if (typeof body.verificationToken === "string" && body.verificationToken) return body.verificationToken;
  const header = req.headers["x-verification-token"];
  if (typeof header === "string" && header) return header;
  return "";
}

/** 取当前请求对应的安全会话；缺失、不匹配或已过期返回 null。 */
export function getSecuritySession(req: Request): ProfileVerificationSession | null {
  const userId = (req as Request & { user?: { id?: string } }).user?.id;
  const token = requestVerificationToken(req);
  if (!userId || !token) return null;
  // RC-41：把本次请求的 IP/UA 一并传入 —— UA 摘要不匹配会在这里**立即失效**（同步判定）。
  return validateProfileVerificationSession(userId, token, {
    ipAddress: getClientIP(req),
    userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined,
  });
}

async function resolveLocation(ip: string): Promise<string | null> {
  try {
    const cached = await getCachedIpLocation(ip);
    if (cached?.location) return cached.location;
    return (await lookupIpLocation(ip, 1500)) || null;
  } catch (error) {
    logger.warn("[SecuritySession] 属地查询失败", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * RC-41 / 裁决二 的**异步**绑定检查：只在高危控制面操作（命令执行、密钥导出/轮换）前调用。
 *
 * 为什么不在同步的 `hasValidSecuritySession` 里做：属地判定要查 IP 归属（外部/缓存），
 * 而那个函数被十几处同步条件使用。所以：
 * - **UA 摘要**：同步路径就能判，已放进 `validateProfileVerificationSession`（不匹配直接失效）；
 * - **IP 异地**：在这里判 —— 同城异网**不**踢人（移动网络换基站是常态，裁决二明确禁止），
 *   只写风险信号；只有 `isGeoJump`（跳国家/省）才终止安全会话 + 全站下线。
 *
 * 返回 true = 会话可继续使用；false = 已失效（调用方必须拒绝该请求）。
 */
export async function assertSecuritySessionBinding(req: Request): Promise<boolean> {
  const session = getSecuritySession(req);
  if (!session) return false;

  const cfg = config.securitySession;
  if (!cfg?.revokeOnGeoJump) return true;
  if (!session.issuedIp) return true;

  const currentIp = getClientIP(req);
  if (!currentIp || currentIp === session.issuedIp) return true;

  const [previousLocation, currentLocation] = await Promise.all([
    resolveLocation(session.issuedIp),
    resolveLocation(currentIp),
  ]);

  const geoJump = isGeoJump(
    previousLocation,
    currentLocation,
    config.mobileTokenRotationRisk.geoJumpScope,
  );

  if (!geoJump) {
    // 同城异网：只记信号（不踢会话），供账户风险聚合与排查使用。
    void SecurityEvent.create({
      deviceFingerprint: session.userAgentHash || "security-session",
      userId: session.userId,
      eventType: "SECURITY_SESSION_IP_CHANGED",
      eventData: { fromIp: session.issuedIp, toIp: currentIp, previousLocation, currentLocation },
      riskScore: 20,
      ipAddress: currentIp,
      userAgent: "",
      createdAt: new Date(),
    }).catch(() => undefined);
    return true;
  }

  // 跨国/跨省：终止该用户全部安全会话 + 全站下线（裁决二）。
  logger.warn("[SecuritySession] 属地跳变，终止安全会话并全站下线", {
    userId: session.userId,
    fromIp: session.issuedIp,
    toIp: currentIp,
    previousLocation,
    currentLocation,
  });
  clearProfileVerificationSessions(session.userId);
  try {
    await revokeAllAuthSessions(session.userId);
  } catch (error) {
    logger.error("[SecuritySession] 属地跳变后撤销登录会话失败，需人工核查", {
      userId: session.userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  void SecurityEvent.create({
    deviceFingerprint: session.userAgentHash || "security-session",
    userId: session.userId,
    eventType: "SECURITY_SESSION_GEO_JUMP",
    eventData: { fromIp: session.issuedIp, toIp: currentIp, previousLocation, currentLocation },
    riskScore: 60,
    ipAddress: currentIp,
    userAgent: "",
    createdAt: new Date(),
  }).catch(() => undefined);
  return false;
}

/**
 * @param options.requireTwoFactor 要求会话必须由 TOTP / Passkey 建立（配置双因素时用）。
 */
export function hasValidSecuritySession(req: Request, options?: { requireTwoFactor?: boolean }): boolean {
  const session = getSecuritySession(req);
  if (!session) return false;
  return options?.requireTwoFactor ? session.method !== "password" : true;
}

/**
 * 双因素配置类操作（启用/关闭 TOTP、配置 Passkey、查看与重生成恢复码）的安全会话守卫。
 *
 * 账号已配置任一二次验证因素（TOTP 或 Passkey）时，必须用 TOTP / Passkey 建立的安全会话，
 * 禁止用密码二次验证来改动双因素配置——否则只拿到密码的攻击者可以关掉二次验证。
 * 两者都未配置时（首次启用）放行密码会话，否则永远无法开始配置。
 */
export async function requireTwoFactorConfigSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const session = getSecuritySession(req);
    if (!session) {
      res.status(403).json({ error: "安全会话无效或已过期，请先建立安全会话", code: "SECURITY_SESSION_REQUIRED" });
      return;
    }

    if (session.method !== "password") {
      next();
      return;
    }

    const userId = (req as Request & { user?: { id?: string } }).user?.id;
    const user = userId ? await UserStorage.getUserById(userId) : null;
    const hasTwoFactorFactor = Boolean(user?.totpEnabled) || (user?.passkeyCredentials?.length ?? 0) > 0;
    if (!hasTwoFactorFactor) {
      next();
      return;
    }

    logger.warn("[SecuritySession] 双因素配置要求非密码安全会话", {
      userId,
      path: req.originalUrl || req.path,
    });
    res.status(403).json({
      error: "配置双因素验证需使用 TOTP 或 Passkey 建立安全会话",
      code: "TWO_FACTOR_SESSION_REQUIRED",
    });
  } catch (error) {
    logger.error("[SecuritySession] 双因素配置安全会话校验失败", { error });
    res.status(500).json({ error: "安全会话校验失败" });
  }
}
