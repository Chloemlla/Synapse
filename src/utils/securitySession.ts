import type { NextFunction, Request, Response } from "express";
import {
  type ProfileVerificationSession,
  validateProfileVerificationSession,
} from "../services/profileUpdateVerificationService";
import logger from "./logger";
import { UserStorage } from "./userStorage";

/**
 * 全站统一的「安全会话」校验：所有需要二次验证（超级）管理员身份的敏感操作，
 * 都复用个人资料页建立的同一枚 verificationToken（见 profileUpdateVerificationService），
 * 而不再各自校验管理操作口令。
 *
 * token 从请求体 verificationToken 或请求头 x-verification-token 读取，按 req.user.id 校验，
 * 校验不消耗（同一会话在 10 分钟 TTL 内可用于多次敏感操作）。
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
  return validateProfileVerificationSession(userId, token);
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
