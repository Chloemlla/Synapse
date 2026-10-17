import { describe, expect, it, jest } from "@jest/globals";
import fs from "node:fs";
import path from "node:path";

jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { isWafBypassPath } from "../middleware/wafMiddleware";
import { getAllRouteAuditRecords, validateRouteGovernance } from "../routes";

/**
 * RC-33：邮件 API 的 WAF 处置**按 RC-48 的实测结论落地**（本批次不改前缀豁免）。
 *
 * 审计原文 RC-33 最初要求「给 /api/email、/api/outemail 加前缀级 WAF 豁免」，
 * 但 RC-48 用实测推翻了它：WAF 已有**字段级**白名单（html / text / content），
 * 邮件 HTML 正文本来就能通过；再加前缀豁免等于把这两个端点完全绕开
 * SQLi/XSS/路径穿越/命令注入扫描（含 `to`/`subject` 的邮件头注入面）。
 * 本仓库也已有 `wafEmailFields.test.ts` 把「没有前缀豁免」钉成回归。
 *
 * 所以本用例钉的是 RC-33 的另一半要求：**豁免不放开注入面**这件事，
 * 必须由「鉴权 + 限流仍然成立」来兜底；声明与实现都要能被用例发现漂移。
 */
describe("RC-33 邮件 API × WAF（按 RC-48 结论）", () => {
  it("邮件路径没有前缀级 WAF 豁免（字段级白名单才是豁免面）", () => {
    expect(isWafBypassPath("/api/email")).toBe(false);
    expect(isWafBypassPath("/api/email/send")).toBe(false);
    expect(isWafBypassPath("/api/outemail")).toBe(false);
    expect(isWafBypassPath("/api/outemail/send")).toBe(false);
  });

  it("路由注册表仍声明了鉴权与限流（WAF 不扫 ≠ 不设防）", () => {
    const records = getAllRouteAuditRecords();
    const email = records.find((record) => record.name === "email-routes");
    const outemail = records.find((record) => record.name === "outemail-routes");

    expect(email).toBeDefined();
    expect(email?.requiresAuth).toBe("mixed");
    expect(email?.rateLimited).toBe("mixed");
    expect(email?.authPolicy?.handlers).toEqual(
      expect.arrayContaining(["authMiddleware", "adminAuthMiddleware", "authenticateSuperAdmin"]),
    );

    expect(outemail).toBeDefined();
    expect(outemail?.requiresAuth).toBe("mixed");
    expect(outemail?.rateLimited).toBe(true);
    expect(outemail?.rateLimitPolicy?.limiters).toEqual(expect.arrayContaining(["outEmailLimiter"]));
  });

  it("实现侧：/api/email 写操作仍是 superadmin 级，/api/outemail/send 仍挂专属限流", () => {
    const emailSource = fs.readFileSync(path.join(process.cwd(), "src", "routes", "emailRoutes.ts"), "utf8");
    // 挂载层先过登录，随后 admin 门槛 + 页面范围；写操作再叠 superadmin（逐个端点核对）。
    expect(emailSource).toMatch(/router\.use\(authMiddleware\)/);
    expect(emailSource).toMatch(/router\.use\(adminAuthMiddleware, requireAdminScope\)/);
    expect((emailSource.match(/authenticateSuperAdmin/g) || []).length).toBeGreaterThanOrEqual(4);
    expect((emailSource.match(/emailSendLimiter/g) || []).length).toBeGreaterThanOrEqual(4);

    const outemailSource = fs.readFileSync(path.join(process.cwd(), "src", "routes", "outemailRoutes.ts"), "utf8");
    expect(outemailSource).toMatch(/router\.post\("\/send", outEmailLimiter/);
  });

  it("security-bypass-inconsistency 不对邮件路径告警，且治理无 fatal 项", () => {
    const violations = validateRouteGovernance();
    const emailWarnings = violations.filter(
      (item) =>
        item.code === "security-bypass-inconsistency" &&
        (item.path.startsWith("/api/email") || item.path.startsWith("/api/outemail")),
    );
    expect(emailWarnings).toEqual([]);
    expect(violations.filter((item) => item.code !== "security-bypass-inconsistency")).toEqual([]);
  });
});
