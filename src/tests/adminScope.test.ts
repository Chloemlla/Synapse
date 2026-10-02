import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { NextFunction, Request, Response } from "express";
import {
  isAdminAnyRolePath,
  isAdminUserSelfServicePath,
  isPlainAdminAllowedPath,
  normalizeAdminScopePath,
  requireAdminScope,
} from "../middleware/adminScope";
import { getPagesForUser } from "../services/adminScopeConfigService";

jest.mock("../services/adminScopeConfigService", () => ({
  // 展开真实导出再只替换需要 stub 的成员：替身缺件会让生产代码在调用点抛 TypeError，
  // 表现成「合法请求被 500/403」而不是断言失败。
  ...jest.requireActual("../services/adminScopeConfigService"),
  getPagesForUser: jest.fn(),
}));

const mockGetPagesForUser = getPagesForUser as jest.MockedFunction<typeof getPagesForUser>;

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
    // 默认授权 = 历史行为（用户管理 / API Key / 计费 / OAuth）。
    mockGetPagesForUser.mockResolvedValue(["dashboard", "users", "apikeys", "apikey-billing", "oauth"]);
  });

  describe("路径归一与默认放行集合", () => {
    it("折叠重复斜杠、去掉 query 与尾斜杠", () => {
      expect(normalizeAdminScopePath("/api/admin//users/?page=1")).toBe("/api/admin/users");
      expect(normalizeAdminScopePath("/api/admin/users/")).toBe("/api/admin/users");
    });

    it("默认集合里只有用户管理 / API Key / API Key 计费 / OAuth 管理", () => {
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
        "/api/admin/mobile-token/overview",
        "/api/admin/policy-consents/overview",
        "/api/cdks/export",
        "/api/webhooks",
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

    it("只要求管理员身份的端点：AdminGuard 的自检与页面授权自读", () => {
      expect(isAdminAnyRolePath("/api/admin/verify-access")).toBe(true);
      expect(isAdminAnyRolePath("/api/admin/admin-scope/me")).toBe(true);
      // 配置读写不在其列（只有超管能改）。
      expect(isAdminAnyRolePath("/api/admin/admin-scope/setting")).toBe(false);
      expect(isAdminAnyRolePath("/api/admin/users")).toBe(false);
    });
  });

  describe("fail-closed 行为", () => {
    it("未通过管理员认证（匿名）→ 403 ADMIN_REQUIRED，而不是放行", async () => {
      const res = makeRes();
      const next = jest.fn() as unknown as NextFunction;

      await requireAdminScope(makeReq({ role: null, baseUrl: "/api/admin" }), res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
      expect(res.payload.code).toBe("ADMIN_REQUIRED");
    });

    it("普通用户角色 → 403 ADMIN_REQUIRED（挂错位置只会更严）", async () => {
      const res = makeRes();
      const next = jest.fn() as unknown as NextFunction;

      await requireAdminScope(
        makeReq({ role: "user", baseUrl: "/api/turnstile", path: "/fingerprint-stats" }),
        res,
        next,
      );

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
      expect(res.payload.code).toBe("ADMIN_REQUIRED");
    });

    it("配置读取抛错时也拒绝（不因为读不到配置就放行）", async () => {
      mockGetPagesForUser.mockRejectedValue(new Error("mongo down"));
      const res = makeRes();
      const next = jest.fn() as unknown as NextFunction;

      await requireAdminScope(makeReq({ role: "admin", baseUrl: "/api/admin", path: "/users" }), res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
      expect(res.payload.code).toBe("ADMIN_SCOPE_FORBIDDEN");
    });
  });

  describe("角色分流", () => {
    it("superadmin 在任何管理端路径都放行（且不查配置）", async () => {
      const res = makeRes();
      const next = jest.fn() as unknown as NextFunction;

      await requireAdminScope(
        makeReq({ role: "superadmin", baseUrl: "/api/admin", path: "/config/envs" }),
        res,
        next,
      );

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(0);
      expect(mockGetPagesForUser).not.toHaveBeenCalled();
    });

    it("普通管理员：授权页面内的路径放行", async () => {
      const res = makeRes();
      const next = jest.fn() as unknown as NextFunction;

      await requireAdminScope(makeReq({ role: "admin", baseUrl: "/api/admin", path: "/users" }), res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(0);
    });

    it("普通管理员：授权之外一律 403 ADMIN_SCOPE_FORBIDDEN，并带上需要哪个页面", async () => {
      const res = makeRes();
      const next = jest.fn() as unknown as NextFunction;

      await requireAdminScope(makeReq({ role: "admin", baseUrl: "/api/admin", path: "/config/envs" }), res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
      expect(res.payload.code).toBe("ADMIN_SCOPE_FORBIDDEN");
      expect(res.payload.requiredPages).toEqual([]);
    });

    it("运行时授权生效：给普通管理员加 audit-log 页面后即可访问审计接口", async () => {
      mockGetPagesForUser.mockResolvedValue(["dashboard", "users", "audit-log"]);
      const res = makeRes();
      const next = jest.fn() as unknown as NextFunction;

      await requireAdminScope(
        makeReq({ role: "admin", baseUrl: "/api/admin/audit-logs", path: "/" }),
        res,
        next,
      );

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(0);
    });

    it("运行时授权生效：收回 users 页面后用户接口被拒", async () => {
      mockGetPagesForUser.mockResolvedValue(["dashboard"]);
      const res = makeRes();
      const next = jest.fn() as unknown as NextFunction;

      await requireAdminScope(makeReq({ role: "admin", baseUrl: "/api/admin", path: "/users" }), res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
      expect(res.payload.requiredPages).toEqual(["users"]);
    });

    it("普通管理员：用户自助端点放行（不因范围收窄而破坏用户功能）", async () => {
      const res = makeRes();
      const next = jest.fn() as unknown as NextFunction;

      await requireAdminScope(makeReq({ role: "admin", baseUrl: "/api/admin", path: "/user/profile" }), res, next);

      expect(next).toHaveBeenCalledTimes(1);
    });

    it("普通管理员：AdminGuard 自检的 verify-access 放行（此前会被 403 并打告警）", async () => {
      const res = makeRes();
      const next = jest.fn() as unknown as NextFunction;

      await requireAdminScope(
        makeReq({ role: "admin", baseUrl: "/api/admin", path: "/verify-access" }),
        res,
        next,
      );

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.statusCode).toBe(0);
      expect(mockGetPagesForUser).not.toHaveBeenCalled();
    });
  });
});
