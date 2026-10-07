const mockPolicy = jest.fn();
const mockVerify = jest.fn();

jest.mock("../services/turnstileService", () => ({
  TurnstileService: {
    getCaptchaRequestPolicy: (...args: unknown[]) => mockPolicy(...args),
    verifyCaptchaChallenge: (...args: unknown[]) => mockVerify(...args),
  },
}));

import { verifyRequiredCaptcha, verifyRequiredTurnstile } from "../controllers/auth/_state";

describe("认证请求的人机验证闸门", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPolicy.mockResolvedValue({ required: true, enabledProviders: ["hcaptcha"] });
    mockVerify.mockResolvedValue(false);
  });

  it("声明已下线的供应商不能豁免失败验证", async () => {
    const error = await verifyRequiredCaptcha(
      { captchaToken: "invalid-token-value", captchaProvider: "trycap" },
      "203.0.113.5", "test",
    );
    expect(error).not.toBeNull();
  });

  it("兼容包装器透传 Turnstile 令牌", async () => {
    mockVerify.mockResolvedValue(true);
    expect(await verifyRequiredTurnstile("valid-token-value", "203.0.113.5", "test")).toBeNull();
    expect(mockVerify).toHaveBeenCalledWith({
      token: "valid-token-value", provider: "turnstile", remoteIp: "203.0.113.5",
    });
  });

  it("服务端关闭验证时保持兼容放行", async () => {
    mockPolicy.mockResolvedValue({ required: false, enabledProviders: [] });
    expect(await verifyRequiredCaptcha({}, "203.0.113.5", "test")).toBeNull();
    expect(mockVerify).not.toHaveBeenCalled();
  });
});
