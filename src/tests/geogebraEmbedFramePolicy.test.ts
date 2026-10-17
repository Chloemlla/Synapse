import { renderCspHeaderValue } from "../security/contentSecurityPolicy";
import {
  geoGebraEmbedFrameAncestorsForUrl,
  isGeoGebraEmbedRequest,
  resolveGeoGebraEmbedFrameAncestors,
} from "../security/embedFramePolicy";

// GEO-17：分享嵌入壳要被 iframe 接受，但放宽只能发生在 `/geogebra/share/<slug>?embed=1`
// 这一条只读路径上；其它页面必须继续 frame-ancestors 'none'。
const EMBED_URL = "/geogebra/share/canvas-abc12345?embed=1";

describe("GeoGebra embed frame policy", () => {
  const originalValue = process.env.GEOGEBRA_EMBED_FRAME_ANCESTORS;

  afterEach(() => {
    if (originalValue === undefined) delete process.env.GEOGEBRA_EMBED_FRAME_ANCESTORS;
    else process.env.GEOGEBRA_EMBED_FRAME_ANCESTORS = originalValue;
  });

  it("只命中带 embed=1 的分享路径", () => {
    expect(isGeoGebraEmbedRequest(EMBED_URL)).toBe(true);
    expect(isGeoGebraEmbedRequest("https://synapse.example/geogebra/share/canvas-abc12345?embed=1")).toBe(true);
    expect(isGeoGebraEmbedRequest("/geogebra/share/canvas-abc12345")).toBe(false);
    expect(isGeoGebraEmbedRequest("/geogebra/share/canvas-abc12345?embed=0")).toBe(false);
    expect(isGeoGebraEmbedRequest("/geogebra?share=canvas-abc12345")).toBe(false);
    expect(isGeoGebraEmbedRequest("/admin?embed=1")).toBe(false);
    expect(isGeoGebraEmbedRequest("")).toBe(false);
  });

  it("默认允许任意来源嵌入只读分享壳", () => {
    delete process.env.GEOGEBRA_EMBED_FRAME_ANCESTORS;
    expect(resolveGeoGebraEmbedFrameAncestors()).toEqual(["*"]);
    expect(geoGebraEmbedFrameAncestorsForUrl(EMBED_URL)).toEqual(["*"]);
  });

  it("支持逗号分隔的来源白名单，并丢弃非法项", () => {
    process.env.GEOGEBRA_EMBED_FRAME_ANCESTORS = "https://example.com, https://*.example.org, javascript:alert(1), https://x.test/path";
    expect(resolveGeoGebraEmbedFrameAncestors()).toEqual(["https://example.com", "https://*.example.org"]);
  });

  it("空字符串或全部非法时关闭嵌入（保持 DENY）", () => {
    process.env.GEOGEBRA_EMBED_FRAME_ANCESTORS = "";
    expect(resolveGeoGebraEmbedFrameAncestors()).toBeNull();
    process.env.GEOGEBRA_EMBED_FRAME_ANCESTORS = "not-a-source, javascript:alert(1)";
    expect(resolveGeoGebraEmbedFrameAncestors()).toBeNull();
    expect(geoGebraEmbedFrameAncestorsForUrl(EMBED_URL)).toBeNull();
  });

  it("非嵌入页面永远返回 null（调用方维持 DENY）", () => {
    delete process.env.GEOGEBRA_EMBED_FRAME_ANCESTORS;
    expect(geoGebraEmbedFrameAncestorsForUrl("/geogebra/share/canvas-abc12345")).toBeNull();
    expect(geoGebraEmbedFrameAncestorsForUrl("/geogebra")).toBeNull();
  });

  it("CSP 只为嵌入壳放行 frame-ancestors", () => {
    delete process.env.GEOGEBRA_EMBED_FRAME_ANCESTORS;
    const embedHeader = renderCspHeaderValue({}, { path: EMBED_URL, nodeEnv: "production" });
    expect(embedHeader).toContain("frame-ancestors *");
    expect(embedHeader).not.toContain("frame-ancestors 'none'");

    const normalHeader = renderCspHeaderValue({}, { path: "/geogebra/share/canvas-abc12345", nodeEnv: "production" });
    expect(normalHeader).toContain("frame-ancestors 'none'");

    process.env.GEOGEBRA_EMBED_FRAME_ANCESTORS = "https://example.com";
    const narrowed = renderCspHeaderValue({}, { path: EMBED_URL, nodeEnv: "production" });
    expect(narrowed).toContain("frame-ancestors https://example.com");
  });
});
