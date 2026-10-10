import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import express from "express";
import request from "supertest";

// 替身必须覆盖生产代码用到的每个成员，漏一个会在调用点抛 TypeError 并伪装成业务失败。
const mockUploadFile = jest.fn();
const mockUpdateUser = jest.fn();
let mockRole = "user";

jest.mock("../middleware/auth", () => ({
  authMiddlewareV2: (req: { user?: unknown }, _res: unknown, next: () => void) => {
    req.user = { id: "u1", username: "alice", role: mockRole };
    next();
  },
  isAdminRole: (role: unknown) => role === "admin" || role === "superadmin",
}));

jest.mock("../services/ipfsService", () => ({
  IPFSService: { uploadFile: (...args: unknown[]) => mockUploadFile(...args) },
}));

jest.mock("../utils/userStorage", () => ({
  UserStorage: { updateUser: (...args: unknown[]) => mockUpdateUser(...args) },
}));

import { registerProfileAvatarRoutes } from "../routes/admin/profile.avatar";

// 最小合法 JPEG 头尾：本用例只验「字段透传」，不验图片解码。
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

function buildApp() {
  const app = express();
  const router = express.Router();
  registerProfileAvatarRoutes(router);
  app.use("/api/admin", router);
  return app;
}

describe("头像上传的人机验证透传", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRole = "user";
    mockUploadFile.mockResolvedValue({ web2url: "https://ipfs.example/avatar.jpg" });
    mockUpdateUser.mockResolvedValue(undefined);
  });

  it("把 multipart 里的挑战令牌与供应商传给 IPFSService", async () => {
    const res = await request(buildApp())
      .post("/api/admin/user/avatar")
      .field("captchaToken", "tok-123")
      .field("captchaProvider", "hcaptcha")
      .attach("avatar", JPEG, { filename: "avatar.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(200);
    expect(mockUploadFile).toHaveBeenCalledTimes(1);
    const args = mockUploadFile.mock.calls[0];
    expect(args[0]).toEqual(JPEG);
    expect(args[1]).toBe("avatar.jpg");
    expect(args[2]).toBe("image/jpeg");
    expect(args[4]).toBe("tok-123");
    expect(args[5]).toMatchObject({ captchaProvider: "hcaptcha", shouldSkipTurnstile: false });
  });

  it("没有令牌时不编造令牌，交给服务层回「请先完成人机验证」", async () => {
    const res = await request(buildApp())
      .post("/api/admin/user/avatar")
      .attach("avatar", JPEG, { filename: "avatar.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(200);
    expect(mockUploadFile.mock.calls[0][4]).toBe("");
  });

  it("管理员上传带 shouldSkipTurnstile 豁免，不必先过验证", async () => {
    mockRole = "admin";
    const res = await request(buildApp())
      .post("/api/admin/user/avatar")
      .attach("avatar", JPEG, { filename: "avatar.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(200);
    expect(mockUploadFile.mock.calls[0][5]).toMatchObject({ isAdmin: true, shouldSkipTurnstile: true });
  });

  it("挑战缺失/失效时把「去完成人机验证」原样回给用户，而不是通用失败文案", async () => {
    mockUploadFile.mockRejectedValueOnce(new Error("请先完成人机验证"));

    const res = await request(buildApp())
      .post("/api/admin/user/avatar")
      .attach("avatar", JPEG, { filename: "avatar.jpg", contentType: "image/jpeg" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("请先完成人机验证");
  });
});
