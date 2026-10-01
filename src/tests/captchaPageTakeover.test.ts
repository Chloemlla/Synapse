/**
 * 后台页面（登录/注册/忘记密码/TTS/图床/抽奖/CDK…）共用同一套人机验证下发链路的请求侧契约：
 * 字段读取、供应商归一、请求闸门、统一校验入口的分派。
 */

const mockGetTurnstileKey = jest.fn();
const mockGetHCaptchaKey = jest.fn();
const mockGetCapKey = jest.fn();
const mockGetProviderSettings = jest.fn();
const mockGetAllocationPolicy = jest.fn();
const mockGetWidgetSettings = jest.fn();
const mockPersistTurnstileTrace = jest.fn();
const mockAxiosPost = jest.fn();

jest.mock("axios", () => ({
  __esModule: true,
  default: { post: (...args: unknown[]) => mockAxiosPost(...args) },
}));

jest.mock("../services/turnstile/models", () => ({
  getTurnstileKey: (...args: unknown[]) => mockGetTurnstileKey(...args),
  getHCaptchaKey: (...args: unknown[]) => mockGetHCaptchaKey(...args),
  getCapKey: (...args: unknown[]) => mockGetCapKey(...args),
  getCaptchaProviderSettingDocs: (...args: unknown[]) => mockGetProviderSettings(...args),
  getCaptchaAllocationPolicyDoc: (...args: unknown[]) => mockGetAllocationPolicy(...args),
  getCaptchaWidgetSettingsDoc: (...args: unknown[]) => mockGetWidgetSettings(...args),
  upsertCaptchaAllocationPolicy: jest.fn(),
  upsertCaptchaWidgetSettings: jest.fn(),
}));

jest.mock("../services/turnstile/quota", () => {
  const build = (provider: string) => ({
    provider,
    monthKey: "2026-10",
    limit: 0,
    used: 0,
    remaining: -1,
    percentage: 0,
    exhausted: false,
    resetsAt: "2026-10-31T16:00:00.000Z",
  });
  return {
    getCaptchaQuotaSnapshots: async () => ({
      turnstile: build("turnstile"),
      hcaptcha: build("hcaptcha"),
      trycap: build("trycap"),
    }),
  };
});

jest.mock("../services/turnstile/trace", () => ({
  generateUniqueTraceId: () => "trace-page-takeover",
  persistTurnstileTrace: (...args: unknown[]) => mockPersistTurnstileTrace(...args),
}));

jest.mock("../services/turnstile/risk", () => ({
  assessClientRisk: () => ({ riskLevel: "LOW", riskScore: 0, riskReasons: [] }),
  recordVerificationOutcome: jest.fn(),
  translateTurnstileErrors: jest.fn(),
}));

import { readCaptchaChallenge, readCaptchaToken } from "../services/turnstile/challenge";
import { getCaptchaRequestPolicy } from "../services/turnstile/providers";
import { normalizeCaptchaProviderId } from "../services/turnstile/types";
import { verifyCaptchaChallenge } from "../services/turnstile/verify";

type KeyMap = Record<string, string | null>;

function setProviderConfig(options: {
  keys?: KeyMap;
  settings?: Array<{ provider: string; enabled?: boolean; weight?: number }>;
}) {
  const keys = options.keys ?? {};
  mockGetTurnstileKey.mockImplementation(async (key: string) => keys[key] ?? null);
  mockGetHCaptchaKey.mockImplementation(async (key: string) => keys[key] ?? null);
  mockGetCapKey.mockImplementation(async (key: string) => keys[key] ?? null);
  mockGetProviderSettings.mockResolvedValue(options.settings ?? []);
  mockGetAllocationPolicy.mockResolvedValue(null);
  mockGetWidgetSettings.mockResolvedValue(null);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPersistTurnstileTrace.mockResolvedValue(undefined);
  mockAxiosPost.mockResolvedValue({ data: { success: false } });
  setProviderConfig({});
});

describe("挑战载荷读取", () => {
  it("按候选顺序回退令牌字段，并兼容独立验证页的裸 token", () => {
    expect(readCaptchaToken({ captchaToken: "a" })).toBe("a");
    expect(readCaptchaToken({ cfToken: "b" })).toBe("b");
    expect(readCaptchaToken({ turnstileToken: "c" })).toBe("c");
    expect(readCaptchaToken({ hcaptchaToken: "d" })).toBe("d");
    expect(readCaptchaToken({ capToken: "e" })).toBe("e");
    // 裸 token 只在显式开启兼容（独立验证页 / Cloudflare 挑战页）时读取
    expect(readCaptchaToken({ token: "f" })).toBe("");
    expect(readCaptchaToken({ token: "f" }, { genericToken: true })).toBe("f");
    expect(readCaptchaToken({ cfToken: "old", token: "legacy" }, { genericToken: true })).toBe("old");
    // captchaToken 优先于历史字段
    expect(readCaptchaToken({ captchaToken: "new", cfToken: "old" })).toBe("new");
  });

  it("缺令牌 / 非字符串令牌一律回落空串，不抛异常", () => {
    expect(readCaptchaToken(undefined)).toBe("");
    expect(readCaptchaToken(null)).toBe("");
    expect(readCaptchaToken("plain-string")).toBe("");
    expect(readCaptchaToken({ cfToken: 42 })).toBe("");
    expect(readCaptchaToken({ cfToken: "" })).toBe("");
  });

  it("供应商字段只用 captchaProvider / captchaType —— 裸 provider 是 TTS 提供商，不能误读", () => {
    expect(readCaptchaChallenge({ captchaProvider: "hcaptcha" }).provider).toBe("hcaptcha");
    expect(readCaptchaChallenge({ captchaType: "trycap" }).provider).toBe("trycap");
    expect(readCaptchaChallenge({ token: "x", provider: "fish" }).provider).toBe("turnstile");
    expect(readCaptchaChallenge({ token: "x", provider: "fish" }).providerDeclared).toBe(false);
  });

  it("供应商归一：非法值、大小写、非字符串都回落 turnstile（老客户端语义）", () => {
    expect(normalizeCaptchaProviderId("hcaptcha")).toBe("hcaptcha");
    expect(normalizeCaptchaProviderId("trycap")).toBe("trycap");
    expect(normalizeCaptchaProviderId("turnstile")).toBe("turnstile");
    expect(normalizeCaptchaProviderId("HCAPTCHA")).toBe("turnstile");
    expect(normalizeCaptchaProviderId("recaptcha")).toBe("turnstile");
    expect(normalizeCaptchaProviderId(undefined)).toBe("turnstile");
    expect(normalizeCaptchaProviderId(7)).toBe("turnstile");
  });
});

describe("请求闸门：哪几家可用、要不要验", () => {
  it("三家都配齐凭据且未下线 ⇒ required，并列出三家", async () => {
    setProviderConfig({
      keys: {
        TURNSTILE_SITE_KEY: "0x1",
        TURNSTILE_SECRET_KEY: "ts-secret",
        HCAPTCHA_SITE_KEY: "hc-site",
        HCAPTCHA_SECRET_KEY: "hc-secret",
        CAP_SITE_KEY: "0123456789",
        CAP_SECRET_KEY: "cap-secret",
      },
    });

    const policy = await getCaptchaRequestPolicy();
    expect(policy.required).toBe(true);
    expect(policy.enabledProviders).toEqual(["turnstile", "hcaptcha", "trycap"]);
  });

  it("只有 hCaptcha 在线时也能 required，且名单里没有 turnstile", async () => {
    setProviderConfig({
      keys: { TURNSTILE_SITE_KEY: "0x1", TURNSTILE_SECRET_KEY: "ts-secret", HCAPTCHA_SITE_KEY: "hc-site", HCAPTCHA_SECRET_KEY: "hc-secret" },
      settings: [{ provider: "turnstile", enabled: false }, { provider: "hcaptcha", enabled: true }],
    });

    const policy = await getCaptchaRequestPolicy();
    expect(policy.required).toBe(true);
    expect(policy.enabledProviders).toEqual(["hcaptcha"]);
  });

  it("三家都没有凭据 ⇒ 不要求人机验证（与历史「开关关闭即放行」等价）", async () => {
    setProviderConfig({});
    const policy = await getCaptchaRequestPolicy();
    expect(policy.required).toBe(false);
    expect(policy.enabledProviders).toEqual([]);
  });
});

describe("统一校验入口：按供应商分派", () => {
  it("未声明供应商（老客户端）走 Turnstile 分支", async () => {
    // 没配 TURNSTILE_SECRET_KEY ⇒ Turnstile 分支 fail-closed，且不外呼 axios
    await expect(verifyCaptchaChallenge({ token: "tok", remoteIp: "203.0.113.5" })).resolves.toBe(false);
    expect(mockAxiosPost).not.toHaveBeenCalled();
    expect(mockPersistTurnstileTrace).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "service_unavailable", errorCode: "SERVICE_UNAVAILABLE" }),
    );
  });

  it("非法供应商名回落 Turnstile，不会走到 hCaptcha / trycap 的外呼", async () => {
    await expect(
      verifyCaptchaChallenge({ token: "tok", provider: "recaptcha", remoteIp: "203.0.113.5" }),
    ).resolves.toBe(false);
    expect(mockAxiosPost).not.toHaveBeenCalled();
  });

  it("hCaptcha 供应商走 hCaptcha 校验（缺密钥时 fail-closed 且打上 hcaptcha 溯源标记）", async () => {
    await expect(
      verifyCaptchaChallenge({ token: "tok", provider: "hcaptcha", remoteIp: "203.0.113.5" }),
    ).resolves.toBe(false);
    expect(mockAxiosPost).not.toHaveBeenCalled();
    expect(mockPersistTurnstileTrace).toHaveBeenCalledWith(
      expect.objectContaining({ verificationMethod: "hcaptcha", reason: "service_unavailable" }),
    );
  });

  it("trycap 供应商走 Cap 校验（缺密钥时 fail-closed 且打上 trycap 溯源标记）", async () => {
    await expect(
      verifyCaptchaChallenge({ token: "tok", provider: "trycap", remoteIp: "203.0.113.5" }),
    ).resolves.toBe(false);
    expect(mockAxiosPost).not.toHaveBeenCalled();
    expect(mockPersistTurnstileTrace).toHaveBeenCalledWith(
      expect.objectContaining({ verificationMethod: "trycap", reason: "service_unavailable" }),
    );
  });
});
