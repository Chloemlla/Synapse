// 仅管理员可用的公开口令端点：requireAdminOrAnonymous 的三态判定。
//
// 为什么需要这条闸门：optionalAdminAuth 在识别出非管理员时会**清掉身份**（匿名口令流程的前提），
// 于是到了 handler 里「已登录的普通用户」与「真匿名」无法区分 —— 普通用户只要知道共享口令就能用。
// 这里把「拿到存活会话但不是管理员 → 403」这条边界钉住。
jest.mock("../middleware/optionalAuthenticateToken", () => ({
  optionalAuthenticateToken: jest.fn(async () => undefined),
}));

jest.mock("../services/authSessionService", () => ({
  assertActiveAuthSession: jest.fn(async () => undefined),
}));

import type { NextFunction, Request, Response } from "express";
import { requireAdminOrAnonymous } from "../middleware/optionalAdminAuth";

/** 最小 req/res 对：只关心「是否被拒、以什么状态码与 code 被拒」。 */
function makeRes() {
  const state: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      state.status = code;
      return this;
    },
    json(body: unknown) {
      state.body = body;
      return this;
    },
  } as unknown as Response;
  return { res, state };
}

const run = async (
  req: Partial<Request>,
): Promise<{ nextCalled: boolean; status?: number; body?: unknown }> => {
  const { res, state } = makeRes();
  let nextCalled = false;
  await requireAdminOrAnonymous(
    req as Request,
    res,
    (() => {
      nextCalled = true;
    }) as NextFunction,
  );
  return { nextCalled, status: state.status, body: state.body };
};

describe("requireAdminOrAnonymous", () => {
  it("匿名放行：共享口令闸门自己会拦", async () => {
    const result = await run({} as Request);
    expect(result.nextCalled).toBe(true);
    expect(result.status).toBeUndefined();
  });

  it("管理员放行", async () => {
    const result = await run({ user: { id: "admin-1", role: "admin" } } as unknown as Request);
    expect(result.nextCalled).toBe(true);
    expect(result.status).toBeUndefined();
  });

  it("超管放行", async () => {
    const result = await run({ user: { id: "root", role: "superadmin" } } as unknown as Request);
    expect(result.nextCalled).toBe(true);
  });

  it("已登录的普通用户被拒：403 + 稳定 code（这就是「普通用户不显示」的后端那一半）", async () => {
    const result = await run({ user: { id: "user-1", role: "user" } } as unknown as Request);
    expect(result.nextCalled).toBe(false);
    expect(result.status).toBe(403);
    expect((result.body as { code?: string }).code).toBe("ADMIN_ONLY_FEATURE");
  });
});
