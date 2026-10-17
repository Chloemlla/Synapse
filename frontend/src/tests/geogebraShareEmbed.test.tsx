import { describe, expect, it } from "vitest";
import { geoGebraShareEmbedUrl, geoGebraShareUrl, resolveGeoGebraEmbedUrl } from "../components/geogebra/embed";

// GEO-17：分享 URL 与 embed URL 的口径必须一致，且 embed 链接始终带 ?embed=1。
describe("GeoGebra share embed URL", () => {
  it("从 slug 生成分享页与嵌入地址", () => {
    expect(geoGebraShareUrl("canvas-abc123", "https://example.test"))
      .toBe("https://example.test/geogebra/share/canvas-abc123");
    expect(geoGebraShareEmbedUrl("canvas-abc123", "https://example.test"))
      .toBe("https://example.test/geogebra/share/canvas-abc123?embed=1");
  });

  it("对 slug 做 URL 编码，避免路径穿越或注入", () => {
    expect(geoGebraShareEmbedUrl("a b/c", "https://example.test"))
      .toBe("https://example.test/geogebra/share/a%20b%2Fc?embed=1");
  });

  it("优先使用服务端返回的相对 embedUrl，并补全为绝对地址", () => {
    expect(resolveGeoGebraEmbedUrl({ slug: "canvas-abc123", embedUrl: "/geogebra/share/canvas-abc123?embed=1" }, "https://example.test"))
      .toBe("https://example.test/geogebra/share/canvas-abc123?embed=1");
  });

  it("服务端字段缺失或不可解析时回落到本地推导", () => {
    expect(resolveGeoGebraEmbedUrl({ slug: "canvas-abc123" }, "https://example.test"))
      .toBe("https://example.test/geogebra/share/canvas-abc123?embed=1");
    expect(resolveGeoGebraEmbedUrl({ slug: "canvas-abc123", embedUrl: "http://[bad" }, "https://example.test"))
      .toBe("https://example.test/geogebra/share/canvas-abc123?embed=1");
  });
});
