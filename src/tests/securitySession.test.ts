import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { NextFunction, Request, Response } from "express";
import {
  clearProfileVerificationSessions,
  createProfileVerificationSession,
} from "../services/profileUpdateVerificationService";
import {
  hasValidSecuritySession,
  requireTwoFactorConfigSession,
} from "../utils/securitySession";
import { UserStorage } from "../utils/userStorage";

jest.mock("../utils/userStorage", () => ({
  UserStorage: {
    getUserById: jest.fn(),
  },
}));

const USER_ID = "u-security-session";
const mockGetUserById = UserStorage.getUserById as jest.MockedFunction<typeof UserStorage.getUserById>;

type TestResponse = Response & { statusCode: number; payload: any };

function makeReq(token?: string): Request {
  return {
    body: token === undefined ? {} : { verificationToken: token },
    headers: {},
    user: { id: USER_ID },
    originalUrl: "/api/totp/disable",
  } as unknown as Request;
}

function makeRes(): TestResponse {
  const res: any = {
    statusCode: 0,
    payload: undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: any) {
      res.payload = body;
      return res;
    },
  };
  return res as TestResponse;
}

describe("安全会话统一校验", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearProfileVerificationSessions(USER_ID);
  });

  describe("hasValidSecuritySession", () => {
    it("无令牌时返回 false", () => {
      expect(hasValidSecuritySession(makeReq())).toBe(false);
    });

    it("令牌不属于当前用户时返回 false", () => {
      const token = createProfileVerificationSession("someone-else", "password").token;
      expect(hasValidSecuritySession(makeReq(token))).toBe(false);
    });

    it("默认接受密码建立的会话", () => {
      const token = createProfileVerificationSession(USER_ID, "password").token;
      expect(hasValidSecuritySession(makeReq(token))).toBe(true);
    });

    it("requireTwoFactor 时拒绝密码会话、接受 TOTP / Passkey 会话", () => {
      const legacyMethodToken = createProfileVerificationSession(USER_ID, "password").token;
      expect(hasValidSecuritySession(makeReq(legacyMethodToken), { requireTwoFactor: true })).toBe(false);

      const totpToken = createProfileVerificationSession(USER_ID, "totp").token;
      expect(hasValidSecuritySession(makeReq(totpToken), { requireTwoFactor: true })).toBe(true);

      const passkeyToken = createProfileVerificationSession(USER_ID, "passkey").token;
      expect(hasValidSecuritySession(makeReq(passkeyToken), { requireTwoFactor: true })).toBe(true);
    });

    it("从 x-verification-token 请求头读取令牌", () => {
      const token = createProfileVerificationSession(USER_ID, "password").token;
      const req = { body: {}, headers: { "x-verification-token": token }, user: { id: USER_ID } } as unknown as Request;
      expect(hasValidSecuritySession(req)).toBe(true);
    });
  });

  describe("requireTwoFactorConfigSession", () => {
    it("无令牌时以 SECURITY_SESSION_REQUIRED 拒绝且不进入下一层", async () => {
      const res = makeRes();
      const next = jest.fn() as unknown as NextFunction;

      await requireTwoFactorConfigSession(makeReq(), res, next);

      expect(res.statusCode).toBe(403);
      expect(res.payload.code).toBe("SECURITY_SESSION_REQUIRED");
      expect(next).not.toHaveBeenCalled();
    });

    it("账号已配置 TOTP 时拒绝密码会话", async () => {
      mockGetUserById.mockResolvedValue({ id: USER_ID, totpEnabled: true } as any);
      const token = createProfileVerificationSession(USER_ID, "password").token;
      const res = makeRes();
      const next = jest.fn() as unknown as NextFunction;

      await requireTwoFactorConfigSession(makeReq(token), res, next);

      expect(res.statusCode).toBe(403);
      expect(res.payload.code).toBe("TWO_FACTOR_SESSION_REQUIRED");
      expect(next).not.toHaveBeenCalled();
    });

    it("账号只配置了 Passkey 时同样拒绝密码会话", async () => {
      mockGetUserById.mockResolvedValue({
        id: USER_ID,
        totpEnabled: false,
        passkeyCredentials: [{ credentialID: "cred-1" }],
      } as any);
      const token = createProfileVerificationSession(USER_ID, "password").token;
      const res = makeRes();
      const next = jest.fn() as unknown as NextFunction;

      await requireTwoFactorConfigSession(makeReq(token), res, next);

      expect(res.statusCode).toBe(403);
      expect(res.payload.code).toBe("TWO_FACTOR_SESSION_REQUIRED");
      expect(next).not.toHaveBeenCalled();
    });

    it("账号尚未配置任何二次验证因素时放行密码会话（否则无法开始首次配置）", async () => {
      mockGetUserById.mockResolvedValue({ id: USER_ID, totpEnabled: false, passkeyCredentials: [] } as any);
      const token = createProfileVerificationSession(USER_ID, "password").token;
      const res = makeRes();
      const next = jest.fn() as unknown as NextFunction;

      await requireTwoFactorConfigSession(makeReq(token), res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(0);
    });

    it("TOTP 会话直接放行，无需回查用户", async () => {
      const token = createProfileVerificationSession(USER_ID, "totp").token;
      const res = makeRes();
      const next = jest.fn() as unknown as NextFunction;

      await requireTwoFactorConfigSession(makeReq(token), res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(mockGetUserById).not.toHaveBeenCalled();
    });
  });
});
