/**
 * 「按用户自己的同意开放功能」回归测试。
 *
 * 不连 Mongo：模型层与同意记录服务整体替身。
 *  - `requireFeatureConsent`（中间件）用 `../services/policyConsentService` 的替身，只保留
 *    `resolveFeatureConsentViews` 一个可编程成员；其余成员展开真实导出，
 *    替身缺件会让调用点抛 TypeError 并伪装成「业务坏了」。
 *  - 服务层两个核心函数（`hasValidUserConsent` / `resolveFeatureConsentViews`）跑**真实实现**，
 *    只把模型层换成替身 —— 这样「只认 userId、不回落到指纹」是可以断言的事实，
 *    而不是靠替身自说自话。
 *
 * 核心判据（方案 §6.3）：用户 A 的同意不会让用户 B 通过 —— 同一个「设备」也不行。
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { NextFunction, Request, Response } from "express";
import {
  FEATURE_CONSENT_CATEGORIES,
  FEATURE_CONSENT_CATEGORY_AGREEMENTS,
  FEATURE_CONSENT_KEYS,
  FEATURE_CONSENT_REQUIREMENTS,
  type FeatureConsentKey,
  type FeatureConsentView,
  isFeatureConsentKey,
  requiredAgreementsFor,
} from "../config/featureConsent";
import { CURRENT_POLICY_VERSION, POLICY_AGREEMENT_KEYS, type PolicyAgreementKey } from "../config/policyMeta";
import { POLICY_CONSENT_REQUIRED_CODE, requireFeatureConsent } from "../middleware/featureConsent";
import { PolicyConsent } from "../models/policyConsentModel";
import { resolveFeatureConsentViews } from "../services/policyConsentService";

jest.mock("../services/policyConsentService", () => ({
  // 展开真实导出再只替换需要 stub 的成员（与 adminScope.test.ts 同一取舍）。
  ...jest.requireActual("../services/policyConsentService"),
  resolveFeatureConsentViews: jest.fn(),
}));

jest.mock("../models/policyConsentModel", () => ({
  PolicyConsent: {
    findValidConsent: jest.fn(),
    findValidConsentForUser: jest.fn(),
  },
}));

// 真实实现：只被模型层替身挡在库外，判定逻辑本身是真跑。
const realService = jest.requireActual<typeof import("../services/policyConsentService")>(
  "../services/policyConsentService",
);

const mockResolveViews = resolveFeatureConsentViews as jest.MockedFunction<typeof resolveFeatureConsentViews>;
const modelMock = PolicyConsent as unknown as Record<
  "findValidConsent" | "findValidConsentForUser",
  jest.Mock
>;

type TestResponse = Response & { statusCode: number; payload: any; bodyWritten: boolean };

function makeReq(options: { userId?: string | null } = {}): Request {
  const user = options.userId === null ? undefined : { id: options.userId ?? "user-a" };
  return { body: {}, headers: {}, method: "GET", path: "/", baseUrl: "", user } as unknown as Request;
}

function makeRes(): TestResponse {
  const res: any = {
    statusCode: 0,
    payload: undefined,
    bodyWritten: false,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: any) {
      res.payload = body;
      res.bodyWritten = true;
      return res;
    },
  };
  return res as TestResponse;
}

async function runGate(feature: FeatureConsentKey, req: Request, res: TestResponse) {
  const next = jest.fn();
  const handler = requireFeatureConsent(feature) as unknown as (
    req: Request,
    res: Response,
    next: NextFunction,
  ) => Promise<void>;
  await handler(req, res, next as unknown as NextFunction);
  return next;
}

/** 用真实配置表算出「该用户已勾选这些文件」时的每功能状态，替身据此回答。 */
function viewsForUser(granted: PolicyAgreementKey[] | null, expiresAt: string | null = null): FeatureConsentView[] {
  const grantedSet = new Set<string>(granted ?? []);
  return FEATURE_CONSENT_KEYS.map((key) => {
    const requirement = FEATURE_CONSENT_REQUIREMENTS[key];
    const requiredAgreements = requiredAgreementsFor(key);
    const missingAgreements = requiredAgreements.filter((item) => !grantedSet.has(item));
    return {
      key,
      label: requirement.label,
      category: requirement.category,
      rationale: requirement.rationale,
      message: requirement.message,
      satisfied: missingAgreements.length === 0,
      requiredAgreements,
      missingAgreements,
      policyVersion: CURRENT_POLICY_VERSION,
      expiresAt,
    };
  });
}

/** 库里那条记录的样子（模型替身按 userId 命中返回它）。 */
const fullConsentRecord = {
  agreements: [...POLICY_AGREEMENT_KEYS],
  expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
};

describe("requireFeatureConsent（功能同意闸门）", () => {
  // userId → 已勾选文件；null 表示该用户没有有效同意记录（从未同意 / 已过期 / 已撤销）
  const grants = new Map<string, PolicyAgreementKey[] | null>();

  beforeEach(() => {
    jest.clearAllMocks();
    grants.clear();
    mockResolveViews.mockImplementation(async (userId: string) =>
      viewsForUser(grants.get(userId) ?? null),
    );
  });

  it("未登录直接 401，不进入业务路由", async () => {
    const res = makeRes();
    const next = await runGate("doc-tool", makeReq({ userId: null }), res);

    expect(res.statusCode).toBe(401);
    expect(res.payload).toEqual({ error: "未登录", code: "UNAUTHENTICATED" });
    expect(next).not.toHaveBeenCalled();
    // 未登录不该去查同意状态：查了也只能得到「没有」
    expect(mockResolveViews).not.toHaveBeenCalled();
  });

  it("已登录但未同意：403 + 稳定 code + 缺失的条款清单", async () => {
    const res = makeRes();
    const next = await runGate("doc-tool", makeReq({ userId: "user-a" }), res);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.payload.code).toBe(POLICY_CONSENT_REQUIRED_CODE);
    expect(res.payload.feature).toBe("doc-tool");
    expect(res.payload.label).toBe(FEATURE_CONSENT_REQUIREMENTS["doc-tool"].label);
    expect(res.payload.category).toBe(FEATURE_CONSENT_REQUIREMENTS["doc-tool"].category);
    expect(res.payload.rationale).toBe(FEATURE_CONSENT_REQUIREMENTS["doc-tool"].rationale);
    expect(res.payload.requiredAgreements).toEqual(["usage", "specific-terms"]);
    expect(res.payload.missingAgreements).toEqual(["usage", "specific-terms"]);
    expect(res.payload.policyVersion).toBe(CURRENT_POLICY_VERSION);
    expect(res.payload.message).toBe(FEATURE_CONSENT_REQUIREMENTS["doc-tool"].message);
  });

  it("只勾了一部分时只报缺失的那几项", async () => {
    grants.set("user-a", ["usage"]);
    const res = makeRes();
    await runGate("doc-tool", makeReq({ userId: "user-a" }), res);

    expect(res.statusCode).toBe(403);
    expect(res.payload.missingAgreements).toEqual(["specific-terms"]);
  });

  it("已同意：放行且不写响应", async () => {
    grants.set("user-a", ["usage", "specific-terms"]);
    const res = makeRes();
    const next = await runGate("doc-tool", makeReq({ userId: "user-a" }), res);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(0);
    expect(res.bodyWritten).toBe(false);
  });

  it("判定按人而不是按设备：同一次请求上下文里，已同意的用户放行、未同意的用户被拦", async () => {
    grants.set("user-a", ["usage", "specific-terms"]);

    const allowedRes = makeRes();
    const allowedNext = await runGate("doc-tool", makeReq({ userId: "user-a" }), allowedRes);
    expect(allowedNext).toHaveBeenCalledTimes(1);
    expect(allowedRes.bodyWritten).toBe(false);

    // 同一个功能、同一台「设备」（请求形态完全一样），换成 user-b：必须被拦
    const blockedRes = makeRes();
    const blockedNext = await runGate("doc-tool", makeReq({ userId: "user-b" }), blockedRes);
    expect(blockedNext).not.toHaveBeenCalled();
    expect(blockedRes.statusCode).toBe(403);
    expect(blockedRes.payload.code).toBe(POLICY_CONSENT_REQUIRED_CODE);

    // 判定携带的身份必须是调用方自己的 id
    expect(mockResolveViews).toHaveBeenNthCalledWith(1, "user-a", CURRENT_POLICY_VERSION);
    expect(mockResolveViews).toHaveBeenNthCalledWith(2, "user-b", CURRENT_POLICY_VERSION);
  });

  it("读不到同意状态时 fail-closed：仍按未同意拒绝，并保持同一个 code", async () => {
    mockResolveViews.mockRejectedValue(new Error("mongo down"));
    const res = makeRes();
    const next = await runGate("doc-tool", makeReq({ userId: "user-a" }), res);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.payload.code).toBe(POLICY_CONSENT_REQUIRED_CODE);
    expect(res.payload.missingAgreements).toEqual(["usage", "specific-terms"]);
  });

  it("不同分类的功能各自按自己的清单判定：勾了 usage+specific-terms 不等于 terms 类功能也满足", async () => {
    grants.set("user-a", ["usage", "specific-terms"]);

    const docRes = makeRes();
    const docNext = await runGate("doc-tool", makeReq({ userId: "user-a" }), docRes);
    expect(docNext).toHaveBeenCalledTimes(1);
    expect(docRes.bodyWritten).toBe(false);

    // api-access 属于 account-credential，要的是 terms + specific-terms
    const apiRes = makeRes();
    const apiNext = await runGate("api-access", makeReq({ userId: "user-a" }), apiRes);
    expect(apiNext).not.toHaveBeenCalled();
    expect(apiRes.statusCode).toBe(403);
    expect(apiRes.payload.feature).toBe("api-access");
    expect(apiRes.payload.requiredAgreements).toEqual(["terms", "specific-terms"]);
    expect(apiRes.payload.missingAgreements).toEqual(["terms"]);
  });
});

describe("用户级同意判定（服务层真实实现 + 模型替身）", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    modelMock.findValidConsent.mockResolvedValue(null);
    modelMock.findValidConsentForUser.mockResolvedValue(null);
  });

  it("只查 userId 命中的记录：不回落到设备指纹", async () => {
    modelMock.findValidConsentForUser.mockResolvedValue(fullConsentRecord);

    await expect(realService.hasValidUserConsent("user-a")).resolves.toBe(true);
    expect(modelMock.findValidConsentForUser).toHaveBeenCalledWith("user-a", CURRENT_POLICY_VERSION);
    // 指纹级查询一旦被调用，就等于把「同设备换账号」重新引回来
    expect(modelMock.findValidConsent).not.toHaveBeenCalled();
  });

  it("该用户没有有效记录时视为未同意（历史只绑指纹的记录不兜底）", async () => {
    // 设备指纹下有一条满勾的有效记录，但用户自己没有任何记录
    modelMock.findValidConsent.mockResolvedValue(fullConsentRecord);
    modelMock.findValidConsentForUser.mockResolvedValue(null);

    await expect(realService.hasValidUserConsent("user-b")).resolves.toBe(false);
  });

  it("记录没勾满全部文件就不算同意（版本号对得上也不行）", async () => {
    modelMock.findValidConsentForUser.mockResolvedValue({ ...fullConsentRecord, agreements: ["usage"] });

    await expect(realService.hasValidUserConsent("user-a")).resolves.toBe(false);
  });

  it("空 / 全空格 userId 一律视为未同意，且不查库", async () => {
    await expect(realService.hasValidUserConsent("   ")).resolves.toBe(false);
    expect(modelMock.findValidConsentForUser).not.toHaveBeenCalled();
  });

  it("resolveFeatureConsentViews：无记录时每个功能都列出全部缺失项", async () => {
    const views = await realService.resolveFeatureConsentViews("user-b");

    expect(views.map((view) => view.key)).toEqual([...FEATURE_CONSENT_KEYS]);
    for (const view of views) {
      expect(view.satisfied).toBe(false);
      expect(view.missingAgreements).toEqual(requiredAgreementsFor(view.key));
      expect(view.expiresAt).toBeNull();
      expect(view.policyVersion).toBe(CURRENT_POLICY_VERSION);
    }
  });

  it("resolveFeatureConsentViews：已有满勾记录时全部满足，并回带到期时间；用户 B 仍不满足", async () => {
    modelMock.findValidConsentForUser.mockImplementation(async (userId: string) =>
      userId === "user-a" ? fullConsentRecord : null,
    );

    const viewsForA = await realService.resolveFeatureConsentViews("user-a");
    for (const view of viewsForA) {
      expect(view.satisfied).toBe(true);
      expect(view.missingAgreements).toEqual([]);
      expect(view.expiresAt).toBe(fullConsentRecord.expiresAt.toISOString());
    }

    const viewsForB = await realService.resolveFeatureConsentViews("user-b");
    expect(viewsForB.every((view) => view.satisfied === false)).toBe(true);
  });

  it("resolveFeatureConsentViews：只勾了部分文件时该功能仍未满足", async () => {
    modelMock.findValidConsentForUser.mockResolvedValue({ ...fullConsentRecord, agreements: ["usage"] });

    const views = await realService.resolveFeatureConsentViews("user-a");
    for (const view of views) {
      expect(view.satisfied).toBe(false);
      expect(view.missingAgreements).toEqual(requiredAgreementsFor(view.key));
      // 未勾满不算有效同意，因此不报到期时间（避免界面显示「已同意，还有 20 天到期」）
      expect(view.expiresAt).toBeNull();
    }
  });
});

describe("功能 ↔ 政策文件映射自检", () => {
  it("每个功能的 agreements 非空、都取自四份必读文件", () => {
    for (const key of FEATURE_CONSENT_KEYS) {
      const agreements = FEATURE_CONSENT_REQUIREMENTS[key].agreements;
      expect(agreements.length).toBeGreaterThan(0);
      for (const agreement of agreements) {
        expect(POLICY_AGREEMENT_KEYS).toContain(agreement);
      }
    }
  });

  it("没有任何功能要求 supported-regions（那是平台级可用地区声明，不是单功能义务）", () => {
    for (const key of FEATURE_CONSENT_KEYS) {
      expect(FEATURE_CONSENT_REQUIREMENTS[key].agreements).not.toContain("supported-regions");
    }
  });

  it("同一分类要求同一组文件（规则表与逐条配置不许静默分叉）", () => {
    for (const key of FEATURE_CONSENT_KEYS) {
      const requirement = FEATURE_CONSENT_REQUIREMENTS[key];
      expect(requirement.category).toBeDefined();
      expect(requirement.agreements).toEqual(FEATURE_CONSENT_CATEGORY_AGREEMENTS[requirement.category]);
    }
  });

  it("每个分类都至少被一个功能用到", () => {
    const usedCategories = new Set(FEATURE_CONSENT_KEYS.map((key) => FEATURE_CONSENT_REQUIREMENTS[key].category));

    for (const category of FEATURE_CONSENT_CATEGORIES) {
      expect(usedCategories.has(category)).toBe(true);
    }
  });

  it("键集与需求表完全一致，且每条都自带面向用户的 label / rationale / message", () => {
    expect(Object.keys(FEATURE_CONSENT_REQUIREMENTS).sort()).toEqual([...FEATURE_CONSENT_KEYS].sort());

    for (const key of FEATURE_CONSENT_KEYS) {
      const requirement = FEATURE_CONSENT_REQUIREMENTS[key];
      expect(requirement.key).toBe(key);
      expect(requirement.label.trim().length).toBeGreaterThan(0);
      expect(requirement.rationale.trim().length).toBeGreaterThan(0);
      expect(requirement.message.trim().length).toBeGreaterThan(0);
    }
  });

  it("isFeatureConsentKey 只认表内的键", () => {
    for (const key of FEATURE_CONSENT_KEYS) {
      expect(isFeatureConsentKey(key)).toBe(true);
    }

    for (const invalid of ["", "doc", "doc-tool ", "DOC-TOOL", "supported-regions", 1, null, undefined, {}]) {
      expect(isFeatureConsentKey(invalid)).toBe(false);
    }
  });

  it("requiredAgreementsFor 返回副本：调用方改返回值不会污染映射表", () => {
    const first = requiredAgreementsFor("doc-tool");
    first.push("terms");

    expect(requiredAgreementsFor("doc-tool")).toEqual(["usage", "specific-terms"]);
    expect(FEATURE_CONSENT_REQUIREMENTS["doc-tool"].agreements).toEqual(["usage", "specific-terms"]);
  });
});
