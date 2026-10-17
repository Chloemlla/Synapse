// PIX-13：Pixel 上游集成配置的来源/覆盖/热更分类、恢复默认与受保护字段。
//
// 这些断言不依赖真实 Mongo：直接替换已注册 Mongoose 模型上的查询方法。
// 重点是「读出来的元数据与实际生效值同源」以及「写接口是 allowlist」。
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import mongoose from "mongoose";
import {
  getPixelIntegrationConfigView,
  invalidatePixelIntegrationConfigCache,
  loadPixelIntegrationConfig,
  resetPixelIntegrationConfig,
  savePixelIntegrationConfig,
} from "../pixel/integrationConfigService";

const model = mongoose.models.PixelIntegrationConfig as unknown as {
  findOne: jest.Mock;
  updateOne: jest.Mock;
  deleteOne: jest.Mock;
};

const ENV_KEYS = [
  "PIXEL_UPSTREAM_BASE_URL",
  "PIXEL_UPSTREAM_ALLOWED_HOSTS",
  "PIXEL_UPSTREAM_ENABLED",
  "PIXEL_UPSTREAM_TIMEOUT_MS",
] as const;

function doc(overrides: Record<string, unknown> = {}) {
  return {
    key: "default",
    upstreamBaseUrl: "https://upstream.example.com",
    allowedHosts: ["upstream.example.com"],
    enabled: true,
    requestTimeoutMs: 20_000,
    updatedByUserId: "root",
    updatedByUsername: "root",
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function mockFindOne(value: unknown) {
  model.findOne.mockReturnValue({ lean: async () => value } as never);
}

beforeEach(() => {
  jest.clearAllMocks();
  invalidatePixelIntegrationConfigCache();
  for (const key of ENV_KEYS) delete process.env[key];
  mockFindOne(null);
  model.updateOne.mockResolvedValue({} as never);
  model.deleteOne.mockResolvedValue({} as never);
});

describe("Pixel 集成配置来源（PIX-13）", () => {
  it("没有数据库记录也没有环境变量时，来源是内置默认且未启用", async () => {
    const view = await getPixelIntegrationConfigView();
    expect(view).toMatchObject({
      configured: false,
      enabled: false,
      source: "default",
      overridden: false,
      reload: "runtime",
    });
    await expect(loadPixelIntegrationConfig()).resolves.toBeNull();
  });

  it("数据库记录标记 source=db / overridden=true，并即时生效", async () => {
    mockFindOne(doc());
    const view = await getPixelIntegrationConfigView();
    expect(view).toMatchObject({
      configured: true,
      enabled: true,
      source: "db",
      overridden: true,
      reload: "runtime",
    });
    const effective = await loadPixelIntegrationConfig();
    expect(effective).toMatchObject({ upstreamBaseUrl: "https://upstream.example.com", enabled: true });
  });

  it("环境变量来源标记 source=env，并提示需要重启生效", async () => {
    process.env.PIXEL_UPSTREAM_BASE_URL = "https://env.example.com";
    process.env.PIXEL_UPSTREAM_ALLOWED_HOSTS = "env.example.com";
    process.env.PIXEL_UPSTREAM_ENABLED = "true";
    process.env.PIXEL_UPSTREAM_TIMEOUT_MS = "15000";

    const view = await getPixelIntegrationConfigView();
    expect(view).toMatchObject({
      configured: true,
      enabled: true,
      source: "env",
      overridden: false,
      reload: "restart",
      requestTimeoutMs: 15_000,
    });
    await expect(loadPixelIntegrationConfig()).resolves.toMatchObject({
      upstreamBaseUrl: "https://env.example.com",
      requestTimeoutMs: 15_000,
    });
  });

  it("环境变量显式关闭时不会回落成可用配置（fail-closed）", async () => {
    process.env.PIXEL_UPSTREAM_BASE_URL = "https://env.example.com";
    process.env.PIXEL_UPSTREAM_ALLOWED_HOSTS = "env.example.com";
    process.env.PIXEL_UPSTREAM_ENABLED = "false";

    await expect(loadPixelIntegrationConfig()).resolves.toBeNull();
    expect(await getPixelIntegrationConfigView()).toMatchObject({ configured: true, enabled: false, source: "env" });
  });

  it("恢复默认会删除数据库记录并回到 default 来源", async () => {
    const view = await resetPixelIntegrationConfig();
    expect(model.deleteOne).toHaveBeenCalledWith({ key: "default" });
    expect(view).toMatchObject({ source: "default", overridden: false, configured: false });
  });
});

describe("Pixel 集成配置写接口的字段保护（PIX-13）", () => {
  it("只允许四个可写字段；Mongo URI 等 bootstrap 项直接 400 且不落库", async () => {
    await expect(savePixelIntegrationConfig({
      upstreamBaseUrl: "https://upstream.example.com",
      allowedHosts: ["upstream.example.com"],
      enabled: true,
      requestTimeoutMs: 20_000,
      mongoUri: "mongodb://protected",
    }, { userId: "root", username: "root" })).rejects.toMatchObject({
      code: "PIXEL_CONFIG_PROTECTED_FIELD",
      status: 400,
    });
    expect(model.updateOne).not.toHaveBeenCalled();
  });

  it("合法字段保存成功，且地址被归一为 https://host", async () => {
    await savePixelIntegrationConfig({
      upstreamBaseUrl: "https://upstream.example.com/",
      allowedHosts: ["upstream.example.com"],
      enabled: true,
      requestTimeoutMs: 25_000,
    }, { userId: "root", username: "root" });

    expect(model.updateOne).toHaveBeenCalledTimes(1);
    const update = model.updateOne.mock.calls[0][1] as { $set: Record<string, unknown> };
    expect(update.$set).toMatchObject({
      upstreamBaseUrl: "https://upstream.example.com",
      allowedHosts: ["upstream.example.com"],
      enabled: true,
      requestTimeoutMs: 25_000,
      updatedByUsername: "root",
    });
  });
});
