import { describe, expect, it } from "@jest/globals";
import {
  isAllowedGeoGebraAiBaseUrl,
  normalizeGeoGebraAiResult,
  resolveGeoGebraAiProvider,
} from "../geogebra/aiService";

// AI 服务的两条底线：未配置就 fail-closed；模型输出只走白名单收敛（GEO-15/16）。
describe("isAllowedGeoGebraAiBaseUrl", () => {
  it("只接受 https 且拒绝内网/环回/带凭据的地址", () => {
    expect(isAllowedGeoGebraAiBaseUrl("https://api.example.com/v1")).toBe(true);
    expect(isAllowedGeoGebraAiBaseUrl("http://api.example.com")).toBe(false);
    expect(isAllowedGeoGebraAiBaseUrl("https://127.0.0.1:8080")).toBe(false);
    expect(isAllowedGeoGebraAiBaseUrl("https://localhost")).toBe(false);
    expect(isAllowedGeoGebraAiBaseUrl("https://10.1.2.3")).toBe(false);
    expect(isAllowedGeoGebraAiBaseUrl("https://192.168.1.10")).toBe(false);
    expect(isAllowedGeoGebraAiBaseUrl("https://user:pass@api.example.com")).toBe(false);
    expect(isAllowedGeoGebraAiBaseUrl("not-a-url")).toBe(false);
  });
});

describe("resolveGeoGebraAiProvider", () => {
  it("缺少任一凭据即视为未配置，且不回显任何凭据", () => {
    const provider = resolveGeoGebraAiProvider(
      { GEOGEBRA_AI_BASE_URL: "https://api.example.com" } as NodeJS.ProcessEnv,
      { useConfigFallback: false },
    );
    expect(provider.configured).toBe(false);
    expect(provider.apiKey).toBe("");
    expect(provider.reason).toBeTruthy();
  });

  it("配置了内网地址时也拒绝（不回退到默认地址）", () => {
    const provider = resolveGeoGebraAiProvider({
      GEOGEBRA_AI_BASE_URL: "http://127.0.0.1:9000",
      GEOGEBRA_AI_API_KEY: "k",
      GEOGEBRA_AI_MODEL: "m",
    } as NodeJS.ProcessEnv, { useConfigFallback: false });
    expect(provider.configured).toBe(false);
  });

  it("完整配置时给出规范化 baseUrl，并默认关闭图片能力", () => {
    const provider = resolveGeoGebraAiProvider({
      GEOGEBRA_AI_BASE_URL: "https://api.example.com/v1/",
      GEOGEBRA_AI_API_KEY: "secret",
      GEOGEBRA_AI_MODEL: "m",
    } as NodeJS.ProcessEnv, { useConfigFallback: false });
    expect(provider).toMatchObject({ configured: true, baseUrl: "https://api.example.com/v1", vision: false });
  });
});

describe("normalizeGeoGebraAiResult", () => {
  it("解析标准 JSON 并保留摘要/指令/建议", () => {
    const result = normalizeGeoGebraAiResult(JSON.stringify({
      summary: "画一个圆",
      commands: ["A = (0, 0)", "circle = Circle(A, 2)"],
      notes: ["半径可调"],
      confidence: 1.4,
    }), "ai-drawing");
    expect(result.commands).toEqual(["A = (0, 0)", "circle = Circle(A, 2)"]);
    expect(result.confidence).toBe(1);
  });

  it("兼容被 ```json 包裹的返回体", () => {
    const result = normalizeGeoGebraAiResult("```json\n{\"summary\":\"s\",\"commands\":[\"A = (1, 1)\"]}\n```", "ai-drawing");
    expect(result.commands).toEqual(["A = (1, 1)"]);
  });

  it("含可执行片段的指令一律拒绝", () => {
    expect(() => normalizeGeoGebraAiResult(JSON.stringify({ summary: "s", commands: ["javascript:alert(1)"] }), "ai-drawing"))
      .toThrow(/无法执行/);
    expect(() => normalizeGeoGebraAiResult(JSON.stringify({ summary: "s", commands: ["x = eval(1)"] }), "ai-drawing"))
      .toThrow(/无法执行/);
  });

  it("绘图类返回空指令视为失败，解读类允许空指令", () => {
    expect(() => normalizeGeoGebraAiResult(JSON.stringify({ summary: "s", commands: [] }), "ai-drawing")).toThrow();
    const insight = normalizeGeoGebraAiResult(JSON.stringify({ summary: "s", commands: [], notes: ["n"] }), "ai-insight");
    expect(insight.commands).toEqual([]);
    expect(insight.notes).toEqual(["n"]);
  });

  it("无法解析的返回体报统一错误，不透传模型原文", () => {
    expect(() => normalizeGeoGebraAiResult("完全不是 JSON", "ai-insight")).toThrow(/无法解析/);
  });
});
