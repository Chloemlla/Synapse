/**
 * 一次性迁移：把审计日志的 TTL 从旧值（90 天）改成当前的
 * `AUDIT_LOG_RETENTION_DAYS`（60 天）。
 *
 * 为什么需要单独一个脚本：MongoDB **不会**因为 schema 里改了 `expireAfterSeconds`
 * 就更新已有索引 —— TTL 选项是索引的物理属性，同名不同选项时 Mongoose 的 autoIndex
 * 只会报一次错，什么也不会改。也就是说：只改代码 + 重启，线上仍然按 90 天过期，
 * 而界面上的「保留 60 天」已经变了 —— 这种「声明与行为不一致」正是最该避免的。
 *
 * 两条路，脚本自动选：
 *   1. `collMod`（MongoDB ≥ 5.1）：**原地**改 TTL，不重建索引，集合多大都是瞬间完成；
 *   2. 退路：`dropIndex` + `createIndex`（老版本服务器）。大集合上会重建索引，耗时较长。
 *
 * 幂等：已是目标值则什么都不做，只打印现状。可重复执行。
 *
 * 用法：`ts-node src/scripts/applyAuditLogTtl.ts`（本机不要跑，交给部署侧执行）
 */
import { AuditLogModel, AUDIT_LOG_RETENTION_DAYS } from "../models/auditLogModel";
import { connectMongo, mongoose } from "../services/mongoService";
import logger from "../utils/logger";

const TARGET_SECONDS = AUDIT_LOG_RETENTION_DAYS * 24 * 60 * 60;

interface IndexInfo {
  name?: string;
  key?: Record<string, number>;
  expireAfterSeconds?: number;
}

function describeTtl(index: IndexInfo): string {
  if (typeof index.expireAfterSeconds !== "number") return "无 TTL";
  const days = index.expireAfterSeconds / (24 * 60 * 60);
  return `${index.expireAfterSeconds}s（约 ${Number.isInteger(days) ? days : days.toFixed(2)} 天）`;
}

/**
 * 找到既有 TTL 索引：按**形状**判定（`createdAt: 1` 且带 expireAfterSeconds），不按名字。
 * 历史索引名是隐式的 `createdAt_1`，写死名字反而在存量库上找不到。
 */
function findTtlIndex(indexes: IndexInfo[]): IndexInfo | undefined {
  return indexes.find((index) => index.key?.createdAt === 1 && typeof index.expireAfterSeconds === "number");
}

async function run(): Promise<void> {
  await connectMongo();
  const collection = AuditLogModel.collection;

  const before = (await collection.indexes()) as IndexInfo[];
  const existing = findTtlIndex(before);

  logger.info("[audit-ttl] 当前 TTL 索引", {
    name: existing?.name ?? "(未找到)",
    ttl: existing ? describeTtl(existing) : "-",
    target: `${TARGET_SECONDS}s（${AUDIT_LOG_RETENTION_DAYS} 天）`,
  });

  if (existing && existing.expireAfterSeconds === TARGET_SECONDS) {
    logger.info("[audit-ttl] 已是目标保留期，无需变更");
    return;
  }

  // collMod / dropIndex 都按实际索引名定位（存量库是隐式的 createdAt_1）。
  const indexName = existing?.name || "createdAt_1";

  // 1. 原地改：MongoDB ≥ 5.1 支持 collMod 修改 TTL；不支持时会抛错，走退路。
  try {
    const db = mongoose.connection.db;
    if (!db) throw new Error("Mongo 连接不可用");
    await db.command({
      collMod: collection.collectionName,
      index: { name: indexName, expireAfterSeconds: TARGET_SECONDS },
    });
    logger.info("[audit-ttl] 已通过 collMod 原地更新 TTL", {
      indexName,
      ttl: describeTtl({ expireAfterSeconds: TARGET_SECONDS }),
    });
  } catch {
    logger.warn("[audit-ttl] collMod 不可用，改用 dropIndex + createIndex（大集合上会重建索引，耗时较长）", {
      indexName,
    });
    if (existing?.name) {
      await collection.dropIndex(existing.name);
    }
    await collection.createIndex({ createdAt: 1 }, { expireAfterSeconds: TARGET_SECONDS });
    logger.info("[audit-ttl] 已重建 TTL 索引", { indexName });
  }

  const after = (await collection.indexes()) as IndexInfo[];
  const finalIndex = findTtlIndex(after);
  logger.info("[audit-ttl] 完成", {
    name: finalIndex?.name ?? "(未找到)",
    ttl: finalIndex ? describeTtl(finalIndex) : "-",
  });
}

if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error("[audit-ttl] 迁移失败", error);
      process.exit(1);
    });
}

export { run as applyAuditLogTtl };
