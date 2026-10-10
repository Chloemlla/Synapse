/**
 * RC-47 迁移的手工入口（自动触发版见 services/migrationRunner，启动时自动执行）。
 *
 * 为什么还要留手工入口：
 *   - 排障时想先看状态而不改库（`--dry-run`）；
 *   - 迁移曾被判 `blocked`（如活跃账号有重复邮箱），人工去重后需要主动重跑（`--force`）；
 *   - 有人手工删坏了索引，需要复查（`--reverify`）。
 *
 * 与启动期同一套实现（`rc47UserDataPartialUniqueIndexes`），不重复写第二份索引逻辑 ——
 * 两份实现必然漂移，这是本仓已经反复踩过的坑。
 *
 * 用法：
 *   pnpm run migrate:rc47-indexes -- --dry-run
 *   pnpm run migrate:rc47-indexes -- --force
 *   pnpm run migrate:rc47-indexes -- --reverify
 */
import { connectMongo } from "../../src/services/mongoService";
import { runSchemaMigrations } from "../../src/services/migrationRunner";
import { rc47UserDataPartialUniqueIndexes } from "../../src/services/migrations/rc47UserDataPartialUniqueIndexes";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");
  const reverify = args.includes("--reverify");

  // runner 通过 env 开关决定是否忽略终态标记；CLI 的 --reverify 映射到它。
  if (reverify) process.env.MIGRATIONS_REVERIFY = "true";

  await connectMongo();

  const results = await runSchemaMigrations({
    migrations: [rc47UserDataPartialUniqueIndexes],
    dryRun,
    force,
  });

  const summary = results.map((r) => `${r.id}: ${r.outcome} (state=${r.state})${r.error ? ` error=${r.error}` : ""}`);
  if (summary.length === 0) summary.push("（无结果：Mongo 未连接或已被其他实例接管）");

  console.log(`\n[RC-47 迁移] 模式：${dryRun ? "DRY-RUN（未写入）" : force ? "FORCE" : "常规"}`);
  summary.forEach((line) => console.log(`  - ${line}`));

  const failed = results.filter((r) => r.outcome === "failed" || r.outcome === "blocked");
  if (failed.length > 0) {
    console.error("\n存在失败/被阻断的迁移，请按上面的 error 处理后再重跑。");
    process.exit(1);
  }
  console.log("\n[RC-47 迁移] 完成。");
  process.exit(0);
}

main().catch((error) => {
  console.error("[RC-47 迁移] 异常：", error);
  process.exit(1);
});
