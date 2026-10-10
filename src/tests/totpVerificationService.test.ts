import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

/**
 * TOTP 单次使用语义（用户回报「同一时期的验证码可以重复使用」后的收口）。
 *
 * 这里锁的是三条容易复发的性质：
 * 1. 验证通过但 counter 不可用 ⇒ **拒绝**（旧实现在这个分支静默跳过消费，等于放行）；
 * 2. 消费失败 ⇒ 明确区分 `reused`（同一枚码第二次），而不是笼统的「验证码错误」；
 * 3. 存储层没实现消费能力 ⇒ 抛错 ⇒ `unavailable`（fail-closed），绝不放行。
 */

const mockVerify = jest.fn();
const mockConsume = jest.fn();
const mockCreate = jest.fn(async (doc: Record<string, unknown>) => doc);
const mockWarn = jest.fn();
const mockError = jest.fn();

jest.mock("../services/totpService", () => ({
  TOTPService: {
    verifyTokenWithCounter: (...args: unknown[]) => mockVerify(...(args as [])),
  },
}));

jest.mock("../utils/userStorage", () => ({
  UserStorage: {
    consumeTotpCounter: (...args: unknown[]) => mockConsume(...(args as [string, number])),
  },
}));

jest.mock("../models/securityEventModel", () => ({
  SecurityEvent: { create: (doc: Record<string, unknown>) => mockCreate(doc) },
}));

jest.mock("../services/mongoService", () => ({
  mongoose: { connection: { readyState: 1 } },
}));

jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { warn: (...args: unknown[]) => mockWarn(...args), error: (...args: unknown[]) => mockError(...args), info: jest.fn(), debug: jest.fn() },
}));

import { verifyAndConsumeTotpCode } from "../services/totpVerificationService";

const params = { userId: "u1", token: "123456", secret: "JBSWY3DPEHPK3PXP" };

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("verifyAndConsumeTotpCode", () => {
  it("验证通过且 counter 是新值时消费成功", async () => {
    mockVerify.mockReturnValue({ valid: true, counter: 42 });
    mockConsume.mockResolvedValue(true);

    await expect(verifyAndConsumeTotpCode(params)).resolves.toEqual({ ok: true, counter: 42 });
    expect(mockConsume).toHaveBeenCalledWith("u1", 42);
  });

  it("验证码本身就是错的 → invalid，且不触碰 counter", async () => {
    mockVerify.mockReturnValue({ valid: false, counter: null });

    await expect(verifyAndConsumeTotpCode(params)).resolves.toEqual({ ok: false, reason: "invalid" });
    expect(mockConsume).not.toHaveBeenCalled();
  });

  it("验证通过但 counter 缺失 → fail-closed（旧实现会在这里静默放行）", async () => {
    mockVerify.mockReturnValue({ valid: true, counter: undefined });
    await expect(verifyAndConsumeTotpCode(params)).resolves.toEqual({ ok: false, reason: "unavailable" });
    expect(mockConsume).not.toHaveBeenCalled();
    expect(mockError).toHaveBeenCalled();
  });

  it("counter 为 NaN → fail-closed（NaN 落库会打成 500，不能当成有效 counter）", async () => {
    mockVerify.mockReturnValue({ valid: true, counter: Number.NaN });
    await expect(verifyAndConsumeTotpCode(params)).resolves.toEqual({ ok: false, reason: "unavailable" });
    expect(mockConsume).not.toHaveBeenCalled();
  });

  it("同一枚码第二次提交 → reused，并写 TOTP_CODE_REPLAY 留痕", async () => {
    mockVerify.mockReturnValue({ valid: true, counter: 42 });
    mockConsume.mockResolvedValue(false);

    await expect(verifyAndConsumeTotpCode(params)).resolves.toEqual({ ok: false, reason: "reused", counter: 42 });
    await Promise.resolve();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const doc = mockCreate.mock.calls[0][0];
    expect(doc.eventType).toBe("TOTP_CODE_REPLAY");
    expect(doc.userId).toBe("u1");
    expect((doc.eventData as Record<string, unknown>).counter).toBe(42);
  });

  it("存储层没有消费能力（抛错）→ unavailable，绝不放行", async () => {
    mockVerify.mockReturnValue({ valid: true, counter: 42 });
    mockConsume.mockRejectedValue(new Error("未实现 consumeTotpCounter"));

    await expect(verifyAndConsumeTotpCode(params)).resolves.toEqual({ ok: false, reason: "unavailable" });
    expect(mockError).toHaveBeenCalled();
  });
});
