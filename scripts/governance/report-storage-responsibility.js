#!/usr/bin/env node

// 存储职责核对（只报告，从不失败）。
//
// 背景：本仓库的存储分工是「MongoDB = 主持久层，Redis = 短期/共享状态（限流、nonce、IP 封禁加速），
// 文件 = 运行期目录/音频缓存/日志/降级」。分工是否被破坏，靠人肉 review 很难发现：新增一个
// 「带 expiresAt 的缓存集合」或者「进程内 Map 当共享状态」都不会报错，只会在多实例或长跑之后
// 以写放大、无界增长、跨实例不一致的形式暴露。
//
// 这个脚本把两件事摆到 CI 日志里（不判定、不阻断）：
//   1. Mongo 侧：哪些 Schema 带过期字段（expiresAt / ttlExpireAt），其中哪些真的建了 TTL 索引
//      （expireAfterSeconds）、哪些只是普通索引或应用级定时清理（需要留意）；
//   2. 进程内状态：services/middleware/utils 里新增的模块级 Map/Set（跨实例不共享、重启即丢，
//      需要显式确认「是不是共享状态」）。
//
// 判定规则与已核对结论见 docs/audit/audit-2026-10-01-storage-responsibility.md。

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");

function walk(dir, filter) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "generated") return [];
      return walk(full, filter);
    }
    return entry.isFile() && filter(full) ? [full] : [];
  });
}

const rel = (file) => path.relative(root, file).replace(/\\/g, "/");
const isTs = (file) => file.endsWith(".ts") && !file.endsWith(".d.ts");

const EXPIRY_FIELD_PATTERN = /\b(expiresAt|expireAt|ttlExpireAt|expiredAt)\b\s*:/g;
const COLLECTION_PATTERN = /collection:\s*["'`]([^"'`]+)["'`]/g;
const TTL_INDEX_PATTERN = /expireAfterSeconds/;
const SCHEMA_PATTERN = /new mongoose\.Schema\s*[<(]/;

/** 模块级 Map/Set：文件顶层（列 0）声明、且名字看起来是进程内状态的情况。 */
// 只报「状态型」名字（camelCase）的 Map/Set；全大写名字（ALLOWED_HOSTS 之类）基本是常量白名单，
// 进报告只会淹没真正需要确认的共享状态。
const MODULE_LEVEL_STATE_PATTERN = /^(?:export\s+)?const\s+([a-z][A-Za-z0-9_$]*)\s*=\s*new\s+(Map|Set|WeakMap|WeakSet)\b/gm;

function scanMongo() {
  const rows = [];
  for (const file of [...walk(path.join(root, "src", "models"), isTs), ...walk(path.join(root, "src", "services"), isTs)]) {
    const source = fs.readFileSync(file, "utf8");
    if (!SCHEMA_PATTERN.test(source)) continue;

    const collections = [...source.matchAll(COLLECTION_PATTERN)].map((match) => match[1]);
    const expiryFields = [...new Set([...source.matchAll(EXPIRY_FIELD_PATTERN)].map((match) => match[1]))];
    if (collections.length === 0 && expiryFields.length === 0) continue;

    rows.push({
      file: rel(file),
      collections,
      expiryFields,
      hasTtlIndex: TTL_INDEX_PATTERN.test(source),
    });
  }
  return rows.sort((a, b) => a.file.localeCompare(b.file));
}

function scanProcessState() {
  const rows = [];
  const dirs = ["services", "middleware", "utils"].map((name) => path.join(root, "src", name));
  for (const dir of dirs) {
    for (const file of walk(dir, isTs)) {
      const source = fs.readFileSync(file, "utf8");
      const names = [...source.matchAll(MODULE_LEVEL_STATE_PATTERN)].map((match) => `${match[1]} (${match[2]})`);
      if (names.length > 0) rows.push({ file: rel(file), names });
    }
  }
  return rows.sort((a, b) => b.names.length - a.names.length || a.file.localeCompare(b.file));
}

const mongoRows = scanMongo();
const ttlRows = mongoRows.filter((row) => row.hasTtlIndex);
const expiryWithoutTtl = mongoRows.filter((row) => row.expiryFields.length > 0 && !row.hasTtlIndex);
const stateRows = scanProcessState();

console.log("=== Mongo 集合：过期字段 vs TTL 索引（信息性） ===");
for (const row of mongoRows) {
  const collections = row.collections.length > 0 ? row.collections.join(", ") : "(内联集合名未在同一文件)";
  const expiry = row.expiryFields.length > 0 ? row.expiryFields.join(", ") : "-";
  console.log(`  ${row.file}: [${collections}] 过期字段=${expiry} TTL索引=${row.hasTtlIndex ? "有" : "无"}`);
}
console.log(`  合计 ${mongoRows.length} 个 Schema 文件，其中 ${ttlRows.length} 个带 TTL 索引。`);

if (expiryWithoutTtl.length > 0) {
  console.log("\n=== 注意：带过期字段但没有 TTL 索引（可能靠应用级定时清理，需人工确认） ===");
  for (const row of expiryWithoutTtl) {
    console.log(`  ${row.file}: 过期字段=${row.expiryFields.join(", ")}`);
  }
}

console.log("\n=== 进程内状态（跨实例不共享、重启即丢；多实例部署前必须逐项确认） ===");
for (const row of stateRows.slice(0, 15)) {
  console.log(`  ${row.file}: ${row.names.join(", ")}`);
}
if (stateRows.length > 15) {
  console.log(`  ...另有 ${stateRows.length - 15} 个文件命中，完整清单见 docs/audit/audit-2026-10-01-storage-responsibility.md`);
}
console.log(`  合计 ${stateRows.length} 个文件声明了状态型模块级 Map/Set（全大写常量白名单已排除）。`);

console.log("\n（本步骤只做可见性，不判定对错、不阻断构建；判定规则见上述审计文档。）");
