import type { Db } from "mongodb";
import { isConnected, mongoose } from "./mongoService";
import logger from "../utils/logger";

/**
 * 启动期自动迁移运行器（RC-47）。
 *
 * 核心约定：**执行结果落库做终态标记，后续启动直接短路跳过**，不反复检查、不反复执行。
 *
 * 启动时对每条迁移只看一次 `schema_migrations` 里的标记：
 *   - 标记为 `applied` ⇒ **直接跳过**（不再读索引、不再连集合，启动开销恒定）；
 *   - 无标记 / `failed` / `blocked` ⇒ 进入**智能状态判定**（只读检查真实状态）再决定动作。
 *
 * 状态判定本身是"智能"的部分（不做盲跑）：
 *   - 全新库（索引不存在）→ 直接建；
 *   - 半迁移（旧索引已删、新索引没建起来）→ 补齐；
 *   - 已达标但没写标记（如手工建过）→ 只补标记，零写入；
 *   - **不安全状态**（活跃账号里出现重复邮箱，建唯一索引必然失败）→ 记 `blocked` 并保持原样，
 *     绝不"先删了再说"。
 *
 * 代价（有意接受，且必须知道）：标记为 `applied` 后，若有人**手工**把索引删了/改坏了，
 * 启动期不会再发现。需要复查时设 `MIGRATIONS_REVERIFY=true`（或走 `--reverify` 的 CLI），
 * 它会忽略标记、重新做一次状态判定。生产不建议常开 —— 那就回到"每次启动都检查"。
 *
 * 失败语义：迁移失败**不让进程退出**。多数失败（重复数据等）需要人工介入，
 * 此时全站不可用比风控特性缺失严重得多；因此只记录结果，并提供两个观测通道：
 *   1. 启动日志（`[Migration]` 前缀，`logger.error` 级）—— 可被日志告警采集；
 *   2. 手工入口 `pnpm run migrate:rc47-indexes -- --dry-run` —— 直接回声当前状态。
 * `getMigrationHealth()` 已备好（返回本轮结果），但**尚未**接入 `/health`；
 * 接它要改 health 响应形状与相应用例，未在本批范围。
 *
 * 跨实例：用 `schema_migrations` 上的原子锁（compare-and-set；upsert 撞主键即为"已被占用"），
 * 不依赖 Redis（启动期 Redis 可能还没起来），且**已 applied 的实例根本不抢锁**。
 */

const LEDGER_COLLECTION = "schema_migrations";
const LOCK_ID = "migration-runner-lock";

export interface MigrationContext {
  db: Db;
}

export interface MigrationPlan {
  /** 运行前判定的真实状态（落库 + 写日志，便于事后归因）。 */
  state: string;
  /** 需要执行的动作描述；空数组 = 已经达标，无需动作。 */
  actions: string[];
  /** true = 当前状态禁止自动执行（需人工介入），运行器保持原样并告警。 */
  blocked: boolean;
  blockedReason?: string;
  /** 实际执行体。仅在 `blocked === false` 且 `actions.length > 0` 时被调用。 */
  apply?: () => Promise<void>;
}

export interface SchemaMigration {
  id: string;
  description: string;
  /** **只读**：检查真实状态并给出计划。实现里不得有任何写入。 */
  plan: (ctx: MigrationContext) => Promise<MigrationPlan>;
}

export type MigrationOutcome = "applied" | "skipped" | "already-marked" | "blocked" | "failed";

export interface MigrationResult {
  id: string;
  outcome: MigrationOutcome;
  state: string;
  actions: string[];
  error?: string;
  at: string;
}

interface LedgerDoc {
  status?: "applied" | "blocked" | "failed";
  state?: string;
  appliedAt?: Date;
}

let lastReport: { ranAt: string; results: MigrationResult[] } | null = null;

/** 本轮结果（供后续接入 /health 或诊断端点；当前只用启动日志 + 手工 CLI）。 */
export function getMigrationHealth(): { ranAt: string; results: MigrationResult[] } | null {
  return lastReport;
}

/** 是否忽略终态标记、重新做一次状态判定。排查用；生产不建议常开。 */
export function isReverifyEnabled(): boolean {
  return String(process.env.MIGRATIONS_REVERIFY || "").trim().toLowerCase() === "true";
}

async function claimLock(db: Db, ttlMs: number): Promise<string | null> {
  const owner = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  try {
    // 条件更新 + upsert：文档存在但条件不满足时会走 insert，撞 _id 主键即代表锁已被持有。
    await db.collection(LEDGER_COLLECTION).findOneAndUpdate(
      { _id: LOCK_ID as unknown as never, lockedUntil: { $lt: now } },
      { $set: { owner, lockedUntil: now + ttlMs } },
      { upsert: true },
    );
    return owner;
  } catch (error) {
    if (error && typeof error === "object" && (error as { code?: number }).code === 11000) {
      return null;
    }
    throw error;
  }
}

async function releaseLock(db: Db, owner: string): Promise<void> {
  await db
    .collection(LEDGER_COLLECTION)
    .updateOne({ _id: LOCK_ID as unknown as never, owner }, { $set: { lockedUntil: 0, owner: "" } });
}

async function readLedger(db: Db, id: string): Promise<LedgerDoc | null> {
  const doc = await db.collection<LedgerDoc>(LEDGER_COLLECTION).findOne({ _id: id as unknown as never });
  return doc ?? null;
}

async function writeLedger(
  db: Db,
  id: string,
  patch: { status: "applied" | "blocked" | "failed"; state: string; actions: string[]; error?: string },
): Promise<void> {
  await db.collection(LEDGER_COLLECTION).updateOne(
    { _id: id as unknown as never },
    {
      $set: {
        ...patch,
        updatedAt: new Date(),
        // appliedAt 只在首次真正达标时写，复查时就靠它判断"标记何时落地"。
        ...(patch.status === "applied" ? { appliedAt: new Date() } : {}),
      },
    },
    { upsert: true },
  );
}

export interface RunMigrationsOptions {
  migrations: readonly SchemaMigration[];
  /** 忽略终态标记强制重跑（排查用）；仍遵守 blocked 判定。 */
  force?: boolean;
  /** 只观察不执行：打印计划但不写入。 */
  dryRun?: boolean;
  lockTtlMs?: number;
}

/**
 * 跑一遍所有迁移。逐条记录结果，不抛错。
 * 已标记 `applied` 的迁移会**在读一次标记后直接跳过**。
 */
export async function runSchemaMigrations(options: RunMigrationsOptions): Promise<MigrationResult[]> {
  const { migrations, force = false, dryRun = false, lockTtlMs = 5 * 60 * 1000 } = options;
  const results: MigrationResult[] = [];
  const reverify = isReverifyEnabled();

  if (!isConnected()) {
    logger.warn("[Migration] Mongo 未连接，跳过启动期迁移");
    return results;
  }

  const db = mongoose.connection.db;
  if (!db) {
    logger.warn("[Migration] 拿不到 db 句柄，跳过启动期迁移");
    return results;
  }

  // ── 第一层：终态短路 ──────────────────────────────────────────────
  // 已标记 applied 的迁移直接出结果，不进锁、不做状态检查。
  const pending: SchemaMigration[] = [];
  for (const migration of migrations) {
    if (dryRun) {
      pending.push(migration);
      continue;
    }
    let ledger: LedgerDoc | null = null;
    try {
      ledger = await readLedger(db, migration.id);
    } catch (error) {
      logger.warn("[Migration] 读取迁移标记失败，按待处理继续", {
        id: migration.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (!force && !reverify && ledger?.status === "applied") {
      results.push({
        id: migration.id,
        outcome: "already-marked",
        state: ledger.state ?? "applied",
        actions: [],
        at: new Date().toISOString(),
      });
      continue;
    }
    pending.push(migration);
  }

  if (pending.length === 0) {
    lastReport = { ranAt: new Date().toISOString(), results };
    logger.info("[Migration] 全部迁移已在库中标记完成，跳过检查", { count: results.length });
    return results;
  }

  const owner = await claimLock(db, lockTtlMs);
  if (!owner) {
    logger.info("[Migration] 其他实例正在执行迁移，本实例跳过", { pending: pending.map((m) => m.id) });
    return results;
  }

  try {
    for (const migration of pending) {
      let plan: MigrationPlan;
      try {
        plan = await migration.plan({ db });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("[Migration] 状态检查失败", { id: migration.id, error: message });
        if (!dryRun) {
          await writeLedger(db, migration.id, { status: "failed", state: "inspect_failed", actions: [], error: message });
        }
        results.push({ id: migration.id, outcome: "failed", state: "inspect_failed", actions: [], error: message, at: new Date().toISOString() });
        continue;
      }

      if (plan.blocked) {
        logger.error("[Migration] 状态不安全，已跳过（需人工介入）", {
          id: migration.id,
          state: plan.state,
          reason: plan.blockedReason,
        });
        if (!dryRun) {
          await writeLedger(db, migration.id, {
            status: "blocked",
            state: plan.state,
            actions: plan.actions,
            error: plan.blockedReason,
          });
        }
        results.push({
          id: migration.id,
          outcome: "blocked",
          state: plan.state,
          actions: plan.actions,
          error: plan.blockedReason,
          at: new Date().toISOString(),
        });
        continue;
      }

      // 状态已达标：只补标记，零写入（覆盖"手工建过索引但没写标记"的情况）。
      if (plan.actions.length === 0) {
        if (!dryRun) {
          await writeLedger(db, migration.id, { status: "applied", state: plan.state, actions: [] });
        }
        results.push({ id: migration.id, outcome: "skipped", state: plan.state, actions: [], at: new Date().toISOString() });
        continue;
      }

      if (dryRun) {
        logger.info("[Migration] 预演：不改动数据库", { id: migration.id, state: plan.state, actions: plan.actions });
        results.push({
          id: migration.id,
          outcome: "skipped",
          state: plan.state,
          actions: plan.actions,
          error: "dry-run",
          at: new Date().toISOString(),
        });
        continue;
      }

      try {
        logger.info("[Migration] 开始执行", { id: migration.id, state: plan.state, actions: plan.actions });
        await plan.apply?.();
        await writeLedger(db, migration.id, { status: "applied", state: plan.state, actions: plan.actions });
        logger.info("[Migration] 执行完成并已落库标记（后续启动将跳过）", { id: migration.id });
        results.push({ id: migration.id, outcome: "applied", state: plan.state, actions: plan.actions, at: new Date().toISOString() });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("[Migration] 执行失败（服务继续启动，请人工处理）", { id: migration.id, error: message });
        await writeLedger(db, migration.id, {
          status: "failed",
          state: plan.state,
          actions: plan.actions,
          error: message,
        });
        results.push({ id: migration.id, outcome: "failed", state: plan.state, actions: plan.actions, error: message, at: new Date().toISOString() });
      }
    }
  } finally {
    await releaseLock(db, owner).catch((error: unknown) => {
      logger.warn("[Migration] 释放迁移锁失败（锁会按 TTL 自然过期）", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    lastReport = { ranAt: new Date().toISOString(), results };
  }

  return results;
}
