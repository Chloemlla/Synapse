import { createClient, type RedisClientType } from "redis";
import { startupConfig } from "../config/config";
import logger from "../utils/logger";
import { escapeRegexLiteral } from "../utils/regexEscape";
import { mongoose } from "./mongoService";

// 前缀当字面量（统一实现见 utils/regexEscape）。放在类定义之前：类方法在模块求值期间
// 就可能被定时器/回调触发，const 在 TDZ 里会抛错。
const escapeRegex = escapeRegexLiteral;

/**
 * 共享短期状态存储（跨实例、可重建、带 TTL）。
 *
 * 定位：本仓库的存储分工是「MongoDB = 主持久层，Redis = 短期/共享状态，文件 = 运行期产物」。
 * 安全会话、OAuth state、账号合并会话、探针会话、人机验证 abuse 计数、调度器任务锁这类数据
 * 都属于「短期 + 必须被所有实例看到」，过去散落在各家服务自己的进程内 Map 里：单实例没事，
 * 一旦横向扩容或进程重启就会变成「A 实例发的凭证 B 实例不认」。
 *
 * 分层（与 services/sharedRateLimitStore.ts 同款策略）：
 *   1. 配了 `REDIS_URL`：Redis 为权威层；Redis 报错时退回 Mongo（有 TTL 索引），再不行退回进程内存并告警；
 *   2. 没配 Redis：Mongo 为权威层（`shared_state_entries`，TTL 索引），Mongo 不可用则退回进程内存；
 *   3. 进程内存层始终有容量上限 + 过期清扫，只作最后兜底。
 *
 * 语义约定（调用方必须知道）：
 *   - 同一部署里所有实例的层级必须一致（同一 Redis / 同一 Mongo），否则 `claim()` 的「一次性」语义会失效
 *     （各写各的层，互相看不到）；
 *   - 进程内存兜底只保证单实例正确性，落地日志里会带 `consistency: "per-process only"` 方便排查；
 *   - key 用 `<组件>:<用途>:<标识>` 约定命名，便于按前缀排查与清理。
 */

export type SharedStateTier = "redis" | "mongo" | "memory";

/** 拿不到临界区锁时抛出（调用方决定是提示重试还是排队）。 */
export class SharedStateLockedError extends Error {
  public readonly key: string;
  constructor(key: string) {
    super("操作正在进行中，请稍后重试");
    this.name = "SharedStateLockedError";
    this.key = key;
  }
}

export interface SharedStateStats {
  tier: SharedStateTier;
  shared: boolean;
  memoryEntries: number;
}

interface SharedStateDocument {
  _id: string;
  value: unknown;
  expiresAt: Date;
}

const REDIS_KEY_PREFIX = process.env.SHARED_STATE_REDIS_PREFIX || "synapse:state:";
const MEMORY_MAX_ENTRIES = 20_000;
const MEMORY_SWEEP_INTERVAL_MS = 60_000;
const REDIS_RETRY_BACKOFF_MS = 30_000;

const SharedStateSchema = new mongoose.Schema<SharedStateDocument>(
  {
    _id: { type: String, required: true },
    value: { type: mongoose.Schema.Types.Mixed, required: true },
    expiresAt: { type: Date, required: true },
  },
  { collection: "shared_state_entries", versionKey: false, timestamps: false },
);
// TTL 索引兜住「读过即忘」的键；读取仍会显式比对 expiresAt（TTL 监视器有分钟级粒度）。
SharedStateSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const SharedStateModel: mongoose.Model<SharedStateDocument> =
  (mongoose.models.SharedStateEntry as mongoose.Model<SharedStateDocument>) ||
  mongoose.model<SharedStateDocument>("SharedStateEntry", SharedStateSchema);

interface MemoryEntry {
  value: unknown;
  expiresAt: number;
}

class SharedStateStore {
  private redisClient: RedisClientType | null = null;
  private redisReady = false;
  private redisRetryAfter = 0;
  private readonly memory = new Map<string, MemoryEntry>();
  private sweepTimer: NodeJS.Timeout | null = null;
  private warnedMemoryFallback = false;

  private get redisConfigured(): boolean {
    return Boolean(startupConfig.redis.url);
  }

  /** 当前权威层级（不含「Redis 报错后临时降级」这种瞬时状态）。 */
  public tier(): SharedStateTier {
    if (this.redisConfigured) return "redis";
    return mongoose.connection.readyState === 1 ? "mongo" : "memory";
  }

  /** 是否具备跨实例共享能力（多实例部署前应确保为 true）。 */
  public isShared(): boolean {
    return this.tier() !== "memory";
  }

  public stats(): SharedStateStats {
    this.sweepMemory();
    const tier = this.tier();
    return { tier, shared: tier !== "memory", memoryEntries: this.memory.size };
  }

  /**
   * 读取并删除（一次性凭证语义：state / ticket / 探针 session），
   * 实现必须是原子的 —— 并发/多实例下只能有一个调用方拿到值。
   * 返回 null 表示不存在、已过期或已被消费。
   */
  public async consume<T>(key: string): Promise<T | null> {
    if (this.redisConfigured) {
      const client = await this.getRedisClient();
      if (client) {
        try {
          const raw = await client.getDel(this.redisKey(key));
          return raw ? (JSON.parse(raw) as T) : null;
        } catch (error) {
          this.markRedisFailure(error);
        }
      }
    }

    if (mongoose.connection.readyState === 1) {
      try {
        const doc = await SharedStateModel.findOneAndDelete({
          _id: key,
          expiresAt: { $gt: new Date() },
        })
          .lean()
          .exec();
        return doc ? ((doc as unknown as SharedStateDocument).value as T) : null;
      } catch (error) {
        logger.warn("[SharedState] Mongo consume 失败，回落到进程内存", {
          key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.warnMemoryFallback();
    const entry = this.memory.get(key);
    if (!entry) return null;
    this.memory.delete(key);
    return entry.expiresAt > Date.now() ? (entry.value as T) : null;
  }

  /**
   * 原子申领（「同一时刻只有一个实例能拿到」）：
   * Redis `SET NX PX`；Mongo 以 `_id` 为主键 upsert（已存在且未过期 ⇒ 抢不到）；内存层为单实例语义。
   *
   * 传入 `owner` 时写入的值就是 owner，配合 `release(key, owner)` 实现「只有持有者能解锁」，
   * 避免一个过期后被别人抢走的锁又被前一持有者误删。
   */
  public async claim(key: string, ttlMs: number, owner?: string): Promise<boolean> {
    const ttl = Math.max(1, Math.floor(ttlMs));
    const expiresAt = Date.now() + ttl;
    const claimValue = owner ?? "1";

    if (this.redisConfigured) {
      const client = await this.getRedisClient();
      if (client) {
        try {
          const result = await client.set(this.redisKey(key), claimValue, { NX: true, PX: ttl });
          return result === "OK";
        } catch (error) {
          this.markRedisFailure(error);
        }
      }
    }

    if (mongoose.connection.readyState === 1) {
      try {
        // 过滤条件只匹配「不存在或已过期」，因此命中即等于抢到（过期文档被顺带续期）。
        const result = await SharedStateModel.updateOne(
          { _id: key, expiresAt: { $lte: new Date() } },
          { $set: { value: claimValue, expiresAt: new Date(expiresAt) } },
          { upsert: true },
        );
        if ((result?.upsertedCount ?? 0) > 0 || (result?.matchedCount ?? 0) > 0) return true;
        return false;
      } catch (error) {
        // 已存在且未过期时 upsert 会撞主键唯一约束 —— 这正是「没抢到」。
        if ((error as { code?: number })?.code === 11000) return false;
        logger.warn("[SharedState] Mongo claim 失败，回落到进程内存", {
          key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.warnMemoryFallback();
    const existing = this.memory.get(key);
    if (existing && existing.expiresAt > Date.now()) return false;
    this.memory.set(key, { value: claimValue, expiresAt });
    this.sweepMemory();
    return true;
  }

  /** 释放自己持有的锁：只有当前值等于 `owner` 才删（Redis 走 Lua，Mongo 走带条件 deleteOne）。 */
  public async release(key: string, owner: string): Promise<boolean> {
    if (this.redisConfigured) {
      const client = await this.getRedisClient();
      if (client) {
        try {
          const result = (await (client as any).eval(
            'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end',
            { keys: [this.redisKey(key)], arguments: [owner] },
          )) as number;
          if (result > 0) return true;
        } catch (error) {
          this.markRedisFailure(error);
        }
      }
    }

    if (mongoose.connection.readyState === 1) {
      try {
        const result = await SharedStateModel.deleteOne({ _id: key, value: owner });
        if ((result?.deletedCount ?? 0) > 0) return true;
      } catch (error) {
        logger.warn("[SharedState] Mongo 释放锁失败", {
          key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const entry = this.memory.get(key);
    if (entry && entry.value === owner) {
      this.memory.delete(key);
      return true;
    }
    return false;
  }

  /**
   * 在跨实例锁内执行一段临界区（读-改-写类操作的正确性保障）。
   *
   * 语义：
   *   - 拿不到锁 → 抛 `SharedStateLockedError`，由调用方决定怎么回复（抽奖场景直接提示稍后重试
   *     比默默并发更安全）；
   *   - 锁层不可用（Redis/Mongo 都不可）→ `claim` 会退到进程内存锁，也就是「单实例内串行」。
   *     对「奖品库存不得被并发覆盖」这类需求，宁可保留单实例保护也不拒绝业务请求。
   *   - 临界区抛出时锁照常释放；释放失败也不会覆盖业务结果（锁有 TTL 兜底）。
   */
  public async withLock<T>(key: string, ttlMs: number, criticalSection: () => Promise<T>): Promise<T> {
    const owner = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const acquired = await this.claim(key, ttlMs, owner);
    if (!acquired) throw new SharedStateLockedError(key);
    try {
      return await criticalSection();
    } finally {
      try {
        await this.release(key, owner);
      } catch (error) {
        logger.warn("[SharedState] 释放临界区锁失败（将由 TTL 兜底）", {
          key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  public async set<T>(key: string, value: T, ttlMs: number): Promise<boolean> {
    const ttl = Math.max(1, Math.floor(ttlMs));
    const expiresAt = Date.now() + ttl;

    if (this.redisConfigured) {
      const client = await this.getRedisClient();
      if (client) {
        try {
          await client.set(this.redisKey(key), JSON.stringify(value), { PX: ttl });
          return true;
        } catch (error) {
          this.markRedisFailure(error);
        }
      }
    }

    if (mongoose.connection.readyState === 1) {
      try {
        await SharedStateModel.updateOne(
          { _id: key },
          { $set: { value, expiresAt: new Date(expiresAt) } },
          { upsert: true },
        );
        return true;
      } catch (error) {
        logger.warn("[SharedState] Mongo 写入失败，回落到进程内存", {
          key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.warnMemoryFallback();
    this.memory.set(key, { value, expiresAt });
    this.sweepMemory();
    return true;
  }

  public async get<T>(key: string): Promise<T | null> {
    if (this.redisConfigured) {
      const client = await this.getRedisClient();
      if (client) {
        try {
          const raw = await client.get(this.redisKey(key));
          return raw ? (JSON.parse(raw) as T) : null;
        } catch (error) {
          this.markRedisFailure(error);
        }
      }
    }

    if (mongoose.connection.readyState === 1) {
      try {
        const doc = await SharedStateModel.findOne({ _id: key, expiresAt: { $gt: new Date() } })
          .lean()
          .exec();
        return doc ? ((doc as unknown as SharedStateDocument).value as T) : null;
      } catch (error) {
        logger.warn("[SharedState] Mongo 读取失败，回落到进程内存", {
          key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const entry = this.memory.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.memory.delete(key);
      return null;
    }
    return entry.value as T;
  }

  public async delete(key: string): Promise<boolean> {
    let removed = false;

    if (this.redisConfigured) {
      const client = await this.getRedisClient();
      if (client) {
        try {
          removed = (await client.del(this.redisKey(key))) > 0;
        } catch (error) {
          this.markRedisFailure(error);
        }
      }
    }

    if (mongoose.connection.readyState === 1) {
      try {
        const result = await SharedStateModel.deleteOne({ _id: key });
        removed = removed || (result?.deletedCount ?? 0) > 0;
      } catch (error) {
        logger.warn("[SharedState] Mongo 删除失败，继续清理进程内存", {
          key,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (this.memory.delete(key)) removed = true;
    return removed;
  }

  /** 按前缀批量删除（例如某用户的所有会话）。仅对权威层生效，不做跨层扫描。 */
  public async deleteByPrefix(prefix: string): Promise<number> {
    let removed = 0;

    if (this.redisConfigured) {
      const client = await this.getRedisClient();
      if (client) {
        try {
          const keys: string[] = [];
          for await (const keyOrKeys of client.scanIterator({ MATCH: `${this.redisKey(prefix)}*`, COUNT: 200 })) {
            // @redis/client v5 的 scanIterator 按批产出数组（旧版产出单个 key），两种都吃得下。
            // 同款处理见 redisService.ts 的批量 GET 路径。
            const batch = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
            for (const key of batch) {
              keys.push(key);
              if (keys.length >= 5_000) break;
            }
            if (keys.length >= 5_000) break;
          }
          // redis v6 的 del 类型是单 key（可变参数写法在各版本不一致），逐个删：前缀清理不在热路径上。
          for (const key of keys) {
            removed += await client.del(key);
          }
        } catch (error) {
          this.markRedisFailure(error);
        }
      }
    } else if (mongoose.connection.readyState === 1) {
      try {
        const result = await SharedStateModel.deleteMany({ _id: { $regex: `^${escapeRegex(prefix)}` } });
        removed += result?.deletedCount ?? 0;
      } catch (error) {
        logger.warn("[SharedState] Mongo 前缀删除失败", {
          prefix,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    for (const key of [...this.memory.keys()]) {
      if (key.startsWith(prefix)) {
        this.memory.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** 测试/运维用：清空进程内存层（不动 Redis / Mongo）。 */
  public clearMemory(): void {
    this.memory.clear();
  }

  private redisKey(key: string): string {
    return `${REDIS_KEY_PREFIX}${key}`;
  }

  private warnMemoryFallback(): void {
    if (this.warnedMemoryFallback) return;
    logger.error("[SharedState] 共享层不可用，使用进程内存兜底", {
      consistency: "per-process only",
      redisConfigured: this.redisConfigured,
      mongoReadyState: mongoose.connection.readyState,
    });
    this.warnedMemoryFallback = true;
  }

  private markRedisFailure(error: unknown): void {
    this.redisReady = false;
    this.redisRetryAfter = Date.now() + REDIS_RETRY_BACKOFF_MS;
    logger.warn("[SharedState] Redis 操作失败，暂退避后重试", {
      error: error instanceof Error ? error.message : String(error),
      retryAfterMs: REDIS_RETRY_BACKOFF_MS,
    });
  }

  private async getRedisClient(): Promise<RedisClientType | null> {
    if (!this.redisConfigured) return null;
    if (this.redisReady && this.redisClient) return this.redisClient;
    if (Date.now() < this.redisRetryAfter) return null;

    if (!this.redisClient) {
      try {
        const client = createClient({
          url: startupConfig.redis.url,
          socket: { reconnectStrategy: (retries) => Math.min(100 * 2 ** Math.min(retries, 8), 30_000) },
        });
        client.on("error", (error) => {
          this.redisReady = false;
          logger.error("[SharedState] Redis 错误:", error);
        });
        client.on("ready", () => {
          this.redisReady = true;
        });
        client.on("end", () => {
          this.redisReady = false;
        });
        await client.connect();
        this.redisClient = client;
        this.redisReady = true;
        return this.redisClient;
      } catch (error) {
        this.redisClient = null;
        this.markRedisFailure(error);
        return null;
      }
    }

    return null;
  }

  private sweepMemory(): void {
    const now = Date.now();
    for (const [key, entry] of this.memory.entries()) {
      if (entry.expiresAt <= now) this.memory.delete(key);
    }
    if (this.memory.size > MEMORY_MAX_ENTRIES) {
      const ordered = [...this.memory.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
      for (const [key] of ordered.slice(0, this.memory.size - MEMORY_MAX_ENTRIES)) {
        this.memory.delete(key);
      }
    }
    this.ensureSweepTimer();
  }

  private ensureSweepTimer(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.memory.entries()) {
        if (entry.expiresAt <= now) this.memory.delete(key);
      }
    }, MEMORY_SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }
}

export const sharedStateStore = new SharedStateStore();
