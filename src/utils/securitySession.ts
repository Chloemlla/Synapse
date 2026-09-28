import type { Request } from "express";
import { validateProfileVerificationSession } from "../services/profileUpdateVerificationService";

/**
 * 全站统一的「安全会话」校验：所有需要二次验证（超级）管理员身份的敏感操作，
 * 都复用个人资料页建立的同一枚 verificationToken（见 profileUpdateVerificationService），
 * 而不再各自校验管理操作口令。
 *
 * token 从请求体 verificationToken 或请求头 x-verification-token 读取，按 req.user.id 校验，
 * 校验不消耗（同一会话在 5 分钟 TTL 内可用于多次敏感操作）。
 */
export function requestVerificationToken(req: Request): string {
  const body = (req.body ?? {}) as { verificationToken?: unknown };
  if (typeof body.verificationToken === "string" && body.verificationToken) return body.verificationToken;
  const header = req.headers["x-verification-token"];
  if (typeof header === "string" && header) return header;
  return "";
}

export function hasValidSecuritySession(req: Request): boolean {
  const userId = (req as Request & { user?: { id?: string } }).user?.id;
  const token = requestVerificationToken(req);
  return Boolean(userId && token && validateProfileVerificationSession(userId, token));
}
