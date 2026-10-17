// PIX-14：Pixel 管理总览的「无数据」语义。
//
// 约束：proxy/worker/queue 没有数据源时必须显式 null + 原因；errors/latency/requestSize
// 没有样本时同理，不得用 0 代替。这里用替身把「有数据」与「无数据」两条路径都钉住。
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("../pixel/cdkMappingService", () => ({
  pixelCdkMappingService: { stats: jest.fn() },
}));
jest.mock("../pixel/integrationConfigService", () => ({
  getPixelIntegrationConfigView: jest.fn(),
}));
jest.mock("../pixel/taskAccessStore", () => ({
  pixelTaskAccessStore: { countBySubmitState: jest.fn() },
}));
jest.mock("../pixel/usageLogService", () => ({
  pixelUsageLogService: { stats: jest.fn(), metrics: jest.fn() },
}));
jest.mock("../pixel/runtime", () => ({
  pixelLimitsFromEnv: () => ({ usageLogRetentionDays: 30 }),
}));

import { getPixelAdminDashboard } from "../pixel/dashboardService";
import { pixelCdkMappingService } from "../pixel/cdkMappingService";
import { getPixelIntegrationConfigView } from "../pixel/integrationConfigService";
import { pixelTaskAccessStore } from "../pixel/taskAccessStore";
import { pixelUsageLogService } from "../pixel/usageLogService";

const configMock = getPixelIntegrationConfigView as unknown as jest.Mock;
const statsMock = (pixelCdkMappingService as unknown as { stats: jest.Mock }).stats;
const tasksMock = (pixelTaskAccessStore as unknown as { countBySubmitState: jest.Mock }).countBySubmitState;
const usageStatsMock = (pixelUsageLogService as unknown as { stats: jest.Mock }).stats;
const usageMetricsMock = (pixelUsageLogService as unknown as { metrics: jest.Mock }).metrics;

const CONFIG = {
  configured: false,
  enabled: false,
  upstreamBaseUrl: "",
  allowedHosts: [],
  requestTimeoutMs: 20_000,
  updatedAt: null,
  updatedByUsername: "",
  source: "default" as const,
  overridden: false,
  reload: "runtime" as const,
};

const EMPTY_METRICS = {
  total: 0,
  errors: null,
  latency: null,
  requestSize: null,
  unavailableReasons: {
    errors: "没有样本",
    latency: "没有样本",
    requestSize: "没有样本",
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  configMock.mockResolvedValue(CONFIG);
  statsMock.mockResolvedValue({ total: 0, enabled: 0 });
  tasksMock.mockResolvedValue({ total: 0, bySubmitState: {} });
  usageStatsMock.mockResolvedValue({ total: 0, last24h: 0, last7d: 0, lastAt: null });
  usageMetricsMock.mockResolvedValue(EMPTY_METRICS);
});

describe("Pixel 管理总览（PIX-14）", () => {
  it("没有数据源时 proxy/worker/queue 显式为 null，并带原因", async () => {
    const view = await getPixelAdminDashboard();
    expect(view.runtime.proxy).toBeNull();
    expect(view.runtime.worker).toBeNull();
    expect(view.runtime.queue).toBeNull();
    expect(view.runtime.unavailableReasons.proxy).toMatch(/没有独立代理进程/);
    expect(view.runtime.unavailableReasons.worker).toMatch(/没有独立 worker/);
    expect(view.runtime.unavailableReasons.queue).toMatch(/没有本地任务队列/);
  });

  it("没有溯源样本时错误/延迟/大小为 null 而不是 0，并带原因", async () => {
    const view = await getPixelAdminDashboard();
    expect(view.metrics.errors).toBeNull();
    expect(view.metrics.latency).toBeNull();
    expect(view.metrics.requestSize).toBeNull();
    expect(view.metrics.unavailableReasons.errors).toBe("没有样本");
    expect(view.metrics.unavailableReasons.latency).toBe("没有样本");
    expect(view.metrics.unavailableReasons.requestSize).toBe("没有样本");
  });

  it("有样本时原样透传真实聚合，并带上来源与热更分类", async () => {
    configMock.mockResolvedValue({
      ...CONFIG,
      configured: true,
      enabled: true,
      upstreamBaseUrl: "https://upstream.example.com",
      allowedHosts: ["upstream.example.com"],
      source: "db",
      overridden: true,
    });
    usageMetricsMock.mockResolvedValue({
      total: 4,
      errors: { total: 4, failed: 1, rate: 0.25, byOutcome: { success: 3, upstream_error: 1 } },
      latency: { samples: 4, avgMs: 120, p95Ms: 200, p99Ms: 200, maxMs: 200 },
      requestSize: { samples: 4, avgBytes: 512, p95Bytes: 800, maxBytes: 900 },
      unavailableReasons: { errors: null, latency: null, requestSize: null },
    });

    const view = await getPixelAdminDashboard();
    expect(view.config).toMatchObject({ source: "db", reload: "runtime", host: "upstream.example.com" });
    expect(view.runtime.upstream).toMatchObject({ source: "db", reload: "runtime", enabled: true });
    expect(view.metrics.errors).toMatchObject({ failed: 1, rate: 0.25 });
    expect(view.metrics.latency).toMatchObject({ p95Ms: 200 });
    expect(view.metrics.requestSize).toMatchObject({ maxBytes: 900 });
  });
});
