import type { Request, Response } from "express";
jest.mock("../models/verificationTokenModel", () => ({
  VerificationTokenType: { EMAIL_REGISTRATION: "email_registration", PASSWORD_RESET: "password_reset" },
  verificationTokenStorage: { createToken: jest.fn(), deleteToken: jest.fn(), validateToken: jest.fn() },
}));
jest.mock("../services/emailSender", () => ({ sendEmail: jest.fn() }));
jest.mock("../services/authEmailCooldownService", () => ({ reserveAuthEmail: jest.fn(), completeAuthEmail: jest.fn(), releaseAuthEmail: jest.fn() }));
jest.mock("../services/authSessionService", () => ({ revokeAllAuthSessions: jest.fn() }));
jest.mock("../services/verificationService", () => ({ verifyEmailLink: jest.fn(), verifyPasswordResetLink: jest.fn() }));
jest.mock("../services/registrationInviteService", () => ({ validateRegistrationInviteForRegistration: jest.fn(), consumeRegistrationInvite: jest.fn() }));
// RC-05 新增依赖：注册闸门与台账。本套件只测“邮件链路是不是事务”，所以闸门一律放行、台账不打库。
jest.mock("../services/registrationRiskService", () => ({
  evaluateRegistrationRisk: jest.fn(async () => ({ allowed: true, ipRiskScore: null })),
  recordRegistrationAttempt: jest.fn(async () => undefined),
}));
jest.mock("../services/policyConsentService", () => ({
  POLICY_AGREEMENT_KEYS: [], POLICY_CONSENT_REQUIRED_MESSAGE: "Consent required",
  normalizeAuthPolicyConsent: jest.fn(() => ({})), shouldRequireAuthPolicyConsent: jest.fn(() => false),
  resolveRequestFingerprint: jest.fn(() => "device"), writePolicyConsent: jest.fn(),
}));
jest.mock("../templates/emailTemplates", () => ({
  generateVerificationCodeEmailHtml: jest.fn(() => "code"), generateVerificationLinkEmailHtml: jest.fn(() => "link"),
  generateWelcomeEmailHtml: jest.fn(() => "welcome"), generatePasswordResetLinkEmailHtml: jest.fn(() => "reset"),
  generatePasswordChangedEmailHtml: jest.fn(() => "changed"), generatePasswordResetSuccessEmailHtml: jest.fn(() => "changed"),
}));
jest.mock("../utils/userStorage", () => ({ UserStorage: {
  getUserByEmail: jest.fn(), getUserByUsername: jest.fn(), getUserById: jest.fn(),
  // RC-05：规范化邮箱查重也必须给替身，否则调用点会拿到 undefined 而抛 TypeError（伪装成业务坏了）。
  getUserByEmailCanonical: jest.fn(),
  createUser: jest.fn(), deleteUser: jest.fn(), hardDeleteUser: jest.fn(), updateUser: jest.fn(), validateUserInput: jest.fn(),
} }));
jest.mock("../utils/ipUtils", () => ({ getClientIP: jest.fn(() => "192.0.2.1") }));
jest.mock("../utils/logger", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock("../controllers/auth/_state", () => ({
  MAX_CODE_ATTEMPTS: 5, emailCodeMap: new Map(), resetPasswordCodeMap: new Map(),
  emailPattern: /^[\w.-]+@gmail\.com$/, getFrontendBaseUrl: () => "https://app.example.com", verifyRequiredCaptcha: jest.fn(),
}));

import { register, sendVerifyEmail } from "../controllers/auth/registrationHandlers";
import { forgotPassword, resetPassword, validateResetToken } from "../controllers/auth/passwordResetHandlers";
import { emailCodeMap, resetPasswordCodeMap, verifyRequiredCaptcha } from "../controllers/auth/_state";
import { verificationTokenStorage, VerificationTokenType } from "../models/verificationTokenModel";
import { reserveAuthEmail, completeAuthEmail, releaseAuthEmail } from "../services/authEmailCooldownService";
import { sendEmail } from "../services/emailSender";
import { writePolicyConsent } from "../services/policyConsentService";
import { validateRegistrationInviteForRegistration } from "../services/registrationInviteService";
import { UserStorage, type User } from "../utils/userStorage";

const reservation = { key: "digest", id: "owner", cooldownMs: 60_000 };
function req(body: Record<string, unknown>) { return { body, headers: {}, ip: "192.0.2.1" } as Request; }
function res() { return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis(), setHeader: jest.fn() } as unknown as Response; }
const registerBody = { username: "newuser", email: "new@gmail.com", password: "Strong!6421", fingerprint: "device" };
const user: User = { id: "user", username: "member", email: "new@gmail.com", role: "user", dailyUsage: 0, lastUsageDate: "2026-10-07", createdAt: "2026-10-07" };

beforeEach(() => {
  jest.clearAllMocks();
  emailCodeMap.clear(); resetPasswordCodeMap.clear();
  jest.mocked(verifyRequiredCaptcha).mockResolvedValue(null);
  jest.mocked(reserveAuthEmail).mockResolvedValue({ success: true, reservation });
  jest.mocked(completeAuthEmail).mockResolvedValue(undefined);
  jest.mocked(releaseAuthEmail).mockResolvedValue(undefined);
  jest.mocked(sendEmail).mockReset().mockResolvedValue({ success: true });
  jest.mocked(UserStorage.getUserByEmail).mockResolvedValue(null);
  jest.mocked(UserStorage.getUserByEmailCanonical).mockResolvedValue(null);
  jest.mocked(UserStorage.getUserByUsername).mockResolvedValue(null);
  jest.mocked(UserStorage.validateUserInput).mockReturnValue([]);
  jest.mocked(UserStorage.getUserById).mockResolvedValue(user);
  jest.mocked(UserStorage.updateUser).mockResolvedValue(user);
  jest.mocked(validateRegistrationInviteForRegistration).mockResolvedValue({ ok: true, code: "invite" });
  jest.mocked(verificationTokenStorage.createToken).mockResolvedValue({ token: "a".repeat(64), type: VerificationTokenType.EMAIL_REGISTRATION, email: "new@gmail.com", fingerprint: "device", ipAddress: "192.0.2.1", createdAt: Date.now(), expiresAt: Date.now() + 600_000, used: false });
  jest.mocked(verificationTokenStorage.deleteToken).mockResolvedValue(undefined);
  jest.mocked(writePolicyConsent).mockReset().mockResolvedValue({ id: "consent", expiresAt: new Date() });
});

it("sends registration as a transaction without general daily quota", async () => {
  const response = res();
  await register(req(registerBody), response);
  expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "new@gmail.com", purpose: "transactional", checkQuota: false }));
  expect(completeAuthEmail).toHaveBeenCalledWith(reservation);
  expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ needVerify: true }));
});

it("returns structured cooldown without creating another verification token", async () => {
  jest.mocked(reserveAuthEmail).mockResolvedValue({ success: false, retryAfterSeconds: 42 });
  const response = res();
  await register(req(registerBody), response);
  expect(response.status).toHaveBeenCalledWith(429);
  expect(response.setHeader).toHaveBeenCalledWith("Retry-After", "42");
  expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ code: "EMAIL_SEND_COOLDOWN", retryAfterSeconds: 42 }));
  expect(verificationTokenStorage.createToken).not.toHaveBeenCalled();
});

it("cleans only the pending token and reservation when transport throws", async () => {
  jest.mocked(sendEmail).mockRejectedValue(new Error("offline"));
  await register(req(registerBody), res());
  expect(verificationTokenStorage.deleteToken).toHaveBeenCalledWith("a".repeat(64));
  expect(releaseAuthEmail).toHaveBeenCalledWith(reservation);
  expect(completeAuthEmail).not.toHaveBeenCalled();
});

it("finishes consent persistence before sending a usable link", async () => {
  jest.mocked(writePolicyConsent).mockRejectedValue(new Error("offline"));
  await register(req(registerBody), res());
  expect(sendEmail).not.toHaveBeenCalled();
  expect(releaseAuthEmail).toHaveBeenCalledWith(reservation);
});

it("gives identical successful reset responses for existing and unknown addresses", async () => {
  const unknownResponse = res();
  await forgotPassword(req(registerBody), unknownResponse);
  jest.mocked(UserStorage.getUserByEmail).mockResolvedValue(user);
  const existingResponse = res();
  await forgotPassword(req(registerBody), existingResponse);
  expect(existingResponse.json).toHaveBeenCalledWith(jest.mocked(unknownResponse.json).mock.calls[0][0]);
  expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ purpose: "transactional", checkQuota: false }));
  expect(reserveAuthEmail).toHaveBeenCalledTimes(2);
});

it("restores a previous valid legacy code when a resend fails", async () => {
  const entry = { code: "12345678", time: Date.now() - 61_000, attempts: 2, regInfo: registerBody };
  emailCodeMap.set(registerBody.email, entry);
  jest.mocked(sendEmail).mockResolvedValue({ success: false });
  await sendVerifyEmail(req({ email: registerBody.email }), res());
  expect(emailCodeMap.get(registerBody.email)).toBe(entry);
});

it("does not renew expired legacy registration data", async () => {
  emailCodeMap.set(registerBody.email, { code: "12345678", time: Date.now() - 600_001, attempts: 0, regInfo: registerBody });
  const response = res();
  await sendVerifyEmail(req({ email: registerBody.email }), response);
  expect(response.status).toHaveBeenCalledWith(400);
  expect(sendEmail).not.toHaveBeenCalled();
});

it("requires a legacy reset's recorded fingerprint even when the request omits it", async () => {
  resetPasswordCodeMap.set(registerBody.email, { code: "12345678", time: Date.now(), attempts: 0, userId: "user", fingerprint: "device" });
  const response = res();
  await resetPassword(req({ email: registerBody.email, code: "12345678", newPassword: "Strong!6421" }), response);
  expect(response.status).toHaveBeenCalledWith(403);
  expect(UserStorage.updateUser).not.toHaveBeenCalled();
});

it("allows only one concurrent legacy reset to consume a matching code", async () => {
  resetPasswordCodeMap.set(registerBody.email, { code: "12345678", time: Date.now(), attempts: 0, userId: "user", fingerprint: "device" });
  const body = { email: registerBody.email, code: "12345678", newPassword: "Strong!6421", fingerprint: "device" };
  await Promise.all([resetPassword(req(body), res()), resetPassword(req(body), res())]);
  expect(UserStorage.updateUser).toHaveBeenCalledTimes(1);
});

it("prevalidates only password-reset tokens", async () => {
  jest.mocked(verificationTokenStorage.validateToken).mockResolvedValue({ valid: false, error: "Wrong type" });
  await validateResetToken(req({ token: "a".repeat(64), fingerprint: "device" }), res());
  expect(verificationTokenStorage.validateToken).toHaveBeenCalledWith("a".repeat(64), "device", "192.0.2.1", VerificationTokenType.PASSWORD_RESET);
});
