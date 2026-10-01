import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { NextFunction, Request, Response } from "express";
import {
  isAdminUserSelfServicePath,
  isPlainAdminAllowedPath,
  normalizeAdminScopePath,
  requireAdminScope,
} from "../middleware/adminScope";

type TestResponse = Response & { statusCode: number; payload: any };

function makeReq(options: { role?: string | null; path?: string; baseUrl?: string }): Request {
  const user = options.role === null ? undefined : { id: "u-1", role: options.role ?? "admin" };
  return {
    body: {},
    headers: {},
    method: "GET",
    path: options.path ?? "/",
    baseUrl: options.baseUrl ?? "",
    user,
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

describe("普通管理员范围守卫 requireAdminScope", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("路径归一与白名单", () => {
    it("折叠重复斜杠、去掉 query 与尾斜杠", () => {
      expect(normalizeAdminScopePath("/api/admin//users/?page=1")).toBe("/api/admin/users");
      expect(normalizeAdminScopePath("/api/admin/users/")).toBe("/api/admin/users");
    });

    it("只有用户管理 / API Key / API Key 计费 / OAuth 管理在白名单内", () => {
      for (const allowed of [
        "/api/admin/users",
        "/api/admin/users/u-1",
        "/api/admin/apikey-billing",
        "/api/apikeys",
        "/api/apikeys/key-1/revoke",
        "/api/oauth",
        "/api/oauth/clients",
      ]) {
        expect(isPlainAdminAllowedPath(allowed)).toBe(true);
      }

      for (const denied of [
        "/api/admin/config/envs",
        "/api/admin/crash-reports",
        "/api/admin/mobile-tokens",
        "/api/admin/policy-consents",
        "/api/cdks/export",
        "/api/webhook-events",
        "/api/status/profiling",
        "/api/turnstile/providers",
      ]) {
        expect(isPlainAdminAllowedPath(denied)).toBe(false);
      }
    });

    it("用户自助端点是例外（普通登录用户的接口，住在 /api/admin 前缀下）", () => {
      expect(isAdminUserSelfServicePath("/api/admin/user/profile")).toBe(true);
      expect(isAdminUserSelfServicePath("/api/admin/user/avatar")).toBe(true);
      expect(isAdminUserSelfServicePath("/api/admin/user/fingerprint")).toBe(true);
      expect(isAdminUserSelfServicePath("/api/admin/users")).toBe(false);
    });
  });

  describe("fail-closed 行为", () => {
    it("未通过管理员认证（匿名）→ 403 ADMIN_REQUIRED，而不是放行", () => {
      const res = makeRes();
      const next = jest.fn() as unknown as NextFunction;

      requireAdminScope(makeReq({ role: null, baseUrl: "/api/admin" }), res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
      expect(res.payload.code).toBe("ADMIN_REQUIRED");
    });

    it("普通用户角色 → 403 ADMIN_REQUIRED（挂错位置只会更严）", () => {
      const res = makeRes();
      const next = jest.fn() as unknown as NextFunction;

      requireAdminScope(makeReq({ role: "user", baseUrl: "/api/turnstile", path: "/fingerprint-stats" }), res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
      expect(res.payload.code).toBe("ADMIN_REQUIRED");
    });
  });

  describe("角色分流", () => {
    it("superadmin 在任何管理端路径都放行", () => {
      const res = makeRes();
      const next = jest.fn() as unknown as NextFunction;

      requireAdminScope(makeReq({ role: "superadmin", baseUrl: "/api/admin", path: "/config/envs" }), res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(0);
    });

    it("普通管理员：白名单路径放行", () => {
      const res = makeRes();
      const next = jest.fn() as unknown as NextFunction;

      requireAdminScope(makeReq({ role: "admin", baseUrl: "/api/admin", path: "/users" }), res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(0);
    });

    it("普通管理员：白名单之外一律 403 ADMIN_SCOPE_FORBIDDEN", () => {
      const res = makeRes();
      const next = jest.fn() as unknown as NextFunction;

      requireAdminScope(makeReq({ role: "admin", baseUrl: "/api/admin", path: "/config/envs" }), res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
      expect(res.payload.code).toBe("ADMIN_SCOPE_FORBIDDEN");
    });

    it("普通管理员：用户自助端点放行（不因范围收窄而破坏用户功能）", () => {
      const res = makeRes();
      const next = jest.fn() as unknown as NextFunction;

      requireAdminScope(makeReq({ role: "admin", baseUrl: "/api/admin", path: "/user/profile" }), res, next);

      expect(next).toHaveBeenCalledTimes(1);
    });
  });
});
