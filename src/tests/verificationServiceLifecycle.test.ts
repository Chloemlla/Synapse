jest.mock("../models/verificationTokenModel", () => ({
  VerificationTokenType: { EMAIL_REGISTRATION: "email_registration", PASSWORD_RESET: "password_reset" },
  verificationTokenStorage: { validateToken: jest.fn(), getToken: jest.fn(), verifyAndUseToken: jest.fn(), deleteToken: jest.fn() },
}));
jest.mock("../services/emailService", () => ({ EmailService: { sendHtmlEmail: jest.fn() } }));
jest.mock("../services/emailSender", () => ({ sendEmail: jest.fn() }));
jest.mock("../services/authEmailCooldownService", () => ({ reserveAuthEmail: jest.fn(), completeAuthEmail: jest.fn(), releaseAuthEmail: jest.fn() }));
jest.mock("../services/authSessionService", () => ({ revokeAllAuthSessions: jest.fn() }));
jest.mock("../services/registrationInviteService", () => ({ validateRegistrationInviteForRegistration: jest.fn(), consumeRegistrationInvite: jest.fn() }));
jest.mock("../templates/emailTemplates", () => ({ generateWelcomeEmailHtml: jest.fn(() => "welcome") }));
jest.mock("../utils/userStorage", () => ({ UserStorage: {
  getUserById: jest.fn(), getUserByEmail: jest.fn(), getUserByUsername: jest.fn(),
  updateUser: jest.fn(), createUser: jest.fn(), deleteUser: jest.fn(), validateUserInput: jest.fn(),
} }));
jest.mock("../utils/logger", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

import { VerificationTokenType, verificationTokenStorage } from "../models/verificationTokenModel";
import { verifyEmailLink, verifyPasswordResetLink } from "../services/verificationService";
import { UserStorage, type User } from "../utils/userStorage";
import { revokeAllAuthSessions } from "../services/authSessionService";

const token = "a".repeat(64);
const user: User = { id: "user", username: "member", email: "member@gmail.com", role: "user", dailyUsage: 0, lastUsageDate: "2026-10-07", createdAt: "2026-10-07" };
beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(verificationTokenStorage.validateToken).mockResolvedValue({ valid: true });
  jest.mocked(verificationTokenStorage.getToken).mockResolvedValue({
    token, type: VerificationTokenType.PASSWORD_RESET, email: user.email, fingerprint: "device", ipAddress: "192.0.2.1",
    createdAt: Date.now(), expiresAt: Date.now() + 600_000, used: false, metadata: { userId: user.id, username: user.username, email: user.email },
  });
  jest.mocked(verificationTokenStorage.verifyAndUseToken).mockResolvedValue({ success: true });
  jest.mocked(UserStorage.getUserById).mockResolvedValue(user);
  jest.mocked(UserStorage.validateUserInput).mockReturnValue([]);
  jest.mocked(UserStorage.updateUser).mockResolvedValue(user);
});

it("does not consume a valid reset link when full password policy rejects the password", async () => {
  jest.mocked(UserStorage.validateUserInput).mockReturnValueOnce([{ field: "password", message: "weak password" }]);
  expect(await verifyPasswordResetLink(token, "device", "192.0.2.1", "abcdefgh")).toEqual({ success: false, error: "weak password" });
  expect(verificationTokenStorage.verifyAndUseToken).not.toHaveBeenCalled();
  expect(UserStorage.updateUser).not.toHaveBeenCalled();
  expect((await verifyPasswordResetLink(token, "device", "192.0.2.1", "Strong!6421")).success).toBe(true);
  expect(verificationTokenStorage.verifyAndUseToken).toHaveBeenCalledWith(token, "device", "192.0.2.1", VerificationTokenType.PASSWORD_RESET);
  expect(revokeAllAuthSessions).toHaveBeenCalledWith(user.id);
});

it.each([verifyEmailLink, (value: string, fingerprint: string, ip: string) => verifyPasswordResetLink(value, fingerprint, ip, "Strong!6421")])("rejects wrong-purpose links before consuming them", async (verify) => {
  jest.mocked(verificationTokenStorage.validateToken).mockResolvedValue({ valid: false, error: "Wrong type" });
  expect(await verify(token, "device", "192.0.2.1")).toEqual({ success: false, error: "Wrong type" });
  expect(verificationTokenStorage.verifyAndUseToken).not.toHaveBeenCalled();
});

it("prevents two concurrent requests from updating the password after one CAS wins", async () => {
  let consumed = false;
  jest.mocked(verificationTokenStorage.verifyAndUseToken).mockImplementation(async () => {
    if (consumed) return { success: false, error: "Used" };
    consumed = true;
    return { success: true };
  });
  const results = await Promise.all([
    verifyPasswordResetLink(token, "device", "192.0.2.1", "Strong!6421"),
    verifyPasswordResetLink(token, "device", "192.0.2.1", "Other!9876"),
  ]);
  expect(results.filter((result) => result.success)).toHaveLength(1);
  expect(UserStorage.updateUser).toHaveBeenCalledTimes(1);
});
