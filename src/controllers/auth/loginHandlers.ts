import type { Request, Response } from "express";
import { getAuthSessionMetadata, issueTrackedLoginToken } from "../../services/authSessionService";
import { scheduleLoginRiskSignals } from "../../services/accountRiskService";
import { sendEmail } from "../../services/emailSender";
import { sendThrottledAuthNotification } from "../../services/authEmailNotificationService";
import {
  POLICY_AGREEMENT_KEYS,
  POLICY_CONSENT_REQUIRED_MESSAGE,
  normalizeAuthPolicyConsent,
  resolveRequestFingerprint,
  shouldRequireAuthPolicyConsent,
  writePolicyConsent,
} from "../../services/policyConsentService";
import { readCaptchaChallenge } from "../../services/turnstile/challenge";
import {
  generateAccountLockedEmailHtml,
  generateLoginFailureAlertEmailHtml,
  generateLoginIpChangedEmailHtml,
} from "../../templates/emailTemplates";
import { setAuthSessionCookie } from "../../utils/authCookie";
import { getClientIP } from "../../utils/ipUtils";
import logger from "../../utils/logger";
import { UserStorage } from "../../utils/userStorage";
import {
  LOGIN_ATTEMPT_LIMIT,
  LOGIN_FAILURE_ALERT_THRESHOLD,
  LOGIN_LOCKOUT_DURATION,
  getLoginRetrySeconds,
  loginAttempts,
  verifyRequiredCaptcha,
} from "./_state";
import {
  clearLoginFailures,
  readLoginBackoffState,
  recordLoginFailure,
  LOGIN_BACKOFF_THRESHOLD,
} from "../../services/loginBackoffService";

function summarizeAuthBody(body: any) {
  const challenge = readCaptchaChallenge(body);
  return {
    hasIdentifier: typeof body?.identifier === "string" && body.identifier.length > 0,
    hasPassword: typeof body?.password === "string" && body.password.length > 0,
    hasCfToken: typeof body?.cfToken === "string" && body.cfToken.length > 0,
    hasTurnstileToken: typeof body?.turnstileToken === "string" && body.turnstileToken.length > 0,
    hasCaptchaToken: challenge.token.length > 0,
    captchaProvider: challenge.provider,
  };
}

// identifier 既可能是用户名也可能是邮箱。getUserByUsername 对非用户名字符串会抛
// "非法的用户名"，必须先按形态分流再查，否则邮箱登录失败走到告警/锁定时会 500。
async function resolveNotifyTarget(identifier: string) {
  return identifier.includes("@")
    ? await UserStorage.getUserByEmail(identifier)
    : await UserStorage.getUserByUsername(identifier);
}

// 辅助函数：写入token和过期时间到users.json
async function updateUserToken(userId: string, token: string, expiresInMs = 2 * 60 * 60 * 1000) {
  await UserStorage.updateUser(userId, {
    token,
    tokenExpiresAt: Date.now() + expiresInMs,
  });
}

export async function login(req: Request, res: Response) {
  const t0 = Date.now();
  try {
    const { password } = req.body;
    const identifier = typeof req.body?.identifier === "string" ? req.body.identifier.trim() : "";
    const ip = getClientIP(req);
    const userAgent = req.headers["user-agent"] || "unknown";

    // 记录收到的请求体（不记录密码等敏感字段）
    logger.info("收到登录请求", {
      identifier: req.body?.identifier,
      ip,
      userAgent: req.headers?.["user-agent"],
      timestamp: new Date().toISOString(),
    });

    // 验证必填字段
    if (!identifier) {
      logger.warn("登录失败：identifier 字段缺失", summarizeAuthBody(req.body));
      return res.status(400).json({ error: "请提供用户名或邮箱" });
    }
    if (!password) {
      logger.warn("登录失败：password 字段缺失", summarizeAuthBody(req.body));
      return res.status(400).json({ error: "请提供密码" });
    }

    // 登录前必须逐项勾选四份政策文件。校验放在这里（而不是认证之后）是为了不让
    // 未同意的请求走到密码校验，避免「先试密码、后补同意」把同意变成可选步骤。
    const policyConsent = normalizeAuthPolicyConsent(req.body?.policyConsent);
    if (shouldRequireAuthPolicyConsent() && !policyConsent) {
      logger.warn("登录失败：未逐项同意政策条款", { identifier, ip });
      return res.status(400).json({
        error: POLICY_CONSENT_REQUIRED_MESSAGE,
        code: "POLICY_CONSENT_REQUIRED",
        agreementsRequired: [...POLICY_AGREEMENT_KEYS],
      });
    }

    // 三家供应商（Turnstile / hCaptcha / trycap）共用同一套下发链路：要不要验、验哪家
    // 由管理端供应商配置与请求载荷里的 captchaProvider 共同决定。
    const captchaError = await verifyRequiredCaptcha(req.body, ip, "登录", identifier);
    if (captchaError) {
      return res.status(400).json({ error: captchaError });
    }

    const logDetails = {
      identifier,
      ip,
      userAgent,
      timestamp: new Date().toISOString(),
    };

    logger.info("开始用户认证", logDetails);

    // 检查登录尝试限制（按 IP+用户名 键控，防止攻击者锁定任意已知用户）
    const attemptKey = `${ip}:${identifier.toLowerCase()}`;
    const attempts = loginAttempts.get(attemptKey) || { count: 0, lastAttempt: 0 };
    // RC-27 / D14(a)：锁定状态以**共享存储**为准（多实例下进程内存 Map 不同步，
    // 攻击者把失败次数均摊到各实例就能避开阈值）。内存 Map 仍保留作为快速路径与库不可用时的兜底。
    const sharedBackoff = await readLoginBackoffState(attemptKey);
    const sharedLockedUntil = sharedBackoff?.lockedUntil ?? 0;
    const effectiveLockedUntil = Math.max(attempts.lockedUntil ?? 0, sharedLockedUntil);
    if (effectiveLockedUntil && Date.now() >= effectiveLockedUntil) {
      attempts.count = 0;
      attempts.lockedUntil = undefined;
      void clearLoginFailures(attemptKey);
    }
    if (effectiveLockedUntil && Date.now() < effectiveLockedUntil) {
      const remainingMinutes = Math.ceil((effectiveLockedUntil - Date.now()) / 60000);
      return res.status(429).json({
        error: `尝试次数过多，请在 ${remainingMinutes} 分钟后重试`,
        code: "LOGIN_LOCKED",
        remainingAttempts: 0,
        attemptLimit: LOGIN_ATTEMPT_LIMIT,
        lockedUntil: effectiveLockedUntil,
        retryAfterSeconds: getLoginRetrySeconds(effectiveLockedUntil),
      });
    }

    // 使用 UserStorage 进行认证
    const user = await UserStorage.authenticateUser(identifier, password);

    if (!user) {
      // 记录失败尝试（共享存储 + 内存两份：前者定阈值，后者保证库不可用时不会完全失去限制）
      attempts.count += 1;
      attempts.lastAttempt = Date.now();
      const sharedAfter = await recordLoginFailure(attemptKey);
      const sharedCount = sharedAfter?.count ?? 0;
      const effectiveCount = Math.max(attempts.count, sharedCount);

      // 多次登录失败预警：达到预警阈值时发送提醒邮件（每个锁定窗口仅在 count 恰为阈值时触发一次，且不与锁定邮件同时发送）
      if (attempts.count === LOGIN_FAILURE_ALERT_THRESHOLD) {
        const targetUser = await resolveNotifyTarget(identifier);
        if (targetUser?.email) {
          try {
            const time = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
            const alertEmailHtml = generateLoginFailureAlertEmailHtml(
              targetUser.username,
              attempts.count,
              LOGIN_ATTEMPT_LIMIT,
              time,
              ip,
              req.headers["user-agent"] || "未知设备"
            );
            sendThrottledAuthNotification({
              to: targetUser.email,
              subject: "Synapse 登录安全提醒：检测到多次登录失败",
              html: alertEmailHtml,
              logTag: "登录失败提醒",
              checkQuota: false,
            }, "login-failure")
              .then((result) => {
                if (result.success) {
                  logger.info(`[登录失败提醒] 已发送至 ${targetUser.email}`);
                } else {
                  logger.warn(`[登录失败提醒] 邮件发送失败: ${targetUser.email} - ${result.error}`);
                }
              })
              .catch((e) => {
                logger.warn(`[登录失败提醒] 邮件发送异常: ${targetUser.email}`, e);
              });
          } catch (notifyErr) {
            logger.warn("[登录失败提醒] 发送通知邮件失败:", notifyErr);
          }
        }
      }

      if (effectiveCount >= LOGIN_BACKOFF_THRESHOLD) {
        // 指数退避：第 N 次触发锁定时，时长 = 15 分钟 × 2^(N-5)，上限由服务层封顶（24h）。
        const sharedLockedUntil = sharedAfter?.lockedUntil ?? 0;
        attempts.lockedUntil = Math.max(sharedLockedUntil, Date.now() + LOGIN_LOCKOUT_DURATION);
        loginAttempts.set(attemptKey, attempts);
        const lockMinutes = Math.max(1, Math.ceil((attempts.lockedUntil - Date.now()) / 60000));

        // 发送锁定通知邮件
        const targetUser = await resolveNotifyTarget(identifier);
        if (targetUser?.email) {
          try {
            const time = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
            const lockEmailHtml = generateAccountLockedEmailHtml(targetUser.username, time, ip, userAgent, `${lockMinutes} 分钟`);
            sendThrottledAuthNotification({
              to: targetUser.email,
              subject: "Synapse 账号登录安全警报",
              html: lockEmailHtml,
              logTag: "账号锁定提醒",
              checkQuota: false,
            }, "login-lockout")
              .then((result) => {
                if (result.success) {
                  logger.info(`[账号锁定提醒] 已发送至 ${targetUser.email}`);
                } else {
                  logger.warn(`[账号锁定提醒] 邮件发送失败: ${targetUser.email} - ${result.error}`);
                }
              })
              .catch((e) => {
                logger.warn(`[账号锁定提醒] 邮件发送异常: ${targetUser.email}`, e);
              });
          } catch (notifyErr) {
            logger.warn("[账号锁定提醒] 发送通知邮件失败:", notifyErr);
          }
        }

        return res.status(429).json({
          error: `尝试次数过多，账号已锁定 ${Math.max(1, Math.ceil((attempts.lockedUntil - Date.now()) / 60000))} 分钟`,
          code: "LOGIN_LOCKED",
          remainingAttempts: 0,
          attemptLimit: LOGIN_ATTEMPT_LIMIT,
          lockedUntil: attempts.lockedUntil,
          retryAfterSeconds: getLoginRetrySeconds(attempts.lockedUntil),
        });
      }
      loginAttempts.set(attemptKey, attempts);

      // 不区分「用户不存在」和「密码错误」，统一返回模糊提示（防用户名枚举）
      logger.warn("登录失败：用户名或密码错误", logDetails);
      return res.status(401).json({
        error: "用户名/邮箱或密码错误",
        code: "INVALID_CREDENTIALS",
        remainingAttempts: Math.max(0, LOGIN_ATTEMPT_LIMIT - attempts.count),
        attemptLimit: LOGIN_ATTEMPT_LIMIT,
      });
    }
    if ((user as any).accountStatus === "suspended") {
      return res.status(403).json({ error: "账户已被封停", code: "ACCOUNT_SUSPENDED", supportEmail: "support@chloemlla.com" });
    }

    // 登录成功，重置尝试次数（内存 + 共享存储都清）
    loginAttempts.delete(attemptKey);
    void clearLoginFailures(attemptKey);

    // 认证通过后落同意记录（客户端提交了载荷才写；指纹缺失时只记日志，见服务实现）。
    // 记录失败不影响登录本身：同意记录是留档，不是放行条件。
    if (policyConsent) {
      await writePolicyConsent({
        fingerprint: resolveRequestFingerprint(req),
        source: "login",
        userAgent: typeof userAgent === "string" ? userAgent : undefined,
        ipAddress: ip,
      });
    }

    // 检查用户是否启用了TOTP或Passkey
    const hasTOTP = !!user.totpEnabled;
    const hasPasskey = Array.isArray(user.passkeyCredentials) && user.passkeyCredentials.length > 0;
    if (hasTOTP || hasPasskey) {
      // 使用短期 JWT 作为 2FA 临时令牌，而非明文 userId（防止 2FA 绕过）
      const jwt = require("jsonwebtoken");
      const config = require("../../config/config").config;
      const tempToken = jwt.sign({ userId: user.id, purpose: "2fa_pending" }, config.jwtSecret, { expiresIn: "5m" });
      const tToken = Date.now();
      await updateUserToken(user.id, tempToken, 5 * 60 * 1000); // 5分钟过期
      const tTokenEnd = Date.now();
      logger.info("[login] updateUserToken耗时", {
        耗时: `${tTokenEnd - tToken}ms`,
      });
      // 不返回avatarBase64
      const { id, username, email, role } = user;
      const t1 = Date.now();
      res.json({
        user: { id, username, email, role },
        token: tempToken,
        requires2FA: true,
        twoFactorType: [hasTOTP ? "TOTP" : null, hasPasskey ? "Passkey" : null].filter(Boolean),
      });
      logger.info("[login] 已返回二次验证响应", {
        总耗时: `${t1 - t0}ms`,
        t0,
        t1,
      });
      return;
    }

    // 登录成功
    logger.info("登录成功", {
      userId: user.id,
      username: user.username,
      ...logDetails,
    });
    // 生成JWT token
    const token = await issueTrackedLoginToken(user, getAuthSessionMetadata(req, { ipAddress: ip }));

    // RC-06：把这次登录的 IP 沉淀到账户维度并聚合一次风险（后台异步，不进登录响应路径）。
    scheduleLoginRiskSignals(user.id, ip);

    // 异地登录检测：比较当前IP与上次登录IP
    const lastIp = user.lastLoginIp;
    if (lastIp && lastIp !== "unknown" && ip !== "unknown" && lastIp !== ip && user.email) {
      try {
        const loginTime = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
        const emailHtml = generateLoginIpChangedEmailHtml(user.username, ip, lastIp, loginTime, userAgent);
        sendEmail({
          to: user.email,
          subject: "Synapse 异地登录安全提醒",
          html: emailHtml,
          logTag: "异地登录提醒",
          // 安全/账户事件通知（由合法操作触发，不可被匿名滥用），不占用也不受验证码发送配额限制。
          checkQuota: false,
        })
          .then((result) => {
            if (result.success) {
              logger.info(`[异地登录] 已发送提醒邮件至 ${user.email}，上次IP=${lastIp}，本次IP=${ip}`);
            } else {
              logger.warn(`[异地登录] 提醒邮件发送失败: ${user.email} - ${result.error}`);
            }
          })
          .catch((e) => {
            logger.warn(`[异地登录] 提醒邮件发送异常: ${user.email}`, e);
          });
      } catch (notifyErr) {
        logger.warn("[异地登录] 发送提醒邮件失败:", notifyErr);
      }
    }

    // 更新上次登录IP和时间
    UserStorage.updateUser(user.id, {
      lastLoginIp: ip,
      lastLoginAt: new Date().toISOString(),
    } as any).catch((e) => {
      logger.warn("[登录] 更新lastLoginIp失败:", e);
    });

    // 不再写入user.token，仅返回JWT
    const { id, username, email, role, isTranslationEnabled, translationAccessUntil, accountStatus } = user as any;
    const t1 = Date.now();
    setAuthSessionCookie(req, res, token);
    res.json({
      user: { id, username, email, role, isTranslationEnabled, translationAccessUntil, accountStatus },
      token,
      authMode: "cookie+bearer",
    });
    logger.info("[login] 已返回登录响应", { 总耗时: `${t1 - t0}ms`, t0, t1 });
    return;
  } catch (error) {
    logger.error("登录流程发生未知错误", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      identifier: req.body?.identifier,
      ip: req.ip,
      body: summarizeAuthBody(req.body),
    });
    res.status(500).json({ error: "登录失败" });
  }
}
