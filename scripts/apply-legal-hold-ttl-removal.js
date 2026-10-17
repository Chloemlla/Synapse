#!/usr/bin/env node
/**
 * RC-22 / 裁决三（D8）：把关键集合的物理 TTL 索引摘掉，改由应用层清理。
 *
 * 为什么必须有这一步：schema 里删掉 `expireAfterSeconds` 只影响**新建**索引；
 * 线上已经建好的 TTL 索引不会因为代码变更消失，Mongo 后台线程仍会绕开
 * legal_holds 直接删文档（这正是 RC-22.2 记录的竞态）。
 *
 * 用法：
 *   node scripts/apply-legal-hold-ttl-removal.js            # 只打印将要做什么（dry-run）
 *   node scripts/apply-legal-hold-ttl-removal.js --apply    # 真正 dropIndex
 *
 * 安全约束（与 methodology「破坏性操作先看现状」一致）：
 *  - 默认 dry-run，不带 --apply 不动库；
 *  - 按**索引形状**匹配（键 + expireAfterSeconds），不按名字盲删 —— 历史部署的
 *    索引名可能不同；
 *  - 同名但形状不同的索引一律跳过并打印，绝不动非 TTL 索引；
 *  - 每个集合逐条打印 before/after。
 *
 * 连接串取 MONGODB_URI / MONGO_URI，其次 config 默认值；库名取连接串里的库。
 */

const { MongoClient } = require('mongodb');

const APPLY = process.argv.includes('--apply');

/** 与 legalHoldCleanupService.LEGAL_HOLD_CLEANUP_TARGETS 对齐的关键集合。 */
const TARGETS = [
  { collection: 'ipbans', key: { expiresAt: 1 } },
  { collection: 'accesstokens', key: { expiresAt: 1 } },
  { collection: 'ip_verification_tokens', key: { expiresAt: 1 } },
  { collection: 'verification_tokens', key: { ttlExpireAt: 1 } },
  { collection: 'proxycheck_risk_cache', key: { expiresAt: 1 } },
  { collection: 'auth_email_cooldowns', key: { expiresAt: 1 } },
];

function sameKey(indexKey, expected) {
  const entries = Object.entries(expected);
  if (!indexKey || Object.keys(indexKey).length !== entries.length) return false;
  return entries.every(([field, direction]) => indexKey[field] === direction);
}

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI || 'mongodb://localhost:27017/synapse';
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db();
  console.log(`[legal-hold-ttl] 目标库: ${db.databaseName}${APPLY ? '' : '（dry-run，加 --apply 才执行）'}`);

  let dropped = 0;
  let missing = 0;

  for (const target of TARGETS) {
    let indexes;
    try {
      indexes = await db.collection(target.collection).listIndexes().toArray();
    } catch (error) {
      if (error && (error.code === 26 || error.codeName === 'NamespaceNotFound')) {
        console.log(`  - ${target.collection}: 集合不存在，跳过`);
        missing += 1;
        continue;
      }
      throw error;
    }

    const targets = indexes.filter(
      (index) => sameKey(index.key, target.key) && Number(index.expireAfterSeconds) >= 0,
    );
    if (targets.length === 0) {
      console.log(`  - ${target.collection}.${JSON.stringify(target.key)}: 已无 TTL 索引`);
      continue;
    }
    for (const index of targets) {
      console.log(
        `  - ${target.collection} 索引 ${index.name}（${JSON.stringify(index.key)}, expireAfterSeconds=${index.expireAfterSeconds}）`,
      );
      if (APPLY) {
        await db.collection(target.collection).dropIndex(index.name);
        console.log(`    → 已删除 ${index.name}`);
        dropped += 1;
      }
    }
  }

  await client.close();
  console.log(
    APPLY
      ? `[legal-hold-ttl] 完成：删除 ${dropped} 个 TTL 索引${missing ? `，${missing} 个集合不存在` : ''}`
      : '[legal-hold-ttl] dry-run 结束；确认无误后加 --apply 重跑。',
  );
}

main().catch((error) => {
  console.error('[legal-hold-ttl] 失败:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
