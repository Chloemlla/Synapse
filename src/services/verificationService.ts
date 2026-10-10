/**
 * 验证服务模块
 * 处理邮箱验证链接和密码重置链接的业务逻辑
 */

import type { Request } from "express";
import { VerificationTokenType, verificationTokenStorage } from "../models/verificationTokenModel";
import {
  generatePasswordResetLinkEmailHtml,
  generateVerificationLinkEmailHtml,
  generateWelcomeEmailHtml,
} from "../templates/emailTemplates";
import logger from "../utils/logger";
import { UserStorage } from "../utils/userStorage";
import { EmailService } from "./emailService";
import { sendEmail } from "./emailSender";
import { completeAuthEmail, releaseAuthEmail, reserveAuthEmail, type AuthEmailReservation } from "./authEmailCooldownService";
import { revokeAllAuthSessions } from "./authSessionService";
import { getClientIP as resolveClientIP } from "../utils/ipUtils";
import {
  consumeRegistrationInvite,
  validateRegistrationInviteForRegistration,
} from "./registrationInviteService";

/**
 * 获取前端基础URL
 */
function getFrontendBaseUrl(): string {
  return process.env.FRONTEND_URL || "https://chloemlla.com";
}

/**
 * G2-16: 获取客户端IP地址。只信任服务端解析的 IP（resolveClientIP(req)），
 * 客户端自报的 IP 不参与任何安全判定。
 */
function getClientIP(req: Request): string {
  return resolveClientIP(req);
}

/**
 * 创建并发送邮箱验证链接
 * @param email 邮箱地址
 * @param username 用户名
 * @param password 密码
 * @param fingerprint 设备指纹
 * @param ipAddress IP地址
 * @returns 发送结果
 */
export async function createAndSendVerificationLink(
  email: string,
  username: string,
  password: string,
  fingerprint: string,
  ipAddress: string,
): Promise<{ success: boolean; error?: string }> {
  let pendingToken: string | undefined;
  let reservation: AuthEmailReservation | undefined;
  let delivered = false;
  try {
    const reserved = await reserveAuthEmail(email, "registration");
    if (!reserved.success) return { success: false, error: "验证邮件刚刚发送，请稍后再试" };
    reservation = reserved.reservation;
    // 创建验证令牌
    const verificationToken = await verificationTokenStorage.createToken(
      VerificationTokenType.EMAIL_REGISTRATION,
      email,
      fingerprint,
      ipAddress,
      { username, email, password },
    );
    pendingToken = verificationToken.token;

    // 生成验证链接
    const frontendBaseUrl = getFrontendBaseUrl();
    const verificationLink = `${frontendBaseUrl}/verify-email?token=${verificationToken.token}`;

    // 发送邮件验证链接
    const emailHtml = generateVerificationLinkEmailHtml(username, verificationLink);
    const emailResult = await sendEmail({ to: email, subject: "Synapse 电子邮件确认", html: emailHtml, logTag: "邮箱验证链接", checkQuota: false, purpose: "transactional" });

    if (emailResult.success) {
      delivered = true;
      await completeAuthEmail(reservation);
      logger.info(`[邮箱验证链接] 成功发送到: ${email}`);
      return { success: true };
    } else {
      logger.error(`[邮箱验证链接] 发送失败: ${email}, 错误: ${emailResult.error}`);
      return { success: false, error: "验证链接发送失败，请稍后重试" };
    }
  } catch (error) {
    logger.error(`[邮箱验证链接] 发送异常: ${email}`, error);
    return { success: false, error: "验证链接发送失败，请稍后重试" };
  } finally {
    if (!delivered) {
      if (pendingToken) await verificationTokenStorage.deleteToken(pendingToken).catch((error) => logger.warn("[邮箱验证链接] 清理失败", { error }));
      if (reservation) await releaseAuthEmail(reservation);
    }
  }
}

/**
 * 验证邮箱链接并创建用户
 * @param token 验证令牌
 * @param fingerprint 设备指纹
 * @param ipAddress IP地址
 * @returns 验证结果
 */
export async function verifyEmailLink(
  token: string,
  fingerprint: string,
  ipAddress: string,
): Promise<{ success: boolean; error?: string; message?: string }> {
  try {
    // 验证令牌
    const result = await verificationTokenStorage.validateToken(token, fingerprint, ipAddress, VerificationTokenType.EMAIL_REGISTRATION);

    if (!result.valid) {
      return { success: false, error: result.error };
    }

    const verificationData = await verificationTokenStorage.getToken(token);
    if (!verificationData?.metadata) return { success: false, error: "验证链接无效或已过期" };

    // 检查令牌类型
    if (verificationData.type !== VerificationTokenType.EMAIL_REGISTRATION) {
      return { success: false, error: "无效的验证类型" };
    }

    const { username, email, password, invitationCode } = verificationData.metadata;

    // 再次检查用户名/邮箱是否被注册（防止并发）
    const existUser = await UserStorage.getUserByUsername(username);
    const existEmail = await UserStorage.getUserByEmail(email);
    if (existUser || existEmail) {
      await verificationTokenStorage.deleteToken(token);
      return { success: false, error: "用户名或邮箱已被使用" };
    }

    const inviteValidation = await validateRegistrationInviteForRegistration(invitationCode);
    if (!inviteValidation.ok) {
      await verificationTokenStorage.deleteToken(token);
      return { success: false, error: inviteValidation.error || "邀请码无效" };
    }

    const inputErrors = UserStorage.validateUserInput(username, password, email, true);
    if (inputErrors.length > 0) return { success: false, error: inputErrors[0].message };
    const consumed = await verificationTokenStorage.verifyAndUseToken(token, fingerprint, ipAddress, VerificationTokenType.EMAIL_REGISTRATION);
    if (!consumed.success) return { success: false, error: consumed.error };

    // 创建用户
    const user = await UserStorage.createUser(username, email, password);
    if (!user) {
      await verificationTokenStorage.deleteToken(token);
      return { success: false, error: "注册失败" };
    }
    const consumeResult = await consumeRegistrationInvite(invitationCode, {
      id: user.id,
      username: user.username,
      email: user.email,
    });
    if (!consumeResult.ok) {
      // RC-01: 注册回滚必须用物理删除 —— 账号从未真正成立，软删除会留下占着邮箱的幽灵账号。
      await UserStorage.hardDeleteUser(user.id);
      await verificationTokenStorage.deleteToken(token);
      return { success: false, error: consumeResult.error || "邀请码无效" };
    }
    await verificationTokenStorage.deleteToken(token);

    // 发送欢迎邮件（不影响主流程）
    try {
      const welcomeHtml = generateWelcomeEmailHtml(username);
      await EmailService.sendHtmlEmail([email], "欢迎加入 Synapse", welcomeHtml);
    } catch (e) {
      logger.warn(`[欢迎邮件] 发送失败: ${email}`, e);
    }

    logger.info(`[邮箱验证] 用户 ${username} (${email}) 注册成功`);
    return { success: true, message: "注册成功，请登录" };
  } catch (error) {
    logger.error("[邮箱验证] 验证失败:", error);
    return { success: false, error: "邮箱验证失败" };
  }
}

/**
 * 创建并发送密码重置链接
 * @param email 邮箱地址
 * @param username 用户名
 * @param userId 用户ID
 * @param fingerprint 设备指纹
 * @param ipAddress IP地址
 * @returns 发送结果
 */
export async function createAndSendPasswordResetLink(
  email: string,
  username: string,
  userId: string,
  fingerprint: string,
  ipAddress: string,
): Promise<{ success: boolean; error?: string }> {
  let pendingToken: string | undefined;
  let reservation: AuthEmailReservation | undefined;
  let delivered = false;
  try {
    const reserved = await reserveAuthEmail(email, "password-reset");
    if (!reserved.success) return { success: false, error: "请求已提交，请稍后再试" };
    reservation = reserved.reservation;
    // 创建验证令牌
    const verificationToken = await verificationTokenStorage.createToken(
      VerificationTokenType.PASSWORD_RESET,
      email,
      fingerprint,
      ipAddress,
      { userId, username, email },
    );
    pendingToken = verificationToken.token;

    // 生成重置链接
    const frontendBaseUrl = getFrontendBaseUrl();
    const resetLink = `${frontendBaseUrl}/reset-password?token=${verificationToken.token}`;

    // 发送邮件重置链接
    const emailHtml = generatePasswordResetLinkEmailHtml(username, resetLink);
    const emailResult = await sendEmail({ to: email, subject: "Synapse 账号密码重置", html: emailHtml, logTag: "密码重置", checkQuota: false, purpose: "transactional" });

    if (emailResult.success) {
      delivered = true;
      await completeAuthEmail(reservation);
      logger.info(`[密码重置] 成功发送到: ${email}`);
      return { success: true };
    } else {
      logger.error(`[密码重置] 发送失败: ${email}, 错误: ${emailResult.error}`);
      return { success: false, error: "重置链接发送失败，请稍后重试" };
    }
  } catch (error) {
    logger.error(`[密码重置] 发送异常: ${email}`, error);
    return { success: false, error: "重置链接发送失败，请稍后重试" };
  } finally {
    if (!delivered) {
      if (pendingToken) await verificationTokenStorage.deleteToken(pendingToken).catch((error) => logger.warn("[密码重置链接] 清理失败", { error }));
      if (reservation) await releaseAuthEmail(reservation);
    }
  }
}

/**
 * 验证密码重置链接并更新密码
 * @param token 验证令牌
 * @param fingerprint 设备指纹
 * @param ipAddress IP地址
 * @param newPassword 新密码
 * @returns 验证结果
 */
export async function verifyPasswordResetLink(
  token: string,
  fingerprint: string,
  ipAddress: string,
  newPassword: string,
): Promise<{ success: boolean; error?: string; message?: string; email?: string; username?: string }> {
  try {
    // 验证令牌
    const result = await verificationTokenStorage.validateToken(token, fingerprint, ipAddress, VerificationTokenType.PASSWORD_RESET);

    if (!result.valid) {
      return { success: false, error: result.error };
    }

    const verificationData = await verificationTokenStorage.getToken(token);
    if (!verificationData?.metadata) return { success: false, error: "验证链接无效或已过期" };

    // 检查令牌类型
    if (verificationData.type !== VerificationTokenType.PASSWORD_RESET) {
      return { success: false, error: "无效的验证类型" };
    }

    const { userId, username, email } = verificationData.metadata;

    // 获取用户信息
    const user = await UserStorage.getUserById(userId);
    if (!user) {
      await verificationTokenStorage.deleteToken(token);
      return { success: false, error: "用户不存在" };
    }

    if (typeof newPassword !== "string" || newPassword.length < 8 || newPassword.length > 128) {
      return { success: false, error: "新密码长度须在 8-128 字符之间" };
    }
    // 验证新密码强度
    const passwordErrors = UserStorage.validateUserInput(user.username, newPassword, user.email, true);
    if (passwordErrors.length > 0) {
      return { success: false, error: passwordErrors[0].message };
    }

    const consumed = await verificationTokenStorage.verifyAndUseToken(token, fingerprint, ipAddress, VerificationTokenType.PASSWORD_RESET);
    if (!consumed.success) return { success: false, error: consumed.error };

    // 更新密码
    await UserStorage.updateUser(user.id, { password: newPassword });
    // G2-02: 密码重置成功后撤销该用户全部会话（含 OAuth token 与 client-token），旧 JWT 立即失效。
    await revokeAllAuthSessions(user.id);
    await verificationTokenStorage.deleteToken(token);

    logger.info(`[密码重置] 用户 ${username} (${email}) 密码重置成功`);
    return { success: true, message: "密码重置成功，请使用新密码登录", email, username };
  } catch (error) {
    logger.error("[密码重置] 重置密码异常:", error);
    return { success: false, error: "密码重置失败" };
  }
}

/**
 * 导出工具函数
 */
export { getClientIP, getFrontendBaseUrl };
