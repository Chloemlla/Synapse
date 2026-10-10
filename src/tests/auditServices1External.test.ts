import { withOperationTimeout } from "../services/withOperationTimeout";

const mockGet = jest.fn();
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock("axios", () => ({ __esModule: true, default: { get: mockGet, isAxiosError: () => false } }));
jest.mock("../utils/logger", () => ({ __esModule: true, default: mockLogger }));
const { AntaService } = require("../services/antaService") as typeof import("../services/antaService");
const { DataProcessService } = require("../services/dataProcessService") as typeof import("../services/dataProcessService");
const { lookupIpLocation } = require("../services/ipTelemetryService") as typeof import("../services/ipTelemetryService");

describe("audit services 1: external failure boundaries", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns the requested product's 400 and never queries a sample product", async () => {
    mockGet.mockResolvedValue({ status: 400, data: "invalid product" });
    const service = new AntaService();
    await expect(service.queryProduct("TESTPRODUCT123")).resolves.toMatchObject({ success: false });
    expect(mockGet).toHaveBeenCalledTimes(1);
    const [url, options] = mockGet.mock.calls[0];
    expect(url).toContain("TESTPRODUCT123");
    expect(options.httpsAgent.options.keepAlive).toBe(false);
  });

  it.each(["base64Encode", "base64Decode", "md5Hash"] as const)("keeps content out of %s logs", async (method) => {
    mockGet.mockResolvedValue({ data: { data: "sensitive-decoded-result" } });
    await DataProcessService[method]("sensitive-original-input");
    const serialized = JSON.stringify([mockLogger.info.mock.calls, mockLogger.error.mock.calls]);
    expect(serialized).not.toContain("sensitive-decoded-result");
    expect(serialized).not.toContain("sensitive-original-input");
  });

  it("cools down providers whose JSON has no usable location", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true, headers: { get: () => "application/json" }, json: async () => ({}),
    } as unknown as Response);
    try {
      expect(await lookupIpLocation("8.8.8.8")).toBe("未知");
      const attempts = fetchMock.mock.calls.length;
      expect(attempts).toBeGreaterThan(0);
      expect(await lookupIpLocation("1.1.1.1")).toBe("未知");
      expect(fetchMock).toHaveBeenCalledTimes(attempts);
    } finally {
      fetchMock.mockRestore();
    }
  });
});

describe("audit services 1: operation timeout lifecycle", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("clears successful and rejected operation timers", async () => {
    await expect(withOperationTimeout(Promise.resolve("done"), 10000, "timeout")).resolves.toBe("done");
    expect(jest.getTimerCount()).toBe(0);
    await expect(withOperationTimeout(Promise.reject(new Error("failure")), 10000, "timeout")).rejects.toThrow("failure");
    expect(jest.getTimerCount()).toBe(0);
  });

  it("rejects an overdue operation and leaves no timer", async () => {
    const operation = withOperationTimeout(new Promise<never>(() => {}), 100, "deadline");
    const assertion = expect(operation).rejects.toThrow("deadline");
    await jest.advanceTimersByTimeAsync(100);
    await assertion;
    expect(jest.getTimerCount()).toBe(0);
  });
});
