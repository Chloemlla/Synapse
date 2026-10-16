/**
 * Pixel 上游适配器用例：allowlist 构造、fail-closed、SSRF/重定向、错误分类、只带必要请求头。
 *
 * 全部通过注入的假 transport / 假配置完成——不发真实网络请求，也不需要 DNS。
 */
import { beforeEach, describe, expect, it } from "@jest/globals";
import {
  createPixelUpstreamClient,
  isPixelPreflightFailure,
  resolvePixelUpstreamRequest,
  type PixelUpstreamCall,
  type PixelUpstreamHttpRequest,
} from "../pixel/upstreamClient";
import { PixelDomainError } from "../pixel/types";
import type { PixelIntegrationConfig } from "../pixel/integrationConfigService";

const CONFIG: PixelIntegrationConfig = {
  upstreamBaseUrl: "https://upstream.example.com",
  allowedHosts: ["upstream.example.com"],
  enabled: true,
  requestTimeoutMs: 5_000,
};

describe("pixel 上游 allowlist 构造", () => {
  it("每条调用只落在 PRD 5.2 列出的方法 + 路径上", () => {
    expect(resolvePixelUpstreamRequest({ route: "settings" })).toEqual({
      method: "GET",
      path: "/api/settings",
      body: undefined,
    });
    expect(resolvePixelUpstreamRequest({ route: "verifyCard", body: { card_key: "up" } })).toEqual({
      method: "POST",
      path: "/api/verify-card",
      body: { card_key: "up" },
    });
    expect(
      resolvePixelUpstreamRequest({
        route: "submitTask",
        body: { card_key: "up", service_type: "link_only", accounts_text: "a@b----c" },
      }),
    ).toEqual({
      method: "POST",
      path: "/api/submit-task",
      body: { card_key: "up", service_type: "link_only", accounts_text: "a@b----c" },
    });
    expect(resolvePixelUpstreamRequest({ route: "task", taskId: "task-abcdef" })).toEqual({
      method: "GET",
      path: "/api/task/task-abcdef",
      body: undefined,
    });
    expect(resolvePixelUpstreamRequest({ route: "tasksByCard", body: { card_key: "up" } })).toEqual({
      method: "POST",
      path: "/api/tasks-by-card",
      body: { card_key: "up", account_query: "" },
    });
    expect(resolvePixelUpstreamRequest({ route: "exportByCard", body: { card_key: "up", account_query: "a@" } })).toEqual({
      method: "POST",
      path: "/api/tasks/export-by-card",
      body: { card_key: "up", account_query: "a@" },
    });
    expect(resolvePixelUpstreamRequest({ route: "cancelQueue", taskId: "task-abcdef", accountId: 7 })).toEqual({
      method: "POST",
      path: "/api/task/task-abcdef/account/7/cancel-queue",
      body: undefined,
    });
  });

  it("路径参数越界时 fail-closed（不允许把任意串拼进路径）", () => {
    const bad: PixelUpstreamCall[] = [
      { route: "task", taskId: "../../etc/passwd" },
      { route: "task", taskId: "short" },
      { route: "task", taskId: "has space in it" },
      { route: "cancelQueue", taskId: "task-abcdef", accountId: Number.NaN },
      { route: "cancelQueue", taskId: "task-abcdef", accountId: -1 },
    ];
    for (const call of bad) {
      expect(() => resolvePixelUpstreamRequest(call)).toThrow(PixelDomainError);
      try {
        resolvePixelUpstreamRequest(call);
      } catch (error) {
        expect((error as PixelDomainError).code).toBe("PIXEL_ROUTE_NOT_ALLOWED");
        expect((error as PixelDomainError).status).toBe(500);
      }
    }
  });
});

describe("pixel 上游客户端 fail-closed 与出站约束", () => {
  let requests: PixelUpstreamHttpRequest[] = [];
  let response: { status: number; bodyText: string };
  let thrown: unknown;
  let config: PixelIntegrationConfig | null;
  let hostPublic: boolean;

  function client() {
    return createPixelUpstreamClient({
      loadConfig: async () => config,
      assertHostPublic: async () => hostPublic,
      transport: async (request) => {
        requests.push(request);
        if (thrown) throw thrown;
        return response;
      },
    });
  }

  beforeEach(() => {
    requests = [];
    response = { status: 200, bodyText: "{}" };
    thrown = undefined;
    config = CONFIG;
    hostPublic = true;
  });

  it("未配置上游时 503 且一个字节都不发出去", async () => {
    config = null;
    await expect(client().call({ route: "settings" })).rejects.toMatchObject({
      code: "PIXEL_UPSTREAM_NOT_CONFIGURED",
      status: 503,
    });
    expect(requests).toHaveLength(0);
  });

  it("主机不在 allowlist 内时拒绝发请求", async () => {
    config = { ...CONFIG, allowedHosts: ["other.example.com"] };
    await expect(client().call({ route: "settings" })).rejects.toMatchObject({
      code: "PIXEL_UPSTREAM_TARGET_BLOCKED",
      status: 502,
    });
    expect(requests).toHaveLength(0);
  });

  it("域名解析到内网/保留地址时拒绝发请求（SSRF 防护）", async () => {
    hostPublic = false;
    await expect(client().call({ route: "settings" })).rejects.toMatchObject({
      code: "PIXEL_UPSTREAM_TARGET_BLOCKED",
    });
    expect(requests).toHaveLength(0);
  });

  it("重定向不跟随：3xx 直接判失败", async () => {
    response = { status: 302, bodyText: "" };
    await expect(client().call({ route: "settings" })).rejects.toMatchObject({
      code: "PIXEL_UPSTREAM_TARGET_BLOCKED",
    });
  });

  it("成功响应解析 JSON，并回报字节数", async () => {
    response = { status: 200, bodyText: '{"valid":true,"remaining_quota":"5"}' };
    const result = await client().call({ route: "verifyCard", body: { card_key: "up" } });
    expect(result.status).toBe(200);
    expect(result.data).toEqual({ valid: true, remaining_quota: "5" });
    expect(result.requestBytes).toBeGreaterThan(0);
    expect(result.responseBytes).toBeGreaterThan(0);
  });

  it("非 JSON 响应不抛异常，data 留 null（由调用方按状态码处理）", async () => {
    response = { status: 200, bodyText: "<html>maintenance</html>" };
    const result = await client().call({ route: "settings" });
    expect(result.data).toBeNull();
  });

  it("超时归 504，连接失败归 502（都不暴露上游细节）", async () => {
    thrown = Object.assign(new Error("timeout of 5000ms exceeded"), { code: "ECONNABORTED" });
    await expect(client().call({ route: "settings" })).rejects.toMatchObject({
      code: "PIXEL_UPSTREAM_TIMEOUT",
      status: 504,
    });
    thrown = Object.assign(new Error("getaddrinfo ENOTFOUND upstream.example.com"), { code: "ENOTFOUND" });
    const failure = await client()
      .call({ route: "settings" })
      .catch((error: unknown) => error as PixelDomainError);
    expect(failure.code).toBe("PIXEL_UPSTREAM_UNREACHABLE");
    expect(failure.message).not.toContain("upstream.example.com");
  });

  it("只带 accept/content-type，且请求体是受控 JSON（不透传客户端 header）", async () => {
    response = { status: 200, bodyText: "{}" };
    await client().call({ route: "submitTask", body: { card_key: "up-1", service_type: "link_only", accounts_text: "a@b.com----p" } });
    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request.url).toBe("https://upstream.example.com/api/submit-task");
    expect(Object.keys(request.headers).sort()).toEqual(["accept", "content-type"]);
    expect(request.headers["content-type"]).toBe("application/json");
    expect(request.timeoutMs).toBe(5_000);
    const parsed = JSON.parse(String(request.body)) as Record<string, unknown>;
    expect(parsed.card_key).toBe("up-1");
    expect(parsed.service_type).toBe("link_only");
    expect(parsed.accounts_text).toBe("a@b.com----p");
  });

  it("GET 请求不带请求体、不带 content-type", async () => {
    response = { status: 200, bodyText: "{}" };
    await client().call({ route: "task", taskId: "task-abcdef" });
    expect(requests[0].body).toBeUndefined();
    expect(requests[0].headers).toEqual({ accept: "application/json" });
  });

  it("只有「请求没送出去」的失败允许复用幂等键重试", () => {
    expect(isPixelPreflightFailure(new PixelDomainError("x", 503, "PIXEL_UPSTREAM_NOT_CONFIGURED"))).toBe(true);
    expect(isPixelPreflightFailure(new PixelDomainError("x", 502, "PIXEL_UPSTREAM_TARGET_BLOCKED"))).toBe(true);
    expect(isPixelPreflightFailure(new PixelDomainError("x", 504, "PIXEL_UPSTREAM_TIMEOUT"))).toBe(false);
    expect(isPixelPreflightFailure(new PixelDomainError("x", 502, "PIXEL_UPSTREAM_UNREACHABLE"))).toBe(false);
    expect(isPixelPreflightFailure(new Error("boom"))).toBe(false);
  });
});
