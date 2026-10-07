import { createClient, type RedisClientType } from "redis";
import logger from "../utils/logger";

/**
 * Redis 服务
 * 用于缓存和存储临时数据，包括 IP 封禁信息
 */
export interface RedisServiceStatus {
  /** `REDIS_URL` 是否配置。配置了但连不上时为 true / available=false。 */
  configured: boolean;
  /** 兼容字段：连接建立后启用；健康判定使用 available。 */
  enabled: boolean;
  /** `ready` 事件后的就绪态；命令层以它为准（`connect` 与 `ready` 之间有窗口期）。 */
  ready: boolean;
  available: boolean;
}

class RedisService {
  private client: RedisClientType | null = null;
  private isConnected: boolean = false;
  // RD-3: `connect` 事件只说明 TCP 建连；`ready` 才是可以收命令。分开跟踪，避免窗口期内误判可用。
  private isReady: boolean = false;
  private isEnabled: boolean = false;
  private initializing = false;
  private retryAfter = 0;
  private stopped = false;

  constructor() {
    this.initialize();
  }

  /**
   * 初始化 Redis 连接
   */
  private async initialize(): Promise<void> {
    if (this.initializing || this.stopped) return;
    this.initializing = true;
    try {
      const redisUrl = process.env.REDIS_URL;

      if (!redisUrl) {
        logger.info("📦 Redis URL 未配置，IP封禁将使用 MongoDB 存储");
        this.isEnabled = false;
        return;
      }

      logger.info("🔄 正在连接 Redis...");

      this.client = createClient({
        url: redisUrl,
        socket: {
          // G5-20: 去掉 10 次上限，指数退避封顶 30 秒无限重连，避免 Redis 滚动升级/
          // 主从切换后永久放弃且没有重新初始化入口。
          reconnectStrategy: (retries) => {
            const delay = Math.min(100 * 2 ** Math.min(retries, 8), 30_000);
            return delay;
          },
        },
      });

      // 错误处理
      this.client.on("error", (err) => {
        logger.error("❌ Redis 错误:", err);
        this.isConnected = false;
        this.isReady = false;
      });

      // 连接成功
      this.client.on("connect", () => {
        logger.info("✅ Redis 连接成功");
        this.isConnected = true;
        this.isEnabled = true;
      });

      // 就绪：可以收发命令
      this.client.on("ready", () => {
        this.isConnected = true;
        this.isReady = true;
        this.isEnabled = true;
      });

      // 断开连接
      this.client.on("disconnect", () => {
        logger.warn("⚠️ Redis 断开连接");
        this.isConnected = false;
        this.isReady = false;
      });

      // 连接彻底结束
      this.client.on("end", () => {
        this.isConnected = false;
        this.isReady = false;
      });

      // 重新连接
      this.client.on("reconnecting", () => {
        logger.info("🔄 Redis 正在重新连接...");
      });

      await this.client.connect();
    } catch (error) {
      logger.error("❌ Redis 初始化失败:", error);
      this.isEnabled = false;
      this.isConnected = false;
      this.isReady = false;
      this.retryAfter = Date.now() + 30_000;
      // 驱动的正常启动失败会自行重试；只有 connect 真正 reject 才释放旧实例。
      if (this.client?.isOpen) this.client.destroy();
      this.client = null;
    } finally {
      this.initializing = false;
    }
  }

  /**
   * 检查 Redis 是否可用
   */
  public isAvailable(): boolean {
    if (!this.stopped && !this.initializing && !this.client && process.env.REDIS_URL && Date.now() >= this.retryAfter) {
      void this.initialize();
    }
    return this.isEnabled && this.isConnected && this.isReady && this.client !== null;
  }

  /**
   * RD-1/RD-4: 连接与就绪状态，供管理端只读展示。
   */
  public getStatus(): RedisServiceStatus {
    return {
      configured: Boolean(process.env.REDIS_URL),
      enabled: this.isEnabled,
      ready: this.isReady,
      available: this.isAvailable(),
    };
  }

  // ==================== 通用原语（RD-1） ====================
  // 说明：这里只提供「缓存/计数器」这类可重建数据的最小原语；一次性凭证、锁语义仍走
  // services/sharedStateStore.ts（它自带 Redis→Mongo→内存的分层与原子 consume/claim）。
  // 调用方必须自己保证 key 命名空间（推荐 `cache:<域>:<标识>`），不要复用 `ipban:` 前缀。

  /** 读取字符串值；不可用时返回 null（调用方自行降级）。 */
  public async getKey(key: string): Promise<string | null> {
    if (!this.isAvailable()) return null;
    try {
      return (await this.client?.get(key)) ?? null;
    } catch (error) {
      logger.warn("⚠️ [Redis] 读取失败:", error);
      return null;
    }
  }

  /** 写入字符串值；ttlMs 省略或 <=0 时不设过期。 */
  public async setKey(key: string, value: string, ttlMs?: number): Promise<boolean> {
    if (!this.isAvailable()) return false;
    try {
      if (typeof ttlMs === "number" && ttlMs > 0) {
        await this.client?.set(key, value, { PX: Math.floor(ttlMs) });
      } else {
        await this.client?.set(key, value);
      }
      return true;
    } catch (error) {
      logger.warn("⚠️ [Redis] 写入失败:", error);
      return false;
    }
  }

  /** 删除指定 key，返回真正删除的数量。 */
  public async deleteKeys(keys: string[]): Promise<number> {
    if (!this.isAvailable() || keys.length === 0) return 0;
    try {
      const result = await this.client?.del(keys as any);
      return typeof result === "number" ? result : 0;
    } catch (error) {
      logger.warn("⚠️ [Redis] 删除失败:", error);
      return 0;
    }
  }

  /**
   * 按前缀删除（缓存失效）。用 scanIterator 分批，绝不使用 KEYS。
   * 上限 MAX_PREFIX_DELETE 个 key，避免一次运维操作把 Redis 打满。
   */
  public async deleteByPrefix(prefix: string, limit = 5000): Promise<number> {
    if (!this.isAvailable() || !prefix) return 0;
    const client = this.client;
    if (!client) return 0;
    let deleted = 0;
    try {
      const keys: string[] = [];
      for await (const keyOrKeys of client.scanIterator({ MATCH: `${prefix}*`, COUNT: 200 })) {
        const batch = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
        for (const key of batch) {
          keys.push(key);
          if (keys.length >= limit) break;
        }
        if (keys.length >= limit) break;
      }
      for (const key of keys) {
        deleted += (await client.del(key)) ?? 0;
      }
    } catch (error) {
      logger.warn("⚠️ [Redis] 按前缀删除失败:", error);
    }
    return deleted;
  }

  /** 计数器自增；首次自增（返回值等于 amount）时按 ttlMs 设置过期。 */
  public async incrementBy(key: string, amount = 1, ttlMs?: number): Promise<number | null> {
    if (!this.isAvailable()) return null;
    try {
      const client = this.client;
      if (!client) return null;
      const next = await client.incrBy(key, amount);
      if (next === amount && typeof ttlMs === "number" && ttlMs > 0) {
        await client.pExpire(key, Math.floor(ttlMs));
      }
      return next;
    } catch (error) {
      logger.warn("⚠️ [Redis] 自增失败:", error);
      return null;
    }
  }

  /** 只读服务端统计；任一命令不可用时对应字段为 null，不抛错。 */
  public async getServerStats(): Promise<{
    dbsize: number | null;
    usedMemoryBytes: number | null;
  }> {
    if (!this.isAvailable()) return { dbsize: null, usedMemoryBytes: null };
    const client = this.client;
    if (!client) return { dbsize: null, usedMemoryBytes: null };

    let dbsize: number | null = null;
    let usedMemoryBytes: number | null = null;
    try {
      dbsize = await client.dbSize();
    } catch (error) {
      logger.warn("⚠️ [Redis] dbSize 失败:", error);
    }
    try {
      const info = await client.info("memory");
      const match = /used_memory:(\d+)/.exec(typeof info === "string" ? info : "");
      if (match) usedMemoryBytes = Number(match[1]);
    } catch (error) {
      logger.warn("⚠️ [Redis] info(memory) 失败:", error);
    }
    return { dbsize, usedMemoryBytes };
  }

  /**
   * 添加 IP 到封禁列表
   * @param ip IP 地址
   * @param reason 封禁原因
   * @param durationMinutes 封禁时长（分钟）
   * @param metadata 额外元数据
   */
  public async banIP(
    ip: string,
    reason: string,
    durationMinutes: number,
    metadata?: {
      fingerprint?: string;
      userAgent?: string;
      violationCount?: number;
    },
  ): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }

    try {
      const key = `ipban:${ip}`;
      const expiresAt = Date.now() + durationMinutes * 60 * 1000;

      const data = {
        ip,
        reason,
        bannedAt: Date.now(),
        expiresAt,
        ...metadata,
      };

      // 存储封禁信息
      await this.client?.set(key, JSON.stringify(data), {
        PX: durationMinutes * 60 * 1000, // 设置过期时间（毫秒）
      });

      logger.info(`🚫 [Redis] IP 已封禁: ${ip}, 原因: ${reason}, 时长: ${durationMinutes}分钟`);
      return true;
    } catch (error) {
      logger.error("❌ [Redis] 封禁 IP 失败:", error);
      return false;
    }
  }

  /**
   * 检查 IP 是否被封禁
   * @param ip IP 地址
   * @returns 封禁信息，如果未封禁则返回 null
   */
  public async checkIPBan(ip: string): Promise<{
    ip: string;
    reason: string;
    bannedAt: number;
    expiresAt: number;
    fingerprint?: string;
    userAgent?: string;
    violationCount?: number;
  } | null> {
    if (!this.isAvailable()) {
      return null;
    }

    try {
      const key = `ipban:${ip}`;
      const data = await this.client?.get(key);

      if (!data) {
        return null;
      }

      return JSON.parse(data);
    } catch (error) {
      logger.error("❌ [Redis] 检查 IP 封禁失败:", error);
      return null;
    }
  }

  /**
   * 解除 IP 封禁
   * @param ip IP 地址
   */
  public async unbanIP(ip: string): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }

    try {
      const key = `ipban:${ip}`;
      const result = await this.client?.del(key);

      if (result && result > 0) {
        logger.info(`✅ [Redis] IP 已解封: ${ip}`);
        return true;
      }

      return false;
    } catch (error) {
      logger.error("❌ [Redis] 解封 IP 失败:", error);
      return false;
    }
  }

  /**
   * 获取所有被封禁的 IP 列表
   */
  public async getAllBannedIPs(): Promise<
    Array<{
      ip: string;
      reason: string;
      bannedAt: number;
      expiresAt: number;
      fingerprint?: string;
      userAgent?: string;
      violationCount?: number;
    }>
  > {
    if (!this.isAvailable()) {
      return [];
    }

    try {
      const client = this.client;
      if (!client) return [];
      // G5-20: 用 scanIterator + 批量 GET 代替 KEYS + N 次 GET，避免 O(N) 阻塞命令与 N+1 往返。
      const bannedIPs: Array<{
        ip: string;
        reason: string;
        bannedAt: number;
        expiresAt: number;
        fingerprint?: string;
        userAgent?: string;
        violationCount?: number;
      }> = [];
      const batch: string[] = [];
      for await (const keyOrKeys of client.scanIterator({ MATCH: "ipban:*", COUNT: 100 })) {
        const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
        for (const key of keys) {
          batch.push(key);
          if (batch.length >= 100) {
            const values = await client.mGet(batch);
            for (const data of values ?? []) {
              if (data) bannedIPs.push(JSON.parse(data));
            }
            batch.length = 0;
          }
        }
      }
      if (batch.length > 0) {
        const values = await client.mGet(batch);
        for (const data of values ?? []) {
          if (data) bannedIPs.push(JSON.parse(data));
        }
      }

      return bannedIPs;
    } catch (error) {
      logger.error("❌ [Redis] 获取封禁 IP 列表失败:", error);
      return [];
    }
  }

  /**
   * 清理所有过期的封禁记录（Redis 会自动处理，此方法用于手动清理）
   */
  public async cleanupExpiredBans(): Promise<number> {
    if (!this.isAvailable()) {
      return 0;
    }

    try {
      const client = this.client;
      if (!client) return 0;
      let cleaned = 0;
      // G5-20: 用 scanIterator 代替 KEYS 全量扫描，避免 O(N) 阻塞。
      for await (const keyOrKeys of client.scanIterator({ MATCH: "ipban:*", COUNT: 100 })) {
        const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
        const values = await client.mGet(keys);
        const toDelete: string[] = [];
        for (let i = 0; i < keys.length; i++) {
          const data = values?.[i];
          if (!data) continue;
          try {
            const ban = JSON.parse(data);
            if (ban.expiresAt < Date.now()) {
              toDelete.push(keys[i]);
              cleaned++;
            }
          } catch {
            toDelete.push(keys[i]);
            cleaned++;
          }
        }
        if (toDelete.length > 0) {
          await client.del(toDelete);
        }
      }

      if (cleaned > 0) {
        logger.info(`🧹 [Redis] 清理了 ${cleaned} 个过期的封禁记录`);
      }

      return cleaned;
    } catch (error) {
      logger.error("❌ [Redis] 清理过期封禁记录失败:", error);
      return 0;
    }
  }

  /**
   * 关闭 Redis 连接
   */
  public async disconnect(): Promise<void> {
    this.stopped = true;
    if (this.client && this.isConnected) {
      try {
        await this.client.quit();
        logger.info("👋 Redis 连接已关闭");
      } catch (error) {
        logger.error("❌ 关闭 Redis 连接失败:", error);
      }
    }
    if (this.client?.isOpen) this.client.destroy();
    this.client = null;
    this.isReady = false;
    this.isConnected = false;
    this.isEnabled = false;
  }
}

// 导出单例
export const redisService = new RedisService();
