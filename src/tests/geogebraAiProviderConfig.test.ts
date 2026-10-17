import { describe, expect, it } from "@jest/globals";
import { buildGeoGebraAiResolution, type GeoGebraAiSettingLike } from "../geogebra/aiProviderConfigService";

// GeoGebra AI 提供方三种来源的解析规则（GEO-15/16 + 管理端运行时配置）。
// 纯函数不碰 Mongo：DB 读写只负责把「设置 + 被复用的 LibreChat 提供者」取出来。
const ENV = {
  GEOGEBRA_AI_BASE_URL: "https://env.example.com/v1/",
  GEOGEBRA_AI_API_KEY: "env-key",
  GEOGEBRA_AI_MODEL: "env-model",
} as NodeJS.ProcessEnv;

function setting(over: Partial<GeoGebraAiSettingLike> = {}): GeoGebraAiSettingLike {
  return {
    mode: "custom",
    baseUrl: "https://custom.example.com/v1/",
    apiKey: "custom-key",
    model: "custom-model",
    vision: false,
    librechatProviderId: "",
    ...over,
  };
}

describe("buildGeoGebraAiResolution", () => {
  it("没有管理端设置时沿用环境变量", () => {
    const provider = buildGeoGebraAiResolution({ setting: null, env: ENV });
    expect(provider).toMatchObject({
      configured: true,
      source: "env",
      baseUrl: "https://env.example.com/v1",
      model: "env-model",
      vision: false,
    });
  });

  it("独立配置优先于环境变量，并透传图片能力开关", () => {
    const provider = buildGeoGebraAiResolution({ setting: setting({ vision: true }), env: ENV });
    expect(provider).toMatchObject({
      configured: true,
      source: "custom",
      baseUrl: "https://custom.example.com/v1",
      apiKey: "custom-key",
      model: "custom-model",
      vision: true,
    });
  });

  it("独立配置缺字段或地址不是 https 时 fail-closed，且不回退到环境变量", () => {
    const missing = buildGeoGebraAiResolution({ setting: setting({ model: "" }), env: ENV });
    expect(missing.configured).toBe(false);
    expect(missing.source).toBe("custom");
    expect(missing.reason).toBeTruthy();

    const insecure = buildGeoGebraAiResolution({ setting: setting({ baseUrl: "http://127.0.0.1:9000" }), env: ENV });
    expect(insecure.configured).toBe(false);
    expect(insecure.baseUrl).toBe("");
  });

  it("复用 LibreChat 提供者时使用其地址、密钥与模型", () => {
    const provider = buildGeoGebraAiResolution({
      setting: setting({ mode: "librechat", baseUrl: "", apiKey: "", model: "", librechatProviderId: "p1", vision: true }),
      librechatProvider: {
        baseUrl: "https://lc.example.com/v1",
        apiKey: "lc-key",
        model: "lc-model",
        wire: "openai-chat",
        enabled: true,
      },
      env: ENV,
    });
    expect(provider).toMatchObject({
      configured: true,
      source: "librechat",
      baseUrl: "https://lc.example.com/v1",
      apiKey: "lc-key",
      model: "lc-model",
      vision: true,
    });
  });

  it("所选 LibreChat 提供者停用 / 不存在 / 协议不兼容时明确不可用", () => {
    const base = setting({ mode: "librechat", librechatProviderId: "p1" });
    const compatible = { baseUrl: "https://lc.example.com/v1", apiKey: "k", model: "m", wire: "openai-chat", enabled: true };

    expect(buildGeoGebraAiResolution({ setting: base, librechatProvider: null, env: ENV })).toMatchObject({
      configured: false,
      reason: expect.stringContaining("不存在"),
    });
    expect(buildGeoGebraAiResolution({ setting: base, librechatProvider: { ...compatible, enabled: false }, env: ENV })).toMatchObject({
      configured: false,
      reason: expect.stringContaining("停用"),
    });
    expect(buildGeoGebraAiResolution({ setting: base, librechatProvider: { ...compatible, wire: "anthropic" }, env: ENV })).toMatchObject({
      configured: false,
      reason: expect.stringContaining("不兼容"),
    });
  });

  it("复用模式下没选提供者时不会误用环境变量", () => {
    const provider = buildGeoGebraAiResolution({
      setting: setting({ mode: "librechat", librechatProviderId: "" }),
      env: ENV,
    });
    expect(provider.configured).toBe(false);
    expect(provider.source).toBe("librechat");
  });
});
