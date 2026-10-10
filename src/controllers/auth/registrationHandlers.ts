import crypto from "node:crypto";
import type { Request, Response } from "express";
import { VerificationTokenType, verificationTokenStorage } from "../../models/verificationTokenModel";
import { sendEmail } from "../../services/emailSender";
import { completeAuthEmail, releaseAuthEmail, reserveAuthEmail, type AuthEmailReservation } from "../../services/authEmailCooldownService";
import {
  consumeRegistrationInvite,
  validateRegistrationInviteForRegistration,
} from "../../services/registrationInviteService";
import * as VerificationService from "../../services/verificationService";
import {
  POLICY_AGREEMENT_KEYS,
  POLICY_CONSENT_REQUIRED_MESSAGE,
  normalizeAuthPolicyConsent,
  resolveRequestFingerprint,
  shouldRequireAuthPolicyConsent,
  writePolicyConsent,
} from "../../services/policyConsentService";
import {
  generateVerificationCodeEmailHtml,
  generateVerificationLinkEmailHtml,
  generateWelcomeEmailHtml,
} from "../../templates/emailTemplates";
import { getClientIP } from "../../utils/ipUtils";
import { isIdentityRetired } from "../../services/blockedIdentityService";
import logger from "../../utils/logger";
import { UserStorage } from "../../utils/userStorage";
import {
  MAX_CODE_ATTEMPTS,
  emailCodeMap,
  emailPattern,
  getFrontendBaseUrl,
  verifyRequiredCaptcha,
} from "./_state";

export async function register(req: Request, res: Response) {
  let pendingToken: string | undefined;
  let reservation: AuthEmailReservation | undefined;
  let delivered = false;
  try {
    const { username, email, password, fingerprint, invitationCode } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: "请提供所有必需的注册信息" });
    }
    if (typeof fingerprint !== "string" || !fingerprint.trim() || fingerprint.length > 512) {
      return res.status(400).json({ error: "设备信息缺失" });
    }
    // 注册必须逐项勾选四份政策文件；载荷无效直接拒绝，不进入格式校验与验证码流程
    const policyConsent = normalizeAuthPolicyConsent(req.body?.policyConsent);
    if (shouldRequireAuthPolicyConsent() && !policyConsent) {
      return res.status(400).json({
        error: POLICY_CONSENT_REQUIRED_MESSAGE,
        code: "POLICY_CONSENT_REQUIRED",
        agreementsRequired: [...POLICY_AGREEMENT_KEYS],
      });
    }
    // 用户名格式校验：3-20 位字母数字下划线
    if (typeof username !== "string" || !/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      return res.status(400).json({ error: "用户名须为 3-20 位字母、数字或下划线" });
    }
    // 密码强度校验：8-128 位
    if (typeof password !== "string" || password.length < 8 || password.length > 128) {
      return res.status(400).json({ error: "密码长度须在 8-128 字符之间" });
    }

    // G2-16: 只信任服务端解析的 IP。客户端自报的 clientIP 不参与任何校验。
    const ipAddress = getClientIP(req);
    // 三家供应商共用同一套下发链路：验哪家由请求载荷里的 captchaProvider 决定。
    const captchaError = await verifyRequiredCaptcha(req.body, ipAddress, "注册", email);
    if (captchaError) {
      return res.status(400).json({ error: captchaError });
    }

    // 仅做诊断日志：前端上报的 clientIP 不参与安全判定
    const reportedClientIp = typeof req.body?.clientIP === "string" ? req.body.clientIP : "";
    if (reportedClientIp && reportedClientIp !== "unknown" && reportedClientIp !== ipAddress) {
      logger.info(`[注册] IP差异检测: 前端=${reportedClientIp}, 后端=${ipAddress}, email=${email}`);
    }
    // 禁止用户名为admin等保留字段，仅注册时校验
    if (username && ["admin", "root", "system", "test", "administrator"].includes(username.toLowerCase())) {
      return res.status(400).json({ error: "用户名不能为保留字段" });
    }
    // 只允许主流邮箱
    if (typeof email !== "string" || !emailPattern.test(email)) {
      return res.status(400).json({
        error: "只支持主流邮箱（如gmail、outlook、qq、163、126、hotmail、yahoo、icloud、foxmail、chloemlla.com等）",
      });
    }
    // 验证邮箱格式
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: "邮箱格式不正确" });
    }
    const inputErrors = UserStorage.validateUserInput(username, password, email, true);
    if (inputErrors.length > 0) return res.status(400).json({ error: inputErrors[0].message });
    // 检查用户名或邮箱是否已注册
    const existUser = await UserStorage.getUserByUsername(username);
    const existEmail = await UserStorage.getUserByEmail(email);
    if (existUser || existEmail) {
      return res.status(400).json({ error: "用户名或邮箱已被使用" });
    }

    // RC-47：已退役身份不得直接重注（否则“注销 → 重注”可把 riskTier 归零）。
    // 这里给可解释的拒绝；userRepository.createUser 里还有一层同样的阑门作为兵底。
    if (await isIdentityRetired(email)) {
      logger.warn("[注册] 拒绍已退役身份", { email, ip: ipAddress });
      return res.status(400).json({
        error: "该邮箱不可用于注册，请联系支持",
        code: "IDENTITY_RETIRED",
        supportEmail: "support@chloemlla.com",
      });
    }

    const inviteValidation = await validateRegistrationInviteForRegistration(invitationCode);
    if (!inviteValidation.ok) {
      return res.status(400).json({ error: inviteValidation.error || "邀请码无效" });
    }

    const reserved = await reserveAuthEmail(email, "registration");
    if (!reserved.success) {
      res.setHeader("Retry-After", String(reserved.retryAfterSeconds));
      return res.status(429).json({ error: "验证邮件刚刚发送，请稍后再试", code: "EMAIL_SEND_COOLDOWN", retryAfterSeconds: reserved.retryAfterSeconds });
    }
    reservation = reserved.reservation;
    // 必要的同意记录先完成；寄出可用链接后不再因辅助写入失败要求用户重新注册。
    if (policyConsent) {
      const userAgent = req.headers["user-agent"];
      await writePolicyConsent({
        fingerprint: resolveRequestFingerprint(req) || fingerprint,
        source: "register",
        userAgent: typeof userAgent === "string" ? userAgent : undefined,
        ipAddress,
      });
    }

    // 创建验证令牌
    const verificationToken = await verificationTokenStorage.createToken(
      VerificationTokenType.EMAIL_REGISTRATION,
      email,
      fingerprint,
      ipAddress,
      { username, email, password, invitationCode: inviteValidation.code },
    );
    pendingToken = verificationToken.token;

    // 生成验证链接
    const frontendBaseUrl = getFrontendBaseUrl();
    const verificationLink = `${frontendBaseUrl}/verify-email?token=${verificationToken.token}`;

    // 统一邮件发送
    const emailHtml = generateVerificationLinkEmailHtml(username, verificationLink);
    const result = await sendEmail({
      to: email,
      subject: "Synapse 电子邮件确认",
      html: emailHtml,
      logTag: "邮箱验证链接",
      checkQuota: false,
      purpose: "transactional",
    });

    if (result.success) {
      delivered = true;
      await completeAuthEmail(reservation);
      res.json({
        needVerify: true,
        message: "验证链接已发送到邮箱，请查收",
      });
    } else {
      res.status(500).json({ error: "验证链接发送失败，请稍后重试" });
    }
  } catch (_error) {
    res.status(500).json({ error: "注册失败" });
  } finally {
    if (!delivered) {
      if (pendingToken) {
        await verificationTokenStorage.deleteToken(pendingToken).catch((error) => logger.warn("[注册] 清理未发送令牌失败", { error }));
      }
      if (reservation) await releaseAuthEmail(reservation);
    }
  }
}

// 新增：验证邮箱链接
export async function verifyEmailLink(req: Request, res: Response) {
  try {
    const { token, fingerprint } = req.body;

    if (!token) {
      return res.status(400).json({ error: "验证令牌缺失" });
    }

    if (!fingerprint) {
      return res.status(400).json({ error: "设备信息缺失" });
    }

    // 获取客户端IP（G2-16：只信任服务端解析的 IP）
    const ipAddress = getClientIP(req);

    // 使用验证服务验证邮箱链接
    const result = await VerificationService.verifyEmailLink(token, fingerprint, ipAddress);

    if (result.success) {
      res.json({ success: true, message: result.message });
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (error) {
    logger.error("[邮箱验证] 验证失败:", error);
    res.status(500).json({ error: "邮箱验证失败" });
  }
}

export async function verifyEmail(req: Request, res: Response) {
  try {
    const { email, code } = req.body;
    if (!email || !code) {
      return res.status(400).json({ error: "参数缺失" });
    }
    if (typeof code !== "string" || !/^[0-9]{8}$/.test(code)) {
      return res.status(400).json({ error: "验证码仅为八位数字" });
    }
    const entry = emailCodeMap.get(email);
    if (!entry) {
      return res.status(400).json({ error: "请先注册获取验证码" });
    }
    // 检查验证码是否过期（10分钟）
    if (Date.now() - entry.time > 10 * 60 * 1000) {
      emailCodeMap.delete(email);
      return res.status(400).json({ error: "验证码已过期，请重新申请" });
    }
    // 失败次数限制（防暴力枚举 10^8 = 1亿）
    if ((entry.attempts || 0) >= MAX_CODE_ATTEMPTS) {
      emailCodeMap.delete(email);
      return res.status(429).json({ error: "验证码尝试次数过多，请重新获取" });
    }
    if (entry.code !== code) {
      entry.attempts = (entry.attempts || 0) + 1;
      emailCodeMap.set(email, entry);
      return res.status(400).json({ error: "验证码错误" });
    }
    // 校验通过，正式创建用户
    const { regInfo } = entry;
    if (!regInfo) {
      return res.status(400).json({ error: "注册信息已过期或无效" });
    }
    // 正确验证码只能推进一个请求；在首次异步用户查询前消费。
    emailCodeMap.delete(email);
    // 再次检查用户名/邮箱是否被注册（防止并发）
    const existUser = await UserStorage.getUserByUsername(regInfo.username);
    const existEmail = await UserStorage.getUserByEmail(regInfo.email);
    if (existUser || existEmail) {
      emailCodeMap.delete(email);
      return res.status(400).json({ error: "用户名或邮箱已被使用" });
    }
    const inviteValidation = await validateRegistrationInviteForRegistration(regInfo.invitationCode);
    if (!inviteValidation.ok) {
      emailCodeMap.delete(email);
      return res.status(400).json({ error: inviteValidation.error || "邀请码无效" });
    }
    const user = await UserStorage.createUser(regInfo.username, regInfo.email, regInfo.password);
    if (!user) {
      emailCodeMap.delete(email);
      return res.status(500).json({ error: "注册失败" });
    }
    const consumeResult = await consumeRegistrationInvite(inviteValidation.code, {
      id: user.id,
      username: user.username,
      email: user.email,
    });
    if (!consumeResult.ok) {
      // RC-01: 注册回滚必须用物理删除 —— 账号从未真正成立，软删除会留下占着邮箱的幽灵账号。
      await UserStorage.hardDeleteUser(user.id);
      emailCodeMap.delete(email);
      return res.status(400).json({ error: consumeResult.error || "邀请码无效" });
    }
    emailCodeMap.delete(email);
    // 发送欢迎邮件（不影响主流程）
    const welcomeHtml = generateWelcomeEmailHtml(regInfo.username);
    sendEmail({
      to: regInfo.email,
      subject: "欢迎加入 Synapse",
      html: welcomeHtml,
      logTag: "欢迎邮件",
      checkQuota: false,
    })
      .then((result) => {
        if (result.success) {
          logger.info(`[欢迎邮件] 已发送至 ${regInfo.email}`);
        } else {
          logger.warn(`[欢迎邮件] 发送失败: ${regInfo.email} - ${result.error}`);
        }
      })
      .catch((e) => {
        logger.warn(`[欢迎邮件] 发送异常: ${regInfo.email}`, e);
      });
    res.json({ success: true });
  } catch (_error) {
    res.status(500).json({ error: "邮箱验证失败" });
  }
}

// 新增：重发验证码接口
export async function sendVerifyEmail(req: Request, res: Response) {
  let restore: (() => void) | undefined;
  try {
    const { email } = req.body;
    if (typeof email !== "string" || !emailPattern.test(email)) {
      return res.status(400).json({ error: "邮箱格式不正确" });
    }
    const entry = emailCodeMap.get(email);
    const now = Date.now();
    if (entry && now - entry.time >= 10 * 60 * 1000) {
      emailCodeMap.delete(email);
      return res.status(400).json({ error: "注册信息已过期，请重新注册" });
    }
    if (entry && now - entry.time < 60000) {
      return res.status(429).json({ error: "请60秒后再试" });
    }

    // 检查是否有注册信息
    if (!entry?.regInfo) {
      return res.status(400).json({ error: "请先进行注册操作" });
    }

    // 生成8位数字验证码
    const code = crypto.randomInt(0, 100_000_000).toString().padStart(8, "0");

    // 重新发码时重置失败计数
    const nextEntry = { code, time: now, regInfo: entry.regInfo, attempts: 0 };
    emailCodeMap.set(email, nextEntry);
    restore = () => {
      if (emailCodeMap.get(email) === nextEntry) emailCodeMap.set(email, entry);
    };

    // 统一邮件发送
    const emailHtml = generateVerificationCodeEmailHtml(entry.regInfo.username, code);
    const result = await sendEmail({
      to: email,
      subject: "Synapse 电子邮件确认码",
      html: emailHtml,
      logTag: "重发邮箱验证码",
      checkQuota: false,
      purpose: "transactional",
    });

    if (result.success) {
      restore = undefined;
      res.json({ success: true });
    } else {
      res.status(500).json({ error: "验证码发送失败，请稍后重试" });
    }
  } catch (_error) {
    res.status(500).json({ error: "验证码发送失败" });
  } finally {
    restore?.();
  }
}
