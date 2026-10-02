import logger from "../utils/logger";
import { redisService } from "./redisService";

/**
 * 通用缓存层（RD-1 / RD-2 / RD-4）。
 *
 * 与 `sharedStateStore` 的分工：
 *   - `sharedStateStore` 管「不可丢失的短期状态」（会话、OAuth state、一次性凭证、分布式锁），
 *     缺 Redis 时会退到 Mongo，保证跨实例一致；
 *   - 本服务管「可重建的派生数据」（聚合统计、热门列表、推荐结果）。它是纯加速层：
 *     Redis 不可用就退回进程内存，**绝不写 Mongo**——缓存回源加重持久层负载是反效果。
 *
 * 因此本层的底线是「miss 不算错」：任何异常都吞掉并返回未命中，由调用方回源。
 *
 * key 约定：`cache:<域>:<标识>`（`buildKey` 会补 `cache:` 前缀）。缓存 key 可能含用户标识，
 * 所以禁止把凭据/密钥/一次性令牌放进缓存值（CO-3）。
 */

const CACHE_KEY_PREFIX = "cache:";
const MEMORY_MAX_ENTRIES = 5_000;
const MEMORY_SWEEP_INTERVAL_MS = 60_000;
const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface MemoryEntry {
  value: string;
  expiresAt: number;
}

export interface CacheStats {
  tier: "redis" | "memory";
  hits: number;
  misses: number;
  sets: number;
  deletes: number;
  errors: number;
  /** 命中率（hits / (hits + misses)），无样本时为 0。 */
  hitRate: number;
  memoryEntries: number;
  inflight: number;
}

class CacheService {
  private readonly memory = new Map<string, MemoryEntry>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private hits = 0;
  private misses = 0;
  private sets = 0;
  private deletes = 0;
  private errors = 0;
  private sweepTimer: NodeJS.Timeout | null = null;

  /** 组装带命名空间的缓存 key；空片段会被丢弃。 */
  public buildKey(...parts: Array<string | number | undefined | null>): string {
    const body = parts
      .filter((part): part is string | number => part !== undefined && part !== null && String(part).length > 0)
      .map((part) => String(part))
      .join(":");
    return `${CACHE_KEY_PREFIX}${body}`;
  }

  public isShared(): boolean {
    return redisService.isAvailable();
  }

  public async get<T>(key: string): Promise<T | null> {
    const fullKey = this.fullKey(key);
    const raw = await this.readRaw(fullKey);
    if (raw === null) {
      this.misses += 1;
      return null;
    }
    try {
      this.hits += 1;
      return JSON.parse(raw) as T;
    } catch {
      // 缓存值损坏：当成未命中并清掉，避免反复解析失败。
      this.errors += 1;
      this.misses += 1;
      void this.del(key);
      return null;
    }
  }

  /** 写入缓存。`ttlMs <= 0` 视为不缓存（直接返回 false），避免误写永久 key。 */
  public async set<T>(key: string, value: T, ttlMs: number): Promise<boolean> {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) return false;
    const ttl = Math.min(Math.floor(ttlMs), MAX_TTL_MS);
    const fullKey = this.fullKey(key);
    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch (error) {
      this.errors += 1;
      logger.warn("[Cache] 值无法序列化，跳过写入", {
        key: fullKey,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }

    this.sets += 1;
    if (redisService.isAvailable()) {
      const ok = await redisService.setKey(fullKey, serialized, ttl);
      if (ok) return true;
      this.errors += 1;
      // Redis 写失败时仍落内存，保证单实例内还有加速；跨实例一致性本来就不是缓存的承诺。
    }
    this.memory.set(fullKey, { value: serialized, expiresAt: Date.now() + ttl });
    this.sweepMemory();
    return true;
  }

  public async del(key: string): Promise<boolean> {
    const fullKey = this.fullKey(key);
    this.deletes += 1;
    let removed = this.memory.delete(fullKey);
    if (redisService.isAvailable()) {
      removed = (await redisService.deleteKeys([fullKey])) > 0 || removed;
    }
    return removed;
  }

  /** 按前缀失效（例如某用户全部推荐）。返回删除条数（内存层 + Redis 层）。 */
  public async delByPrefix(prefix: string): Promise<number> {
    const fullPrefix = this.fullKey(prefix);
    let removed = 0;
    for (const key of [...this.memory.keys()]) {
      if (key.startsWith(fullPrefix)) {
        this.memory.delete(key);
        removed += 1;
      }
    }
    if (redisService.isAvailable()) {
      removed += await redisService.deleteByPrefix(fullPrefix);
    }
    return removed;
  }

  /**
   * 回源取数并缓存。并发同 key 的调用共享一次回源（单飞），避免热点失效瞬间的击穿。
   * 回源抛错时不写缓存、原样抛出，由调用方决定降级。
   */
  public async getOrSet<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;

    const fullKey = this.fullKey(key);
    const existing = this.inflight.get(fullKey) as Promise<T> | undefined;
    if (existing) return existing;

    const task = (async () => {
      try {
        const value = await loader();
        // null/undefined 不缓存：调用方下次仍会回源，语义更直观。
        if (value !== null && value !== undefined) {
          await this.set(key, value, ttlMs);
        }
        return value;
      } finally {
        this.inflight.delete(fullKey);
      }
    })();

    this.inflight.set(fullKey, task);
    return task;
  }

  public stats(): CacheStats {
    this.sweepMemory();
    const samples = this.hits + this.misses;
    return {
      tier: redisService.isAvailable() ? "redis" : "memory",
      hits: this.hits,
      misses: this.misses,
      sets: this.sets,
      deletes: this.deletes,
      errors: this.errors,
      hitRate: samples > 0 ? Number((this.hits / samples).toFixed(4)) : 0,
      memoryEntries: this.memory.size,
      inflight: this.inflight.size,
    };
  }

  /** 测试/运维用：清空本进程内存层。 */
  public clearMemory(): number {
    const size = this.memory.size;
    this.memory.clear();
    return size;
  }

  private fullKey(key: string): string {
    return key.startsWith(CACHE_KEY_PREFIX) ? key : `${CACHE_KEY_PREFIX}${key}`;
  }

  private async readRaw(fullKey: string): Promise<string | null> {
    if (redisService.isAvailable()) {
      const raw = await redisService.getKey(fullKey);
      if (raw !== null) return raw;
      // 注意：Redis 返回 null 有两种含义（未命中 / 读取异常）。读取异常时 redisService 已
      // 记日志并降级，这里继续查内存层，避免「Redis 抖动 ⇒ 全部未命中」。
    }
    const entry = this.memory.get(fullKey);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.memory.delete(fullKey);
      return null;
    }
    return entry.value;
  }

  private sweepMemory(): void {
    const now = Date.now();
    for (const [key, entry] of this.memory.entries()) {
      if (entry.expiresAt <= now) this.memory.delete(key);
    }
    if (this.memory.size > MEMORY_MAX_ENTRIES) {
      // 过期时间最早的最先淘汰：不考虑访问频次，够用且无额外记账成本。
      const ordered = [...this.memory.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
      for (const [key] of ordered.slice(0, this.memory.size - MEMORY_MAX_ENTRIES)) {
        this.memory.delete(key);
      }
    }
    if (!this.sweepTimer) {
      this.sweepTimer = setInterval(() => {
        const current = Date.now();
        for (const [key, entry] of this.memory.entries()) {
          if (entry.expiresAt <= current) this.memory.delete(key);
        }
      }, MEMORY_SWEEP_INTERVAL_MS);
      this.sweepTimer.unref?.();
    }
  }
}

export const cacheService = new CacheService();
