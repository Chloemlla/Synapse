import type { Db, Document, IndexDescriptionInfo } from "mongodb";
import logger from "../utils/logger";
import { normalizeEmailCanonical } from "../blockedIdentityService";
import type { MigrationPlan, SchemaMigration } from "../migrationRunner";

/**
 * RC-47 迁移（自动触发版）：`user_datas` 的 email/username 改为**部分唯一索引** + 回填身份墓碑。
 *
 * 为什么必须由迁移而非"改 schema 声明"完成：
 *   Mongoose 默认 autoIndex=true，会按 schema 建索引。线上已存在 `email_1` / `username_1`
 *   （unique、无 partialFilterExpression）；同 key spec 不同 options 时 MongoDB 返回
 *   IndexOptionsConflict / IndexKeySpecsConflict —— **新索引建不出来、旧索引还在**。
 *   于是"活跃账号唯一性"在开发正常、线上静默失效。必须显式 drop 再 create。
 *
 * 状态判定（只读，供 runner 决策；见下方 plan）：
 *   - `fresh`              集合为空/无相关索引 → 直接建
 *   - `already_migrated`   两条索引已是目标形状 → 无动作（runner 只补标记）
 *   - `legacy_full_unique` 旧的全量唯一索引 → drop + create
 *   - `partial_incomplete` 旧索引已删、部分索引缺一条 → 补齐
 *   - `duplicates_active`  活跃账号存在重复 email/username → **blocked**（绝不先删）
 *   - `foreign_unique`     同 key spec 但名字/选项非预期 → 规范化（drop + create）
 */

const USERS = "user_datas";
const TOMBSTONES = "blocked_identities";

/**
 * 「活跃账号」的部分索引过滤条件。
 * 与 `utils/softDeleteState.ts` 的 `activeUserFilter()` 语义相同（deletedAt 为 0 或缺失），
 * 但改用 `$or` + 等值/`$exists` 这组**部分索引最保守的运算符子集**，避开表达式被拒的风险。
 *
 * ⚠ 不能用 `{ deletedAt: { $eq: null } }`：本模型的 deletedAt 是**数字 0** 表示未删除，
 * `$eq: null` 只匹配「缺失或 null」，不会匹配 0 —— 那会把全部存量活跃账号排除在索引之外，
 * 等于把邮箱唯一性直接取消（比它要解决的洗白问题更严重）。
 */
export const ACTIVE_USER_PARTIAL_FILTER = {
  $or: [{ deletedAt: 0 }, { deletedAt: { $exists: false } }],
} as const;

function indexKeyEquals(index: IndexDescriptionInfo, field: string): boolean {
  const key = index.key as Record<string, unknown>;
  const keys = Object.keys(key);
  return keys.length === 1 && keys[0] === field && key[field] === 1;
}

function isTargetPartialUnique(index: IndexDescriptionInfo): boolean {
  return index.unique === true && index.partialFilterExpression !== undefined;
}

async function findActiveDuplicates(db: Db, field: string): Promise<string[]> {
  const rows = await db
    .collection(USERS)
    .aggregate([
      { $match: ACTIVE_USER_PARTIAL_FILTER },
      { $group: { _id: `$${field}`, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $limit: 10 },
    ])
    .toArray();
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

async function planMigration(ctx: { db: Db }): Promise<MigrationPlan> {
  const { db } = ctx;
  const collection = db.collection(USERS);
  // mongodb@7 的类型叫 IndexDescriptionInfo（IndexDescription 少了 key/version），不要写错。
  const existing: IndexDescriptionInfo[] = await collection.indexes();

  const fields = ["email", "username"] as const;
  const missingTarget: string[] = [];
  const legacyToDrop: string[] = [];
  const foreignToNormalize: string[] = [];

  for (const field of fields) {
    const same = existing.filter((index) => indexKeyEquals(index, field));
    const target = same.find((index) => isTargetPartialUnique(index));
    if (target) continue;
    if (same.length === 0) {
      missingTarget.push(field);
      continue;
    }
    for (const index of same) {
      const name = String(index.name || `${field}_1`);
      // 名字就是 Mongoose 默认名但选项不对 → 旧的全量唯一索引；否则属外部/历史命名。
      if (name === `${field}_1` && index.unique === true) legacyToDrop.push(name);
      else foreignToNormalize.push(name);
    }
    missingTarget.push(field);
  }

  const backfillCount = await countBackfillCandidates(db);
  const actions: string[] = [];

  // 先判不安全状态：有重复就没法建唯一索引，且绝不能"先删数据再说"。
  if (legacyToDrop.length === 0) {
    // 旧索引还在时不可能有活跃重复（全量唯一索引已挡住），所以只需在它缺席时检查。
    for (const field of fields) {
      const duplicates = await findActiveDuplicates(db, field);
      if (duplicates.length > 0) {
        return {
          state: "duplicates_active",
          actions: [],
          blocked: true,
          blockedReason:
            `活跃账号存在重复的 ${field}（示例：${duplicates.slice(0, 3).join(", ")}）。` +
            `建唯一索引会失败，且不能自动删除用户数据 —— 需人工去重后重跑（设 MIGRATIONS_REVERIFY=true）。`,
        };
      }
    }
  }

  for (const name of legacyToDrop) actions.push(`drop 旧全量唯一索引 ${name}`);
  for (const name of foreignToNormalize) actions.push(`drop 非预期索引 ${name}`);
  for (const field of missingTarget) actions.push(`create ${field}_1（部分唯一索引，仅约束活跃账号）`);
  if (backfillCount > 0) actions.push(`回填 ${backfillCount} 条身份墓碑`);

  const state =
    actions.length === 0
      ? "already_migrated"
      : legacyToDrop.length > 0
        ? "legacy_full_unique"
        : missingTarget.length > 0
          ? "partial_incomplete"
          : "fresh";

  if (actions.length === 0) {
    return { state, actions, blocked: false };
  }

  return {
    state,
    actions,
    blocked: false,
    apply: async () => {
      for (const name of [...legacyToDrop, ...foreignToNormalize]) {
        await collection.dropIndex(name);
        logger.info("[RC-47] 已移除旧索引", { index: name });
      }
      for (const field of missingTarget) {
        await collection.createIndex(
          { [field]: 1 },
          {
            unique: true,
            name: `${field}_1`,
            partialFilterExpression: ACTIVE_USER_PARTIAL_FILTER as unknown as Document,
          },
        );
        logger.info("[RC-47] 已创建部分唯一索引", { index: `${field}_1` });
      }
      const written = await backfillTombstones(db);
      if (written > 0) logger.warn("[RC-47] 已回填身份墓碑", { written });
    },
  };
}

export const rc47UserDataPartialUniqueIndexes: SchemaMigration = {
  id: "2026-10-10-rc47-user-datas-partial-unique-indexes",
  description: "user_datas 的 email/username 改为部分唯一索引，并回填身份墓碑（RC-47）",
  plan: planMigration,
};

/** 全部迁移（顺序即执行顺序）。新增迁移直接往这里加。 */
export const SCHEMA_MIGRATIONS: readonly SchemaMigration[] = [rc47UserDataPartialUniqueIndexes];
