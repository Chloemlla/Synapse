#!/usr/bin/env node
/**
 * 前端侧的版本同步入口。
 *
 * 真正的实现在仓库根的 `scripts/sync-package-version.mjs`（根 package.json 与
 * frontend/package.json 都要跟着日期走）。这里只做一件事：**在「只上传 frontend/」
 * 的构建上下文里优雅降级**。
 *
 * 为什么需要这一层：Vercel 若把 Root Directory 设成 `frontend/`，构建上下文里没有
 * 仓库根目录，`../scripts/` 不存在 —— 直接调用根脚本会让 `build:vercel` 以 ENOENT
 * 失败。而根目录版 `vercel.json`（`cd frontend && pnpm run build:vercel`）里它是存在的。
 * 两种布局都要能构建，所以这里先探测再委派；缺失时只告警、不阻断构建：
 * Vercel 产物不是发布镜像，版本号留成仓库里提交的那份即可。
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 本文件位于 <repo>/frontend/scripts/，根脚本在 <repo>/scripts/。 */
const SHARED = path.resolve(HERE, "../../scripts/sync-package-version.mjs");

if (!fs.existsSync(SHARED)) {
  console.warn(
    `[version] 找不到 ${SHARED}（当前构建上下文只包含 frontend/），跳过版本号同步。`,
  );
  process.exit(0);
}

try {
  execFileSync(process.execPath, [SHARED, ...process.argv.slice(2)], { stdio: "inherit" });
} catch (error) {
  // 把子进程的非零退出码原样透传：`--check` 判定漂移时必须以失败结束。
  process.exit(typeof error.status === "number" ? error.status : 1);
}
