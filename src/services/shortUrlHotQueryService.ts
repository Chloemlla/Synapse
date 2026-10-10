// 短链「近期热门查询」加速层。
//
// 需求：最近 1 小时内被查询**超过 3 次**的短链放进 Redis，之后的重定向直接命中缓存、不再打 Mongo。
//
// 三个动作：
//   1) 计数：每小时一个桶 key（shorturl:hits:<桶>:<code>），INCR + 首次写 TTL。
//      为什么用固定小时桶而不是滑动窗口：只需要 INCR / PEXPIRE 两个原语，不用引入 ZSET 与 SCAN；
//      对「算不算热门」这个判断来说，两种窗口的差异只体现在整点前后，可以忽略。
//   2) 晋升：计数越过阈值（默认 3）→ 把 {code, target} 写进 shorturl:hot:<code>，TTL 默认 10 分钟。
//   3) 续期：热门的链接每次被访问都会再次越过阈值（同一个桶里计数只增不减），于是每次都会重写该 key、
//      TTL 随之中续 —— 持续热门的一直留缓存，停止访问后最多再活 10 分钟。
//
// 为什么热点条目 TTL 只给 10 分钟，而不是跟窗口一样 1 小时：
// 缓存与删除之间有竞态 —— 短链删了但缓存还在，重定向就会成功。删除路径已显式失效（invalidate），
// 但管理端还有直接删库的旁路；10 分钟就是给那些旁路兜底的上界。要更严就把 TTL 调小。
//
// Redis 缺失时：计数与晋升整体关闭（isAvailable() 为假直接返回），读取一律回落 Mongo。
// **不退回进程内存计数**：多实例下各自计数会得出不同的「热门」，而本层只是加速层，
// 宁可退化成「没有缓存」，也不要给出各实例不一致的判定（与 cacheService 的取舍一致）。
//
// 只缓存重定向需要的 {code, target}：target 本身就是公开可访问的跳转目标，
// 而 userId/username 之类的归属信息不进 Redis（缓存里不放身份标识，见 cacheService 的 CO-3 约定）。
import logger from "../utils/logger";
import { redisService } from "./redisService";

/** 命中判定阈值：窗口内查询次数「超过」该值才算热门（默认 3，即第 4 次开始进缓存）。 */
const DEFAULT_THRESHOLD = 3;
/** 计数窗口（默认 1 小时）。 */
const DEFAULT_WINDOW_MS = 60 * 60 * 1000;
/** 热点条目存活时间（默认 10 分钟，命中即续期）。 */
const DEFAULT_HOT_TTL_MS = 10 * 60 * 1000;

const KEY_HITS = "shorturl:hits";
const KEY_HOT = "shorturl:hot";
/** 只接受路由层认可的短链字符集，避免把奇怪的字符串拼进 Redis key。 */
const CODE_PATTERN = /^[a-zA-Z0-9_-]{1,50}$/;

export interface ShortUrlHotStats {
  /** Redis 是否可用（不可用时本层整体关闭） */
  enabled: boolean;
  threshold: number;
  windowMs: number;
  hotTtlMs: number;
  /** 晋升次数（写入热点条目） */
  promotions: number;
  /** 直接命中热点缓存的次数 */
  hits: number;
  /** 未命中并回源 Mongo 的次数 */
  misses: number;
  /** 因 Redis 不可用而跳过计数的次数 */
  disabledSkips: number;
}

export interface ShortUrlHotQueryOptions {
  threshold?: number;
  windowMs?: number;
  hotTtlMs?: number;
}

const numFromEnv = (raw: string | undefined, fallback: number): number => {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

function readOptions(overrides: ShortUrlHotQueryOptions = {}): Required<ShortUrlHotQueryOptions> {
  return {
    threshold: overrides.threshold ?? numFromEnv(process.env.SHORT_URL_HOT_QUERY_THRESHOLD, DEFAULT_THRESHOLD),
    windowMs: overrides.windowMs ?? numFromEnv(process.env.SHORT_URL_HOT_WINDOW_MS, DEFAULT_WINDOW_MS),
    hotTtlMs: overrides.hotTtlMs ?? numFromEnv(process.env.SHORT_URL_HOT_TTL_MS, DEFAULT_HOT_TTL_MS),
  };
}

/** 当前小时桶编号（窗口的粒度就是它）。 */
function currentBucket(now = Date.now(), windowMs = DEFAULT_WINDOW_MS): number {
  return Math.floor(now / windowMs);
}

const counterKey = (code: string, bucket: number): string => `${KEY_HITS}:${bucket}:${code}`;
const hotKey = (code: string): string => `${KEY_HOT}:${code}`;

interface HotEntry {
  code: string;
  target: string;
  cachedAt: number;
}

class ShortUrlHotQueryService {
  private promotions = 0;
  private hits = 0;
  private misses = 0;
  private disabledSkips = 0;

  public isEnabled(): boolean {
    return redisService.isAvailable();
  }

  /**
   * 取热点缓存里的跳转目标；未命中/Redis 不可用都返回 null（调用方回源）。
   * 只校验结构，协议合法性交给重定向层那份既有校验（两条路径同一把尺子）。
   */
  public async getHotTarget(code: string): Promise<string | null> {
    const trimmed = String(code || "").trim();
    if (!CODE_PATTERN.test(trimmed)) return null;
    if (!this.isEnabled()) {
      this.misses += 1;
      return null;
    }
    try {
      const raw = await redisService.getKey(hotKey(trimmed));
      if (!raw) {
        this.misses += 1;
        return null;
      }
      const entry = JSON.parse(raw) as Partial<HotEntry>;
      if (!entry || typeof entry.target !== "string" || entry.target.length === 0) {
        // 值损坏：当成未命中，顺手清掉，避免每次访问都要解析失败一次
        this.misses += 1;
        void this.invalidate(trimmed);
        return null;
      }
      this.hits += 1;
      return entry.target;
    } catch (error) {
      this.misses += 1;
      logger.warn("短链热点缓存读取失败，回落数据库", { code: trimmed, error });
      return null;
    }
  }

  /**
   * 记一次查询并视计数决定是否晋升为热点。**fire-and-forget 调用**（重定向不该等它）。
   * 返回处置结果，便于单测与排查：disabled（Redis 不可用）/ counted（只计数）/ promoted（已进缓存）。
   */
  public async recordQuery(
    code: string,
    target: string,
    overrides: ShortUrlHotQueryOptions = {},
  ): Promise<"disabled" | "counted" | "promoted"> {
    const trimmed = String(code || "").trim();
    if (!CODE_PATTERN.test(trimmed) || typeof target !== "string" || target.length === 0) return "disabled";
    if (!this.isEnabled()) {
      this.disabledSkips += 1;
      return "disabled";
    }
    const opts = readOptions(overrides);
    try {
      // 首次自增时才写 TTL（redisService.incrementBy 的语义），所以窗口不会被后续访问无限延长：
      // 给两个窗口的时长，跨桶读与时钟漂移都有余量。
      const count = await redisService.incrementBy(
        counterKey(trimmed, currentBucket(Date.now(), opts.windowMs)),
        1,
        opts.windowMs * 2,
      );
      if (count === null) {
        this.disabledSkips += 1;
        return "disabled";
      }
      if (count <= opts.threshold) return "counted";
      const entry: HotEntry = { code: trimmed, target, cachedAt: Date.now() };
      await redisService.setKey(hotKey(trimmed), JSON.stringify(entry), opts.hotTtlMs);
      this.promotions += 1;
      return "promoted";
    } catch (error) {
      logger.warn("短链热点缓存写入失败", { code: trimmed, error });
      return "disabled";
    }
  }

  /**
   * 失效一个短链的热点状态（删除/改目标时必须调）。
   * 同时清掉当前与上一个小时桶的计数：只清热点条目的话，残留计数会让它在下一次访问时立刻又被晋升。
   */
  public async invalidate(code: string): Promise<void> {
    const trimmed = String(code || "").trim();
    if (!CODE_PATTERN.test(trimmed)) return;
    if (!this.isEnabled()) return;
    const opts = readOptions();
    const bucket = currentBucket(Date.now(), opts.windowMs);
    try {
      await redisService.deleteKeys([hotKey(trimmed), counterKey(trimmed, bucket), counterKey(trimmed, bucket - 1)]);
    } catch (error) {
      logger.warn("短链热点缓存失效失败", { code: trimmed, error });
    }
  }

  /** 批量失效（批量删除、清库）。 */
  public async invalidateMany(codes: string[]): Promise<void> {
    await Promise.all(codes.map((code) => this.invalidate(code)));
  }

  /** 处理量统计：进程内计数，够用来判断这套缓存到底有没有在工作。 */
  public getStats(overrides: ShortUrlHotQueryOptions = {}): ShortUrlHotStats {
    const opts = readOptions(overrides);
    return {
      enabled: this.isEnabled(),
      threshold: opts.threshold,
      windowMs: opts.windowMs,
      hotTtlMs: opts.hotTtlMs,
      promotions: this.promotions,
      hits: this.hits,
      misses: this.misses,
      disabledSkips: this.disabledSkips,
    };
  }

  /** 仅供单测重置进程内计数。 */
  public resetStats(): void {
    this.promotions = 0;
    this.hits = 0;
    this.misses = 0;
    this.disabledSkips = 0;
  }
}

export const shortUrlHotQueryService = new ShortUrlHotQueryService();
export { ShortUrlHotQueryService };
