import { describe, expect, it } from "@jest/globals";
import {
  ACCOUNT_SUSPENDED_CODE,
  ACCOUNT_SUSPENDED_MESSAGE,
  ACCOUNT_SUSPENSION_SUPPORT_EMAIL,
  AccountSuspendedError,
  buildAccountSuspendedBody,
  isAccountSuspendedFailure,
} from "../services/providerAuthErrors";

/**
 * 封停账户的拒绝契约：第三方登录/绑定流程必须能识别封停、并产出与
 * loginHandlers / sessionHandlers / authenticateToken 相同的 403 响应体
 * （前端 `classifyPenaltyAppeal` 靠 `code` 弹申诉入口）。
 *
 * 这里只测纯函数：不 import 控制器，避开“替身缺件”那一类套件级失败。
 */
describe("providerAuthErrors", () => {
  describe("isAccountSuspendedFailure", () => {
    it("recognises the dedicated error type", () => {
      expect(isAccountSuspendedFailure(new AccountSuspendedError())).toBe(true);
    });

    it("recognises legacy bare Error messages in the suspension family", () => {
      expect(isAccountSuspendedFailure(new Error(ACCOUNT_SUSPENDED_MESSAGE))).toBe(true);
      expect(isAccountSuspendedFailure(new Error("账户已被封停，不能绑定第三方账号"))).toBe(true);
      expect(isAccountSuspendedFailure(new Error("账户已暂停"))).toBe(true);
      expect(isAccountSuspendedFailure("账户已被暂停")).toBe(true);
    });

    it("does not treat unrelated auth failures as suspension", () => {
      expect(isAccountSuspendedFailure(new Error("用户名/邮箱或密码错误"))).toBe(false);
      expect(isAccountSuspendedFailure(new Error("第三方登录绑定会话已过期，请返回登录页重试"))).toBe(false);
      expect(isAccountSuspendedFailure(new Error("缺少 Google idToken"))).toBe(false);
      expect(isAccountSuspendedFailure(undefined)).toBe(false);
      expect(isAccountSuspendedFailure(null)).toBe(false);
      expect(isAccountSuspendedFailure({ message: ACCOUNT_SUSPENDED_MESSAGE })).toBe(false);
    });
  });

  describe("buildAccountSuspendedBody", () => {
    it("returns the repo-wide 403 body shape", () => {
      expect(buildAccountSuspendedBody()).toEqual({
        error: ACCOUNT_SUSPENDED_MESSAGE,
        code: ACCOUNT_SUSPENDED_CODE,
        supportEmail: ACCOUNT_SUSPENSION_SUPPORT_EMAIL,
      });
    });

    it("keeps a more specific message but never an empty one", () => {
      expect(buildAccountSuspendedBody("账户已被封停，不能绑定第三方账号").error).toBe(
        "账户已被封停，不能绑定第三方账号",
      );
      expect(buildAccountSuspendedBody("   ").error).toBe(ACCOUNT_SUSPENDED_MESSAGE);
    });
  });

  describe("AccountSuspendedError", () => {
    it("carries the suspension code and status for callers that map it themselves", () => {
      const error = new AccountSuspendedError();
      expect(error.name).toBe("AccountSuspendedError");
      expect(error.code).toBe(ACCOUNT_SUSPENDED_CODE);
      expect(error.statusCode).toBe(403);
      expect(error.message).toBe(ACCOUNT_SUSPENDED_MESSAGE);
    });
  });
});
