import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { createHttpFinanceSource, resolveLotteryFinanceSource, shanghaiDateKey } from "../services/lottery/finance";

jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.LOTTERY_FINANCE_SOURCE_URL;
  (globalThis as unknown as { fetch: unknown }).fetch = jest.fn();
});

describe("lottery/finance 外部财务源", () => {
  it("未配置 LOTTERY_FINANCE_SOURCE_URL 时返回 null（没有基线不伪装成对上了）", () => {
    expect(resolveLotteryFinanceSource()).toBeNull();
    process.env.LOTTERY_FINANCE_SOURCE_URL = "https://finance.example/daily";
    expect(resolveLotteryFinanceSource()).not.toBeNull();
  });

  it("HTTP 源拼 date 参数并解析 totalValue/count", async () => {
    const mockFetch = (globalThis as unknown as { fetch: jest.Mock }).fetch;
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ totalValue: 123.5, count: 4 }) });

    const entry = await createHttpFinanceSource("https://finance.example/daily").fetchDaily("2026-10-11");

    expect(entry).toEqual({ date: "2026-10-11", totalValue: 123.5, count: 4, source: "http" });
    expect(mockFetch).toHaveBeenCalledWith("https://finance.example/daily?date=2026-10-11", expect.anything());
  });

  it("非 2xx 或缺少 totalValue 时返回 null", async () => {
    const mockFetch = (globalThis as unknown as { fetch: jest.Mock }).fetch;
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    await expect(createHttpFinanceSource("https://finance.example/daily").fetchDaily("2026-10-11")).resolves.toBeNull();

    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ count: 1 }) });
    await expect(createHttpFinanceSource("https://finance.example/daily").fetchDaily("2026-10-11")).resolves.toBeNull();
  });

  it("shanghaiDateKey 按上海自然日归日", () => {
    expect(shanghaiDateKey(new Date("2026-10-10T16:30:00Z"))).toBe("2026-10-11");
    expect(shanghaiDateKey(new Date("2026-10-10T15:30:00Z"))).toBe("2026-10-10");
  });
});
