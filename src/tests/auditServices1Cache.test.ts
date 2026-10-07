import mongoose from "mongoose";
jest.mock("../services/mongoService", () => ({ mongoose: jest.requireActual("mongoose") }));
jest.mock("../utils/logger", () => ({ __esModule: true, default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
const { ClarityService } = require("../services/clarityService") as typeof import("../services/clarityService");
const { GitHubBillingService } = require("../services/githubBillingService") as typeof import("../services/githubBillingService");

describe("audit services 1: cache semantics", () => {
  let readyState: PropertyDescriptor | undefined;
  const originalEnvProject = process.env.CLARITY_PROJECT_ID;
  beforeEach(() => {
    readyState = Object.getOwnPropertyDescriptor(mongoose.connection, "readyState");
    Object.defineProperty(mongoose.connection, "readyState", { configurable: true, value: 1 });
    delete process.env.CLARITY_PROJECT_ID;
    ClarityService.clearCache();
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (readyState) Object.defineProperty(mongoose.connection, "readyState", readyState);
    else delete (mongoose.connection as any).readyState;
    if (originalEnvProject === undefined) delete process.env.CLARITY_PROJECT_ID;
    else process.env.CLARITY_PROJECT_ID = originalEnvProject;
  });

  it("retries after a failed Clarity read instead of caching disabled", async () => {
    const exec = jest.fn().mockRejectedValueOnce(new Error("database temporarily unavailable"))
      .mockResolvedValueOnce({ value: "project123" });
    jest.spyOn(mongoose.model("ClaritySetting"), "findOne").mockReturnValue({ lean: () => ({ exec }) } as any);
    await expect(ClarityService.getConfig()).rejects.toThrow("database temporarily unavailable");
    await expect(ClarityService.getConfig()).resolves.toEqual({ enabled: true, projectId: "project123" });
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("keeps environment fallback temporary and caches a successful absence", async () => {
    process.env.CLARITY_PROJECT_ID = "envproject";
    const exec = jest.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(null);
    jest.spyOn(mongoose.model("ClaritySetting"), "findOne").mockReturnValue({ lean: () => ({ exec }) } as any);
    await expect(ClarityService.getConfig()).resolves.toEqual({ enabled: true, projectId: "envproject" });
    delete process.env.CLARITY_PROJECT_ID;
    await expect(ClarityService.getConfig()).resolves.toEqual({ enabled: false, projectId: null });
    await expect(ClarityService.getConfig()).resolves.toEqual({ enabled: false, projectId: null });
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("warms the source customer's config without falling back to config1", async () => {
    const config = { url: "https://github.com/billing/customer-2", method: "GET", headers: {}, cookies: "fixture", customerId: "customer-2" };
    const fresh = { usage: [] };
    const getConfig = jest.spyOn(GitHubBillingService, "getSavedCurlConfig");
    const fetchSingle = jest.spyOn(GitHubBillingService as any, "fetchSingleConfigData").mockResolvedValue(fresh);
    jest.spyOn(GitHubBillingService, "calculateIntelligentTTL").mockResolvedValue(5);
    const cache = jest.spyOn(GitHubBillingService, "cacheBillingData").mockResolvedValue(undefined);
    await GitHubBillingService.warmupCache("customer-2", config);
    expect(getConfig).not.toHaveBeenCalled();
    expect(fetchSingle).toHaveBeenCalledWith(config, true);
    expect(cache).toHaveBeenCalledWith("customer-2", fresh, 5);
  });
});
