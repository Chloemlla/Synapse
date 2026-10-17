/**
 * doc-tool 的「按用户同意」闸门测试。
 *
 * 用假的服务层返回同意视图（不连 Mongo）：只验中间件契约——
 * 已同意放行、未同意/撤销同意回 403 + POLICY_CONSENT_REQUIRED、未登录回 401、
 * 读不到同意状态时 fail-closed（仍然是 403 而不是放行）。
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import { POLICY_CONSENT_REQUIRED_CODE, requireFeatureConsent } from "../middleware/featureConsent";
import { resolveFeatureConsentViews } from "../services/policyConsentService";

jest.mock("../services/policyConsentService", () => ({
  resolveFeatureConsentViews: jest.fn(),
}));

const mockedResolve = resolveFeatureConsentViews as jest.MockedFunction<typeof resolveFeatureConsentViews>;

const REQUIRED = ["usage", "specific-terms"];

function view(satisfied: boolean, missing: string[] = REQUIRED) {
  return {
    key: "doc-tool",
    label: "文档转换（Markdown → Word）",
    category: "content-upload",
    requiredAgreements: REQUIRED,
    acceptedAgreements: satisfied ? REQUIRED : [],
    missingAgreements: missing,
    satisfied,
    policyVersion: "2026-01-01",
  } as unknown as Awaited<ReturnType<typeof resolveFeatureConsentViews>>[number];
}

/** 用请求头模拟上游认证：没有 x-test-user 就是未登录（这层由 authenticateToken 负责，不在本用例范围）。 */
function buildApp() {
  const app = express();
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers["x-test-user"];
    const id = Array.isArray(header) ? header[0] : header;
    if (id) (req as Request & { user?: { id: string } }).user = { id: String(id) };
    next();
  });
  app.use(requireFeatureConsent("doc-tool"));
  app.get("/api/doc-tool/health", (_req, res) => res.json({ ok: true }));
  return app;
}

beforeEach(() => {
  mockedResolve.mockReset();
});

describe("requireFeatureConsent('doc-tool')", () => {
  it("已同意：放行到业务处理器", async () => {
    mockedResolve.mockResolvedValue([view(true)]);
    const res = await request(buildApp()).get("/api/doc-tool/health").set("x-test-user", "user-1");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("撤销同意后：403 + 稳定 code，并带回缺哪几份条款", async () => {
    mockedResolve.mockResolvedValue([view(false)]);
    const res = await request(buildApp()).get("/api/doc-tool/health").set("x-test-user", "user-1");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(POLICY_CONSENT_REQUIRED_CODE);
    expect(res.body.feature).toBe("doc-tool");
    expect(res.body.missingAgreements).toEqual(REQUIRED);
    // 前端靠 code 弹同意清单，不靠文案
    expect(res.body.code).toBe("POLICY_CONSENT_REQUIRED");
  });

  it("未登录：401（而不是 403——那会弹出一份未登录时无法完成的同意清单）", async () => {
    const res = await request(buildApp()).get("/api/doc-tool/health");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("UNAUTHENTICATED");
  });

  it("读不到同意状态时 fail-closed：仍是 403 + code，不是放行", async () => {
    mockedResolve.mockRejectedValueOnce(new Error("mongo down"));
    const res = await request(buildApp()).get("/api/doc-tool/health").set("x-test-user", "user-1");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(POLICY_CONSENT_REQUIRED_CODE);
  });

  it("判定只看 userId（同设备换账号不会蹭到上一位用户的同意）", async () => {
    mockedResolve.mockResolvedValue([view(false)]);
    await request(buildApp()).get("/api/doc-tool/health").set("x-test-user", "user-2");
    expect(mockedResolve).toHaveBeenCalledWith("user-2", expect.anything());
  });
});
