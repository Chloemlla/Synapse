import "./helpers/mockAppSecurityBoundaries";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import jwt from "jsonwebtoken";
import request from "supertest";
import app from "../app";
import { config } from "../config/config";
import { createProfileVerificationSession } from "../services/profileUpdateVerificationService";
import {
  exportRedisAdminSnapshot,
  getRedisAdminOverview,
  readRedisAdminKey,
  scanRedisAdminKeys,
} from "../services/redisAdminService";
import { UserStorage } from "../utils/userStorage";

/**
 * `/api/admin/system/redis/*` 的访问契约：三层保护里**任意一层缺失都必须被拒**。
 * Redis 交互本身在 `redisAdminService.test.ts` 里验，这里只验「谁能进来、进来后拿到什么状态码」。
 */

jest.mock("../utils/userStorage", () => ({
  UserStorage: {
    getUserById: jest.fn(),
  },
}));

jest.mock("../services/authSessionService", () => ({
  ...jest.requireActual("../services/authSessionService"),
  assertActiveAuthSession: jest.fn().mockResolvedValue({ userAgent: "test-agent" }),
  touchAuthSession: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../services/redisAdminService", () => ({
  getRedisAdminOverview: jest.fn(),
  scanRedisAdminKeys: jest.fn(),
  readRedisAdminKey: jest.fn(),
  exportRedisAdminSnapshot: jest.fn(),
}));

const mockGetUserById = UserStorage.getUserById as jest.MockedFunction<typeof UserStorage.getUserById>;
const mockOverview = getRedisAdminOverview as jest.MockedFunction<typeof getRedisAdminOverview>;
const mockScan = scanRedisAdminKeys as jest.MockedFunction<typeof scanRedisAdminKeys>;
const mockValue = readRedisAdminKey as jest.MockedFunction<typeof readRedisAdminKey>;
const mockExport = exportRedisAdminSnapshot as jest.MockedFunction<typeof exportRedisAdminSnapshot>;

const SUPERADMIN_ID = "u-admin";
const OVERVIEW = {
  status: { configured: true, enabled: true, ready: true, available: true },
  dbsize: 12,
  usedMemoryBytes: 4096,
  scope: { restricted: false, prefixes: [], source: "all" as const },
  maxPageLimit: 200,
  defaultPageLimit: 50,
};

function tokenFor(id: string, username: string): string {
  return jwt.sign({ userId: id, username }, config.jwtSecret, { expiresIn: "1h" });
}

function sessionToken(id = SUPERADMIN_ID): string {
  return createProfileVerificationSession(id, "password").token;
}

function asUser(id: string, role: string): void {
  mockGetUserById.mockResolvedValue({ id, username: id, role, accountStatus: "active" } as never);
}

describe("管理端 Redis 数据浏览路由", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    asUser(SUPERADMIN_ID, "superadmin");
    mockOverview.mockResolvedValue(OVERVIEW);
    mockScan.mockResolvedValue({
      ok: true,
      cursor: "0",
      done: true,
      keys: [{ key: "cache:a", type: "string", ttlMs: -1 }],
      scanned: 1,
      outOfScope: 0,
      match: "*",
      hasFilter: false,
      namespace: null,
      scope: OVERVIEW.scope,
    });
    mockValue.mockResolvedValue({
      ok: true,
      key: "cache:a",
      scope: OVERVIEW.scope,
      content: {
        type: "string",
        ttlMs: -1,
        encoding: "embstr",
        sizeBytes: 8,
        stringLength: 1,
        value: "1",
        entries: null,
        totalEntries: null,
        truncated: false,
      },
    });
    mockExport.mockImplementation(async function* () {
      yield {
        kind: "summary",
        exported: 1,
        skipped: 0,
        scanned: 1,
        outOfScope: 0,
        truncated: false,
        durationMs: 2,
      };
    });
  });

  it("未登录一律 401", async () => {
    const res = await request(app).get("/api/admin/system/redis/overview");
    expect(res.status).toBe(401);
  });

  it("普通用户 403", async () => {
    asUser("u-user", "user");
    const res = await request(app)
      .get("/api/admin/system/redis/overview")
      .set("Authorization", `Bearer ${tokenFor("u-user", "u-user")}`);
    expect(res.status).toBe(403);
  });

  it("普通管理员拿不到该页面范围（fail-closed）", async () => {
    asUser("u-plain", "admin");
    const res = await request(app)
      .get("/api/admin/system/redis/overview")
      .set("Authorization", `Bearer ${tokenFor("u-plain", "u-plain")}`);
    expect(res.status).toBe(403);
    expect(mockOverview).not.toHaveBeenCalled();
  });

  it("超管但缺安全会话：403 且带 SECURITY_SESSION_REQUIRED", async () => {
    const res = await request(app)
      .get("/api/admin/system/redis/overview")
      .set("Authorization", `Bearer ${tokenFor(SUPERADMIN_ID, "admin")}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("SECURITY_SESSION_REQUIRED");
    expect(mockOverview).not.toHaveBeenCalled();
  });

  it("超管 + 安全会话：概览放行（令牌走请求头，因为 GET 没有 body）", async () => {
    const res = await request(app)
      .get("/api/admin/system/redis/overview")
      .set("Authorization", `Bearer ${tokenFor(SUPERADMIN_ID, "admin")}`)
      .set("x-verification-token", sessionToken());
    expect(res.status).toBe(200);
    expect(res.body.overview.dbsize).toBe(12);
    expect(mockOverview).toHaveBeenCalledTimes(1);
  });

  it("键分页把查询参数透传给服务层", async () => {
    const res = await request(app)
      .get("/api/admin/system/redis/keys?limit=25&filter=cache&namespace=cache:")
      .set("Authorization", `Bearer ${tokenFor(SUPERADMIN_ID, "admin")}`)
      .set("x-verification-token", sessionToken());
    expect(res.status).toBe(200);
    expect(mockScan).toHaveBeenCalledWith({ cursor: undefined, filter: "cache", namespace: "cache:", limit: "25" });
    expect(res.body.keys).toHaveLength(1);
  });

  it("服务层 Redis 不可用时映射成 503，而不是伪装成空列表", async () => {
    mockScan.mockResolvedValue({ ok: false, code: "REDIS_UNAVAILABLE", error: "Redis 暂不可用" });
    const res = await request(app)
      .get("/api/admin/system/redis/keys")
      .set("Authorization", `Bearer ${tokenFor(SUPERADMIN_ID, "admin")}`)
      .set("x-verification-token", sessionToken());
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("REDIS_UNAVAILABLE");
  });

  it("读单键把内容原样回给调用方（明文属需求本身）", async () => {
    const res = await request(app)
      .post("/api/admin/system/redis/value")
      .set("Authorization", `Bearer ${tokenFor(SUPERADMIN_ID, "admin")}`)
      .send({ verificationToken: sessionToken(), key: "cache:a" });
    expect(res.status).toBe(200);
    expect(res.body.content.value).toBe("1");
    expect(mockValue).toHaveBeenCalledWith("cache:a", { maxValueChars: undefined, maxEntries: undefined });
  });

  it("范围外的键映射成 403（后端 fail-closed）", async () => {
    mockValue.mockResolvedValue({ ok: false, code: "REDIS_KEY_OUT_OF_SCOPE", error: "不在允许浏览的命名空间内" });
    const res = await request(app)
      .post("/api/admin/system/redis/value")
      .set("Authorization", `Bearer ${tokenFor(SUPERADMIN_ID, "admin")}`)
      .send({ verificationToken: sessionToken(), key: "other:1" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("REDIS_KEY_OUT_OF_SCOPE");
  });

  it("format=rdb 明确 501 并指向宿主机备份脚本，不产出假 rdb", async () => {
    const res = await request(app)
      .get("/api/admin/system/redis/export?format=rdb")
      .set("Authorization", `Bearer ${tokenFor(SUPERADMIN_ID, "admin")}`)
      .set("x-verification-token", sessionToken());
    expect(res.status).toBe(501);
    expect(res.body.code).toBe("REDIS_RDB_NOT_AVAILABLE");
    expect(mockExport).not.toHaveBeenCalled();
  });

  it("导出快照以 NDJSON 流出，附件名带时间戳", async () => {
    const res = await request(app)
      .get("/api/admin/system/redis/export")
      .set("Authorization", `Bearer ${tokenFor(SUPERADMIN_ID, "admin")}`)
      .set("x-verification-token", sessionToken());
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/x-ndjson");
    expect(res.headers["content-disposition"]).toContain("synapse-redis-snapshot-");
    expect(res.text.trim().split("\n").map((line) => JSON.parse(line).kind)).toEqual(["summary"]);
  });

  it("导出同样要求安全会话", async () => {
    const res = await request(app)
      .get("/api/admin/system/redis/export")
      .set("Authorization", `Bearer ${tokenFor(SUPERADMIN_ID, "admin")}`);
    expect(res.status).toBe(403);
    expect(mockExport).not.toHaveBeenCalled();
  });
});
