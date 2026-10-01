import express from "express";
import request from "supertest";

const TEST_USER_ID = "u-security-session";

// 鉴权：本套件只测身份验证方式本身，直接把登录态塞进 req.user。
jest.mock("../middleware/auth", () => ({
  authMiddlewareV2: (req: any, _res: any, next: any) => {
    req.user = { id: TEST_USER_ID, username: "tester", role: "admin" };
    next();
  },
  isAdminRole: () => true,
}));

// 精简路由依赖：只留 /user/profile/verify 需要的那几支，避免把 IPFS / 账号合并等外部服务拖进来。
jest.mock("../routes/admin/profile.avatar", () => ({ registerProfileAvatarRoutes: () => {} }));
jest.mock("../routes/admin/profile.fingerprint", () => ({ registerProfileFingerprintRoutes: () => {} }));
jest.mock("../routes/admin/profile.identity", () => ({ registerProfileIdentityRoutes: () => {} }));
jest.mock("../services/userService", () => ({ getUserAuthById: jest.fn() }));
jest.mock("../services/emailSender", () => ({ sendEmail: jest.fn().mockResolvedValue({ success: true }) }));
jest.mock("../services/authSessionService", () => ({
  AuthSessionError: class AuthSessionError extends Error {},
  listAuthDevices: jest.fn(),
  revokeAllAuthSessions: jest.fn(),
  revokeAuthDevice: jest.fn(),
}));
jest.mock("../utils/userStorage", () => ({
  UserStorage: {
    getUserById: jest.fn(),
    checkPassword: jest.fn(),
    updateUser: jest.fn(),
    consumeTotpCounter: jest.fn(),
  },
}));

import profileRouter from "../routes/admin/profile";
import { sendEmail } from "../services/emailSender";
import { getUserAuthById } from "../services/userService";
import { TOTPService } from "../services/totpService";
import { UserStorage } from "../utils/userStorage";
import { validateProfileVerificationSession } from "../services/profileUpdateVerificationService";

const app = express();
app.use(express.json());
app.use("/api/admin", profileRouter);

async function buildUser(overrides: Record<string, unknown> = {}) {
  return {
    id: TEST_USER_ID,
    username: "tester",
    email: "tester@example.com",
    role: "admin",
    totpEnabled: true,
    totpSecret: "JBSWY3DPEHPK3PXP",
    backupCodes: await TOTPService.hashBackupCodes(["ABCD1234", "EFGH5678"]),
    ...overrides,
  };
}

const verify = (body: Record<string, unknown>) =>
  request(app).post("/api/admin/user/profile/verify").send(body);

describe("安全会话：TOTP 验证支持备用恢复码", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("用恢复码可以建立 totp 安全会话，并报废用掉的那一枚", async () => {
    const user = await buildUser();
    (getUserAuthById as jest.Mock).mockResolvedValue(user);

    const response = await verify({ method: "totp", backupCode: "abcd-1234" }).expect(200);

    expect(response.body.success).toBe(true);

    // 会话方式必须是 totp：双因素配置类操作（requireTwoFactorConfigSession）只认非密码会话。
    const session = validateProfileVerificationSession(TEST_USER_ID, response.body.verificationToken);
    expect(session?.method).toBe("totp");

    // 用掉的那一枚被报废，剩余一枚仍以哈希形态落库（不能写回明文）。
    const updateArgs = (UserStorage.updateUser as jest.Mock).mock.calls[0] as [string, { backupCodes: string[] }];
    expect(updateArgs[0]).toBe(TEST_USER_ID);
    expect(updateArgs[1].backupCodes).toHaveLength(1);
    expect(updateArgs[1].backupCodes[0].startsWith("$2")).toBe(true);

    // 恢复码被使用是必须触达的安全事件通知。
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect((sendEmail as jest.Mock).mock.calls[0][0]).toMatchObject({
      to: "tester@example.com",
      checkQuota: false,
    });
  });

  it("恢复码错误时拒绝，且不改动库里的恢复码", async () => {
    const user = await buildUser();
    (getUserAuthById as jest.Mock).mockResolvedValue(user);

    const response = await verify({ method: "totp", backupCode: "ZZZZ9999" }).expect(401);

    expect(response.body.error).toBe("恢复码错误");
    expect(UserStorage.updateUser).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("没有可用恢复码时给出可解释的错误", async () => {
    (getUserAuthById as jest.Mock).mockResolvedValue(await buildUser({ backupCodes: [] }));

    const response = await verify({ method: "totp", backupCode: "ABCD1234" }).expect(400);

    expect(response.body.error).toBe("当前账户没有可用的恢复码");
  });

  it("只给垃圾输入时不消耗任何凭证", async () => {
    (getUserAuthById as jest.Mock).mockResolvedValue(await buildUser());

    const response = await verify({ method: "totp", verificationCode: "not-a-code" }).expect(400);

    expect(response.body.error).toBe("请输入 6 位 TOTP 验证码或 8 位恢复码");
    expect(UserStorage.updateUser).not.toHaveBeenCalled();
  });

  it("6 位 TOTP 验证码仍按原逻辑（含 counter 重放防护）通过", async () => {
    (getUserAuthById as jest.Mock).mockResolvedValue(await buildUser());
    jest.spyOn(TOTPService, "verifyTokenWithCounter").mockReturnValue({ valid: true, counter: 42 });
    (UserStorage.consumeTotpCounter as jest.Mock).mockResolvedValue(true);

    const response = await verify({ method: "totp", verificationCode: "123456" }).expect(200);

    expect(UserStorage.consumeTotpCounter).toHaveBeenCalledWith(TEST_USER_ID, 42);
    const session = validateProfileVerificationSession(TEST_USER_ID, response.body.verificationToken);
    expect(session?.method).toBe("totp");
    jest.restoreAllMocks();
  });
});
