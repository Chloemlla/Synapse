import { createHash } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import rateLimit, { type RateLimitRequestHandler } from "express-rate-limit";
import { createSharedRateLimitStore } from "../services/sharedRateLimitStore";
import logger from "../utils/logger";
import { isTrustedCdictClient } from "./nexaiRequestSignature";

type LimiterCategory =
  | "auth"
  | "login"
  | "register"
  | "tts"
  | "tts-history"
  | "tts-jobs"
  | "transcribe"
  | "docTool"
  | "pixel"
  | "admin"
  | "verification"
  | "command"
  | "librechat"
  | "ticket"
  | "public-api"
  | "status"
  | "static"
  | "cloudflare-challenge"
  | "telemetry"
  | "global";

type RateProfileName =
  | "login"
  | "register"
  | "auth"
  | "authRead"
  | "ttsGenerate"
  | "ttsHistory"
  | "ttsJobs"
  | "admin"
  | "verification"
  | "sensitive"
  | "ticketRead"
  | "ticketWrite"
  | "ticketUpload"
  | "standard"
  | "relaxed"
  | "burst"
  | "static"
  | "global";

interface RateProfile {
  windowMs: number;
  max: number;
}

interface LimiterOptions {
  max?: number;
  windowMs?: number;
  message?: string;
  name?: string;
  category?: LimiterCategory;
  profile?: RateProfileName;
  keyGenerator?: (req: Request) => string;
  skip?: (req: Request) => boolean;
  handler?: (req: Request, res: Response, next: NextFunction) => void;
  skipFailedRequests?: boolean;
  skipSuccessfulRequests?: boolean;
  /** 强制进程内内存档（不走 Redis/Mongo 共享后端）。静态资源类默认已开启，见 PERF-12。 */
  preferMemory?: boolean;
  /**
   * 匿名请求的**第二判据**（默认开启）：除 IP 桶外，再按设备/浏览器指纹单独计一份，
   * 任一超限即拒绝。登录请求不参与（账户 ID 已是更强的身份）。
   * 见 createAnonymousFingerprintGuard：为什么必须是「两桶都算」，而不是把两者拼成一个键。
   */
  anonymousFingerprint?: boolean;
}

interface LimiterDefinition {
  profile: RateProfileName;
  category: LimiterCategory;
  message: string;
  max?: number;
  windowMs?: number;
  keyGenerator?: (req: Request) => string;
  skip?: (req: Request) => boolean;
  handler?: (req: Request, res: Response, next: NextFunction) => void;
  preferMemory?: boolean;
  /** 见 LimiterOptions.anonymousFingerprint。 */
  anonymousFingerprint?: boolean;
}

interface RateLimitMetricRecord {
  limiter: string;
  category: LimiterCategory;
  ip: string;
  route: string;
}

interface RateLimitMetricsSnapshot {
  total429Hits: number;
  byLimiter: Record<string, number>;
  byCategory: Record<string, number>;
  hotIps: Array<{ ip: string; hits: number }>;
  hotRoutes: Array<{ route: string; hits: number }>;
}

const RATE_PROFILES: Record<RateProfileName, RateProfile> = {
  login: { windowMs: 15 * 60_000, max: 10 },
  register: { windowMs: 60 * 60_000, max: 5 },
  auth: { windowMs: 60_000, max: 30 },
  authRead: { windowMs: 5 * 60_000, max: 300 },
  ttsGenerate: { windowMs: 60_000, max: 10 },
  ttsHistory: { windowMs: 60_000, max: 20 },
  ttsJobs: { windowMs: 60_000, max: 60 },
  admin: { windowMs: 60_000, max: 50 },
  verification: { windowMs: 5 * 60_000, max: 20 },
  sensitive: { windowMs: 60_000, max: 10 },
  ticketRead: { windowMs: 60_000, max: 60 },
  ticketWrite: { windowMs: 60_000, max: 10 },
  /** 附件上传/删除：写类操作，但比普通回复更贵（带二进制体），窗口放到 10 分钟。 */
  ticketUpload: { windowMs: 10 * 60_000, max: 20 },
  standard: { windowMs: 60_000, max: 30 },
  relaxed: { windowMs: 60_000, max: 60 },
  burst: { windowMs: 60_000, max: 600 },
  static: { windowMs: 60_000, max: 5000 },
  global: { windowMs: 60_000, max: 100 },
};

const isLocalRequest = (req: Request): boolean => req.isLocalIp || false;

const skipLocalAndStatusPoll = (req: Request): boolean => {
  if (req.originalUrl?.startsWith("/api/command/status")) return true;
  return isLocalRequest(req);
};

const skipLocalAndAuthSpecific = (req: Request): boolean => {
  const url = req.originalUrl?.split("?")[0] || "";
  if (url === "/api/auth/login" || url === "/api/auth/register" || url === "/api/auth/me") {
    return true;
  }
  return isLocalRequest(req);
};

/**
 * CDict tiering: an unsigned request stays on the baseline IP bucket, a request
 * with a verified cdict-sig-v1 signature moves to its own per-install bucket so
 * that users behind one carrier/campus NAT no longer share a quota.
 */
const cdictInstallKey = (req: Request): string => `install:${req.cdictClient?.installId || "unknown"}`;

const skipUnlessTrustedCdict = (req: Request): boolean => isLocalRequest(req) || !isTrustedCdictClient(req);

const skipTrustedCdict = (req: Request): boolean => isLocalRequest(req) || isTrustedCdictClient(req);

/** The two CDict routes that spend server-held upstream credentials. */
const isCdictUpstreamPath = (req: Request): boolean => {
  const path = req.originalUrl?.split("?")[0] || "";
  return path === "/api/cdict/translate" || path === "/api/cdict/tts";
};

const skipUnlessTrustedCdictUpstream = (req: Request): boolean =>
  skipUnlessTrustedCdict(req) || !isCdictUpstreamPath(req);

const skipPrivateIpReport = (req: Request): boolean => {
  const ip = req.ip || req.socket?.remoteAddress || "";
  const whitelist: (string | RegExp)[] = [
    "127.0.0.1",
    "::1",
    "localhost",
    /^10\./,
    /^192\.168\./,
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  ];
  return whitelist.some((rule) => (typeof rule === "string" ? ip === rule : rule.test(ip)));
};

class RateLimitMetricsRegistry {
  // Cap per-IP/per-route tracking to bound memory growth: under attack the key
  // space is unbounded, so once a map exceeds this many keys we evict the
  // oldest-inserted entries (Map preserves insertion order).
  private static readonly MAX_TRACKED_KEYS = 10_000;
  private total429Hits = 0;
  private readonly byLimiter = new Map<string, number>();
  private readonly byCategory = new Map<string, number>();
  private readonly byIp = new Map<string, number>();
  private readonly byRoute = new Map<string, number>();

  record(record: RateLimitMetricRecord): void {
    this.total429Hits += 1;
    this.bump(this.byLimiter, record.limiter);
    this.bump(this.byCategory, record.category);
    this.bump(this.byIp, record.ip);
    this.bump(this.byRoute, record.route);
    this.evictOverflow(this.byIp);
    this.evictOverflow(this.byRoute);
  }

  snapshot(limit = 10): RateLimitMetricsSnapshot {
    return {
      total429Hits: this.total429Hits,
      byLimiter: Object.fromEntries(this.byLimiter),
      byCategory: Object.fromEntries(this.byCategory),
      hotIps: this.topEntries(this.byIp, limit).map(([ip, hits]) => ({ ip, hits })),
      hotRoutes: this.topEntries(this.byRoute, limit).map(([route, hits]) => ({ route, hits })),
    };
  }

  private bump(map: Map<string, number>, key: string): void {
    map.set(key, (map.get(key) || 0) + 1);
  }

  private evictOverflow(map: Map<string, number>): void {
    const overflow = map.size - RateLimitMetricsRegistry.MAX_TRACKED_KEYS;
    if (overflow <= 0) return;
    let evicted = 0;
    for (const key of map.keys()) {
      if (evicted >= overflow) break;
      map.delete(key);
      evicted += 1;
    }
  }

  private topEntries(map: Map<string, number>, limit: number): Array<[string, number]> {
    return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  }
}

const rateLimitMetricsRegistry = new RateLimitMetricsRegistry();

export function getRateLimitMetricsSnapshot(limit = 10): RateLimitMetricsSnapshot {
  return rateLimitMetricsRegistry.snapshot(limit);
}

/**
 * PERF-12: 静态资源类限流器（category === "static"：`static` / `frontend` / `audio`）
 * 强制走进程内内存档，不再每个资源请求都打一次 Redis（配了 REDIS_URL 时
 * ResilientRateLimitStore 默认走 Redis，而一切 JS/CSS/字体/图片/音频都过这三道闸）。
 *
 * 理由：这三道闸的语义是“防刷”（5000/60s），不是“配额”；进程内存档已能拦单机洪水，
 * 而多实例下每实例各算一份对静态资源毫无影响。需要跨实例一致性的调用方
 * （API Key 配额等）显式走 requireSharedBackend，不受本规则影响。
 */
const STATIC_RESOURCE_CATEGORY: LimiterCategory = "static";

function createStore(prefix: string, windowMs: number, options: { preferMemory?: boolean } = {}) {
  // 只在确需内存档时传入该选项：显式传 `preferMemory: false` 会盖掉
  // createSharedRateLimitStore 内部的“未配 Redis 就默认内存”兜底，
  // 把那些限流器推回 Mongo（每请求一次 findOneAndUpdate）。
  return createSharedRateLimitStore(prefix, windowMs, options.preferMemory ? { preferMemory: true } : {});
}

function getClientIp(req: Request): string {
  return req.ip || req.socket?.remoteAddress || "unknown";
}

function getRouteHotspotKey(req: Request): string {
  const path = req.originalUrl?.split("?")[0] || req.baseUrl || req.path || "unknown";
  return `${req.method} ${path}`;
}

/**
 * RC-27：昂贵端点的**双键**限流（User ID + IP）。
 *
 * 为什么不能只用单键：
 * - 只按 IP：NAT/校园网后面的一群正常用户会被当成一个滥用者（误伤）；
 * - 只按账号：同一账号换 IP 就能把并发刷满（算力被一个人吃光）。
 * 两键组合（未登录时才降到纯 IP）才能同时挡住这两种绕法。
 */
function userIpDualKey(req: Request): string {
  const ip = getClientIp(req);
  const userId = (req as Request & { user?: { id?: string } }).user?.id;
  return userId ? `u:${userId}|${ip}` : `ip:${ip}`;
}

/** 请求携带的设备/浏览器指纹：只认请求头（`X-Fingerprint`，前端全局附带；H5 另有 `x-device-id`）。 */
const FINGERPRINT_HEADER_MAX_LENGTH = 200;

export function getRequestFingerprint(req: Request): string | null {
  const headers = req.headers as Record<string, string | string[] | undefined> | undefined;
  const raw = headers?.["x-fingerprint"] ?? headers?.["x-device-id"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "unknown" || trimmed.length > FINGERPRINT_HEADER_MAX_LENGTH) return null;
  return trimmed;
}

/**
 * 指纹是客户端自报的**凭据类标识**：限流存储里只放哈希。
 * 与审计脱敏同一口径 —— 存储与指标快照里的设备标识原文是可被导出、旁读的额外副本，
 * 而限流只需要它稳定可比较。
 */
function fingerprintBucket(fp: string): string {
  return createHash("sha256").update(fp).digest("hex").slice(0, 32);
}

/**
 * 匿名请求的第二判据：IP 与设备指纹**各自计数、任一超限即拒绝**。
 *
 * 为什么不把两者拼成一个键（`ip:<ip>|fp:<fp>`）：
 * - 拼键时换指纹或换 IP 都会得到一个全新的桶，等于给刷子发新额度；
 * - 两个独立桶才能让「同一台设备换 IP」与「同一出口换设备」都被各自那一侧拦住。
 *
 * 指纹由客户端自报，**不能单独作为判据**（伪造即绕过），它的作用是给 IP 判据补一个
 * 正交维度，而不是替代 IP。没有携带指纹的客户端（脚本、原生客户端）只有 IP 桶，
 * 行为与改动前一致。
 */
function createAnonymousFingerprintGuard(options: {
  name: string;
  windowMs: number;
  max: number;
  category: LimiterCategory;
  message: string;
  skip?: (req: Request) => boolean;
  preferMemory: boolean;
}): RateLimitRequestHandler {
  return rateLimit({
    windowMs: options.windowMs,
    max: options.max,
    message: { error: options.message },
    standardHeaders: true,
    legacyHeaders: false,
    store: createStore(`${options.name}-fp`, options.windowMs, { preferMemory: options.preferMemory }),
    validate: { unsharedStore: false },
    keyGenerator: (req: Request) => `fp:${fingerprintBucket(getRequestFingerprint(req) || "unknown")}`,
    // 只在「匿名 + 确实带了有效指纹」时才跑这一道：登录用户与无指纹客户端不进第二桶。
    skip: (req: Request): boolean => {
      if (isLocalRequest(req)) return true;
      if ((req as Request & { user?: { id?: string } }).user?.id) return true;
      if (!getRequestFingerprint(req)) return true;
      return options.skip ? options.skip(req) : false;
    },
    handler: buildDefaultHandler(`${options.name}-fp`, options.category, options.message),
  });
}

function buildDefaultHandler(name: string, category: LimiterCategory, message: string) {
  return (req: Request, res: Response) => {
    const ip = getClientIp(req);
    const route = getRouteHotspotKey(req);

    rateLimitMetricsRegistry.record({
      limiter: name,
      category,
      ip,
      route,
    });

    logger.warn(`[RateLimit] 429 ${name}`, {
      category,
      ip,
      route,
      metrics: getRateLimitMetricsSnapshot(5),
    });

    res.status(429).json({ error: message });
  };
}

let limiterCounter = 0;

export function createLimiter(opts: LimiterOptions): RateLimitRequestHandler {
  const name = opts.name || `rl_${++limiterCounter}`;
  const profile = RATE_PROFILES[opts.profile || "standard"];
  const category = opts.category || "public-api";
  const message = opts.message || "请求过于频繁，请稍后再试";
  const windowMs = opts.windowMs ?? profile.windowMs;
  const max = opts.max ?? profile.max;
  // PERF-12: 静态资源类限流器默认进程内存档，避免每个资源请求一次 Redis 往返。
  const preferMemory = opts.preferMemory ?? category === STATIC_RESOURCE_CATEGORY;

  const base = rateLimit({
    windowMs,
    max,
    message: { error: message },
    standardHeaders: true,
    legacyHeaders: false,
    store: createStore(name, windowMs, { preferMemory }),
    validate: { unsharedStore: false },
    keyGenerator: opts.keyGenerator || ((req: Request) => getClientIp(req)),
    skip: opts.skip ?? ((req: Request): boolean => isLocalRequest(req)),
    handler: opts.handler || buildDefaultHandler(name, category, message),
    ...(opts.skipFailedRequests !== undefined ? { skipFailedRequests: opts.skipFailedRequests } : {}),
    ...(opts.skipSuccessfulRequests !== undefined ? { skipSuccessfulRequests: opts.skipSuccessfulRequests } : {}),
  });

  // 匿名双判据：IP 桶放行后再过指纹桶（静态资源不参与 —— 那是防刷不是配额，
  // 给它加一次存储往返没有意义，见 PERF-12）。
  const withFingerprint = opts.anonymousFingerprint ?? category !== STATIC_RESOURCE_CATEGORY;
  if (!withFingerprint) return base;

  const fingerprintGuard = createAnonymousFingerprintGuard({
    name,
    windowMs,
    max,
    category,
    message,
    skip: opts.skip,
    preferMemory,
  });
  // RateLimitRequestHandler 不只是中间件函数，它还带 resetKey/getKey 两个方法
  // （测试与运维用它重置计数）。包装时必须一并转发，否则类型不成立，
  // 而且真正需要 resetKey 的调用方会拿到 undefined。
  const combined: RateLimitRequestHandler = Object.assign(
    (req: Request, res: Response, next: NextFunction): void => {
      base(req, res, (error?: unknown) => {
        if (error) {
          next(error);
          return;
        }
        fingerprintGuard(req, res, next);
      });
    },
    {
      // 两个桶的键空间不同（IP/账户键 vs `fp:<设备哈希>`），所以这里只按**传入的键**
      // 逐一转发：调用方清 `ip:...` 清的是 IP 桶，清 `fp:...` 清的才是指纹桶。
      // 不要在这里把 IP 键再哈希一遍——那会造出一个永远不会被命中的桶名。
      resetKey: (key: string) => {
        base.resetKey(key);
        fingerprintGuard.resetKey(key);
      },
      getKey: (key: string) => base.getKey(key),
    },
  );
  return combined;
}

// ========== RC-27：突发并发硬顶（在途请求数，而不是"窗口内次数"） ==========
//
// 固定窗口的限流器管不住「同一秒内同时打进来的 N 个昂贵请求」：额度是 10/分钟时，
// 10 个转写任务仍可在同一秒占满 runner。并发硬顶是另一条正交约束 ——
// 超顶**立即拒绝**（不排队），否则排队本身就是新的内存/连接压力（与 RC-43 同一教训）。

interface BurstConcurrencyRegistrySnapshot {
  totalActive: number;
  guards: Record<string, { active: number; keys: number; maxConcurrent: number }>;
}

class BurstConcurrencyRegistry {
  private readonly counters = new Map<string, Map<string, number>>();
  private readonly limits = new Map<string, number>();

  register(name: string, maxConcurrent: number): void {
    this.limits.set(name, maxConcurrent);
  }

  /** 占用一个槽位；返回占用后的值（> max 时调用方必须立刻 release）。 */
  acquire(name: string, key: string): number {
    let bucket = this.counters.get(name);
    if (!bucket) {
      bucket = new Map();
      this.counters.set(name, bucket);
    }
    const next = (bucket.get(key) || 0) + 1;
    bucket.set(key, next);
    return next;
  }

  release(name: string, key: string): void {
    const bucket = this.counters.get(name);
    if (!bucket) return;
    const current = bucket.get(key) || 0;
    if (current <= 1) {
      bucket.delete(key);
    } else {
      bucket.set(key, current - 1);
    }
  }

  snapshot(): BurstConcurrencyRegistrySnapshot {
    const guards: BurstConcurrencyRegistrySnapshot["guards"] = {};
    let totalActive = 0;
    for (const [name, bucket] of this.counters) {
      let active = 0;
      for (const count of bucket.values()) active += count;
      totalActive += active;
      guards[name] = { active, keys: bucket.size, maxConcurrent: this.limits.get(name) || 0 };
    }
    return { totalActive, guards };
  }

  resetForTests(): void {
    this.counters.clear();
    this.limits.clear();
  }
}

const burstConcurrencyRegistry = new BurstConcurrencyRegistry();

/** 当前在途占用（管理端/用例可查；RC-27 要求"暴露占用计数"）。 */
export function getBurstConcurrencySnapshot(): BurstConcurrencyRegistrySnapshot {
  return burstConcurrencyRegistry.snapshot();
}

/** 仅供用例清理：避免套件之间共享计数器。 */
export function resetBurstConcurrencyForTests(): void {
  burstConcurrencyRegistry.resetForTests();
}

export interface BurstConcurrencyOptions {
  name: string;
  /** 每个身份键允许的在途请求数（默认取 env 或调用方给的保守值）。 */
  maxConcurrent: number;
  /** 429 时给出的 Retry-After（秒）；只是"建议重试"提示，不承诺精确时点。 */
  retryAfterSeconds?: number;
  /** 只对这些方法生效（默认写方法）。 */
  methods?: string[];
  /** 只对这些路径生效（如只卡 translate/tts，不卡同前缀的轮询）。 */
  pathFilter?: (pathname: string) => boolean;
  keyGenerator?: (req: Request) => string;
}

/**
 * 创建并发硬顶中间件。
 *
 * 键默认沿用 RC-27 的双键口径（User ID + IP）：
 * - 只按 IP 会在 NAT 后把一群正常用户算成一个人；
 * - 只按账号则换 IP 即可并行刷。
 *
 * 注意：只统计**在途**请求，不统计后台任务；TTS 的"排队任务数"由队列自己的
 * per-user 上限负责（RC-30），两者是不同层面，别互相替代。
 */
export function createBurstConcurrencyGuard(opts: BurstConcurrencyOptions): RequestHandler {
  const methods = new Set((opts.methods ?? ["POST", "PUT", "PATCH"]).map((m) => m.toUpperCase()));
  const maxConcurrent = Math.max(1, Math.floor(opts.maxConcurrent) || 1);
  const retryAfterSeconds = Math.max(1, Math.floor(opts.retryAfterSeconds ?? 2));
  const keyGenerator = opts.keyGenerator || userIpDualKey;
  burstConcurrencyRegistry.register(opts.name, maxConcurrent);

  return (req: Request, res: Response, next: NextFunction): void => {
    // 与其它限流器同一口径：本机调试/健康检查不参与配额。
    if (req.isLocalIp) {
      next();
      return;
    }
    if (!methods.has(req.method)) {
      next();
      return;
    }
    if (opts.pathFilter) {
      const pathname = req.originalUrl?.split("?")[0] || req.path || "";
      if (!opts.pathFilter(pathname)) {
        next();
        return;
      }
    }

    const key = keyGenerator(req);
    // 匿名第二判据（与 createLimiter 同一口径）：同一台设备换 IP 也不该拿到新的并发额度。
    // 登录用户已经有账户键，不再叠加；没有指纹的客户端行为与改动前一致。
    const anonymousFingerprint = (req as Request & { user?: { id?: string } }).user?.id
      ? null
      : getRequestFingerprint(req);
    const fingerprintKey = anonymousFingerprint ? `fp:${fingerprintBucket(anonymousFingerprint)}` : null;
    const active = burstConcurrencyRegistry.acquire(opts.name, key);
    const fingerprintActive = fingerprintKey
      ? burstConcurrencyRegistry.acquire(opts.name, fingerprintKey)
      : 0;
    if (active > maxConcurrent || fingerprintActive > maxConcurrent) {
      burstConcurrencyRegistry.release(opts.name, key);
      if (fingerprintKey) burstConcurrencyRegistry.release(opts.name, fingerprintKey);
      logger.warn(`[RateLimit] 429 ${opts.name} (burst concurrency)`, {
        category: "burst-concurrency",
        key,
        active,
        maxConcurrent,
        route: getRouteHotspotKey(req),
      });
      res.setHeader("Retry-After", String(retryAfterSeconds));
      res.status(429).json({
        error: "同时进行的请求过多，请稍后重试",
        code: "BURST_CONCURRENCY_LIMIT",
        retryAfterSeconds,
      });
      return;
    }

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      burstConcurrencyRegistry.release(opts.name, key);
      if (fingerprintKey) burstConcurrencyRegistry.release(opts.name, fingerprintKey);
    };
    // finish 与 close 都要挂：客户端中断时 finish 不会触发，漏减会让槽位永久泄漏。
    res.once("finish", release);
    res.once("close", release);
    next();
  };
}

const LIMITER_DEFINITIONS = {
  authLogin: {
    profile: "login",
    category: "login",
    message: "登录请求过于频繁，请稍后再试",
  },
  authRegister: {
    profile: "register",
    category: "register",
    message: "注册请求过于频繁，请稍后再试",
  },
  auth: {
    profile: "auth",
    category: "auth",
    message: "请求过于频繁，请稍后再试",
    skip: skipLocalAndAuthSpecific,
  },
  me: {
    profile: "authRead",
    category: "auth",
    message: "请求过于频繁，请稍后再试",
  },
  ttsGenerate: {
    profile: "ttsGenerate",
    category: "tts",
    // RC-27：算力类端点用双键，避免“换 IP 并行刷”与“NAT 误伤”两类问题。
    keyGenerator: userIpDualKey,
    message: "请求过于频繁，请稍后再试",
  },
  ttsHistory: {
    profile: "ttsHistory",
    category: "tts-history",
    message: "请求过于频繁，请稍后再试",
  },
  ttsJobs: {
    profile: "ttsJobs",
    category: "tts-jobs",
    message: "请求过于频繁，请稍后再试",
  },
  // 语音转文本(用户态):上传/建任务是低频重操作,轮询进度是高频轻操作,两者共用一个
  // per-user 桶;轮询频率由前端自控(3s),240/5min 足够跑完一批任务而不至于卡住。
  transcribe: {
    profile: "authRead",
    category: "transcribe",
    max: 240,
    // RC-27：转写同样是重算力，双键（否则换 IP 即可并行刷）。
    keyGenerator: userIpDualKey,
    message: "语音转文本请求过于频繁，请稍后再试",
  },
  // 文档转换(用户态):上传/建任务/轮询进度/下载产物共用一个 per-user 桶。
  // 轮询是「任务在跑就每秒一次」的高频轻请求,而上传/建任务是低频重操作 ——
  // 两者共桶意味着长任务会把配额花在轮询上,所以这一档刻意给得比 transcribe 紧。
  docTool: {
    profile: "authRead",
    category: "docTool",
    max: 120,
    message: "文档转换请求过于频繁，请稍后再试",
  },
  geogebra: {
    profile: "authRead",
    category: "public-api",
    max: 180,
    keyGenerator: userIpDualKey,
    message: "GeoGebra 工作台请求过于频繁，请稍后再试",
  },
  // Pixel 的量级参考来源站点：验证 20/分、提交 10/分、详情查询 60/分。
  // 全部按「用户 + IP」双键分桶：卡密额度属于账号，不能只按 IP 限。
  pixelVerify: {
    profile: "authRead",
    category: "pixel",
    max: 20,
    windowMs: 60_000,
    keyGenerator: userIpDualKey,
    message: "卡密验证过于频繁，请稍后再试",
  },
  pixelSubmit: {
    profile: "sensitive",
    category: "pixel",
    max: 10,
    windowMs: 60_000,
    keyGenerator: userIpDualKey,
    message: "任务提交过于频繁，请稍后再试",
  },
  pixelRead: {
    profile: "authRead",
    category: "pixel",
    max: 60,
    windowMs: 60_000,
    keyGenerator: userIpDualKey,
    message: "任务查询过于频繁，请稍后再试",
  },
  admin: {
    profile: "admin",
    category: "admin",
    message: "管理员操作过于频繁，请稍后再试",
  },
  // 管理端 Redis 浏览：SCAN 是有成本的读命令，额度过得比普通管理读更严。
  adminRedis: {
    profile: "admin",
    category: "admin",
    max: 40,
    message: "Redis 数据浏览请求过于频繁，请稍后再试",
  },
  // 全库快照导出：每次都是长时间扫描 + 大响应，单独一档低频额度。
  adminRedisExport: {
    profile: "sensitive",
    category: "admin",
    windowMs: 10 * 60_000,
    max: 3,
    message: "快照导出过于频繁，请稍后再试",
  },
  frontend: {
    profile: "static",
    category: "static",
    message: "请求过于频繁，请稍后再试",
  },
  totp: {
    profile: "verification",
    category: "verification",
    // /status 与 /backup-codes 是 UI 挂载与每次弹窗关闭都会拉的读接口，与 verify/
    // disable 共用一个桶；verification 档的 20/5min 在移动端很容易被状态刷新打满。
    // 放宽到 120/5min：真正的暴力破解由 totpController 的 TOTP_ATTEMPT_LIMIT(5 次/
    // 15 分钟锁定，per-user)单独兜底，这里只是粗粒度节流。
    max: 120,
    message: "TOTP操作过于频繁，请稍后再试",
  },
  passkey: {
    profile: "verification",
    category: "verification",
    max: 30,
    message: "Passkey操作过于频繁，请稍后再试",
  },
  tamper: {
    profile: "standard",
    category: "public-api",
    message: "防篡改验证请求过于频繁，请稍后再试",
  },
  command: {
    profile: "sensitive",
    category: "command",
    message: "命令执行请求过于频繁，请稍后再试",
    skip: skipLocalAndStatusPoll,
  },
  ticketRead: {
    profile: "ticketRead",
    category: "ticket",
    message: "工单查询请求过于频繁，请稍后再试",
  },
  ticketWrite: {
    profile: "ticketWrite",
    category: "ticket",
    message: "工单写入请求过于频繁，请稍后再试",
  },
  ticketUpload: {
    profile: "ticketUpload",
    category: "ticket",
    message: "工单附件操作过于频繁，请稍后再试",
  },
  ticketAdmin: {
    profile: "admin",
    category: "ticket",
    message: "工单管理请求过于频繁，请稍后再试",
  },
  librechat: {
    profile: "standard",
    // 登录面私有接口：独立类目，避免计入公开(public-api)统计。
    category: "librechat",
    message: "LibreChat请求过于频繁，请稍后再试",
  },
  datacollection: {
    profile: "standard",
    category: "public-api",
    message: "数据收集请求过于频繁，请稍后再试",
  },
  logs: {
    profile: "verification",
    category: "public-api",
    message: "日志请求过于频繁，请稍后再试",
  },
  ipfs: {
    profile: "sensitive",
    category: "public-api",
    message: "上传请求过于频繁，请稍后再试",
  },
  network: {
    profile: "standard",
    category: "public-api",
    message: "网络检测请求过于频繁，请稍后再试",
  },
  dataprocess: {
    profile: "admin",
    category: "public-api",
    message: "数据处理请求过于频繁，请稍后再试",
  },
  media: {
    profile: "verification",
    category: "public-api",
    message: "媒体解析请求过于频繁，请稍后再试",
  },
  social: {
    profile: "standard",
    category: "public-api",
    message: "社交媒体请求过于频繁，请稍后再试",
  },
  life: {
    profile: "standard",
    category: "public-api",
    max: 40,
    message: "生活信息请求过于频繁，请稍后再试",
  },
  miniapi: {
    profile: "standard",
    category: "public-api",
    message: "MiniAPI请求过于频繁，请稍后再试",
  },
  anta: {
    profile: "standard",
    category: "public-api",
    message: "安踏防伪查询请求过于频繁，请稍后再试",
  },
  status: {
    profile: "relaxed",
    category: "status",
    message: "状态检查请求过于频繁，请稍后再试",
  },
  openapi: {
    profile: "sensitive",
    category: "public-api",
    message: "请求过于频繁，请稍后再试",
  },
  oauth: {
    profile: "auth",
    category: "auth",
    message: "OAuth 请求过于频繁，请稍后再试",
  },
  audio: {
    profile: "admin",
    category: "static",
    message: "音频文件请求过于频繁，请稍后再试",
  },
  modlist: {
    profile: "relaxed",
    category: "public-api",
    message: "MOD列表请求过于频繁，请稍后再试",
  },
  cdk: {
    profile: "relaxed",
    category: "public-api",
    message: "CDK 请求过于频繁，请稍后再试",
  },
  ghbilling: {
    profile: "sensitive",
    category: "public-api",
    message: "GitHub Billing请求过于频繁，请稍后再试",
  },
  linuxdocredit: {
    profile: "sensitive",
    category: "public-api",
    message: "LINUX DO Credit 请求过于频繁，请稍后再试",
  },
  deeplx: {
    profile: "verification",
    category: "public-api",
    message: "翻译请求过于频繁，请稍后再试",
  },
  deeplxPublic: {
    profile: "burst",
    category: "public-api",
    max: 300,
    message: "公共翻译 API 请求过于频繁，请稍后再试",
  },
  cdictIngress: {
    profile: "burst",
    category: "public-api",
    max: 1200,
    message: "CDict 请求过于频繁，请稍后再试",
    skip: isLocalRequest,
  },
  cdict: {
    profile: "relaxed",
    category: "public-api",
    message: "CDict 请求过于频繁，请稍后再试",
    skip: skipTrustedCdict,
  },
  cdictTrusted: {
    profile: "relaxed",
    category: "public-api",
    max: 180,
    message: "CDict 请求过于频繁，请稍后再试",
    keyGenerator: cdictInstallKey,
    skip: skipUnlessTrustedCdict,
  },
  cdictTrustedUpstream: {
    profile: "relaxed",
    category: "public-api",
    max: 120,
    message: "翻译/朗读请求过于频繁，请稍后再试",
    keyGenerator: cdictInstallKey,
    skip: skipUnlessTrustedCdictUpstream,
  },
  cdictTrustedUpstreamIp: {
    profile: "relaxed",
    category: "public-api",
    max: 600,
    message: "翻译/朗读请求过于频繁，请稍后再试",
    skip: skipUnlessTrustedCdictUpstream,
  },
  // RC-27：署名申请是写操作，单独一档 每 IP 每小时 10 次，不与翻译/朗读桶共用。
  // 之前这条定义写在 cdictRoutes 里（能用，但不出现在限流器清单里，排查 429 时容易漏看）。
  cdictDonationClaim: {
    profile: "relaxed",
    category: "public-api",
    windowMs: 60 * 60 * 1000,
    max: 10,
    message: "署名提交过于频繁，请稍后再试",
  },
  integrity: {
    profile: "sensitive",
    category: "public-api",
    message: "请求过于频繁，请稍后再试",
  },
  nexaisecurity: {
    profile: "relaxed",
    category: "public-api",
    message: "安全请求过于频繁，请稍后再试",
  },
  bilibiliSync: {
    profile: "authRead",
    category: "auth",
    max: 120,
    message: "Bilibili 同步请求过于频繁，请稍后再试",
  },
  bilibiliReport: {
    profile: "verification",
    category: "public-api",
    max: 12,
    message: "Bilibili 凭据上报过于频繁，请稍后再试",
  },
  lumen: {
    profile: "standard",
    category: "public-api",
    message: "Lumen 请求过于频繁，请稍后再试",
  },
  crashSdk: {
    profile: "standard",
    category: "public-api",
    message: "崩溃上报过于频繁，请稍后再试",
  },
  qqGuard: {
    profile: "relaxed",
    category: "public-api",
    max: 180,
    message: "群纪律审查请求过于频繁，请稍后再试",
  },
  root: {
    profile: "burst",
    category: "public-api",
    message: "访问过于频繁，请稍后再试",
  },
  lccompat: {
    profile: "standard",
    category: "public-api",
    message: "请求过于频繁，请稍后再试",
  },
  ipquery: {
    profile: "relaxed",
    category: "public-api",
    max: 180,
    message: "IP查询过于频繁，请稍后再试",
  },
  iplocation: {
    profile: "verification",
    category: "public-api",
    message: "IP位置查询过于频繁，请稍后再试",
  },
  ipreport: {
    profile: "standard",
    category: "public-api",
    max: 25,
    message: "IP上报过于频繁，请稍后再试",
    skip: skipPrivateIpReport,
  },
  iprisk: {
    profile: "relaxed",
    category: "public-api",
    windowMs: 15 * 60_000,
    max: 60,
    message: "IP风险查询过于频繁，请稍后再试",
  },
  ipprobe: {
    profile: "verification",
    category: "public-api",
    windowMs: 15 * 60_000,
    max: 20,
    message: "出口探测过于频繁，请稍后再试",
  },
  serverstatus: {
    profile: "sensitive",
    category: "status",
    message: "状态查询过于频繁，请稍后再试",
  },
  static: {
    profile: "static",
    category: "static",
    max: 5000,
    message: "静态文件请求过于频繁，请稍后再试",
  },
  docstimeout: {
    profile: "sensitive",
    category: "public-api",
    max: 5,
    message: "上报过于频繁，请稍后再试",
  },
  cloudflareChallenge: {
    profile: "verification",
    category: "cloudflare-challenge",
    max: 120,
    message: "验证请求过于频繁，请稍后再试",
  },
  global: {
    profile: "global",
    category: "global",
    message: "请求过于频繁，请稍后再试",
    skip: skipLocalAndStatusPoll,
  },
  notfound: {
    profile: "admin",
    category: "public-api",
    message: "请求过于频繁，请稍后再试",
  },
  // 浏览器遥测：前端错误上报是批量、低频的，但匿名入口必须防刷。
  // 与 datacollection 不同，这里接受的是结构化事件表，额度按「批」计。
  clientTelemetry: {
    profile: "relaxed",
    category: "telemetry",
    max: 30,
    message: "遥测上报过于频繁，请稍后再试",
  },
} as const satisfies Record<string, LimiterDefinition>;

function limiterFromDefinition(name: keyof typeof LIMITER_DEFINITIONS): RateLimitRequestHandler {
  const definition: LimiterDefinition = LIMITER_DEFINITIONS[name];
  return createLimiter({
    name,
    profile: definition.profile,
    category: definition.category,
    message: definition.message,
    windowMs: definition.windowMs,
    max: definition.max,
    keyGenerator: definition.keyGenerator,
    skip: definition.skip,
    handler: definition.handler,
    preferMemory: definition.preferMemory,
    anonymousFingerprint: definition.anonymousFingerprint,
  });
}

export const loginLimiter = limiterFromDefinition("authLogin");
export const registerLimiter = limiterFromDefinition("authRegister");
export const authLimiter = limiterFromDefinition("auth");
export const meEndpointLimiter = limiterFromDefinition("me");
export const ttsLimiter = limiterFromDefinition("ttsGenerate");
export const historyLimiter = limiterFromDefinition("ttsHistory");
export const jobsLimiter = limiterFromDefinition("ttsJobs");
export const transcribeLimiter = limiterFromDefinition("transcribe");
export const docToolLimiter = limiterFromDefinition("docTool");
export const geogebraLimiter = limiterFromDefinition("geogebra");
export const pixelVerifyLimiter = limiterFromDefinition("pixelVerify");
export const pixelSubmitLimiter = limiterFromDefinition("pixelSubmit");
export const pixelReadLimiter = limiterFromDefinition("pixelRead");
export const adminLimiter = limiterFromDefinition("admin");
export const adminRedisLimiter = limiterFromDefinition("adminRedis");
export const adminRedisExportLimiter = limiterFromDefinition("adminRedisExport");
export const frontendLimiter = limiterFromDefinition("frontend");
export const totpLimiter = limiterFromDefinition("totp");
export const passkeyLimiter = limiterFromDefinition("passkey");
export const tamperLimiter = limiterFromDefinition("tamper");
export const commandLimiter = limiterFromDefinition("command");
export const ticketReadLimiter = limiterFromDefinition("ticketRead");
export const ticketWriteLimiter = limiterFromDefinition("ticketWrite");
export const ticketUploadLimiter = limiterFromDefinition("ticketUpload");
export const ticketAdminLimiter = limiterFromDefinition("ticketAdmin");
export const libreChatLimiter = limiterFromDefinition("librechat");
export const dataCollectionLimiter = limiterFromDefinition("datacollection");
export const clientTelemetryLimiter = limiterFromDefinition("clientTelemetry");
export const logsLimiter = limiterFromDefinition("logs");
export const ipfsLimiter = limiterFromDefinition("ipfs");
export const networkLimiter = limiterFromDefinition("network");
export const dataProcessLimiter = limiterFromDefinition("dataprocess");
export const mediaLimiter = limiterFromDefinition("media");
export const socialLimiter = limiterFromDefinition("social");
export const lifeLimiter = limiterFromDefinition("life");
export const miniapiLimiter = limiterFromDefinition("miniapi");
export const antaLimiter = limiterFromDefinition("anta");
export const statusLimiter = limiterFromDefinition("status");
export const openapiLimiter = limiterFromDefinition("openapi");
export const oauthLimiter = limiterFromDefinition("oauth");
export const audioFileLimiter = limiterFromDefinition("audio");
export const modlistMountLimiter = limiterFromDefinition("modlist");
export const cdkMountLimiter = limiterFromDefinition("cdk");
export const githubBillingLimiter = limiterFromDefinition("ghbilling");
export const linuxDoCreditLimiter = limiterFromDefinition("linuxdocredit");
export const deeplxLimiter = limiterFromDefinition("deeplx");
export const deeplxPublicLimiter = limiterFromDefinition("deeplxPublic");
export const cdictIngressLimiter = limiterFromDefinition("cdictIngress");
export const cdictLimiter = limiterFromDefinition("cdict");
export const cdictTrustedLimiter = limiterFromDefinition("cdictTrusted");
export const cdictTrustedUpstreamLimiter = limiterFromDefinition("cdictTrustedUpstream");
export const cdictTrustedUpstreamIpLimiter = limiterFromDefinition("cdictTrustedUpstreamIp");
export const cdictDonationClaimLimiter = limiterFromDefinition("cdictDonationClaim");
export const integrityLimiter = limiterFromDefinition("integrity");
export const nexaiSecurityLimiter = limiterFromDefinition("nexaisecurity");
export const bilibiliSyncLimiter = limiterFromDefinition("bilibiliSync");
export const bilibiliReportLimiter = limiterFromDefinition("bilibiliReport");
export const lumenLimiter = limiterFromDefinition("lumen");
export const crashSdkLimiter = limiterFromDefinition("crashSdk");
export const qqGuardLimiter = limiterFromDefinition("qqGuard");
export const rootLimiter = limiterFromDefinition("root");
export const lcCompatLimiter = limiterFromDefinition("lccompat");
export const ipQueryLimiter = limiterFromDefinition("ipquery");
export const ipLocationLimiter = limiterFromDefinition("iplocation");
export const ipReportLimiter = limiterFromDefinition("ipreport");
export const ipRiskLimiter = limiterFromDefinition("iprisk");
export const ipProbeLimiter = limiterFromDefinition("ipprobe");
export const serverStatusLimiter = limiterFromDefinition("serverstatus");
export const staticFileLimiter = limiterFromDefinition("static");
export const docsTimeoutLimiter = limiterFromDefinition("docstimeout");
export const cloudflareChallengeLimiter = limiterFromDefinition("cloudflareChallenge");
export const globalDefaultLimiter = limiterFromDefinition("global");
export const notFoundLimiter = limiterFromDefinition("notfound");

// ========== RC-27：昂贵端点的突发并发硬顶实例 ==========
// 默认值刻意给得比"正常用户峰值"宽（单身份 3～6 个在途），只切断病态并发；
// 需要更紧可用 env 调。0/非法 → 回落默认。
function readBurstMaxEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed) || Math.floor(parsed) < 1) return fallback;
  return Math.min(Math.floor(parsed), 100);
}

/** 同时在飞行的 TTS 生成请求（全局队列并发默认 2，这里放一点余量给轮询/重试）。 */
export const ttsGenerateBurstGuard = createBurstConcurrencyGuard({
  name: "tts-generate-burst",
  maxConcurrent: readBurstMaxEnv("BURST_TTS_GENERATE_MAX", 3),
});

const TRANSCRIBE_EXPENSIVE_PATHS = new Set(["/api/transcribe/upload", "/api/transcribe/jobs"]);

/** 转写只卡"上传/建任务"，不卡高频但轻量的进度轮询（否则长任务会把并发槽位吃满）。 */
export const transcribeBurstGuard = createBurstConcurrencyGuard({
  name: "transcribe-burst",
  maxConcurrent: readBurstMaxEnv("BURST_TRANSCRIBE_MAX", 3),
  pathFilter: (pathname) => TRANSCRIBE_EXPENSIVE_PATHS.has(pathname.replace(/\/+$/, "")),
});

const CDICT_UPSTREAM_PATHS = new Set(["/api/cdict/translate", "/api/cdict/tts"]);

/** CDict 的翻译/朗读会消耗服务端持有的上游凭据，单独卡并发（列表/赞赏等轻接口不卡）。 */
export const cdictUpstreamBurstGuard = createBurstConcurrencyGuard({
  name: "cdict-upstream-burst",
  maxConcurrent: readBurstMaxEnv("BURST_CDICT_UPSTREAM_MAX", 6),
  pathFilter: (pathname) => CDICT_UPSTREAM_PATHS.has(pathname.replace(/\/+$/, "")),
});
