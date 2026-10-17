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

/**
 * 非文档响应用的最小策略。
 *
 * 浏览器只对**文档**响应执行 CSP；给 222 字节的 JSON 附一份 3 KB 的 SPA 策略，
 * 除了把响应头撑大、把每条响应都变成不可缓存的值（nonce 每响应不同，HTTP/2
 * HPACK 无法整段复用）之外没有任何收益。这里只保留真正有意义的几条：
 * `frame-ancestors` 防嵌入、`default-src 'none'` 兜住「被当文档打开」的意外路径。
 */
const MINIMAL_DIRECTIVES = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
] as const;

/** 静态构建产物的常见后缀：命中即「这份响应不是文档」，无需下发完整策略。 */
const ASSET_PATH_PATTERN =
  /\.(?:js|mjs|cjs|css|map|json|txt|xml|woff2?|ttf|otf|eot|png|jpe?g|gif|webp|avif|svg|ico|mp3|wav|ogg|flac|m4a|mp4|webm|pdf|zip|wasm)$/i;

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

/**
 * 这份请求的结果会被浏览器当作文档渲染吗？
 *
 * `Sec-Fetch-Dest` 是浏览器写入的 forbidden header，比 `Accept` 可信；老浏览器没有
 * 这个头时退回看 `Accept: text/html`（直接导航/iframe 一定会带）。
 * 注意 fetch()/XHR 的取值是 `Sec-Fetch-Dest: empty`，服务端日志/脚本没有这两个头，
 * 它们都拿不到「文档」判定 —— 正合适，这些响应本来就不会执行脚本。
 */
function isDocumentNavigation(req: Request): boolean {
  const headers: Request["headers"] = (req as { headers?: Request["headers"] }).headers ?? {};
  const dest = headers["sec-fetch-dest"];
  if (typeof dest === "string" && dest.length > 0) {
    return (
      dest === "document" ||
      dest === "iframe" ||
      dest === "frame" ||
      dest === "embed" ||
      dest === "object"
    );
  }
  const accept = headers.accept;
  return typeof accept === "string" && /\btext\/html\b/i.test(accept);
}

/**
 * 判定是否下发最小策略。
 *
 * - `/api-docs`（Swagger）永远是文档，保持完整策略。
 * - SPA 面：只有静态产物后缀才收紧；`/login`、`/geogebra` 这类路径即使被 fetch
 *   也保持完整策略（SPA 兜底会回 shell）。
 * - API/探针面：非文档请求收紧；`/api/email/unsubscribe` 这类直接导航打开 HTML 的
 *   端点仍按文档处理，避免把页面样式/脚本一并拍死。
 */
export function shouldUseMinimalCsp(req: Request, surface: CspSurface, pathname: string): boolean {
  if (surface === "docs") {
    return false;
  }
  if (surface === "spa" && !ASSET_PATH_PATTERN.test(pathname)) {
    return false;
  }
  return !isDocumentNavigation(req);
}

function buildDocumentCsp(req: Request, res: Response): string {
  const nonce = `'nonce-${ensureCspNonce(res)}'`;
  const ancestors = geoGebraEmbedFrameAncestorsForUrl(String(req.originalUrl ?? req.url ?? "")) ?? ["'none'"];
  const connectSources = isNonProductionRuntime()
    ? [...PRODUCTION_CONNECT_HOSTS, ...DEVELOPMENT_CONNECT_HOSTS]
    : [...PRODUCTION_CONNECT_HOSTS];

  // 不再重复下发 script-src-elem / style-src-elem / child-src：
  // 它们的值与 script-src / style-src / (frame-src + worker-src) 完全相同，
  // 按 CSP 的回落链（*-elem → 对应基础指令；child-src → frame-src/worker-src）
  // 浏览器拿到的判定一模一样，白占约 1.1 KB。
  //
  // 'wasm-unsafe-eval'：只放行 WebAssembly 的编译/实例化，不放行 JS eval。
  // trycap（Cap）的 PoW 求解器是 WASM，缺这一条时浏览器直接拦掉 WebAssembly.compile
  // （控制台报 "because 'unsafe-eval' is not an allowed source of script"），
  // 控件只能退化到约慢 10 倍的 JS 求解器，hashwx 挑战更是无解。
  //
  // 'strict-dynamic'：GeoGebra 的加载器链是「我们自己 nonce 过的 bundle → deployggb.js →
  // web3d-0.js → 运行时内联脚本」，后半段全是运行时动态插入、不带 nonce 的内联脚本。
  // 没有 strict-dynamic 时它们一律被拦掉（实测报错：
  // "Executing inline script violates ... script-src-elem"，调用栈在 web3d-0.js 里）。
  // 可选方案只有三个：unsafe-inline（会一并放行注入的内联脚本，等于是把 XSS 防线拆了）、
  // 逐个脚本加 hash（内容是运行时生成的，GeoGebra 一发新版就失效）、或者 strict-dynamic。
  // strict-dynamic 的信任链正好对应上面这条链：nonce 过的 bundle 插入的脚本被信任，
  // 被信任的脚本再插入的脚本也被信任，而页面里凭空出现的内联脚本（注入）依然被拦。
  // 代价要说清：支持 CSP3 的浏览器里 script-src 的 host 名单会被忽略（名单保留作为 CSP2 回退），
  // 所以这里实际信任的是「我们自己的 bundle + 它加载的第三方控件代码」，而不是 host 白名单。
  const scriptSources = [
    "'self'",
    "'wasm-unsafe-eval'",
    "'strict-dynamic'",
    nonce,
    ...THIRD_PARTY_SCRIPT_HOSTS,
  ];
  // style-src 里同时出现 'unsafe-inline' 与 nonce 会让浏览器忽略 'unsafe-inline'，
  // 所以样式面刻意不发 nonce（framer-motion 运行时注入 + Swagger 都需要 inline）。
  const styleSources = ["'self'", "'unsafe-inline'", ...THIRD_PARTY_STYLE_HOSTS];

  return [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors ${ancestors.join(" ")}`,
    "object-src 'none'",
    "img-src 'self' data: blob: https:",
    // Frontend bundles may inline woff2 as data URLs.
    "font-src 'self' data: https://fonts.gstatic.com https://fonts.googleapis.com",
    `script-src ${scriptSources.join(" ")}`,
    "script-src-attr 'none'",
    `style-src ${styleSources.join(" ")}`,
    // Required for React runtime style props and Swagger UI SVG style attributes.
    "style-src-attr 'unsafe-inline'",
    `connect-src ${connectSources.join(" ")}`,
    `frame-src ${FRAME_HOSTS.join(" ")}`,
    "worker-src 'self' blob:",
    "media-src 'self' blob: data:",
    "upgrade-insecure-requests",
  ].join(";");
}

/**
 * 生成这一条响应要下发的 Content-Security-Policy 值。
 *
 * 由 `registerCoreMiddleware` 在请求最前面调用（不再交给 helmet 的 directive
 * 回调），这样 surface 判定与 `/static/*` 这类非文档响应能在同一处收口。
 */
export function buildCspHeaderValue(req: Request, res: Response): string {
  const surface = res.locals.cspSurface ?? resolveCspSurface(req.path);
  if (shouldUseMinimalCsp(req, surface, req.path)) {
    return MINIMAL_DIRECTIVES.join(";");
  }
  return buildDocumentCsp(req, res);
}

/**
 * Materialize the CSP header value for tests/audits without an Express request.
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
    const req = { path: rawPath, url: rawPath, originalUrl: rawPath, headers: {} } as unknown as Request;
    const res = { locals: { ...resLocals } } as Response;
    if (!res.locals.cspSurface) {
      res.locals.cspSurface = resolveCspSurface(req.path);
    }
    return buildCspHeaderValue(req, res);
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
