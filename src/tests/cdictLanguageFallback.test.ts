import { CDictLanguageRequestError } from "../services/cdictLanguageDiagnostics";
import {
  buildFallbackCdictLanguagePayload,
  CDICT_FALLBACK_LANGUAGE_CODES,
  hasUsableCdictLanguages,
  resolveCdictLanguageList,
} from "../services/cdictLanguageCatalogService";
import { collectCdictLanguageCodes, normalizeCdictLanguageResponse } from "../services/cdictLanguageResponse";

/**
 * 语言列表降级契约（无网络、无凭据，CI 必跑）。
 *
 * 背景：vivo `/translation/lang/list` 自 2026-11 起对第三方固定返回 `200 + code=10000 + data:null`，
 * 上游失败不能变成客户端的 502 —— 语言集合是稳定事实，必须回退内置集合，且降级要可观测。
 */

const upstreamBusinessFailure = () =>
  new CDictLanguageRequestError("语言列表上游业务失败 code=10000", {
    upstreamStatus: 200,
    upstreamCode: 10000,
    upstreamMessage: "",
    messageState: "empty",
    responseShape: "object",
    dataShape: "null",
    knownFields: ["code", "msg", "data"],
    listSizes: {},
    upstreamMethod: "POST",
    compatibilityRetried: true,
    previousUpstreamStatus: 405,
  });

describe("CDict language list degradation", () => {
  it("passes the upstream list through untouched when the gateway really answers", async () => {
    const result = await resolveCdictLanguageList(async () => ({
      code: 0,
      data: { langs: ["en", "zh-CHS"] },
    }));
    expect(result.source).toBe("upstream");
    expect(collectCdictLanguageCodes(result.payload)).toEqual(expect.arrayContaining(["en", "zh-CHS"]));
    expect((result.payload as Record<string, unknown>).upstreamDegraded).toBeUndefined();
  });

  it("falls back to the built-in catalog when the upstream reports a business failure", async () => {
    const result = await resolveCdictLanguageList(async () => {
      throw upstreamBusinessFailure();
    });
    expect(result.source).toBe("fallback");
    expect(result.failureReason).toContain("10000");
    // 诊断要透传给调用方（日志里靠它看出是上游业务拒绝而不是我们解析坏了）
    expect(result.diagnostic?.upstreamStatus).toBe(200);
    expect(result.diagnostic?.upstreamCode).toBe(10000);
    expect(hasUsableCdictLanguages(result.payload)).toBe(true);
  });

  it("falls back when a 200 envelope claims success but carries an empty list", async () => {
    const result = await resolveCdictLanguageList(async () => ({ code: 0, success: true, data: { langs: [] } }));
    expect(result.source).toBe("fallback");
    expect(hasUsableCdictLanguages(result.payload)).toBe(true);
  });

  it("falls back on transport errors (no HTTP response at all)", async () => {
    const result = await resolveCdictLanguageList(async () => {
      throw new CDictLanguageRequestError("上游语言列表请求失败", {
        upstreamMessage: "",
        messageState: "missing",
        responseShape: "null",
        dataShape: "null",
        knownFields: [],
        listSizes: {},
      });
    });
    expect(result.source).toBe("fallback");
    expect(result.diagnostic?.upstreamStatus).toBeUndefined();
    expect(hasUsableCdictLanguages(result.payload)).toBe(true);
  });

  it("emits a client-compatible fallback payload that survives normalization", () => {
    const payload = buildFallbackCdictLanguagePayload();
    expect(payload.code).toBe(0);
    expect(payload.upstreamDegraded).toBe(true);
    // 老客户端读顶层 languages，SDK 风格读 data.langs —— 两者都要在。
    expect(payload.languages).toEqual([...CDICT_FALLBACK_LANGUAGE_CODES]);
    expect((payload.data as Record<string, unknown>).langs).toEqual([...CDICT_FALLBACK_LANGUAGE_CODES]);
    expect(hasUsableCdictLanguages(normalizeCdictLanguageResponse(payload))).toBe(true);
  });
});
