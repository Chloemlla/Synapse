import { describe, expect, it, jest } from "@jest/globals";
import type { NextFunction } from "express";

/**
 * 蜜罐与地区限制的**判据**（RC-42 / RC-43 / RC-13）。
 *
 * 三条必须钉死的性质：
 * 1. 蜜罐假响应**只**含显式占位值（D19：不得出现看似真实的个人信息，否则对真的权利请求者构成误导）；
 * 2. Tarpit 有**全局并发硬顶**且使用异步计时（同步阻塞会把整个进程拖死，与初衷相反）；
 * 3. 地区判定的名单语义（黑名单优先、白名单非空才约束、取不到地区按 failOpen）。
 */

jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock("../models/securityEventModel", () => ({
  SecurityEvent: { create: jest.fn(async (doc: Record<string, unknown>) => doc) },
}));
jest.mock("../models/ipBanModel", () => ({ IpBanModel: {} }));
jest.mock("../services/turnstile/ipBan", () => ({ manualBanIp: jest.fn(async () => true) }));
jest.mock("../services/ipRiskService", () => ({ getCachedIpRisk: jest.fn(async () => null) }));
jest.mock("../config/config", () => ({ config: { regionPolicy: { mode: "off", allowedCountries: [], blockedCountries: [], failOpen: true } } }));

import { buildHoneypotResponseBody, isHoneypotPath, getActiveTarpitConnections, TARPIT_LIMITS } from "../security/honeypot";
import { evaluateRegionPolicy } from "../middleware/regionGuard";

describe("蜜罐路径与占位响应（RC-42 / D19）", () => {
  it("只认 /api/v1 与 /api/debug 前缀（已核实空闲，不与现有路由冲突）", () => {
    expect(isHoneypotPath("/api/v1/users")).toBe(true);
    expect(isHoneypotPath("/api/v1")).toBe(true);
    expect(isHoneypotPath("/api/debug/dump")).toBe(true);
    // 前缀相同但不是子路径的不得被吃掉
    expect(isHoneypotPath("/api/v10")).toBe(false);
    expect(isHoneypotPath("/api/users")).toBe(false);
  });

  it("占位响应结构合法但显式无意义，且不含任何个人数据字段", () => {
    const body = buildHoneypotResponseBody("/api/v1/users") as {
      trap: boolean;
      nodes: { id: string }[];
      note: string;
    };
    expect(body.trap).toBe(true);
    expect(body.nodes.every((node) => node.id.startsWith("dummy_trap_"))).toBe(true);
    expect(body.note).toContain("placeholder");
    // 不得出现姓名/邮箱/身份证之类的字段名（避免被当成真实数据）
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/email|username|phone|idCard|passport/i);
  });
});

describe("Tarpit 的硬顶与延时上限（RC-43 / D20）", () => {
  it("并发硬顶为 20、观察期延时上限 2 秒（与 §2.5 的裁决一致）", () => {
    expect(TARPIT_LIMITS.maxConcurrent).toBe(20);
    expect(TARPIT_LIMITS.observeMaxDelayMs).toBe(2_000);
    expect(TARPIT_LIMITS.maxDelayMs).toBeLessThanOrEqual(2_000);
    expect(getActiveTarpitConnections()).toBe(0);
  });
});

describe("地区判定（RC-13）", () => {
  const base = { mode: "challenge" as const, allowedCountries: [] as string[], blockedCountries: [] as string[], failOpen: true };

  it("mode=off 一律放行（默认就是 off，存量行为不变）", () => {
    expect(evaluateRegionPolicy({ ...base, mode: "off" }, "RU")).toMatchObject({ restricted: false });
  });

  it("黑名单优先于白名单", () => {
    const policy = { ...base, allowedCountries: ["CN", "RU"], blockedCountries: ["RU"] };
    expect(evaluateRegionPolicy(policy, "RU")).toMatchObject({ restricted: true, reason: "blocked_country:RU" });
    expect(evaluateRegionPolicy(policy, "CN")).toMatchObject({ restricted: false });
  });

  it("白名单非空时，名单外地区被拒；白名单为空则不约束", () => {
    expect(evaluateRegionPolicy({ ...base, allowedCountries: ["CN"] }, "US")).toMatchObject({ restricted: true });
    expect(evaluateRegionPolicy(base, "US")).toMatchObject({ restricted: false });
  });

  it("取不到地区按 failOpen 决定（默认放行：上游挂了不能锁死全站）", () => {
    expect(evaluateRegionPolicy(base, null)).toMatchObject({ restricted: false });
    expect(evaluateRegionPolicy({ ...base, failOpen: false }, null)).toMatchObject({ restricted: true });
  });

  it("国家码大小写不敏感（缓存里可能给 us，配置里写 US）", () => {
    expect(evaluateRegionPolicy({ ...base, blockedCountries: ["US"] }, "us")).toMatchObject({ restricted: true });
  });
});

void (jest.fn() as unknown as NextFunction);
