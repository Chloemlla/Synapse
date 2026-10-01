const mockFindOne = jest.fn();
const mockFindOneAndUpdate = jest.fn();
const mockUpdateOne = jest.fn();
const mockGetProviderSettings = jest.fn();

jest.mock("../models/captchaQuotaModel", () => ({
  CaptchaQuotaModel: {
    findOne: (...args: unknown[]) => mockFindOne(...args),
    findOneAndUpdate: (...args: unknown[]) => mockFindOneAndUpdate(...args),
    updateOne: (...args: unknown[]) => mockUpdateOne(...args),
  },
}));

jest.mock("../services/turnstile/models", () => ({
  getCaptchaProviderSettingDocs: (...args: unknown[]) => mockGetProviderSettings(...args),
}));

import {
  DEFAULT_MONTHLY_QUOTA,
  clampMonthlyQuota,
  consumeCaptchaQuota,
  consumeConfiguredCaptchaQuota,
  getQuotaMonthKey,
  getQuotaResetAt,
  resolveMonthlyLimit,
} from "../services/turnstile/quota";

/** 极简内存替身：count 按 monthKey+provider 存。 */
let counts: Record<string, number> = {};

function key(provider: string, monthKey: string) {
  return `${provider}:${monthKey}`;
}

beforeEach(() => {
  jest.clearAllMocks();
  counts = {};

  mockFindOne.mockImplementation((filter: { provider: string; monthKey: string }) => ({
    lean: () => ({
      exec: async () => {
        const value = counts[key(filter.provider, filter.monthKey)];
        return value === undefined ? null : { provider: filter.provider, monthKey: filter.monthKey, count: value };
      },
    }),
  }));

  mockFindOneAndUpdate.mockImplementation(
    (filter: { provider: string; monthKey: string }, update: { $inc?: { count?: number } }) => ({
      lean: () => ({
        exec: async () => {
          const k = key(filter.provider, filter.monthKey);
          counts[k] = (counts[k] ?? 0) + (update?.$inc?.count ?? 0);
          return { provider: filter.provider, monthKey: filter.monthKey, count: counts[k] };
        },
      }),
    }),
  );

  mockUpdateOne.mockImplementation(() => ({ exec: async () => ({ acknowledged: true }) }));
  mockGetProviderSettings.mockResolvedValue([]);
});

describe("getQuotaMonthKey", () => {
  it("按 Asia/Shanghai 切分月份（不是 UTC）", () => {
    // UTC 2026-10-31T16:30Z = 北京时间 2026-11-01 00:30
    expect(getQuotaMonthKey(new Date("2026-10-31T16:30:00Z"))).toBe("2026-11");
    // UTC 2026-10-31T15:30Z = 北京时间 2026-10-31 23:30
    expect(getQuotaMonthKey(new Date("2026-10-31T15:30:00Z"))).toBe("2026-10");
  });

  it("格式恒为 YYYY-MM", () => {
    expect(getQuotaMonthKey(new Date("2026-01-05T00:00:00Z"))).toMatch(/^\d{4}-\d{2}$/);
  });
});

describe("getQuotaResetAt", () => {
  it("返回下月 1 日北京时间 00:00", () => {
    expect(getQuotaResetAt("2026-10")).toBe("2026-10-31T16:00:00.000Z");
  });

  it("跨年正确", () => {
    expect(getQuotaResetAt("2026-12")).toBe("2026-12-31T16:00:00.000Z");
  });
});

describe("额度上限解析", () => {
  it("只有 hCaptcha 默认限额 10000；trycap 与 Turnstile 不限额", () => {
    expect(DEFAULT_MONTHLY_QUOTA.hcaptcha).toBe(10_000);
    expect(DEFAULT_MONTHLY_QUOTA.trycap).toBe(0);
    expect(DEFAULT_MONTHLY_QUOTA.turnstile).toBe(0);
  });

  it("clampMonthlyQuota 把非法值归一到 0（= 不限）", () => {
    expect(clampMonthlyQuota(-5)).toBe(0);
    expect(clampMonthlyQuota(undefined)).toBe(0);
    expect(clampMonthlyQuota("abc")).toBe(0);
    expect(clampMonthlyQuota(15_000)).toBe(15_000);
    expect(clampMonthlyQuota(999_999_999)).toBe(10_000_000);
  });

  it("resolveMonthlyLimit：缺省用默认值，管理端 0 表示解除限额", () => {
    expect(resolveMonthlyLimit("hcaptcha")).toBe(10_000);
    expect(resolveMonthlyLimit("turnstile")).toBe(0);
    expect(resolveMonthlyLimit("hcaptcha", 5_000)).toBe(5_000);
    expect(resolveMonthlyLimit("hcaptcha", 0)).toBe(0);
  });
});

describe("consumeCaptchaQuota", () => {
  it("额度未用尽时放行并计数", async () => {
    const result = await consumeCaptchaQuota("hcaptcha", 10_000);

    expect(result.allowed).toBe(true);
    expect(result.snapshot.used).toBe(1);
    expect(result.snapshot.exhausted).toBe(false);
    expect(result.snapshot.remaining).toBe(9_999);
  });

  it("用尽后拒绝且不再计数（不外呼）", async () => {
    counts[key("hcaptcha", getQuotaMonthKey())] = 10_000;

    const result = await consumeCaptchaQuota("hcaptcha", 10_000);

    expect(result.allowed).toBe(false);
    expect(result.snapshot.exhausted).toBe(true);
    expect(result.snapshot.used).toBe(10_000);
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("最后一次可用额度本身应被放行，只是随后标记耗尽", async () => {
    counts[key("hcaptcha", getQuotaMonthKey())] = 9_999;

    const result = await consumeCaptchaQuota("hcaptcha", 10_000);

    expect(result.allowed).toBe(true);
    expect(result.snapshot.used).toBe(10_000);
    expect(result.snapshot.exhausted).toBe(true);
    expect(mockUpdateOne).toHaveBeenCalled();
  });

  it("不限额的供应商即使计数很高也永远放行", async () => {
    counts[key("turnstile", getQuotaMonthKey())] = 999_999;

    const result = await consumeCaptchaQuota("turnstile", 0);

    expect(result.allowed).toBe(true);
    expect(result.snapshot.exhausted).toBe(false);
    expect(result.snapshot.limit).toBe(0);
    expect(result.snapshot.remaining).toBe(-1);
  });

  it("百分比保留一位小数且封顶 100", async () => {
    counts[key("hcaptcha", getQuotaMonthKey())] = 10_000;
    const snapshot = (await consumeCaptchaQuota("hcaptcha", 10_000)).snapshot;

    expect(snapshot.percentage).toBe(100);
  });
});

describe("consumeConfiguredCaptchaQuota", () => {
  it("读取管理端配置的上限", async () => {
    mockGetProviderSettings.mockResolvedValue([{ provider: "hcaptcha", enabled: true, weight: 50, monthlyQuota: 2 }]);

    expect((await consumeConfiguredCaptchaQuota("hcaptcha")).allowed).toBe(true);
    expect((await consumeConfiguredCaptchaQuota("hcaptcha")).allowed).toBe(true);
    const third = await consumeConfiguredCaptchaQuota("hcaptcha");

    expect(third.allowed).toBe(false);
    expect(third.snapshot.limit).toBe(2);
  });

  it("未配置时回落到默认额度", async () => {
    const result = await consumeConfiguredCaptchaQuota("hcaptcha");
    expect(result.snapshot.limit).toBe(10_000);
  });
});
