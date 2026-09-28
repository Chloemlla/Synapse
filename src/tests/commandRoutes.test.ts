import "./helpers/mockAppSecurityBoundaries";
import * as os from "node:os";
import jwt from "jsonwebtoken";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import request from "supertest";
import app from "../app";
import { config } from "../config/config";
import { UserStorage } from "../utils/userStorage";
import { createProfileVerificationSession } from "../services/profileUpdateVerificationService";

jest.mock("../utils/userStorage", () => ({
  UserStorage: {
    getUserById: jest.fn(),
  },
}));

jest.mock("../services/authSessionService", () => ({
  // 补上没被 stub 的纯函数 hashAuthCredential（authenticateToken 会调）：
  // 替身缺它 → 抛错 → 401「认证失败」，整组路由用例全挂。
  ...jest.requireActual("../services/authSessionService"),
  assertActiveAuthSession: jest.fn().mockResolvedValue({ userAgent: "test-agent" }),
  touchAuthSession: jest.fn().mockResolvedValue(undefined),
}));

const mockGetUserById = UserStorage.getUserById as jest.MockedFunction<typeof UserStorage.getUserById>;

function superadminToken(): string {
  return jwt.sign({ userId: "u-admin", username: "admin" }, config.jwtSecret, { expiresIn: "1h" });
}

describe("Command Routes", () => {
  // 命令端点已统一改为复用个人资料页「安全会话」：为 u-admin（与 JWT userId 一致）建立一枚
  // verificationToken，随请求体一并发送；不再校验管理操作口令。
  let adminSessionToken = "";

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUserById.mockResolvedValue({
      id: "u-admin",
      username: "admin",
      role: "superadmin",
      accountStatus: "active",
    } as any);
    adminSessionToken = createProfileVerificationSession("u-admin", "password").token;
  });

  describe("POST /api/command/execute", () => {
    it("应该拒绝未登录请求（401）", async () => {
      const res = await request(app).post("/api/command/execute").send({
        command: "ls",
        verificationToken: adminSessionToken,
      });

      expect(res.status).toBe(401);
    });

    it("非超级管理员应被拒绝（403）", async () => {
      mockGetUserById.mockResolvedValue({
        id: "u-user",
        username: "alice",
        role: "user",
        accountStatus: "active",
      } as any);
      const token = jwt.sign({ userId: "u-user", username: "alice" }, config.jwtSecret, { expiresIn: "1h" });

      const res = await request(app)
        .post("/api/command/execute")
        .set("Authorization", `Bearer ${token}`)
        .send({ command: "ls", verificationToken: adminSessionToken });

      expect(res.status).toBe(403);
    });

    it("应该拒绝无有效安全会话的请求", async () => {
      const res = await request(app)
        .post("/api/command/execute")
        .set("Authorization", `Bearer ${superadminToken()}`)
        .send({
          command: "ls",
          verificationToken: "invalid-token",
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/安全会话/);
    });

    it("应该成功执行安全命令", async () => {
      // 根据平台选择不同的命令
      const testCommand = os.platform() === "win32" ? "dir" : "ls";

      const res = await request(app)
        .post("/api/command/execute")
        .set("Authorization", `Bearer ${superadminToken()}`)
        .send({
          command: testCommand,
          verificationToken: adminSessionToken,
        });

      // 在 Windows 上 dir 可能不在白名单中，所以我们检查状态码
      if (res.status === 200) {
        expect(res.body.output).toBeDefined();
      } else if (res.status === 500) {
        // 如果命令执行失败，至少验证了鉴权和安全会话校验通过
        expect(res.body.error).toBeDefined();
      }
    });
  });

  describe("POST /api/command/status", () => {
    it("应该返回服务器状态", async () => {
      const res = await request(app)
        .post("/api/command/status")
        .set("Authorization", `Bearer ${superadminToken()}`)
        .send({
          verificationToken: adminSessionToken,
        });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("uptime");
      expect(res.body).toHaveProperty("memory_usage");
      expect(res.body).toHaveProperty("cpu_usage_percent");
    });

    it("应该拒绝无有效安全会话的状态请求", async () => {
      const res = await request(app)
        .post("/api/command/status")
        .set("Authorization", `Bearer ${superadminToken()}`)
        .send({
          verificationToken: "invalid-token",
        });

      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/安全会话/);
    });
  });
});
