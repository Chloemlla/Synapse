import logger from "../../utils/logger";
import { mongoose } from "../mongoService";
import { normalizeEmailCanonical } from "../blockedIdentityService";
import type { MigrationPlan, SchemaMigration } from "../migrationRunner";
import { ACTIVE_USER_PARTIAL_FILTER, USER_DELETED_FIELD } from "../../utils/softDeleteState";

export { ACTIVE_USER_PARTIAL_FILTER } from "../../utils/softDeleteState";

/**
 * RC-47：user_datas 的 email/username 改为活跃账号部分唯一索引，并回填身份墓碑。
 * schema 不会替换线上的旧索引，必须通过只读计划 + 显式 drop/create 完成。
 * failed/blocked 台账下次启动会重试；不改原迁移 id。
 * Db 从 mongoose 派生，避免镜像两份 mongodb 驱动的名义类型不兼容。
 */
type Db = NonNullable<typeof mongoose.connection.db>;

interface RawIndexDescription {
  name?: string;
  key: Record<string, unknown>;
  unique?: boolean;
  partialFilterExpression?: unknown;
  sparse?: boolean;
  hidden?: boolean;
  expireAfterSeconds?: unknown;
  collation?: { locale?: string };
}

const USERS = "user_datas";
const TOMBSTONES = "blocked_identities";

function indexKeyEquals(index: RawIndexDescription, field: string): boolean {
  const keys = Object.keys(index.key);
  return keys.length === 1 && keys[0] === field && index.key[field] === 1;
}

function isActivePartialFilter(filter: unknown): boolean {
  if (!filter || typeof filter !== "object") return false;
  const expression = filter as Record<string, unknown>;
  if (Object.keys(expression).length !== 1 || !Array.isArray(expression.$or) || expression.$or.length !== 2) {
    return false;
  }
  const values: unknown[] = [];
  for (const branch of expression.$or) {
    if (!branch || typeof branch !== "object" || Object.keys(branch).length !== 1) return false;
    if (!Object.prototype.hasOwnProperty.call(branch, USER_DELETED_FIELD)) return false;
    let value = (branch as Record<string, unknown>)[USER_DELETED_FIELD];
    // listIndexes 可以返回显式 $eq；只认相同的两个等值，不放行任意 partial。
    if (value && typeof value === "object") {
      const equality = value as Record<string, unknown>;
      if (Object.keys(equality).length !== 1 || !Object.prototype.hasOwnProperty.call(equality, "$eq")) return false;
      value = equality.$eq;
    }
    values.push(value);
  }
  return values.includes(0) && values.includes(null);
}

function isTargetPartialUnique(index: RawIndexDescription, field: string): boolean {
  return indexKeyEquals(index, field) && index.name === `${field}_1` && index.unique === true &&
    isActivePartialFilter(index.partialFilterExpression) && !index.sparse && !index.hidden &&
    index.expireAfterSeconds === undefined && (!index.collation || index.collation.locale === "simple");
}

async function readIndexes(db: Db): Promise<RawIndexDescription[]> {
  try {
    return await db.collection(USERS).indexes() as unknown as RawIndexDescription[];
  } catch (error) {
    // 新安装的集合还不存在；仅 NamespaceNotFound 当作空索引，连接/权限错误继续抛出。
    if (error && typeof error === "object" &&
      ((error as { code?: number }).code === 26 || (error as { codeName?: string }).codeName === "NamespaceNotFound")) {
      return [];
    }
    throw error;
  }
}

async function findActiveDuplicates(db: Db, field: string): Promise<string[]> {
  const rows = await db.collection(USERS).aggregate([
    { $match: ACTIVE_USER_PARTIAL_FILTER },
    { $group: { _id: `$${field}`, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: 10 },
  ], { collation: { locale: "simple" } }).toArray();
  return rows.map((row) => String(row._id));
}

async function countBackfillCandidates(db: Db): Promise<number> {
  // 只挑「被早期版本改名过」的账号：用户名已变成 deleted_<id>，原邮箱另有留存。
  return db.collection(USERS).countDocuments({
    deletedAt: { $gt: 0 },
    deletedOriginalEmail: { $type: "string", $ne: "" },
    username: { $regex: "^deleted_" },
  });
}

async function backfillTombstones(db: Db): Promise<number> {
  const users = db.collection(USERS);
  const tombstones = db.collection(TOMBSTONES);
  const candidates = await users
    .find(
      {
        deletedAt: { $gt: 0 },
        deletedOriginalEmail: { $type: "string", $ne: "" },
        username: { $regex: "^deleted_" },
      },
      { projection: { id: 1, username: 1, deletedOriginalEmail: 1, deletedOriginalUsername: 1, deleteReason: 1 } },
    )
    .toArray();

  let written = 0;
  for (const user of candidates) {
    const canonical = normalizeEmailCanonical(String(user.deletedOriginalEmail || ""));
    if (!canonical) continue;
    // upsert：同一身份重复退役时更新既有墓碑并清掉释放标记。
    await tombstones.updateOne(
      { emailCanonical: canonical },
      {
        $set: {
          emailCanonical: canonical,
          email: user.deletedOriginalEmail,
          username: user.deletedOriginalUsername || user.username,
          userId: user.id,
          reason: user.deleteReason || "account_deleted_backfill",
          blockedAt: new Date(),
          releasedBy: null,
          releasedAt: null,
        },
      },
      { upsert: true },
    );
    written += 1;
  }
  return written;
}

async function planMigration(ctx: { db: Db }, backfill: boolean = true): Promise<MigrationPlan> {
  const { db } = ctx;
  const collection = db.collection(USERS);
  const existing = await readIndexes(db);
  const fields = ["email", "username"] as const;
  const replacements: { field: string; drop: string[]; create: boolean }[] = [];
  const legacyToDrop: string[] = [];
  const foreignToNormalize: string[] = [];

  for (const field of fields) {
    const name = `${field}_1`;
    if (existing.some((index) => index.name === name && !indexKeyEquals(index, field))) {
      return {
        state: "foreign_name", actions: [], blocked: true,
        blockedReason: `索引名 ${name} 被其他键占用；不能自动删除无关索引。`,
      };
    }
    const same = existing.filter((index) => indexKeyEquals(index, field));
    const target = same.find((index) => isTargetPartialUnique(index, field));
    const drop: string[] = [];
    for (const index of same) {
      // External non-unique indexes can serve inactive-user queries without blocking identities.
      if (index === target || (index.name !== name && index.unique !== true)) continue;
      if (!index.name) throw new Error(`无法识别 ${field} 索引名`);
      drop.push(index.name);
      if (index.name === name && index.unique === true && index.partialFilterExpression === undefined) {
        legacyToDrop.push(index.name);
      } else {
        foreignToNormalize.push(index.name);
      }
    }
    if (drop.length > 0 || !target) replacements.push({ field, drop, create: !target });
  }

  async function duplicateReason(): Promise<string | undefined> {
    // email 仍有 full unique 不能证明缺失/错误 username 索引也安全，必须逐字段检查。
    for (const field of fields) {
      const duplicates = await findActiveDuplicates(db, field);
      if (duplicates.length > 0) {
        return `活跃账号存在重复的 ${field}（示例：${duplicates.slice(0, 3).join(", ")}）。` +
          "不能自动删除用户数据；请核查身份冲突后重试，blocked/failed 会在下次启动重试。";
      }
    }
    return undefined;
  }

  const blockedReason = await duplicateReason();
  if (blockedReason) return { state: "duplicates_active", actions: [], blocked: true, blockedReason };

  const backfillCount = backfill ? await countBackfillCandidates(db) : 0;
  const actions: string[] = [];
  for (const replacement of replacements) {
    for (const name of replacement.drop) actions.push(`drop 非目标索引 ${name}`);
    if (replacement.create) actions.push(`create ${replacement.field}_1（部分唯一索引，仅约束活跃账号）`);
  }
  if (backfillCount > 0) actions.push(`回填 ${backfillCount} 条身份墓碑`);

  const state = actions.length === 0 ? "already_migrated"
    : legacyToDrop.length > 0 ? "legacy_full_unique"
    : foreignToNormalize.length > 0 ? "foreign_unique"
    : existing.some((index) => fields.some((field) => indexKeyEquals(index, field))) ? "partial_incomplete"
    : "fresh";

  if (actions.length === 0) return { state, actions, blocked: false };

  return {
    state, actions, blocked: false,
    apply: async () => {
      // plan 与 apply 之间可能有写入，删除任何旧索引前再次检查。建索引期间的竞争由 Mongo
      // unique index build 拒绝；失败保留用户数据，下次计划会识别半迁移状态并补齐。
      const reason = await duplicateReason();
      if (reason) throw new Error(reason);
      for (const replacement of replacements) {
        // 每字段 drop 后立即 create，不能先把所有身份索引一起删光。
        for (const name of replacement.drop) {
          await collection.dropIndex(name);
          logger.info("[RC-47] 已移除非目标索引", { index: name });
        }
        if (replacement.create) {
          await collection.createIndex(
            { [replacement.field]: 1 },
            {
              unique: true, name: `${replacement.field}_1`,
              partialFilterExpression: ACTIVE_USER_PARTIAL_FILTER,
              // 固定二进制身份比较，避免集合默认 collation 改写唯一性与判重口径。
              collation: { locale: "simple" },
            },
          );
          logger.info("[RC-47] 已创建部分唯一索引", { index: `${replacement.field}_1` });
        }
      }
      if (backfill) {
        const written = await backfillTombstones(db);
        if (written > 0) logger.warn("[RC-47] 已回填身份墓碑", { written });
      }
    },
  };
}

export const rc47UserDataPartialUniqueIndexes: SchemaMigration = {
  id: "2026-10-10-rc47-user-datas-partial-unique-indexes",
  description: "user_datas 的 email/username 改为部分唯一索引，并回填身份墓碑（RC-47）",
  plan: planMigration,
};

/**
 * 旧判据可能把错误 partial filter 标记为 applied，必须用新 id 做一次定向复查。
 * 只修索引，不重放身份墓碑回填：否则会把管理员已经释放的墓碑重新封锁。
 */
export const rc47ActiveIndexFilterRepair: SchemaMigration = {
  id: "2026-10-24-rc47-active-index-filter-repair",
  description: "定向复查并修复 RC-47 活跃用户唯一索引过滤器",
  plan: (ctx) => planMigration(ctx, false),
};

/** 手工入口只运行 RC-47 家族；与启动期保持相同顺序，不绕过其他迁移的台账。 */
export const RC47_USER_DATA_MIGRATIONS: readonly SchemaMigration[] = [
  rc47UserDataPartialUniqueIndexes,
  rc47ActiveIndexFilterRepair,
];

/** 全部迁移（顺序即执行顺序）。新增迁移直接往这里加。 */
export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [...RC47_USER_DATA_MIGRATIONS];
