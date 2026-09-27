import cors from "cors";
import type { NextFunction, Request, Response } from "express";

// 允许的域名（白名单，不使用通配符）
const allowedOrigins = [
  "https://chloemlla.com",
  // Vercel 上的前端副本（前端构建把 API base 定到 apex，故为跨源调用）。
  // 与 apex 同 site，SameSite=Lax 的会话 cookie 在 same-site 请求上仍会发送。
  "https://synapse.chloemlla.com",
  ...(process.env.NODE_ENV === "development" || process.env.NODE_ENV === "dev"
    ? [
        "http://192.168.10.7:3001",
        "http://localhost:3000",
        "http://localhost:6000",
        "http://localhost:6001",
        "http://localhost:3002",
        "http://127.0.0.1:3001",
        "http://127.0.0.1:6000",
        "http://127.0.0.1:6001",
        "http://192.168.137.1:3001",
        "http://192.168.137.1:6000",
        "http://192.168.137.1:6001",
        "http://192.168.10.7:6000",
        "http://192.168.10.7:6001",
      ]
    : []),
];

const CORS_METHODS = "GET, POST, PUT, DELETE, OPTIONS, PATCH";
const CORS_ALLOWED_HEADERS = [
  "Content-Type",
  "Authorization",
  "X-Requested-With",
  "Accept",
  "Origin",
  "Access-Control-Request-Method",
  "Access-Control-Request-Headers",
  "Cache-Control",
  "X-Fingerprint",
  "X-IP-Verification-Token",
  "X-Turnstile-Token",
];
const CORS_EXPOSED_HEADERS = [
  "Content-Length",
  "X-RateLimit-Limit",
  "X-RateLimit-Remaining",
  "Content-Disposition",
  "Content-Type",
  "Cache-Control",
];

function matchesOriginPattern(origin: string, pattern: string): boolean {
  if (!pattern) return false;
  if (pattern === origin) return true;

  const match = pattern.match(/^(\*|https?:\/\/\*\.)?([a-zA-Z0-9-]+\.[a-zA-Z0-9.-]+)$/);
  if (!match) return false;

  const protocolPrefix = pattern.startsWith("https://")
    ? "https://"
    : pattern.startsWith("http://")
      ? "http://"
      : "";
  const hostPattern = protocolPrefix ? pattern.slice(protocolPrefix.length) : pattern;

  if (!hostPattern.startsWith("*.")) return false;

  const escapedHost = hostPattern
    .slice(2)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^${protocolPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[a-zA-Z0-9-]+(?:\\.[a-zA-Z0-9-]+)*\\.${escapedHost}$`);
  return regex.test(origin);
}

/** 判断 origin 是否在白名单内（仅允许已知安全域名） */
export function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true; // 无 origin（curl/postman）放行
  if (/^https:\/\/chloemlla\.com$/.test(origin)) return true;
  if (/^https:\/\/synapse\.chloemlla\.com$/.test(origin)) return true;
  return allowedOrigins.some((allowedOrigin) => matchesOriginPattern(origin, allowedOrigin));
}

// ============ 全局 CORS 中间件（挂到 app.use） ============
export const globalCors = cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (isOriginAllowed(origin)) return callback(null, true);
    return callback(new Error("Not allowed by CORS"), false);
  },
  credentials: true,
  methods: CORS_METHODS.split(", "),
  allowedHeaders: CORS_ALLOWED_HEADERS,
  exposedHeaders: CORS_EXPOSED_HEADERS,
  maxAge: 86400,
  preflightContinue: false,
  optionsSuccessStatus: 200,
});

// ============ 路由级 CORS：基于白名单 ============
/** OPTIONS 预检处理器（用于 /s/*、/api/shorturl/* 等需要单独挂 OPTIONS 的路径） */
export function corsPreflightHandler(req: Request, res: Response) {
  const origin = req.headers.origin;
  res.header("Access-Control-Allow-Origin", isOriginAllowed(origin) ? origin || "*" : "");
  res.header("Access-Control-Allow-Methods", CORS_METHODS);
  res.header("Access-Control-Allow-Headers", CORS_ALLOWED_HEADERS.join(", "));
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Max-Age", "86400");
  res.status(200).end();
}

/** 普通请求 CORS 响应头中间件（非 OPTIONS） */
export function corsHeadersMiddleware(req: Request, res: Response, next: NextFunction) {
  const origin = req.headers.origin;
  res.header("Access-Control-Allow-Origin", isOriginAllowed(origin) ? origin || "*" : "");
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Expose-Headers", CORS_EXPOSED_HEADERS.join(", "));
  next();
}

// ============ 路由级 CORS：完全开放（origin: *，无凭据 — 遵循 CORS 规范） ============
export function openCorsPreflightHandler(_req: Request, res: Response) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", CORS_METHODS);
  res.header("Access-Control-Allow-Headers", CORS_ALLOWED_HEADERS.join(", "));
  res.header("Access-Control-Max-Age", "86400");
  res.status(200).end();
}

export function openCorsHeadersMiddleware(_req: Request, res: Response, next: NextFunction) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Expose-Headers", CORS_EXPOSED_HEADERS.join(", "));
  next();
}

// ============ 状态变更请求的 Origin 硬校验（CSRF 纵深防御）============
// F-02（2026-09-27）：敏感写接口（如 /admin/envs）走 Cookie 鉴权（authFetch credentials:'include'）。
// SameSite=Lax 已阻断跨站携 Cookie 的 POST/DELETE；此处再加一道：若带了 Origin/Referer，
// 必须在白名单内，否则直接拒绝。无 Origin（非浏览器/同源省略）不携受害者会话，放行交给鉴权。
const STATE_CHANGING_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

function originFromReferer(referer: string | undefined): string | undefined {
  if (!referer) return undefined;
  try {
    const u = new URL(referer);
    return `${u.protocol}//${u.host}`;
  } catch {
    return undefined;
  }
}

export function requireAllowedOriginForWrites(req: Request, res: Response, next: NextFunction) {
  if (!STATE_CHANGING_METHODS.has(req.method.toUpperCase())) return next();
  const origin = (req.headers.origin as string | undefined) || originFromReferer(req.headers.referer as string | undefined);
  // 没有 Origin/Referer：不是浏览器发起的跨站写（且不会携受害者 SameSite=Lax 会话 Cookie），放行。
  if (!origin) return next();
  if (isOriginAllowed(origin)) return next();
  return res.status(403).json({ error: "请求来源不在允许列表（CSRF 防护）", code: "ORIGIN_NOT_ALLOWED" });
}

export { allowedOrigins };
