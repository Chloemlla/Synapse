import type { Request, Response } from "express";
import {
  applyCspNonceToHtml,
  buildCspHeaderValue,
  createCspNonce,
  renderCspHeaderValue,
  resolveCspSurface,
  shouldUseMinimalCsp,
  summarizeCspHeader,
} from "../security/contentSecurityPolicy";

describe("contentSecurityPolicy", () => {
  describe("resolveCspSurface", () => {
    it("classifies docs, api/default, and spa paths", () => {
      expect(resolveCspSurface("/api-docs")).toBe("docs");
      expect(resolveCspSurface("/api-docs/")).toBe("docs");
      expect(resolveCspSurface("/api-docs/index.html")).toBe("docs");
      expect(resolveCspSurface("/api/openapi.json")).toBe("default");
      expect(resolveCspSurface("/api/auth/login")).toBe("default");
      expect(resolveCspSurface("/health")).toBe("default");
      expect(resolveCspSurface("/cdn-cgi/challenge")).toBe("default");
      expect(resolveCspSurface("/")).toBe("spa");
      expect(resolveCspSurface("/login")).toBe("spa");
      expect(resolveCspSurface("/admin?tab=1")).toBe("spa");
    });
  });

  describe("createCspNonce / applyCspNonceToHtml", () => {
    it("creates opaque nonces", () => {
      const a = createCspNonce();
      const b = createCspNonce();
      expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(a.length).toBeGreaterThanOrEqual(16);
      expect(a).not.toBe(b);
    });

    it("injects nonce into script, style, and stylesheet link tags once", () => {
      const html = `<!doctype html><html><head>
<link rel="stylesheet" href="/assets/app.css">
<link rel="icon" href="/favicon.ico">
<style>body{margin:0}</style>
<script>window.x=1</script>
<script type="module" src="/assets/app.js"></script>
</head></html>`;
      const out = applyCspNonceToHtml(html, "testNonce123");
      expect(out).toContain('<link nonce="testNonce123" rel="stylesheet" href="/assets/app.css">');
      expect(out).toContain('<link rel="icon" href="/favicon.ico">');
      expect(out).toContain('<style nonce="testNonce123">body{margin:0}</style>');
      expect(out).toContain('<script nonce="testNonce123">window.x=1</script>');
      expect(out).toContain('<script nonce="testNonce123" type="module" src="/assets/app.js"></script>');
      // Idempotent: re-applying does not duplicate nonce attributes.
      const twice = applyCspNonceToHtml(out, "other");
      expect(twice).toContain('nonce="testNonce123"');
      expect(twice).not.toContain('nonce="other"');
    });

    it("strips quote characters from nonce before attribute injection", () => {
      const out = applyCspNonceToHtml("<script>1</script>", 'ab"cd');
      expect(out).toBe('<script nonce="abcd">1</script>');
    });
  });

  describe("renderCspHeaderValue / summarizeCspHeader", () => {
    it("uses unsafe-inline for styles on SPA (needed for framer-motion) and nonce for scripts", () => {
      const header = renderCspHeaderValue({ cspNonce: "spaNonce", cspSurface: "spa" }, { path: "/", nodeEnv: "production" });
      const summary = summarizeCspHeader(header);

      expect(summary.hasUnsafeEval).toBe(false);
      expect(summary.hasScriptUnsafeInline).toBe(false);
      expect(summary.hasScriptNonce).toBe(true);
      expect(summary.hasStyleElemUnsafeInline).toBe(true);
      expect(summary.hasStyleAttrUnsafeInline).toBe(true);
      expect(header).toContain("'nonce-spaNonce'");
      expect(header).toMatch(/script-src[^;]*'nonce-spaNonce'/);
      expect(header).toMatch(/style-src[^;]*'unsafe-inline'/);
      expect(header).toMatch(/style-src-attr\s+'unsafe-inline'/);
      expect(header).toMatch(/script-src-attr\s+'none'/);
      // trycap（Cap）的 WASM 求解器需要 wasm-unsafe-eval；它不等于 unsafe-eval（JS eval 仍然禁用）。
      expect(header).toMatch(/script-src[^;]*'wasm-unsafe-eval'/);
      expect(header).not.toContain("'unsafe-eval'");
      expect(header).not.toMatch(/script-src[^;]*'unsafe-inline'/);
      // Must not combine style nonce + unsafe-inline (browsers ignore unsafe-inline then).
      expect(header).not.toMatch(/style-src[^;]*'nonce-/);
    });

    it("enables strict-dynamic for scripts so trusted loaders can insert their own scripts (GeoGebra)", () => {
      const header = renderCspHeaderValue({ cspNonce: "spaNonce", cspSurface: "spa" }, { path: "/geogebra", nodeEnv: "production" });
      const summary = summarizeCspHeader(header);

      // 信任根必须存在：没有 nonce 时 strict-dynamic 会把我们自己 bundle 也拦掉。
      expect(summary.hasStrictDynamic).toBe(true);
      expect(summary.hasScriptNonce).toBe(true);
      // strict-dynamic 只用于脚本；样式仍走 unsafe-inline（framer-motion 运行时样式）。
      expect(header).toMatch(/script-src\s+[^;]*'strict-dynamic'/);
      // script-src-elem / style-src-elem / child-src 与基础指令完全同值，
      // 按 CSP 回落链等价；不再重复下发（每条响应省约 1.1 KB）。
      expect(header).not.toMatch(/script-src-elem/);
      expect(header).not.toMatch(/style-src-elem/);
      expect(header).not.toMatch(/child-src/);
      expect(header).not.toMatch(/style-src[^;]*'strict-dynamic'/);
      // 仍然不得出现 unsafe-inline / unsafe-eval：这两个才是真正会拆掉 XSS 防线的。
      expect(summary.hasScriptUnsafeInline).toBe(false);
      expect(summary.hasUnsafeEval).toBe(false);
      // host 名单保留（CSP2 浏览器忽略 strict-dynamic 时的回退），GeoGebra 与 Cap 都还在。
      expect(header).toMatch(/script-src[^;]*https:\/\/www\.geogebra\.org/);
      expect(header).toMatch(/script-src[^;]*https:\/\/cdn\.jsdelivr\.net/);
    });

    it("keeps docs style unsafe-inline without style nonces so Swagger can inject CSS", () => {
      const header = renderCspHeaderValue({ cspNonce: "docsNonce", cspSurface: "docs" }, { path: "/api-docs", nodeEnv: "production" });
      const summary = summarizeCspHeader(header);

      expect(summary.hasUnsafeEval).toBe(false);
      expect(summary.hasScriptUnsafeInline).toBe(false);
      expect(summary.hasScriptNonce).toBe(true);
      expect(summary.hasStyleElemUnsafeInline).toBe(true);
      expect(header).toMatch(/script-src[^;]*'nonce-docsNonce'/);
      expect(header).toMatch(/style-src[^;]*'unsafe-inline'/);
      // Must not combine style nonce + unsafe-inline (browsers ignore unsafe-inline then).
      expect(header).not.toMatch(/style-src[^;]*'nonce-/);
    });

    it("omits development connect hosts in production and includes them otherwise", () => {
      const prod = renderCspHeaderValue({ cspNonce: "n", cspSurface: "spa" }, { path: "/", nodeEnv: "production" });
      const dev = renderCspHeaderValue({ cspNonce: "n", cspSurface: "spa" }, { path: "/", nodeEnv: "development" });

      expect(prod).not.toContain("http://localhost:3000");
      expect(dev).toContain("http://localhost:3000");
      expect(dev).toContain("ws://localhost:3000");
    });

    it("retains third-party hosts required by SPA integrations", () => {
      const header = renderCspHeaderValue({ cspNonce: "n", cspSurface: "spa" }, { path: "/", nodeEnv: "production" });
      expect(header).toContain("https://challenges.cloudflare.com");
      expect(header).toContain("https://js.hcaptcha.com");
      // trycap（Cap）：控件/wasm 取 jsdelivr，challenge/redeem 取 Cap 实例。
      expect(header).toContain("https://cdn.jsdelivr.net");
      expect(header).toContain("https://cap.chloemlla.com");
      expect(header).toMatch(/connect-src[^;]*https:\/\/cap\.chloemlla\.com/);
      expect(header).toMatch(/script-src[^;]*https:\/\/cap\.chloemlla\.com/);
      expect(header).toContain("https://accounts.google.com");
      expect(header).toContain("https://www.googletagmanager.com");
      expect(header).toContain("https://fonts.googleapis.com");
      expect(header).toMatch(/script-src[^;]*https:\/\/www\.geogebra\.org/);
      expect(header).toMatch(/connect-src[^;]*https:\/\/www\.geogebra\.org/);
      expect(header).toMatch(/frame-src[^;]*https:\/\/www\.geogebra\.org/);
      // 通配只匹配子域，apex 必须显式列出，否则子域页面跨源引用 chloemlla.com 会被拦。
      expect(header).toContain("https://chloemlla.com");
      expect(header).toContain("https://*.chloemlla.com");
      expect(header).toContain("wss://chloemlla.com");
      expect(header).toContain("wss://*.chloemlla.com");
      expect(header).toContain("frame-ancestors 'none'");
      expect(header).toContain("object-src 'none'");
    });
  });

  describe("non-document responses", () => {
    const minimal = "default-src 'none';base-uri 'none';form-action 'none';frame-ancestors 'none'";

    it("sends the minimal policy (and no nonce) for API and static-asset responses", () => {
      const api = renderCspHeaderValue({ cspSurface: "default" }, { path: "/api/auth/login", nodeEnv: "production" });
      expect(api).toBe(minimal);
      expect(api).not.toContain("nonce-");

      const asset = renderCspHeaderValue({ cspSurface: "spa" }, { path: "/static/assets/index-a1b2c3.js", nodeEnv: "production" });
      expect(asset).toBe(minimal);
      expect(asset).not.toContain("nonce-");
    });

    it("keeps the full document policy when an API path is opened as a document", () => {
      const req = {
        path: "/api/email/unsubscribe",
        url: "/api/email/unsubscribe",
        originalUrl: "/api/email/unsubscribe",
        headers: { "sec-fetch-dest": "document" },
      } as unknown as Request;
      expect(shouldUseMinimalCsp(req, "default", req.path)).toBe(false);

      const res = { locals: { cspSurface: "default", cspNonce: "docNonce" } } as unknown as Response;
      const header = buildCspHeaderValue(req, res);
      expect(header).toContain("'nonce-docNonce'");
      expect(header).toMatch(/script-src[^;]*'strict-dynamic'/);
    });

    it("treats fetch() of an API path as non-document", () => {
      const req = {
        path: "/api/tts",
        headers: { "sec-fetch-dest": "empty", accept: "*/*" },
      } as unknown as Request;
      expect(shouldUseMinimalCsp(req, "default", "/api/tts")).toBe(true);
    });

    it("falls back to Accept when Sec-Fetch-Dest is absent", () => {
      const nav = {
        path: "/api/email/unsubscribe",
        headers: { accept: "text/html,application/xhtml+xml" },
      } as unknown as Request;
      const xhr = {
        path: "/api/email/unsubscribe",
        headers: { accept: "application/json" },
      } as unknown as Request;
      expect(shouldUseMinimalCsp(nav, "default", "/api/email/unsubscribe")).toBe(false);
      expect(shouldUseMinimalCsp(xhr, "default", "/api/email/unsubscribe")).toBe(true);
    });

    it("never tightens Swagger docs or SPA page paths", () => {
      const docsReq = { path: "/api-docs", headers: { "sec-fetch-dest": "empty" } } as unknown as Request;
      const spaReq = { path: "/login", headers: { "sec-fetch-dest": "empty" } } as unknown as Request;
      expect(shouldUseMinimalCsp(docsReq, "docs", "/api-docs")).toBe(false);
      expect(shouldUseMinimalCsp(spaReq, "spa", "/login")).toBe(false);
    });
  });
});
