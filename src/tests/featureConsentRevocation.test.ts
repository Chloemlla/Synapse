import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { NextFunction, Request, Response } from "express";

/**
 * 功能同意闸门的**撤销即时生效**（RC-31 回归）。
 *
 * 审计要求的不只是“挂了闸门”，而是「同意后撤销 → **下一请求**即 403」。
 * 服务层刻意不加缓存（`resolveFeatureConsentViews` 每次读库），本用例把这条性质钉住：
 * 同一份中间件实例连续两次调用，第二次读到“已缺失”就必须拒绝，不能被任何进程内缓存挡住。
 */

const mockResolveViews = jest.fn();

jest.mock("../services/policyConsentService", () => ({
  resolveFeatureConsentViews: (...args: unknown[]) => mockResolveViews(...(args as [string, string])),
}));
jest.mock("../config/policyMeta", () => ({ CURRENT_POLICY_VERSION: "2026-10-10" }));
jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { requireFeatureConsent, POLICY_CONSENT_REQUIRED_CODE } from "../middleware/featureConsent";

function makeReq(): Request {
  return { user: { id: "u1" }, headers: {}, path: "/api/doc-tool/convert" } as unknown as Request;
}

function makeRes() {
  const status = jest.fn();
  const json = jest.fn();
  const res = { status: status.mockReturnThis(), json } as unknown as Response;
  return { res, status, json };
}

function view(satisfied: boolean) {
  return [
    {
      key: "doc-tool",
      satisfied,
      requiredAgreements: ["usage", "specific-terms"],
      missingAgreements: satisfied ? [] : ["specific-terms"],
    },
  ];
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("requireFeatureConsent", () => {
  it("未登录是 401（不是 403 —— 403 会让前端弹一份登录后也无从完成的同意清单）", async () => {
    const { res, status, json } = makeRes();
    const next = jest.fn() as unknown as NextFunction;

    await requireFeatureConsent("doc-tool")({ headers: {} } as Request, res, next);

    expect(status).toHaveBeenCalledWith(401);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: "UNAUTHENTICATED" }));
    expect(next).not.toHaveBeenCalled();
  });

  it("已同意则放行", async () => {
    mockResolveViews.mockResolvedValue(view(true));
    const { res } = makeRes();
    const next = jest.fn() as unknown as NextFunction;

    await requireFeatureConsent("doc-tool")(makeReq(), res, next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it("同意后撤销：**下一次**请求即 403 POLICY_CONSENT_REQUIRED（服务层不缓存）", async () => {
    const middleware = requireFeatureConsent("doc-tool");

    // 第一次：已同意 → 放行
    mockResolveViews.mockResolvedValueOnce(view(true));
    const firstNext = jest.fn() as unknown as NextFunction;
    await middleware(makeReq(), makeRes().res, firstNext);
    expect(firstNext).toHaveBeenCalledTimes(1);

    // 第二次：同一次会话里撤回了同意 → 立刻拒绝，且带上缺失清单供前端弹窗
    mockResolveViews.mockResolvedValueOnce(view(false));
    const { res, status, json } = makeRes();
    const secondNext = jest.fn() as unknown as NextFunction;
    await middleware(makeReq(), res, secondNext);

    expect(secondNext).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ code: POLICY_CONSENT_REQUIRED_CODE, feature: "doc-tool", missingAgreements: ["specific-terms"] }),
    );
  });
});
