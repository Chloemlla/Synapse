import crypto from "node:crypto";
import type { Request, Response } from "express";
import { geoGebraEmbedFrameAncestorsForUrl } from "./embedFramePolicy";

export type CspSurface = "default" | "docs" | "spa";

declare global {
  namespace Express {
    interface Locals {
      cspNonce?: string;
      cspSurface?: CspSurface;
    }
  }
}

// 注意：host-source 的通配 `https://*.chloemlla.com` 只匹配子域，**不匹配裸域 apex
// （chloemlla.com）** —— 与 TLS 通配证书同一条规则。所以每个清单里 apex 与通配成对出现；
// 少了 apex 这一条，页面跑在子域上时跨源引用 chloemlla.com 的脚本/样式/接口/iframe 会被拦。
const THIRD_PARTY_SCRIPT_HOSTS = [
  "https://accounts.google.com",
  "https://www.gstatic.com",
  "https://chloemlla.com",
  "https://*.chloemlla.com",
  "https://challenges.cloudflare.com",
  "https://*.cloudflare.com",
  "https://js.hcaptcha.com",
  "https://*.hcaptcha.com",
  // trycap（Cap）：控件脚本与可选的 pako 回退包都从 jsdelivr 取。
  "https://cdn.jsdelivr.net",
  // Cap 实例自身：Standalone 的 asset server 也可直接托管控件与 wasm（CAP_CUSTOM_WASM_URL 指向实例时）。
  "https://cap.chloemlla.com",
  "https://www.googletagmanager.com",
  "https://www.google-analytics.com",
  "https://analytics.google.com",
  "https://www.clarity.ms",
  "https://*.clarity.ms",
  // GeoGebra applet loader and its same-vendor resources are required only by the lazy GeoGebra tool page.
  "https://www.geogebra.org",
  "https://*.geogebra.org",
] as const;

const THIRD_PARTY_STYLE_HOSTS = [
  "https://fonts.googleapis.com",
  "https://accounts.google.com",
  "https://www.gstatic.com",
  "https://chloemlla.com",
  "https://*.chloemlla.com",
  "https://challenges.cloudflare.com",
  "https://*.cloudflare.com",
  "https://js.hcaptcha.com",
  "https://*.hcaptcha.com",
  "https://www.geogebra.org",
  "https://*.geogebra.org",
] as const;

const PRODUCTION_CONNECT_HOSTS = [
  "'self'",
  "https://accounts.google.com",
  "https://www.googleapis.com",
  "https://oauth2.googleapis.com",
  "https://api.openai.com",
  "wss://chloemlla.com",
  "wss://*.chloemlla.com",
  "https://chloemlla.com",
  "https://*.chloemlla.com",
  "https://api.hcaptcha.com",
  "https://*.hcaptcha.com",
  "https://challenges.cloudflare.com",
  "https://*.cloudflare.com",
  // trycap：WASM 求解器从 jsdelivr 下载；challenge/redeem 走实例地址。
  // 实例地址显式列出（不依赖 https://*.chloemlla.com 通配），换自定义域名部署时这里要同步。
  "https://cdn.jsdelivr.net",
  "https://cap.chloemlla.com",
  "https://www.google-analytics.com",
  "https://analytics.google.com",
  "https://www.google.com",
  "https://www.clarity.ms",
  "https://*.clarity.ms",
  "https://www.geogebra.org",
  "https://*.geogebra.org",
] as const;

const DEVELOPMENT_CONNECT_HOSTS = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:6000",
  "http://localhost:6001",
  "ws://localhost:3000",
  "http://127.0.0.1:3001",
  "http://127.0.0.1:6000",
  "http://127.0.0.1:6001",
  "ws://127.0.0.1:3000",
  "http://192.168.10.7:3001",
  "http://192.168.10.7:3000",
  "http://192.168.10.7:6000",
  "http://192.168.10.7:6001",
  "ws://192.168.10.7:3000",
] as const;

const FRAME_HOSTS = [
  "'self'",
  "https://accounts.google.com",
  "https://chloemlla.com",
  "https://*.chloemlla.com",
  "https://challenges.cloudflare.com",
  "https://*.cloudflare.com",
  "https://js.hcaptcha.com",
  "https://*.hcaptcha.com",
  "https://www.geogebra.org",
  "https://*.geogebra.org",
] as const;

function isNonProductionRuntime(): boolean {
  return process.env.NODE_ENV !== "production";
}

export function createCspNonce(): string {
  return crypto.randomBytes(16).toString("base64url");
}

export function ensureCspNonce(res: Response): string {
  if (!res.locals.cspNonce) {
    res.locals.cspNonce = createCspNonce();
  }
  return res.locals.cspNonce;
}

export function resolveCspSurface(pathname: string): CspSurface {
  const normalized = pathname.split("?")[0] || "/";
  if (normalized === "/api-docs" || normalized.startsWith("/api-docs/")) {
    return "docs";
  }

  // API JSON and non-document endpoints still get a tight default policy header.
  if (
    normalized === "/api" ||
    normalized.startsWith("/api/") ||
    normalized === "/health" ||
    normalized.startsWith("/health/") ||
    normalized.startsWith("/cdn-cgi/")
  ) {
    return "default";
  }

  return "spa";
}

function nonceSource(_req: Request, res: Response): string {
  return `'nonce-${ensureCspNonce(res)}'`;
}

function buildConnectSrc(): string[] {
  if (isNonProductionRuntime()) {
    return [...PRODUCTION_CONNECT_HOSTS, ...DEVELOPMENT_CONNECT_HOSTS];
  }
  return [...PRODUCTION_CONNECT_HOSTS];
}

/**
 * Production-compatible CSP:
 * - script-src: nonce only (no unsafe-inline / unsafe-eval)
 * - style-src / style-src-elem: unsafe-inline for runtime-injected UI and Swagger styles
 * - style-src-attr: unsafe-inline kept for React style props + Swagger SVG attrs
 * - script-src-attr: none (blocks inline event handlers)
 */
type HelmetCspDirectiveValue =
  | string
  | ((req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => string);

/**
 * Helmet CSP directives. Callback form uses IncomingMessage/ServerResponse so the
 * return type is assignable to helmet's ContentSecurityPolicyDirectives.
 */
export function buildHelmetCspDirectives(): Record<string, Iterable<HelmetCspDirectiveValue>> {
  const asHttpNonceSource = (
    _req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): string => {
    const expressRes = res as unknown as Response;
    return `'nonce-${ensureCspNonce(expressRes)}'`;
  };

  const asHttpStyleElementSource = (
    _req: import("node:http").IncomingMessage,
    _res: import("node:http").ServerResponse,
  ): string => {
    return "'unsafe-inline'";
  };

  // GEO-17：只有 `/geogebra/share/:slug?embed=1` 这一条只读嵌入路径允许被 iframe，
  // 其余页面继续 frame-ancestors 'none'。策略与 X-Frame-Options 的摘除共用
  // security/embedFramePolicy.ts，避免两处口径漂移。
  const asFrameAncestorsSource = (
    req: import("node:http").IncomingMessage,
  ): string => {
    const url = String((req as { originalUrl?: string; url?: string }).originalUrl ?? req.url ?? "");
    const ancestors = geoGebraEmbedFrameAncestorsForUrl(url);
    return ancestors ? ancestors.join(" ") : "'none'";
  };

  return {
    defaultSrc: ["'self'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: [asFrameAncestorsSource],
    objectSrc: ["'none'"],
    imgSrc: ["'self'", "data:", "blob:", "https:"],
    // Frontend bundles may inline woff2 as data URLs.
    fontSrc: ["'self'", "data:", "https://fonts.gstatic.com", "https://fonts.googleapis.com"],
    // 'wasm-unsafe-eval'：只放行 WebAssembly 的编译/实例化，不放行 JS eval。
    // trycap（Cap）的 PoW 求解器是 WASM，缺这一条时浏览器直接拦掉 WebAssembly.compile
    // （控制台报 "because 'unsafe-eval' is not an allowed source of script"），
    // 控件只能退化到约慢 10 倍的 JS 求解器，hashwx 挑战更是无解。
    //
    // 'strict-dynamic'：GeoGebra 的加载器链是「我们自己 nonce 过的 bundle → deployggb.js →
    // web3d-0.js → 运行时内联脚本」，后半段全是运行时动态插入、不带 nonce 的内联脚本。
    // 没有 strict-dynamic 时它们一律被 script-src-elem 拦掉（实测报错：
    // "Executing inline script violates ... script-src-elem"，调用栈在 web3d-0.js 里）。
    // 可选方案只有三个：unsafe-inline（会一并放行注入的内联脚本，等于是把 XSS 防线拆了）、
    // 逐个脚本加 hash（内容是运行时生成的，GeoGebra 一发新版就失效）、或者 strict-dynamic。
    // strict-dynamic 的信任链正好对应上面这条链：nonce 过的 bundle 插入的脚本被信任，
    // 被信任的脚本再插入的脚本也被信任，而页面里凭空出现的内联脚本（注入）依然被拦。
    // 代价要说清：支持 CSP3 的浏览器里 script-src 的 host 名单会被忽略（名单保留作为 CSP2 回退），
    // 所以这里实际信任的是「我们自己的 bundle + 它加载的第三方控件代码」，而不是 host 白名单。
    scriptSrc: ["'self'", "'wasm-unsafe-eval'", "'strict-dynamic'", asHttpNonceSource, ...THIRD_PARTY_SCRIPT_HOSTS],
    scriptSrcElem: ["'self'", "'wasm-unsafe-eval'", "'strict-dynamic'", asHttpNonceSource, ...THIRD_PARTY_SCRIPT_HOSTS],
    scriptSrcAttr: ["'none'"],
    styleSrc: ["'self'", asHttpStyleElementSource, ...THIRD_PARTY_STYLE_HOSTS],
    styleSrcElem: ["'self'", asHttpStyleElementSource, ...THIRD_PARTY_STYLE_HOSTS],
    // Required for React runtime style props and Swagger UI SVG style attributes.
    styleSrcAttr: ["'unsafe-inline'"],
    connectSrc: buildConnectSrc(),
    frameSrc: [...FRAME_HOSTS],
    childSrc: [...FRAME_HOSTS],
    workerSrc: ["'self'", "blob:"],
    mediaSrc: ["'self'", "blob:", "data:"],
    upgradeInsecureRequests: [],
  };
}

/**
 * Materialize helmet-style directive functions into a CSP header string for tests/audits.
 * Surface metadata does not narrow style sources; script nonces remain mandatory.
 */
export function renderCspHeaderValue(
  resLocals: { cspNonce?: string; cspSurface?: CspSurface } = {},
  options: { path?: string; nodeEnv?: string } = {},
): string {
  const previousNodeEnv = process.env.NODE_ENV;
  if (options.nodeEnv !== undefined) {
    process.env.NODE_ENV = options.nodeEnv;
  }

  try {
    const rawPath = options.path || "/";
    const req = { path: rawPath, url: rawPath, originalUrl: rawPath } as Request;
    const res = { locals: { ...resLocals } } as Response;
    if (!res.locals.cspSurface) {
      res.locals.cspSurface = resolveCspSurface(req.path);
    }
    if (!res.locals.cspNonce) {
      ensureCspNonce(res);
    }

    const directives = buildHelmetCspDirectives();
    const parts: string[] = [];

    for (const [camelKey, values] of Object.entries(directives)) {
      const headerName = camelKey.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
      if (!Array.isArray(values) || values.length === 0) {
        // Empty array directives (e.g. upgradeInsecureRequests) are flag-only.
        parts.push(headerName);
        continue;
      }

      const resolved = values.map((value) => (typeof value === "function" ? value(req, res) : value));
      parts.push(`${headerName} ${resolved.join(" ")}`);
    }

    return parts.join("; ");
  } finally {
    if (options.nodeEnv !== undefined) {
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = previousNodeEnv;
      }
    }
  }
}

export function applyCspNonceToHtml(html: string, nonce: string): string {
  if (!html || !nonce) {
    return html;
  }

  const safeNonce = nonce.replace(/"/g, "");
  return html
    .replace(/<script\b(?![^>]*\bnonce=)([^>]*)>/gi, `<script nonce="${safeNonce}"$1>`)
    .replace(/<style\b(?![^>]*\bnonce=)([^>]*)>/gi, `<style nonce="${safeNonce}"$1>`)
    .replace(/<link\b([^>]*\brel=["']stylesheet["'][^>]*)>/gi, (match, attrs: string) => {
      if (/\bnonce=/.test(attrs)) {
        return match;
      }
      return `<link nonce="${safeNonce}"${attrs}>`;
    });
}

export function summarizeCspHeader(headerValue: string | string[] | undefined): {
  hasUnsafeEval: boolean;
  hasScriptUnsafeInline: boolean;
  hasStyleElemUnsafeInline: boolean;
  hasStyleAttrUnsafeInline: boolean;
  hasNonce: boolean;
  hasScriptNonce: boolean;
  /** 是否启用 strict-dynamic（GeoGebra 等第三方加载器运行时插入脚本所必需）。 */
  hasStrictDynamic: boolean;
} {
  const raw = Array.isArray(headerValue) ? headerValue.join(",") : headerValue || "";
  const lower = raw.toLowerCase();

  const scriptSrcMatch = lower.match(/(?:^|;)\s*script-src\s+([^;]*)/);
  const scriptSrc = scriptSrcMatch?.[1] || "";
  const styleSrcMatch = lower.match(/(?:^|;)\s*style-src(?:-elem)?\s+([^;]*)/);
  const styleSrc = styleSrcMatch?.[1] || "";
  const styleAttrMatch = lower.match(/(?:^|;)\s*style-src-attr\s+([^;]*)/);
  const styleAttr = styleAttrMatch?.[1] || "";

  return {
    hasUnsafeEval: /'unsafe-eval'/.test(lower),
    hasScriptUnsafeInline: /'unsafe-inline'/.test(scriptSrc),
    hasStyleElemUnsafeInline: /'unsafe-inline'/.test(styleSrc),
    hasStyleAttrUnsafeInline: /'unsafe-inline'/.test(styleAttr),
    hasNonce: /'nonce-/.test(lower),
    hasScriptNonce: /'nonce-/.test(scriptSrc),
    hasStrictDynamic: /'strict-dynamic'/.test(scriptSrc),
  };
}
