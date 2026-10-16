/**
 * 账号文本解析用例（PIX-04 的服务端校验）。
 *
 * 重点不是「能不能解析」，而是：整批拒绝、行号可定位、错误里**不含账号内容**。
 */
import { describe, expect, it } from "@jest/globals";
import { normalizeIdempotencyKey, parsePixelAccountsText } from "../pixel/accountText";
import type { PixelRuntimeLimits } from "../pixel/runtime";
import { PixelDomainError } from "../pixel/types";

const LIMITS: PixelRuntimeLimits = {
  maxAccountsPerSubmission: 3,
  maxAccountLineChars: 64,
  maxAccountsTextBytes: 1_024,
  usageLogRetentionDays: 30,
  upstreamTimeoutMs: 5_000,
};

function codeOf(run: () => unknown): { code: string; status: number; message: string; details?: Record<string, unknown> } {
  try {
    run();
  } catch (error) {
    const domain = error as PixelDomainError;
    return { code: domain.code, status: domain.status, message: domain.message, details: domain.details };
  }
  throw new Error("期望抛错但没有抛");
}

describe("pixel 账号文本解析", () => {
  it("接受 邮箱----密码----辅助邮箱----2FA 的每行一个账号", () => {
    const parsed = parsePixelAccountsText(
      "a@example.com----pass1----recovery@example.com----ABCDEFGH\r\nb@example.com----pass2----r2----22222222",
      LIMITS,
    );
    expect(parsed.accountCount).toBe(2);
    expect(parsed.normalizedText).toBe(
      "a@example.com----pass1----recovery@example.com----ABCDEFGH\nb@example.com----pass2----r2----22222222",
    );
  });

  it("也接受只有两段（邮箱 + 密码）的行，忽略空行", () => {
    const parsed = parsePixelAccountsText("\n  a@example.com----pass  \n\n", LIMITS);
    expect(parsed.accountCount).toBe(1);
    expect(parsed.normalizedText).toBe("a@example.com----pass");
  });

  it("非字符串 / 全空 → 400 账号缺失", () => {
    expect(codeOf(() => parsePixelAccountsText(undefined, LIMITS)).code).toBe("PIXEL_ACCOUNTS_REQUIRED");
    expect(codeOf(() => parsePixelAccountsText("   \n  ", LIMITS)).code).toBe("PIXEL_ACCOUNTS_REQUIRED");
  });

  it("超过行数上限 → 400 且带计数（不泄漏内容）", () => {
    const text = "a@x.com----p1\nb@x.com----p2\nc@x.com----p3\nd@x.com----p4";
    const result = codeOf(() => parsePixelAccountsText(text, LIMITS));
    expect(result.code).toBe("PIXEL_ACCOUNTS_TOO_MANY");
    expect(result.status).toBe(400);
    expect(result.details).toEqual({ max: 3, count: 4 });
    expect(JSON.stringify(result.details)).not.toContain("x.com");
  });

  it("整段超字节上限 → 413", () => {
    const result = codeOf(() => parsePixelAccountsText("a".repeat(2_000), { ...LIMITS, maxAccountsTextBytes: 1_024 }));
    expect(result.code).toBe("PIXEL_ACCOUNTS_TOO_LARGE");
    expect(result.status).toBe(413);
  });

  it("字段数量、空字段、邮箱形状不对 → 400 并给出行号", () => {
    expect(codeOf(() => parsePixelAccountsText("a@x.com----p\nnofields", LIMITS))).toMatchObject({
      code: "PIXEL_ACCOUNT_LINE_INVALID",
      details: { lineNumber: 2 },
    });
    expect(codeOf(() => parsePixelAccountsText("a@x.com--------p", LIMITS))).toMatchObject({
      code: "PIXEL_ACCOUNT_LINE_INVALID",
      details: { lineNumber: 1 },
    });
    expect(codeOf(() => parsePixelAccountsText("not-an-email----p", LIMITS))).toMatchObject({
      code: "PIXEL_ACCOUNT_LINE_INVALID",
      details: { lineNumber: 1 },
    });
    expect(codeOf(() => parsePixelAccountsText("a@x.com----p", { ...LIMITS, maxAccountLineChars: 10 }))).toMatchObject({
      code: "PIXEL_ACCOUNT_LINE_INVALID",
      details: { lineNumber: 1, maxChars: 10 },
    });
  });

  it("行内控制字符被拒", () => {
    expect(codeOf(() => parsePixelAccountsText("a@x.com----p\u0001", LIMITS)).code).toBe("PIXEL_ACCOUNT_LINE_INVALID");
  });

  it("重复行 → 400，并指出第二次出现的行号", () => {
    const result = codeOf(() => parsePixelAccountsText("a@x.com----p\nb@x.com----p2\na@x.com----p", LIMITS));
    expect(result.code).toBe("PIXEL_ACCOUNT_DUPLICATE");
    expect(result.details).toEqual({ lineNumber: 3, firstLineNumber: 1 });
  });

  it("错误信息里从不出现账号内容（重复行与格式错误都只看行号）", () => {
    const secret = "victim@example.com----P@ssw0rd----recovery@example.com----TOTPKEY";
    const duplicate = codeOf(() => parsePixelAccountsText(`${secret}\n${secret}`, LIMITS));
    expect(duplicate.code).toBe("PIXEL_ACCOUNT_DUPLICATE");
    const serialized = JSON.stringify(duplicate);
    expect(serialized).not.toContain("victim@example.com");
    expect(serialized).not.toContain("P@ssw0rd");
    expect(serialized).not.toContain("TOTPKEY");

    const malformed = codeOf(() => parsePixelAccountsText("nofields", LIMITS));
    expect(malformed.message).not.toContain("nofields");
    expect(JSON.stringify(malformed.details ?? {})).not.toContain("nofields");
  });
});

describe("pixel 提交幂等键", () => {
  it("接受可见 ASCII 的 8-128 位", () => {
    expect(normalizeIdempotencyKey("abcd1234")).toBe("abcd1234");
    expect(normalizeIdempotencyKey("  712bf0a1-4d0e  ")).toBe("712bf0a1-4d0e");
  });

  it("缺失/过短/带非法字符一律拒绝（没有幂等键就不允许提交）", () => {
    for (const value of [undefined, "", "short", "has space", "x".repeat(129), "换行\n注入"]) {
      const result = codeOf(() => normalizeIdempotencyKey(value));
      expect(result.code).toBe("PIXEL_IDEMPOTENCY_KEY_REQUIRED");
      expect(result.status).toBe(400);
    }
  });
});
