const mockGetTurnstileKey = jest.fn();
const mockGetHCaptchaKey = jest.fn();
const mockGetCapKey = jest.fn();
const mockGetProviderSettings = jest.fn();

jest.mock("../services/turnstile/models", () => ({
  getTurnstileKey: (...args: unknown[]) => mockGetTurnstileKey(...args),
  getHCaptchaKey: (...args: unknown[]) => mockGetHCaptchaKey(...args),
  getCapKey: (...args: unknown[]) => mockGetCapKey(...args),
  getCaptchaProviderSettingDocs: (...args: unknown[]) => mockGetProviderSettings(...args),
}));

// 额度模块会碰 Mongo；选择引擎的测试通过 mockQuotaExhausted 开关模拟「未用尽 / 已用尽」。
let mockQuotaExhausted = false;
jest.mock("../services/turnstile/quota", () => {
  const build = (provider: string, limit: number) => ({
    provider,
    monthKey: "2026-10",
    limit,
    used: mockQuotaExhausted && provider === "hcaptcha" ? limit : 0,
    remaining: limit > 0 ? (mockQuotaExhausted && provider === "hcaptcha" ? 0 : limit) : -1,
    percentage: mockQuotaExhausted && provider === "hcaptcha" && limit > 0 ? 100 : 0,
    exhausted: mockQuotaExhausted && provider === "hcaptcha" && limit > 0,
    resetsAt: "2026-10-31T16:00:00.000Z",
  });
  return {
    getCaptchaQuotaSnapshots: async () => ({
      turnstile: build("turnstile", 0),
      hcaptcha: build("hcaptcha", 10_000),
      trycap: build("trycap", 0),
    }),
  };
});

import {
  CAPTCHA_PROVIDER_IDS,
  clampProviderWeight,
  collectCaptchaProviders,
  isCaptchaProviderId,
  normalizeWeightPercentages,
  pickWeightedProvider,
  selectCaptchaProvider,
} from "../services/turnstile/providers";

type KeyMap = Record<string, string | null>;

function setProviderConfig(options: { keys?: KeyMap; settings?: Array<{ provider: string; enabled: boolean; weight: number }> }) {
  const keys = options.keys ?? {};
  mockGetTurnstileKey.mockImplementation(async (key: string) => keys[key] ?? null);
  mockGetHCaptchaKey.mockImplementation(async (key: string) => keys[key] ?? null);
  mockGetCapKey.mockImplementation(async (key: string) => keys[key] ?? null);
  mockGetProviderSettings.mockResolvedValue(options.settings ?? []);
}

const ALL_KEYS: KeyMap = {
  TURNSTILE_SITE_KEY: "ts-site",
  TURNSTILE_SECRET_KEY: "ts-secret",
  HCAPTCHA_SITE_KEY: "hc-site",
  HCAPTCHA_SECRET_KEY: "hc-secret",
  CAP_SITE_KEY: "cap-site",
  CAP_SECRET_KEY: "sk-cap",
  CAP_API_ENDPOINT: "https://cap.example.com/",
};

beforeEach(() => {
  jest.clearAllMocks();
  mockQuotaExhausted = false;
  setProviderConfig({});
});

describe("pickWeightedProvider", () => {
  const entries = [
    { provider: "a", weight: 10 },
    { provider: "b", weight: 30 },
    { provider: "c", weight: 60 },
  ];

  it("按权重区间命中，且不受浮点误差影响", () => {
    const pick = (ticket: number) => pickWeightedProvider(entries, () => ticket)?.provider;

    expect(pick(0)).toBe("a");
    expect(pick(9)).toBe("a");
    expect(pick(10)).toBe("b");
    expect(pick(39)).toBe("b");
    expect(pick(40)).toBe("c");
    expect(pick(99)).toBe("c");
  });

  it("随机源越界（返回 total）时不会产出 undefined", () => {
    expect(pickWeightedProvider(entries, (_min, max) => max)?.provider).toBe("c");
  });

  it("权重全 0 时退化为等概率，而不是返回 null", () => {
    const zero = [
      { provider: "a", weight: 0 },
      { provider: "b", weight: 0 },
    ];
    expect(pickWeightedProvider(zero, () => 0)?.provider).toBe("a");
    expect(pickWeightedProvider(zero, () => 1)?.provider).toBe("b");
  });

  it("容忍负数与 NaN 权重", () => {
    const messy = [
      { provider: "a", weight: Number.NaN },
      { provider: "b", weight: -5 },
      { provider: "c", weight: 7 },
    ];
    expect(pickWeightedProvider(messy, () => 0)?.provider).toBe("c");
  });

  it("空数组返回 null", () => {
    expect(pickWeightedProvider([])).toBeNull();
  });

  it("注入真随机源时不会抛错且结果合法", () => {
    for (let i = 0; i < 50; i += 1) {
      const picked = pickWeightedProvider(entries);
      expect(["a", "b", "c"]).toContain(picked?.provider);
    }
  });
});

describe("normalizeWeightPercentages", () => {
  it("按总和归一化并保留一位小数", () => {
    expect(normalizeWeightPercentages([10, 30, 60])).toEqual([10, 30, 60]);
    expect(normalizeWeightPercentages([1, 2])).toEqual([33.3, 66.7]);
  });

  it("全 0 时等分，空数组返回空", () => {
    expect(normalizeWeightPercentages([0, 0])).toEqual([50, 50]);
    expect(normalizeWeightPercentages([])).toEqual([]);
  });
});

describe("clampProviderWeight", () => {
  it("限制在 0..1000 并取整", () => {
    expect(clampProviderWeight(-10)).toBe(0);
    expect(clampProviderWeight(99999)).toBe(1000);
    expect(clampProviderWeight(12.6)).toBe(13);
    expect(clampProviderWeight("42")).toBe(42);
  });

  it("非法输入回落到默认权重", () => {
    expect(clampProviderWeight(undefined)).toBe(50);
    expect(clampProviderWeight("abc")).toBe(50);
  });
});

describe("isCaptchaProviderId", () => {
  it("识别三家供应商", () => {
    expect(CAPTCHA_PROVIDER_IDS).toEqual(["turnstile", "hcaptcha", "trycap"]);
    expect(isCaptchaProviderId("trycap")).toBe(true);
    expect(isCaptchaProviderId("recaptcha")).toBe(false);
    expect(isCaptchaProviderId(null)).toBe(false);
  });
});

describe("collectCaptchaProviders", () => {
  it("凭据齐全且未下线时进入候选，并给出归一化概率", async () => {
    setProviderConfig({
      keys: ALL_KEYS,
      settings: [
        { provider: "turnstile", enabled: true, weight: 10 },
        { provider: "hcaptcha", enabled: true, weight: 30 },
        { provider: "trycap", enabled: true, weight: 60 },
      ],
    });

    const { providers, candidates } = await collectCaptchaProviders();

    expect(candidates.map((candidate) => candidate.provider)).toEqual(["turnstile", "hcaptcha", "trycap"]);
    expect(providers.map((provider) => provider.percentage)).toEqual([10, 30, 60]);
    expect(candidates[2].apiEndpoint).toBe("https://cap.example.com");
  });

  it("下线但凭据齐全 → 不参与下发且原因可解释", async () => {
    setProviderConfig({
      keys: ALL_KEYS,
      settings: [{ provider: "hcaptcha", enabled: false, weight: 100 }],
    });

    const { providers, candidates } = await collectCaptchaProviders();
    const hcaptcha = providers.find((provider) => provider.provider === "hcaptcha");

    expect(hcaptcha?.reason).toBe("scheduling_disabled");
    expect(hcaptcha?.effective).toBe(false);
    expect(hcaptcha?.percentage).toBe(0);
    expect(candidates.map((candidate) => candidate.provider)).not.toContain("hcaptcha");
  });

  it("上线但缺凭据 → 不进候选，且原因标为凭据缺失", async () => {
    setProviderConfig({ keys: { TURNSTILE_SITE_KEY: "ts-site" }, settings: [] });

    const { providers, candidates } = await collectCaptchaProviders();
    const turnstile = providers.find((provider) => provider.provider === "turnstile");

    expect(turnstile?.reason).toBe("credentials_missing");
    expect(turnstile?.credentialsConfigured).toBe(false);
    expect(candidates).toHaveLength(0);
  });

  it("未配置的供应商默认权重 50 但不写库（读接口无副作用）", async () => {
    setProviderConfig({ keys: ALL_KEYS, settings: [] });

    const { providers } = await collectCaptchaProviders();

    expect(providers.every((provider) => provider.weight === 50)).toBe(true);
    expect(providers.every((provider) => provider.enabled)).toBe(true);
  });

  it("本月额度用尽 → 自动摘出候选，原因标为 quota_exhausted", async () => {
    setProviderConfig({ keys: ALL_KEYS, settings: [] });
    mockQuotaExhausted = true;

    const { providers, candidates } = await collectCaptchaProviders();
    const hcaptcha = providers.find((provider) => provider.provider === "hcaptcha");

    expect(hcaptcha?.reason).toBe("quota_exhausted");
    expect(hcaptcha?.effective).toBe(false);
    expect(candidates.map((candidate) => candidate.provider)).not.toContain("hcaptcha");
    // Turnstile / trycap 不限额，不受影响
    expect(candidates.map((candidate) => candidate.provider)).toEqual(["turnstile", "trycap"]);
  });

  it("额度用尽后仍能选出其他供应商，不会导致无人可下发", async () => {
    setProviderConfig({ keys: ALL_KEYS, settings: [] });
    mockQuotaExhausted = true;

    const selection = await selectCaptchaProvider(() => 0);

    expect(selection.enabled).toBe(true);
    expect(selection.provider).not.toBe("hcaptcha");
  });
});

describe("selectCaptchaProvider", () => {
  it("无候选时回退为 disabled，由前端走「未启用」分支", async () => {
    setProviderConfig({ keys: {}, settings: [] });

    const selection = await selectCaptchaProvider();

    expect(selection).toMatchObject({ provider: "turnstile", enabled: false, reason: "no-candidates" });
  });

  it("只有一个候选时直连该家，不走随机", async () => {
    setProviderConfig({ keys: { HCAPTCHA_SITE_KEY: "hc-site", HCAPTCHA_SECRET_KEY: "hc-secret" }, settings: [] });

    const selection = await selectCaptchaProvider();

    expect(selection).toMatchObject({ provider: "hcaptcha", siteKey: "hc-site", enabled: true, reason: "single-available" });
  });

  it("多候选时按权重选中 trycap 并带上实例地址", async () => {
    setProviderConfig({
      keys: ALL_KEYS,
      settings: [
        { provider: "turnstile", enabled: true, weight: 0 },
        { provider: "trycap", enabled: true, weight: 100 },
      ],
    });

    const selection = await selectCaptchaProvider(() => 0);

    expect(selection).toMatchObject({
      provider: "trycap",
      siteKey: "cap-site",
      apiEndpoint: "https://cap.example.com",
      enabled: true,
      reason: "weighted",
    });
  });

  it("权重全 0 时仍能选出在线候选（不死锁）", async () => {
    setProviderConfig({
      keys: ALL_KEYS,
      settings: [
        { provider: "turnstile", enabled: true, weight: 0 },
        { provider: "hcaptcha", enabled: true, weight: 0 },
      ],
    });

    const selection = await selectCaptchaProvider(() => 0);

    expect(selection.enabled).toBe(true);
    expect(selection.reason).toBe("weighted");
    expect(["turnstile", "hcaptcha"]).toContain(selection.provider);
  });
});
