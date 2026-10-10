import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config/config";
import logger from "../utils/logger";
import type { AuthenticatedRequest } from "../types/authRequest";
import { getTokenFromRequest } from "../utils/authCookie";
import { UserStorage } from "../utils/userStorage";
import { assertActiveAuthSession, hashAuthCredential, touchAuthSession } from "../services/authSessionService";
import { USER_DELETED_FIELD, isSoftDeleted } from "../utils/softDeleteState";
import { getClientIP } from "../utils/ipUtils";
import { enforceAccountStepUp } from "./accountStepUpGuard";

type JwtUserPayload = {
  userId?: string;
};

export const authenticateToken = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authedReq = req as AuthenticatedRequest;
    if ((authedReq.apiKey || authedReq.oauthToken) && authedReq.user) {
      return next();
    }

    const token = getTokenFromRequest(req);
    if (!token) {
      return res.status(401).json({ error: "未授权" });
    }

    let userId: string;
    try {
      const decoded = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"] }) as JwtUserPayload;
      if (!decoded.userId) {
        return res.status(401).json({ error: "Token 无 userId" });
      }
      userId = decoded.userId;
    } catch (_err) {
      return res.status(401).json({ error: "Token 无效或已过期" });
    }

    const user = await UserStorage.getUserById(userId);
    if (!user) {
      return res.status(403).json({ error: "无效的Token" });
    }
    // RC-01: 软删除账号与不存在同等对待 —— 不得凭存量 JWT 继续访问（否则「删了还能登」）。
    if (isSoftDeleted(user, USER_DELETED_FIELD)) {
      return res.status(403).json({ error: "账户已注销", code: "ACCOUNT_DELETED", supportEmail: "support@chloemlla.com" });
    }
    if ((user as any).disabled) {
      // SYN-02: 与 authMiddlewareV2 / wsAuthentication 对齐，被禁用账户不得通过认证。
      return res.status(403).json({ error: "账户已被禁用" });
    }
    if (user.accountStatus === "suspended") {
      return res.status(403).json({ error: "账户已被封停", code: "ACCOUNT_SUSPENDED", supportEmail: "support@chloemlla.com" });
    }
    // G2-08: 只计算一次凭证哈希，assert + touch 共享，避免每请求两次哈希。
    const credentialHash = hashAuthCredential(token);
    const session = await assertActiveAuthSession(userId, token, credentialHash);
    // PERF-02: assert 已取到会话文档，直接透传给 touch 复用，省掉一次 Mongo findOne。
    await touchAuthSession(
      userId,
      token,
      {
        ipAddress: getClientIP(req),
        userAgent: String(req.headers["user-agent"] || session.userAgent),
      },
      credentialHash,
      session,
    );
    authedReq.user = user;
    authedReq.auth = { kind: "session", user };
    // RC-02 / RC-45：账户逐步验证闸门。为什么在这里而不是 assembly.ts ——
    // 本仓的 authenticateToken 是**路由级**中间件（没有全局认证层），
    // 挂在更前面的全局中间件拿不到 req.user。这里正好是「认证已完成、业务之前」，
    // 与审计 §4.4 的意图一致，且 routeKey 用的是 req.baseUrl + req.path（禁用 req.route）。
    // 默认关闭（accountRisk.stepUpEnabled=false）时这是一次布尔判断，无额外 I/O。
    if (await enforceAccountStepUp(req, res)) return;
    next();
  } catch (error) {
    if (error instanceof Error && (error.name === "AuthSessionError" || error.message.includes("会话不存在或已撤销"))) {
      return res.status(401).json({ error: "会话不存在或已撤销" });
    }
    logger.error("Token 认证失败:", error);
    res.status(401).json({ error: "认证失败" });
  }
};
