import express from "express";
import jwt from "jsonwebtoken";
import request from "supertest";
import { config } from "../config/config";
import totpRoutes from "../routes/totpRoutes";
import { createProfileVerificationSession } from "../services/profileUpdateVerificationService";
import { UserStorage } from "../utils/userStorage";

// 与 backupCodes.test.ts 同一套最小应用：只挂 totpRoutes，避免拉起整个 app。
const app = express();
app.use(express.json());
app.use("/api/totp", totpRoutes);

const USER_ID = "test-user-id";

const mockUser = {
  id: USER_ID,
  username: "testuser",
  email: "test@example.com",
  role: "user",
  totpEnabled: true,
  totpSecret: "JBSWY3DPEHPK3PXP",
  backupCodes: [],
};

const generateTestToken = (userId: string) =>
  jwt.sign({ userId }, config.jwtSecret, { expiresIn: "1h" });

jest.mock("../utils/userStorage", () => ({
  UserStorage: {
    getUserById: jest.fn(),
    getUserSecretsById: jest.fn(),
    updateUser: jest.fn(),
  },
}));

// 认证链上的会话服务要替掉，真实现要查库（本套件没起 Mongo），报错会被中间件兜成 401。
jest.mock("../services/authSessionService", () => ({
  ...jest.requireActual("../services/authSessionService"),
  assertActiveAuthSession: jest.fn().mockResolvedValue({ userAgent: "test-agent" }),
  touchAuthSession: jest.fn().mockResolvedValue(undefined),
}));

describe("关闭 TOTP", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (UserStorage.getUserById as jest.Mock).mockResolvedValue(mockUser);
    (UserStorage.getUserSecretsById as jest.Mock).mockResolvedValue(mockUser);
    (UserStorage.updateUser as jest.Mock).mockResolvedValue(undefined);
  });

  it("安全会话有效时无需验证码直接关闭", async () => {
    const verificationToken = createProfileVerificationSession(USER_ID, "totp").token;

    const response = await request(app)
      .post("/api/totp/disable")
      .set("Authorization", `Bearer ${generateTestToken(USER_ID)}`)
      .send({ verificationToken })
      .expect(200);

    expect(response.body).toEqual({ message: "TOTP已禁用", enabled: false });
    expect(UserStorage.updateUser).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ totpEnabled: false, totpSecret: "" }),
    );
  });

  it("没有安全会话时拒绝关闭", async () => {
    const response = await request(app)
      .post("/api/totp/disable")
      .set("Authorization", `Bearer ${generateTestToken(USER_ID)}`)
      .send({})
      .expect(403);

    expect(response.body.code).toBe("SECURITY_SESSION_REQUIRED");
    expect(UserStorage.updateUser).not.toHaveBeenCalled();
  });

  it("已启用TOTP的账号不接受密码建立的会话", async () => {
    const legacyMethodSession = createProfileVerificationSession(USER_ID, "password").token;

    const response = await request(app)
      .post("/api/totp/disable")
      .set("Authorization", `Bearer ${generateTestToken(USER_ID)}`)
      .send({ verificationToken: legacyMethodSession })
      .expect(403);

    expect(response.body.code).toBe("TWO_FACTOR_SESSION_REQUIRED");
    expect(UserStorage.updateUser).not.toHaveBeenCalled();
  });

  it("请求体里残留验证码字段时同样直接关闭（旧前端缓存的请求体）", async () => {
    const verificationToken = createProfileVerificationSession(USER_ID, "totp").token;

    const response = await request(app)
      .post("/api/totp/disable")
      .set("Authorization", `Bearer ${generateTestToken(USER_ID)}`)
      .send({ verificationToken, token: "000000" })
      .expect(200);

    expect(response.body).toEqual({ message: "TOTP已禁用", enabled: false });
  });

  it("未启用TOTP时返回400", async () => {
    (UserStorage.getUserSecretsById as jest.Mock).mockResolvedValue({ ...mockUser, totpEnabled: false });
    const verificationToken = createProfileVerificationSession(USER_ID, "totp").token;

    const response = await request(app)
      .post("/api/totp/disable")
      .set("Authorization", `Bearer ${generateTestToken(USER_ID)}`)
      .send({ verificationToken })
      .expect(400);

    expect(response.body.error).toBe("TOTP未启用");
  });
});
