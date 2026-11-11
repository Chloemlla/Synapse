import { resolveCdictLanguageList } from "../services/cdictLanguageCatalogService";
import { collectCdictLanguageCodes } from "../services/cdictLanguageResponse";

// Opt-in CI probe only. No axios/service mock, Mongo connection, TTS invocation or credentials.
const live = process.env.CDICT_LIVE_LANGUAGE_CHECK === "1" ? describe : describe.skip;

/**
 * 真实上游探针（每次 CI 只发一次 HTTP 请求，最多带一次 405 兼容重试）。
 *
 * 断言的是**本服务的契约**，不是 vive 网关的业务结论：无论上游给不给列表，
 * `/languages` 都必须返回一份非空语言集合。上游的业务失败（例如
 * `200 + {"code":10000,"data":null}`，见 2026-11-11 实测）只允许触发内置集合降级，
 * 不允许让客户端拿不到列表；但传输层真断了（DNS/TLS/非 200/非 JSON）仍然要红。
 */
live("CDict upstream live language protocol", () => {
  it("serves a nonempty language list through the real gateway request, degrading only on upstream business errors", async () => {
    const result = await resolveCdictLanguageList(); // bounded SDK request, at most one HTTP 405 compatibility retry
    const codes = collectCdictLanguageCodes(result.payload);
    // 上游结论只进日志：业务码与响应形状是排障入口，不作为 CI 判据。
    process.stdout.write(
      `[CDict live] source=${result.source} upstreamStatus=${result.diagnostic?.upstreamStatus ?? "none"} ` +
        `upstreamCode=${result.diagnostic?.upstreamCode ?? "none"} method=${result.diagnostic?.upstreamMethod ?? "-"} ` +
        `retried=${result.diagnostic?.compatibilityRetried ?? false} shape=${result.diagnostic?.responseShape ?? "-"}\n`,
    );
    expect(codes.length).toBeGreaterThan(0);

    // 只有“网关确实应答了、只是业务上拒绝”才允许降级；请求根本没成功不能算过。
    if (result.source === "fallback") {
      expect(result.diagnostic?.upstreamStatus).toBe(200);
      expect(["object", "array"]).toContain(result.diagnostic?.responseShape);
    }
  }, 50_000);
});
