import { mongoose } from "./mongoService";
import logger from "../utils/logger";

/**
 * 登录失败的**共享后端**计数 + 指数退避（RC-27 / D14(a)）。
 *
 * 为什么必须搬出进程内存：原先 `loginAttempts` 是 `Map`，多实例部署下不同步 ——
 * 攻击者把失败次数均摊到 N 个实例，每个实例都看到 “5 次以内”，锁定阈值形同虚设。
 * D14 的裁决是 **(a) Redis 优先、Mongo 兜底**；本模块用**原子 Mongo 更新**做主实现
 * （不依赖 Redis，启动期/未配 Redis 时也能一致），语义是“跨实例一致”而不是“最快”。
 *
 * 语义（与仓库既有 15 分钟锁定保持一致，另加**指数退避**）：
 * - 累计失败次数达到阈值后锁定；重复触发时锁定时长**翻倍**（上限 `MAX_LOCKOUT_MS`）；
 * - 成功登录即清零；
 * - 记录带 TTL，失败历史不会无限积累（`expireAfterSeconds` 由写入时算出）。
 */

const COLLECTION = "login_attempt_counters";
/** 失败次数达到该值开始锁定（与 _state.LOGIN_ATTEMPT_LIMIT 保持一致）。 */
export const LOGIN_BACKOFF_THRESHOLD = 5;
/** 首次锁定时长（15 分钟，与既有行为一致）。 */
export const LOGIN_BACKOFF_BASE_MS = 15 * 60 * 1000;
/** 锁定时长上限（24 小时）——不能让退避无限涨到“事实上的永久封禁”。 */
export const LOGIN_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;
/** 计数与锁定状态的保留期：至少覆盖最长锁定，再加一天宽限。 */
const COUNTER_TTL_MS = LOGIN_BACKOFF_MAX_MS + 24 * 60 * 60 * 1000;

export interface LoginBackoffState {
  count: number;
  lockedUntil: number;
  /** 已经翻倍的次数（用于解释“为什么这次锁得更久”）。 */
  lockoutLevel: number;
}

interface LoginAttemptDoc {
  _id: string;
  count: number;
  lockedUntil: number;
  lockoutLevel: number;
  expiresAt: Date;
  updatedAt: Date;
}

function counters() {
  return mongoose.connection.collection<LoginAttemptDoc>(COLLECTION) as unknown as {
    findOne(filter: Record<string, unknown>): Promise<LoginAttemptDoc | null>;
    updateOne(
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
      options?: Record<string, unknown>,
    ): Promise<{ modifiedCount?: number; matchedCount?: number; upsertedCount?: number }>;
    deleteOne(filter: Record<string, unknown>): Promise<unknown>;
  };
}

function mongoReady(): boolean {
  return mongoose.connection.readyState === 1;
}

/** 规范化计数键：与仓库既有逻辑一致（用户名/邮箱统一小写去空白；IP 原样）。 */
export function normalizeLoginAttemptKey(kind: "identifier" | "ip", value: string): string {
  const trimmed = String(value || "").trim();
  if (kind === "ip") return `ip:${trimmed || "unknown"}`;
  return `id:${trimmed.toLowerCase()}`;
}

/** 读当前状态；库不可用时返回“未锁定”，让调用方走内存兜底路径（不因此拒绝所有人）。 */
export async function readLoginBackoffState(key: string): Promise<LoginBackoffState | null> {
  if (!mongoReady()) return null;
  try {
    const doc = await counters().findOne({ _id: key });
    if (!doc) return { count: 0, lockedUntil: 0, lockoutLevel: 0 };
    return {
      count: Number(doc.count) || 0,
      lockedUntil: Number(doc.lockedUntil) || 0,
      lockoutLevel: Number(doc.lockoutLevel) || 0,
    };
  } catch (error) {
    logger.warn("[LoginBackoff] 读取计数失败（按未锁定处理）", {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * 记一次失败并返回最新状态。**原子**：用 `$inc` + `$set` 一次完成，
 * 不做“读-改-写”（那正是多实例下计数丢掉的根因）。
 *
 * 锁定策略：`count - THRESHOLD + 1` 作为“第几次触发锁定”，时长 = base * 2^(level-1)，
 * 上限 `LOGIN_BACKOFF_MAX_MS`。因此第 5 次 → 1x、第 6 次 → 2x、第 7 次 → 4x…
 */
export async function recordLoginFailure(key: string): Promise<LoginBackoffState | null> {
  if (!mongoReady()) return null;
  try {
    const now = Date.now();
    // 先原子自增，再根据新值决定是否写入锁定时间（两步都是为了避开 read-modify-write）。
    const after = (await counters().updateOne(
      { _id: key },
      {
        $inc: { count: 1 },
        $set: { updatedAt: new Date(now) },
        $setOnInsert: { lockedUntil: 0, lockoutLevel: 0 },
      },
      { upsert: true },
    )) as unknown as { matchedCount?: number };

    const doc = await counters().findOne({ _id: key });
    void after;
    if (!doc) return null;

    const count = Number(doc.count) || 0;
    if (count < LOGIN_BACKOFF_THRESHOLD) {
      return { count, lockedUntil: Number(doc.lockedUntil) || 0, lockoutLevel: Number(doc.lockoutLevel) || 0 };
    }

    const level = Math.max(1, count - LOGIN_BACKOFF_THRESHOLD + 1);
    const duration = Math.min(LOGIN_BACKOFF_BASE_MS * 2 ** (level - 1), LOGIN_BACKOFF_MAX_MS);
    const lockedUntil = now + duration;
    await counters().updateOne(
      { _id: key },
      {
        $set: {
          lockedUntil,
          lockoutLevel: level,
          expiresAt: new Date(Math.max(lockedUntil, now) + COUNTER_TTL_MS),
          updatedAt: new Date(now),
        },
      },
    );
    logger.warn("[LoginBackoff] 登录失败触发锁定", { key, count, level, durationMs: duration });
    return { count, lockedUntil, lockoutLevel: level };
  } catch (error) {
    logger.warn("[LoginBackoff] 记录失败次数出错（不影响本次登录响应）", {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** 登录成功即清零（不留“差一次就锁”的历史）。 */
export async function clearLoginFailures(key: string): Promise<void> {
  if (!mongoReady()) return;
  try {
    await counters().deleteOne({ _id: key });
  } catch (error) {
    logger.warn("[LoginBackoff] 清理失败计数出错", {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** 原子建 TTL 索引（与项目内裸集合写法一致；失败只告警）。 */
export async function ensureLoginBackoffIndexes(): Promise<void> {
  if (!mongoReady()) return;
  try {
    await mongoose.connection
      .collection(COLLECTION)
      .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "login_attempt_ttl" })
      .catch(() => undefined);
  } catch {
    // 索引不是功能前置条件
  }
}
