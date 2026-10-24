import { getAllRouteAuditRecords, postTamperRouteModules, routeLimiterModules, validateRouterMiddlewarePresence } from "../routes";
import { knownAuthMiddleware, knownMountLimiters } from "../routes/routeModules/knownMiddleware";
import { authenticateToken } from "../middleware/authenticateToken";
import { translationAccessMiddleware } from "../middleware/translationAccessMiddleware";
import { cdictWebIngressLimiter } from "../middleware/cdictWebLimiters";
import { nexaiRequestSignature } from "../middleware/nexaiRequestSignature";
import { shouldBypassSecurityComponent, type SecurityComponent } from "../security/securityPolicy";
import { isWafBypassPath, wafMiddleware } from "../middleware/wafMiddleware";
import express from "express";
import request from "supertest";

jest.mock("../utils/logger", () => ({
  __esModule: true, default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

describe("CDict website real route registry security", () => {
  it("registers the private website module in the post-tamper phase with real middleware metadata", () => {
    const web = postTamperRouteModules.find((module) => module.name === "cdict-web-routes");
    expect(web).toBeDefined();
    expect(web?.path).toBe("/api/translate/cdict");
    expect(validateRouterMiddlewarePresence(web!)).toEqual([]);
    expect(knownAuthMiddleware.get(authenticateToken)).toBe("authenticateToken");
    expect(knownAuthMiddleware.get(translationAccessMiddleware)).toBe("translationAccessMiddleware");
    expect(knownMountLimiters.get(cdictWebIngressLimiter)).toBe("cdictWebIngressLimiter");
    const record = getAllRouteAuditRecords().find((item) => item.name === "cdict-web-routes");
    expect(record?.phase).toBe("post-tamper");
    expect(record?.mountMiddlewareNames).toEqual(expect.arrayContaining([
      "authenticateToken", "translationAccessMiddleware", "cdictWebIngressLimiter",
    ]));
    expect(record?.rateLimitPolicy?.limiters).toEqual(expect.arrayContaining([
      "cdictWebUpstreamIpLimiter", "cdictWebUpstreamUserLimiter", "cdictWebUpstreamGlobalBurstGuard",
    ]));
    expect(record?.auditLogPolicy.enabled).toBe(true);
  });
  it.each(["waf", "ipBan", "ipVerification", "tamperProtection", "replayProtection"] as SecurityComponent[])
    ("never inherits Android or other namespace exemptions for %s", (component) => {
      for (const path of ["/translate", "/languages", "/tts", "/donate", "/donate/claim", "/donate/alipay"]) {
        expect(shouldBypassSecurityComponent(component, "/api/translate/cdict" + path)).toBe(false);
      }
    });
  it("preserves the Android-only WAF/signature scope and leaves the website fully inspected", () => {
    expect(isWafBypassPath("/api/cdict/translate")).toBe(true);
    expect(isWafBypassPath("/api/translate/cdict/translate")).toBe(false);
    const signatureMount = routeLimiterModules.find((module) => module.name === "cdict-signature");
    expect(signatureMount?.path).toBe("/api/cdict");
    expect(signatureMount?.router).toBe(nexaiRequestSignature);
    expect(postTamperRouteModules.find((module) => module.name === "cdict-routes")?.requiresAuth).toBe(false);
  });
});


describe("website CDict full WAF before mount guards", () => {
  const app = express();
  app.use(express.json());
  app.use(wafMiddleware);
  const web = postTamperRouteModules.find((module) => module.name === "cdict-web-routes")!;
  app.use(web.path, ...(web.middlewares || []), web.router);

  it("permits the normal 5000-character body to reach session authentication", async () => {
    const res = await request(app).post("/api/translate/cdict/translate").send({ text: "x".repeat(5000), to: "en" });
    expect(res.status).toBe(401);
  });
  it.each([
    ["post", "/translate", { text: "<script>alert(1)</script>", to: "en" }],
    ["get", "/tts?text=%3Cscript%3Ealert(1)%3C%2Fscript%3E", undefined],
  ] as const)("inspects %s %s payloads instead of exempting the namespace", async (method, path, body) => {
    const call = method === "post" ? request(app).post(web.path + path).send(body) : request(app).get(web.path + path);
    const res = await call;
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });
});
