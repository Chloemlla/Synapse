import { createClient, RESP_TYPES, type RedisClientType } from "redis";
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

/** 管理端只读浏览：SCAN 单页结果。cursor 为 "0" 表示遍历结束。 */
export interface RedisScanPage {
  cursor: string;
  keys: string[];
}

/** 管理端只读浏览：单键条目（含义随类型变化，见 readKeyContent）。 */
export interface RedisKeyEntry {
  /** hash 字段 / stream 记录 ID；list、set、zset 为空（用数组下标表达位置）。 */
  field?: string;
  /** 值本体：hash 值、list 元素、set 成员、zset 成员。 */
  value: string;
  /** zset 分数（字符串形式，避免浮点舍入）。 */
  score?: string;
}

/** 管理端只读浏览的单键快照。所有字段都有界：内容按上限截断并置 truncated。 */
export interface RedisKeyContent {
  /** string | list | set | zset | hash | none | 模块自定义类型（如 ReJSON-RL）。 */
  type: string;
  /** PTTL：-1 永不过期，-2 键不存在。 */
  ttlMs: number;
  encoding: string | null;
  sizeBytes: number | null;
  /** string 的字符长度（STRLEN）；集合类型为 null。 */
  stringLength: number | null;
  /** string 值（可能被截断）。 */
  value: string | null;
  /** 集合类条目（可能被截断）；string 与不支持的类型为 null。 */
  entries: RedisKeyEntry[] | null;
  /** 集合类总条目数（HLEN / LLEN / SCARD / ZCARD）；其余为 null。 */
  totalEntries: number | null;
  /** 是否因上限而截断了内容。 */
  truncated: boolean;
}

/**
 * 管理端快照导出：单键 DUMP 的结果。
 * `missing` = 键已不存在（快照期间过期）；`unavailable` = Redis 不可用；
 * `dump-failed` = 服务端禁用/改了 DUMP；`binary-unsafe` = 类型映射未生效（拒绝出快照）。
 */
export type RedisDumpOutcome =
  | { ok: true; dumpBase64: string; ttlMs: number }
  | { ok: false; reason: "missing" | "unavailable" | "dump-failed" | "binary-unsafe" };

const ADMIN_READ_MAX_VALUE_CHARS = 4_000;
const ADMIN_READ_MAX_ENTRIES = 200;
const ADMIN_READ_VALUE_HARD_CAP = 20_000;
const ADMIN_READ_ENTRY_HARD_CAP = 1_000;
const ADMIN_SCAN_COUNT_CAP = 1_000;

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

  // ==================== 管理端只读浏览原语 ====================
  // 说明：这两个方法只执行读命令（SCAN/TYPE/PTTL/STRLEN/GETRANGE/HSCAN/LRANGE/SSCAN/ZRANGE*），
  // 且返回值一律有界；客户端是私有成员，故意不对外暴露 connection，避免浏览功能被复用成写通道。

  /** SCAN 单页；不可用或命令失败返回 null（调用方按「浏览器不可用」处理）。 */
  public async scanKeysPage(cursor: string, match: string | undefined, count: number): Promise<RedisScanPage | null> {
    if (!this.isAvailable()) return null;
    const client = this.client;
    if (!client) return null;
    try {
      const result = await client.scan(cursor || "0", {
        COUNT: Math.max(1, Math.min(count, ADMIN_SCAN_COUNT_CAP)),
        ...(match ? { MATCH: match } : {}),
      });
      return { cursor: String(result.cursor ?? "0"), keys: (result.keys ?? []) as string[] };
    } catch (error) {
      logger.warn("⚠️ [Redis] SCAN 失败:", error);
      return null;
    }
  }

  /** 只读键的类型与 TTL（列表分页用，不读内容）；失败或不可用返回 null。 */
  public async readKeyMeta(key: string): Promise<{ type: string; ttlMs: number } | null> {
    if (!this.isAvailable()) return null;
    const client = this.client;
    if (!client) return null;
    try {
      const [type, ttlRaw] = await Promise.all([client.type(key), client.pTTL(key)]);
      return { type, ttlMs: typeof ttlRaw === "number" ? ttlRaw : -1 };
    } catch (error) {
      logger.warn("⚠️ [Redis] 读取键元信息失败:", error);
      return null;
    }
  }

  /**
   * 读取单键的类型/元信息/有界内容。键不存在时返回 type="none"（不是 null）；
   * Redis 不可用或命令失败返回 null。集合类条目按上限截断，并在 truncated 里标注。
   */
  public async readKeyContent(
    key: string,
    limits: { maxValueChars?: number; maxEntries?: number } = {},
  ): Promise<RedisKeyContent | null> {
    if (!this.isAvailable()) return null;
    const client = this.client;
    if (!client) return null;

    const maxValueChars = Math.max(
      1,
      Math.min(limits.maxValueChars ?? ADMIN_READ_MAX_VALUE_CHARS, ADMIN_READ_VALUE_HARD_CAP),
    );
    const maxEntries = Math.max(1, Math.min(limits.maxEntries ?? ADMIN_READ_MAX_ENTRIES, ADMIN_READ_ENTRY_HARD_CAP));

    try {
      const type = await client.type(key);
      if (type === "none") {
        return {
          type,
          ttlMs: -2,
          encoding: null,
          sizeBytes: null,
          stringLength: null,
          value: null,
          entries: null,
          totalEntries: null,
          truncated: false,
        };
      }

      const [ttlRaw, encoding, sizeBytes] = await Promise.all([
        client.pTTL(key),
        // MEMORY USAGE / OBJECT ENCODING 在部分托管 Redis 上被禁用；拿不到不影响查看内容。
        client.objectEncoding(key).catch(() => null),
        client.memoryUsage(key).catch(() => null),
      ]);

      const base: RedisKeyContent = {
        type,
        ttlMs: typeof ttlRaw === "number" ? ttlRaw : -1,
        encoding,
        sizeBytes,
        stringLength: null,
        value: null,
        entries: null,
        totalEntries: null,
        truncated: false,
      };

      if (type === "string") {
        const length = await client.strLen(key);
        base.stringLength = length;
        if (length > maxValueChars) {
          // GETRANGE 的 end 是闭区间，取 maxValueChars 个字符即 maxValueChars - 1。
          base.value = (await client.getRange(key, 0, maxValueChars - 1)) ?? "";
          base.truncated = true;
        } else {
          base.value = (await client.get(key)) ?? "";
        }
        return base;
      }

      if (type === "hash") {
        const total = await client.hLen(key);
        const page = await client.hScan(key, "0", { COUNT: maxEntries });
        const entries: RedisKeyEntry[] = (page.entries ?? []).slice(0, maxEntries).map((entry) => ({
          field: entry.field,
          value: entry.value,
        }));
        base.entries = entries;
        base.totalEntries = total;
        base.truncated = total > entries.length;
        return base;
      }

      if (type === "list") {
        const total = await client.lLen(key);
        const items = await client.lRange(key, 0, maxEntries - 1);
        const entries: RedisKeyEntry[] = items.map((value) => ({ value }));
        base.entries = entries;
        base.totalEntries = total;
        base.truncated = total > entries.length;
        return base;
      }

      if (type === "set") {
        const total = await client.sCard(key);
        const page = await client.sScan(key, "0", { COUNT: maxEntries });
        const subset = (page.members ?? []).slice(0, maxEntries);
        const entries: RedisKeyEntry[] = subset.map((value) => ({ value }));
        base.entries = entries;
        base.totalEntries = total;
        base.truncated = total > entries.length;
        return base;
      }

      if (type === "zset") {
        const total = await client.zCard(key);
        const items = await client.zRangeWithScores(key, 0, maxEntries - 1);
        const entries: RedisKeyEntry[] = items
          .slice(0, maxEntries)
          .map((item) => ({ value: item.value, score: String(item.score) }));
        base.entries = entries;
        base.totalEntries = total;
        base.truncated = total > entries.length;
        return base;
      }

      // 其余类型（stream、模块自定义类型）：只回类型与元信息，不猜编码、不读内容。
      return base;
    } catch (error) {
      logger.warn("⚠️ [Redis] 读取键内容失败:", error);
      return null;
    }
  }

  /**
   * 快照导出：`DUMP` 单键的序列化内容（与 RDB 单键编码一致）+ PTTL，base64 承载以便文本传输。
   *
   * 二进制必须字节精确：node-redis 默认把 RESP bulk string 按 UTF-8 解码，用于 DUMP 会静默损坏；
   * 所以这里用类型映射把 BLOB_STRING 改成 Buffer，并在拿到的不是 Buffer 时**拒绝出快照**
   * （宁可不导，也不能导出一份恢复不了的“看起来像快照”的文件）。
   */
  public async dumpKeyForExport(key: string): Promise<RedisDumpOutcome> {
    if (!this.isAvailable()) return { ok: false, reason: "unavailable" };
    const client = this.client;
    if (!client) return { ok: false, reason: "unavailable" };
    try {
      const mapped = client.withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer });
      const [raw, ttlRaw] = await Promise.all([mapped.dump(key), client.pTTL(key)]);
      if (raw === null || raw === undefined) return { ok: false, reason: "missing" };
      if (!Buffer.isBuffer(raw)) {
        logger.error("❌ [Redis] DUMP 未返回二进制内容，已拒绝生成快照");
        return { ok: false, reason: "binary-unsafe" };
      }
      return {
        ok: true,
        dumpBase64: raw.toString("base64"),
        ttlMs: typeof ttlRaw === "number" ? ttlRaw : -1,
      };
    } catch (error) {
      logger.warn("⚠️ [Redis] DUMP 导出失败:", error);
      return { ok: false, reason: "dump-failed" };
    }
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
