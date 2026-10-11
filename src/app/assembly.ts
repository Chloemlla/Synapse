import fs from "node:fs";
import path, { join } from "node:path";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import compression from "compression";
import helmet from "helmet";
import { config, startupConfig } from "../config/config";
import {
  corsHeadersMiddleware,
  corsPreflightHandler,
  globalCors,
  openCorsHeadersMiddleware,
  openCorsPreflightHandler,
} from "../middleware/corsMiddleware";
import { passkeyErrorHandler } from "../middleware/passkeyAutoFix";
import { requestProfilingMiddleware } from "../middleware/requestProfiling";
import { requestIdMiddleware } from "../middleware/requestId";
import { regionGuard } from "../middleware/regionGuard";
import { honeypotMiddleware } from "../security/honeypot";
import {
  audioFileLimiter,
  frontendLimiter,
  globalDefaultLimiter,
  notFoundLimiter,
  rootLimiter,
  staticFileLimiter,
} from "../middleware/routeLimiters";
import {
  assertRouteGovernance,
  earlyRouteModules,
  isExemptNonApiRoutePath,
  NON_API_ROUTE_EXEMPTION_PATHS,
  postTamperRouteModules,
  preDocsRouteModules,
  preParserRouteModules,
  preTamperRouteModules,
  registerRouteModules,
  routeLimiterModules,
} from "../routes";
import { legacyApiRedirectMiddleware } from "../routes/legacyApiRedirect";
import {
  applyCspNonceToHtml,
  buildHelmetCspDirectives,
  ensureCspNonce,
  resolveCspSurface,
} from "../security/contentSecurityPolicy";
import { registerSecurityPipeline } from "../security/securityPipeline";
import logger from "../utils/logger";
import { sanitizeLogValue } from "../utils/requestLogSanitizer";
import { parseTrustProxySetting } from "../utils/trustProxy";
import cloudflareChallengeRoutes from "../routes/cloudflareChallengeRoutes";

declare global {
  namespace Express {
    interface Request {
      isLocalIp?: boolean;
    }
  }
}

const audioDir = path.join(__dirname, "../finish");
const assemblyNonApiRouteExemptionSet = new Set<string>(NON_API_ROUTE_EXEMPTION_PATHS);

/**
 * PERF-01: 源站响应压缩。`compression` 依赖的 `compressible` 把 `text/event-stream`
 * 判为可压缩，一旦压缩就会把分块缓冲成一次性响应，SSE（`/api/librechat/**` 的流式端点，
 * 见 src/routes/libreChatRoutes.ts）会退化为"等全部生成完才出数据"。
 *
 * 同时必须跳过 206 / 带 Content-Range 的响应：`compression` 不检查分块语义，而
 * `express.static`（含 /static/audio 的音频文件）会按 Range 请求回 206，对它压缩会让
 * `Content-Range` 的偏移量与实体体（gzip 后）不再对应，浏览器音频 seek 会取到错位数据。
 *
 * 其余沿用 compression 的默认 filter（仅按 mime 判定可压缩性）；阈值(1kb)、HEAD、
 * 204/304、已带 Content-Encoding、Cache-Control: no-transform 由中间件自身处理。
 */
const SSE_CONTENT_TYPE = "text/event-stream";
const shouldCompressResponse = (req: Request, res: Response): boolean => {
  if (res.statusCode === 206 || res.getHeader("Content-Range") !== undefined) {
    return false;
  }
  const contentType = res.getHeader("Content-Type");
  if (typeof contentType === "string" && contentType.toLowerCase().includes(SSE_CONTENT_TYPE)) {
    return false;
  }
  return compression.filter(req, res);
};

function assertAssemblyNonApiRoutePath(routePath: string): void {
  if (!isExemptNonApiRoutePath(routePath)) {
    throw new Error(
      `[assembly] Non-API route "${routePath}" is not in the explicit exemption list: ${Array.from(assemblyNonApiRouteExemptionSet).join(", ")}`,
    );
  }
}

const authCacheBypassPaths = [
  "/api/totp/status",
  "/api/passkey/credentials",
  "/api/passkey/authenticate/start",
  "/api/passkey/authenticate/finish",
  "/api/passkey/register/start",
  "/api/passkey/register/finish",
  "/api/auth/me",
  "/api/auth/logout",
  "/api/auth/login",
  "/api/auth/register",
  "/api/oauth/authorize",
  "/api/oauth/token",
  "/api/oauth/userinfo",
  "/api/oauth/introspect",
  "/api/oauth/revoke",
];

// Node 在双栈监听下把 IPv4 连接报成 ::ffff:127.0.0.1 形态，需要先还原成裸 IPv4 再比对。
const IPV4_MAPPED_PREFIX = "::ffff:";

const isLoopbackAddress = (ip: string): boolean => ip === "::1" || ip.startsWith("127.");

// 私有网段只在开发环境算本机：isLocalIp 命中即豁免限流，生产环境把同内网/同 Docker
// 网络的来源全按本机放行等于限流整体失效。
const isPrivateIpv4Address = (ip: string): boolean =>
  ip.startsWith("10.") || ip.startsWith("192.168.") || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);

const isLocalIp = (req: Request, _res: Response, next: NextFunction) => {
  // G1-33: 原实现在 development 分支硬编码 false（开发环境等于不做本机判断），非 dev 分支
  // 又拿 ::ffff:127.0.0.1 去比 config.localIps（127.0.0.1 / ::1），结果 IPv4
  // 回环永不命中、IPv6 回环命中，两种回环行为相反。
  // 只取 TCP 层地址：trust proxy 打开后 req.ip 可被 X-Forwarded-For 伪造。
  const rawSocketIp = req.socket.remoteAddress || "";
  const socketIp = rawSocketIp.startsWith(IPV4_MAPPED_PREFIX)
    ? rawSocketIp.slice(IPV4_MAPPED_PREFIX.length)
    : rawSocketIp;
  // 带转发头的回环连接是反代转发来的远端请求，不算本机：反代与后端同机时 socket 地址恒为
  // 回环，只看回环会把所有限流器一起豁免掉。转发头只能让结果更严格，伪造它拿不到豁免。
  const forwarded = req.headers["x-forwarded-for"] ?? req.headers["x-real-ip"];
  const isDevelopment = process.env.NODE_ENV === "development" || process.env.NODE_ENV === "dev";

  req.isLocalIp =
    socketIp.length > 0 &&
    forwarded === undefined &&
    (isLoopbackAddress(socketIp) ||
      config.localIps.includes(socketIp) ||
      (isDevelopment && isPrivateIpv4Address(socketIp)));
  next();
};

// G1-26: 开发环境曾把完整 headers/body 倒进日志。即使敏感键已脱敏，剩下的
// 字段（邮箱、昵称、地址、UA 全文）仍是 PII，且日志会落盘留存。
const REQUEST_LOG_HEADER_ALLOWLIST = ["content-type", "content-length", "user-agent", "accept-language"] as const;

const pickAllowlistedHeaders = (headers: Request["headers"]): Record<string, string> => {
  const picked: Record<string, string> = {};
  for (const name of REQUEST_LOG_HEADER_ALLOWLIST) {
    const value = headers[name];
    if (typeof value === "string") {
      picked[name] = value;
    }
  }
  return picked;
};

const requestLogger = (req: Request, _res: Response, next: NextFunction) => {
  if (process.env.NODE_ENV === "development" || process.env.VERBOSE_LOGGING === "true") {
    // 需要整份请求体排查问题时显式开 VERBOSE_REQUEST_DUMP=true，默认不落 PII。
    const meta: Record<string, unknown> =
      process.env.VERBOSE_REQUEST_DUMP === "true"
        ? { ip: req.ip, headers: sanitizeLogValue(req.headers), body: sanitizeLogValue(req.body) }
        : { ip: req.ip, headers: pickAllowlistedHeaders(req.headers) };
    logger.info(`收到请求: ${req.method} ${req.url}`, meta);
  } else if (process.env.ACCESS_LOG_ENABLED === "true") {
    logger.info(`${req.method} ${req.url}`, { ip: req.ip });
  }
  next();
};

const frontendCandidates = [
  process.env.FRONTEND_DIST_DIR && path.resolve(process.env.FRONTEND_DIST_DIR),
  join(__dirname, "../frontend/dist"),
  join(__dirname, "../../frontend/dist"),
  path.resolve(process.cwd(), "frontend/dist"),
].filter(Boolean) as string[];

const ensureAudioDir = () => {
  if (!fs.existsSync(audioDir)) {
    fs.mkdirSync(audioDir, { recursive: true });
  }
};

const applyNoCacheHeaders = (_req: Request, res: Response, next: NextFunction) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.removeHeader?.("ETag");
  next();
};

// 不可变缓存策略：Vite 使用 [name].[hash].[ext] 命名，
// hashed 资源用 1 年 immutable；HTML 永远 no-cache 以便部署后立即拿到新 shell。
const HASHED_FILE_RE = /\.[A-Za-z0-9_-]{6,}\.(?:js|mjs|cjs|css|woff2?|ttf|otf|eot|svg|png|jpe?g|gif|webp|avif|ico|map)$/i;

const applyStaticCacheHeaders = (res: Response, filePath: string): void => {
  if (/\.html?$/i.test(filePath)) {
    res.set("Cache-Control", "no-cache, must-revalidate");
    return;
  }
  if (HASHED_FILE_RE.test(filePath) || /[\\/]assets[\\/]/.test(filePath)) {
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    return;
  }
  res.set("Cache-Control", "public, max-age=3600");
};

const getFrontendFallbackHtml = (expected: string, nonce?: string) => {
  const html = `<!doctype html>
<html lang="zh-CN">
  <head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>Synapse API</title>
    <style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;padding:40px;line-height:1.6}.card{max-width:680px;margin:0 auto;border:1px solid #e5e7eb;border-radius:12px;padding:24px;box-shadow:0 4px 14px rgba(0,0,0,.08)}h1{margin:0 0 12px;font-size:24px}a{color:#3b82f6;text-decoration:none}code{background:#f3f4f6;padding:2px 6px;border-radius:6px}</style>
  </head>
  <body><div class="card"><h1>Synapse 后端已启动</h1><p>未检测到前端构建文件。您仍可通过 Swagger 访问 API 文档：</p>
    <ul><li><a href="/api-docs">Swagger UI</a></li><li><a href="/api/openapi.json">Swagger JSON</a></li></ul>
    <p>如果需要启用前端，请设置环境变量 <code>FRONTEND_DIST_DIR</code> 或将构建产物放到以下任一路径：<br/><small>${expected}</small></p>
  </div></body>
</html>`;
  return nonce ? applyCspNonceToHtml(html, nonce) : html;
};

function resolveStaticDirectory(candidates: string[], requiredFiles: string[]): string | undefined {
  return candidates.find((candidate) => {
    try {
      const stats = fs.statSync(candidate);
      if (!stats.isDirectory()) {
        return false;
      }

      return requiredFiles.every((requiredFile) => fs.statSync(join(candidate, requiredFile)).isFile());
    } catch (_error) {
      return false;
    }
  });
}

export function registerCoreMiddleware(app: Express): void {
  app.set("trust proxy", parseTrustProxySetting());

  // G1-07: 安全响应头（CSP nonce + helmet + 去 Server/X-Powered-By）提到最前，
  // 使 pre-parser 路由（/health、/api/health、/status、/api/webhooks/*、
  // /api/data-collection/*）以及 IP 封禁 403 / 限流 429 响应都带上安全头。
  // globalCors 仍保持后置（registerSecurityMiddleware），避免在 open-CORS 路由
  // 处理器（/api/turnstile/verify-token 等）之前短路预检，也避免 data-collection
  // 被白名单外 Origin 拦截。
  app.use((req, res, next) => {
    res.locals.cspSurface = resolveCspSurface(req.path);
    ensureCspNonce(res);
    next();
  });
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: buildHelmetCspDirectives(),
      },
      hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
      noSniff: true,
      referrerPolicy: { policy: "strict-origin-when-cross-origin" },
      xssFilter: true,
      frameguard: { action: "deny" },
      crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
      crossOriginResourcePolicy: { policy: "cross-origin" },
    }),
  );
  app.use((_req, res, next) => {
    res.removeHeader("X-Powered-By");
    res.removeHeader("Server");
    next();
  });

  // PERF-01: 压缩放在所有业务路由之前，使 SPA shell、express.static 产物、
  // 以及所有 res.json() / 错误响应都走同一条压缩路径。helmet 在前不受影响。
  app.use(compression({ filter: shouldCompressResponse }));

  assertAssemblyNonApiRoutePath("/s/*path");
  app.options("/s/*path", corsPreflightHandler);
  app.use("/s/*path", corsHeadersMiddleware);

  // 健康模块挂在 preParser 阶段，位于 globalCors（registerSecurityMiddleware）之前，
  // 所以拿不到全局 CORS 头。而前端副本（Vercel: synapse.chloemlla.com）会跨源调用
  // 其中的公开端点：POST /api/health/frontend-visit 带 X-Requested-With 与
  // credentials:include，会先发 OPTIONS 预检 —— 不在这里补白名单 CORS，浏览器直接
  // 报 “No 'Access-Control-Allow-Origin' header”，通知永远发不出去。
  // 用 corsPreflightHandler + corsHeadersMiddleware（白名单）而不是 globalCors：
  // 与 /s/*path、/api/shorturl/*path 一致，白名单外 Origin 只是拿不到头，不会被 500。
  app.options("/api/health", corsPreflightHandler);
  app.options("/api/health/*path", corsPreflightHandler);
  app.use("/api/health", corsHeadersMiddleware);

  registerSecurityPipeline(app, "preBodyParser");
  registerRouteModules(app, preParserRouteModules);

  app.use(requestIdMiddleware);
  app.use(requestProfilingMiddleware);
  app.use(express.json({
    limit: "10mb",
    verify: (req, _res, buf) => {
      // G1-34: 拒绝 JSON 载荷里的 __proto__（原型污染向量）。body-parser 的
      // JSON.parse 默认不过滤该键，后续若被 merge/assign 会污染 Object.prototype。
      // 先做 Buffer 原生快速扫描，命中后才转字符串正则确认，避免大请求体重复转换。
      if (buf.length > 0 && buf.includes('"__proto__"') && /"__proto__"\s*:/.test(buf.toString("utf8"))) {
        const err: any = new Error("Prototype pollution payload rejected");
        err.status = 400;
        err.statusCode = 400;
        throw err;
      }
      // Preserve raw bytes only for the signed surfaces (nexai-sig-v2 / cdict-sig-v1 / lumen-sig-v1).
      // Copying the buffer for every request wastes CPU and memory; all other
      // routes only need the parsed JSON body. req.url is path + optional query.
      if (
        req.url?.startsWith("/api/nexai") ||
        req.url?.startsWith("/api/cdict") ||
        req.url?.startsWith("/api/lumen")
      ) {
        (req as any).rawBody = Buffer.from(buf);
      }
    },
  }));
  app.use(express.urlencoded({
    extended: true,
    limit: "10mb",
    verify: (req, _res, buf) => {
      // /api/cdict/translate also accepts form-urlencoded and cdict-sig-v1 signs raw bytes.
      if (req.url?.startsWith("/api/cdict")) {
        (req as any).rawBody = Buffer.from(buf);
      }
    },
  }));
}

export function registerSecurityMiddleware(app: Express): void {
  registerSecurityPipeline(app, "preBodyParser");

  // RC-13：地区限制闸门。放在 IP 封禁/审计相位（preBodyParser）之后、body 解析之前——
  // 命中的请求不该再付出解析与后续安全组件的成本；也便于它只读缓存而不需要 body。
  app.use(regionGuard);

  registerSecurityPipeline(app, "postBodyParser");

  if (startupConfig.security.wafEnabled) {
    logger.info("[WAF] 已启用");
  } else {
    logger.info("[WAF] 已通过 WAF_ENABLED=false 禁用");
  }

  app.use(globalCors);
  app.use(isLocalIp);
  app.use(requestLogger);
}

export function registerApiRoutes(app: Express): void {
  assertRouteGovernance();

  app.options("/api/shorturl/*path", corsPreflightHandler);
  app.use("/api/shorturl/*path", corsHeadersMiddleware);

  app.options("/api/turnstile/verify-token", openCorsPreflightHandler);
  app.options("/api/turnstile/public-turnstile", openCorsPreflightHandler);
  app.use("/api/turnstile/verify-token", openCorsHeadersMiddleware);
  app.use("/api/turnstile/public-turnstile", openCorsHeadersMiddleware);

  app.use(authCacheBypassPaths, applyNoCacheHeaders);

  // RC-42：蜜罐端点（`/api/v1/*`、`/api/debug/*` 已核实空闲）。
  // 必须在 SPA 兜底之前挂，且已在 securityBypassPolicy 里登记 ipBan / ipVerification 绕过 ——
  // 否则一个被封 IP 的扫描器会在 ipBanCheck 就被拦下，蜜罐永远触不到（分不清“没人扫”与“扫了但被前置拦了”）。
  app.use(honeypotMiddleware);

  registerRouteModules(app, earlyRouteModules);
  registerRouteModules(app, routeLimiterModules);
  registerRouteModules(app, preDocsRouteModules);

  registerRouteModules(app, preTamperRouteModules);
  registerSecurityPipeline(app, "prePostTamperRoutes");

  registerRouteModules(app, postTamperRouteModules);
  app.use(legacyApiRedirectMiddleware);

  logger.info("[NexAI] 鉴权路由已挂载 /api/nexai");
  logger.info("[NexAI Security] 安全路由已挂载 /api/nexai/security");
}

export function registerStaticRoutes(app: Express): void {
  app.use("/cdn-cgi", cloudflareChallengeRoutes);

  ensureAudioDir();
  if (process.env.TTS_PUBLIC_STATIC_AUDIO_ENABLED === "true") {
    app.use(
      "/static/audio",
      audioFileLimiter,
      express.static(audioDir, {
        setHeaders: (res) => {
          res.set("Cross-Origin-Resource-Policy", "cross-origin");
          res.set("Access-Control-Allow-Origin", "*");
          // PERF-06: TTS 产物文件名唯一（`tts_<ts>_<rand>`，见 src/tts/tts.storage.ts），
          // 同一 URL 的内容不会再变，可以长期强缓存；ETag/Last-Modified 仍作兜底。
          res.set("Cache-Control", "public, max-age=31536000, immutable");
        },
      }),
    );
  } else {
    app.use("/static/audio", audioFileLimiter, (_req, res) => {
      res.status(410).json({
        success: false,
        error: "Public static audio access is disabled. Use authorized TTS asset URLs.",
        code: "TTS_PUBLIC_AUDIO_DISABLED",
      });
    });
  }

  const serveFrontend = process.env.SERVE_FRONTEND !== "false";
  if (!serveFrontend) {
    logger.info("[Frontend] Static hosting disabled via SERVE_FRONTEND=false");
    return;
  }

  const resolvedFrontendPath = resolveStaticDirectory(frontendCandidates, ["index.html"]);
  if (resolvedFrontendPath) {
    logger.info(`[Frontend] Serving static files from: ${resolvedFrontendPath}`);
    // Read index.html once at startup instead of hitting the disk on every SPA
    // request. Per-request only the CSP nonce is injected into the cached shell.
    const indexPath = join(resolvedFrontendPath, "index.html");
    let cachedIndexHtml: string | null = null;
    try {
      cachedIndexHtml = fs.readFileSync(indexPath, "utf8");
    } catch (error) {
      logger.error("[Frontend] Failed to read index.html at startup", {
        path: indexPath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const frontendStaticOptions = {
      setHeaders: (res: Response, filePath: string) => applyStaticCacheHeaders(res, filePath),
    };
    // PERF-13: `/static` 挂载必须排在根挂载之前。生产构建的 base 是 `/static/`，所有
    // 哈希资源都走 `/static/assets/*`：先跑根挂载就是“限流 + 一次注定落空的 fs 探测”，
    // 落空后才轮到 `/static` 挂载真正命中 —— 每个资源请求因此被限流两次（原先就是两次
    // Redis 计数）且多一次 stat。先挂 `/static`：命中即响应，根挂载不再参与。
    app.use("/static", staticFileLimiter, express.static(resolvedFrontendPath, frontendStaticOptions));
    app.use(staticFileLimiter, express.static(resolvedFrontendPath, { index: false, ...frontendStaticOptions }));
    // PERF-07: 启动时把 nonce 注一次（写成占位符），每请求只做一次 split/join；
    // 原先每请求都要对整份 shell 跑 3 条正则（script / style / stylesheet link）。
    const CSP_NONCE_PLACEHOLDER = "{{SYNAPSE_CSP_NONCE}}";
    const cspNonceTemplate =
      cachedIndexHtml === null ? null : applyCspNonceToHtml(cachedIndexHtml, CSP_NONCE_PLACEHOLDER);
    const renderShellWithNonce = (nonce: string): string =>
      cspNonceTemplate === null ? "" : cspNonceTemplate.split(CSP_NONCE_PLACEHOLDER).join(nonce.replace(/"/g, ""));
    const sendIndexHtml = (_req: Request, res: Response) => {
      const nonce = ensureCspNonce(res);
      if (cspNonceTemplate === null || cachedIndexHtml === null) {
        res.status(500).type("text/plain").send("Frontend shell unavailable");
        return;
      }
      res.set("Cache-Control", "no-cache, must-revalidate");
      res.set("Content-Type", "text/html; charset=utf-8");
      res.status(200).send(renderShellWithNonce(nonce));
    };
    app.get("/", rootLimiter, sendIndexHtml);
    // /api-docs is an SPA route (embedded Swagger UI); only /api itself and the
    // raw spec paths stay backend-owned.
    app.get(/^\/(?!\.well-known(?:\/|$)|api(?:\/|$)|docs(?:\/|$)|static|assets(?:\/|$)|openapi)(.*)/, frontendLimiter, sendIndexHtml);
    return;
  }

  const expected = frontendCandidates.join(" | ");
  logger.warn(`[Frontend] 在任何候选路径中均未找到前端文件。已尝试：${expected}`);
  app.get("/index.html", (req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(getFrontendFallbackHtml(expected, ensureCspNonce(res)));
  });
}

export function registerErrorHandlers(app: Express): void {
  app.use(globalDefaultLimiter);

  app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    if (err instanceof SyntaxError && "body" in err) {
      logger.warn("JSON parse error", {
        ip: req.ip || req.connection.remoteAddress,
        path: req.path,
        method: req.method,
        userAgent: req.headers["user-agent"],
        error: err.message,
      });
      return res.status(400).json({ error: "无效的JSON格式" });
    }
    next(err);
  });

  app.use(passkeyErrorHandler);

  app.use((err: any, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      return next(err);
    }

    const statusCode = Number(err?.statusCode || err?.status || 500);
    const safeStatusCode = statusCode >= 400 && statusCode < 600 ? statusCode : 500;
    logger.error("Unhandled request error", {
      path: req.path,
      method: req.method,
      ip: req.ip,
      error: err instanceof Error ? err.message : String(err),
      stack: process.env.NODE_ENV === "production" ? undefined : err?.stack,
    });

    return res.status(safeStatusCode).json({
      error: safeStatusCode >= 500 ? "Internal Server Error" : err?.message || "Request failed",
    });
  });

  app.use(notFoundLimiter, (req: Request, res: Response) => {
    logger.warn(`404 Not Found: ${req.method} ${req.url}`, {
      ip: req.ip,
      headers: pickAllowlistedHeaders(req.headers),
    });
    res.status(404).json({ error: "Not Found" });
  });
}
