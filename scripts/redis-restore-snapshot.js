#!/usr/bin/env node
"use strict";

/**
 * 把管理端「导出快照」产出的 NDJSON 恢复回 Redis。
 *
 * 快照格式（`GET /api/admin/system/redis/export`）：一行一条 JSON，其中
 * `{ "kind": "key", "key", "ttlMs", "dumpBase64" }` 就是 `DUMP` 的原始序列化内容
 * （与 RDB 单键编码一致），`ttlMs = -1` 表示无过期。本脚本用 `RESTORE` 原样写回，
 * 因此类型、编码、TTL 都被保留 —— 这是「逻辑快照」相对逐条 SET 的价值。
 *
 * 默认是 **dry-run**：必须显式 `--apply` 才会真正写库；`--replace` 才会覆盖同名键。
 * 之所以这么设计：恢复动作本身有破坏性（覆盖/丢 TTL），误跑一次的代价远大于多打一个参数。
 *
 * 用法：
 *   node scripts/redis-restore-snapshot.js --file snapshot.ndjson
 *   node scripts/redis-restore-snapshot.js --file snapshot.ndjson --url redis://127.0.0.1:6379 --apply --replace
 *   node scripts/redis-restore-snapshot.js --file snapshot.ndjson --apply --filter 'cache:'
 *
 * 可选参数：
 *   --url <url>       Redis 连接串；缺省读 REDIS_URL / REDIS_URI
 *   --filter <prefix> 只恢复键名以该前缀开头的记录
 *   --apply           真正写库（缺省只打印将要执行的动作）
 *   --replace         允许覆盖已存在的键（RESTORE 默认遇到已存在键会失败）
 *   --limit <n>       最多处理 n 条键记录（排练用）
 */

const fs = require("node:fs");
const readline = require("node:readline");
const path = require("node:path");

function parseArgs(argv) {
  const options = { apply: false, replace: false, url: "", file: "", filter: "", limit: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") options.apply = true;
    else if (arg === "--replace") options.replace = true;
    else if (arg === "--url") options.url = argv[++i] || "";
    else if (arg === "--file") options.file = argv[++i] || "";
    else if (arg === "--filter") options.filter = argv[++i] || "";
    else if (arg === "--limit") options.limit = Number.parseInt(argv[++i] || "0", 10) || 0;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else {
      console.error(`未知参数: ${arg}`);
      options.help = true;
    }
  }
  return options;
}

function printUsage() {
  console.log(
    [
      "用法: node scripts/redis-restore-snapshot.js --file <snapshot.ndjson> [--url <redis-url>] [--apply] [--replace] [--filter <prefix>] [--limit <n>]",
      "",
      "默认 dry-run（只打印将执行的动作）；--apply 才真正写库。",
      "连接串缺省读环境变量 REDIS_URL / REDIS_URI。",
    ].join("\n"),
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !options.file) {
    printUsage();
    process.exitCode = options.help ? 0 : 1;
    return;
  }

  const filePath = path.resolve(options.file);
  if (!fs.existsSync(filePath)) {
    console.error(`快照文件不存在: ${filePath}`);
    process.exitCode = 1;
    return;
  }

  const url = options.url || process.env.REDIS_URL || process.env.REDIS_URI || "";
  if (options.apply && !url) {
    console.error("缺少 Redis 连接串：传 --url，或设置 REDIS_URL / REDIS_URI");
    process.exitCode = 1;
    return;
  }

  let client = null;
  let createClient = null;
  if (options.apply) {
    ({ createClient } = require("redis"));
    client = createClient({ url });
    client.on("error", (error) => console.error("Redis 错误:", error.message));
    await client.connect();
  }

  const stats = { meta: 0, total: 0, restored: 0, skipped: 0, failed: 0, truncated: false };
  const failures = [];

  const rl = readline.createInterface({ input: fs.createReadStream(filePath, "utf8"), crlfDelay: Infinity });

  try {
    for await (const rawLine of rl) {
      const line = rawLine.trim();
      if (!line) continue;

      let record;
      try {
        record = JSON.parse(line);
      } catch {
        stats.failed += 1;
        failures.push("无法解析的 NDJSON 行（已跳过）");
        continue;
      }

      if (record.kind === "meta" || record.kind === "summary" || record.kind === "error" || record.kind === "skip") {
        if (record.kind === "meta") stats.meta += 1;
        if (record.kind === "summary" && record.truncated) stats.truncated = true;
        continue;
      }
      if (record.kind !== "key" || typeof record.key !== "string" || typeof record.dumpBase64 !== "string") continue;

      stats.total += 1;
      if (options.limit > 0 && stats.restored + stats.skipped >= options.limit) break;
      if (options.filter && !record.key.startsWith(options.filter)) {
        stats.skipped += 1;
        continue;
      }

      // ttlMs = -1（无过期）→ RESTORE 的 0；-2（键已不存在）没有可恢复内容，跳过。
      const ttl = typeof record.ttlMs === "number" && record.ttlMs > 0 ? record.ttlMs : 0;
      if (typeof record.ttlMs === "number" && record.ttlMs === -2) {
        stats.skipped += 1;
        continue;
      }
      const payload = Buffer.from(record.dumpBase64, "base64");

      if (!options.apply) {
        if (stats.restored < 20) console.log(`[dry-run] RESTORE ${record.key} ${ttl} (${payload.length} B)`);
        stats.restored += 1;
        continue;
      }

      try {
        await client.restore(record.key, ttl, payload, { REPLACE: options.replace });
        stats.restored += 1;
      } catch (error) {
        stats.failed += 1;
        if (failures.length < 20) failures.push(`${record.key}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    if (client) await client.quit().catch(() => {});
  }

  console.log(
    [
      `快照文件: ${filePath}`,
      `模式: ${options.apply ? "APPLY（已写库）" : "dry-run（未写库）"}`,
      `键记录: ${stats.total} · 成功 ${stats.restored} · 跳过 ${stats.skipped} · 失败 ${stats.failed}`,
      stats.truncated ? "注意: 快照自身标记为 truncated（导出时达到 maxKeys 上限），并非全量。" : "",
      failures.length ? `首批失败样本:\n  - ${failures.join("\n  - ")}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );

  if (stats.failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("恢复失败:", error);
  process.exitCode = 1;
});
