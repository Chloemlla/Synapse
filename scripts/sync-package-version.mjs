#!/usr/bin/env node
/**
 * 构建期版本号注入：把 package.json 的 `version` 同步成**当天（UTC+8）的日期**。
 *
 * 格式：`YY.MM.DD`（月/日补零），例如 2026-09-01 → `26.09.01`、2026-10-17 → `26.10.17`。
 * 为什么是这个格式而不是 semver 的 `1.2.3`：这个数字不表达兼容性承诺，只回答
 * 「这份产物是哪天的」。补零让三段宽度固定，排序与肉眼比对都更稳
 * （`26.9.10` 与 `26.10.1` 不补零时按字典序会排反）。
 *
 * 为什么必须显式指定时区：构建机可能是 UTC（GitHub Actions 默认），也可能是
 * Asia/Shanghai（本地开发机）。用 `Intl` 显式指定 `Asia/Shanghai`，两边算出来的
 * 日期一致；直接读 `new Date()` 的本地字段会在 UTC 机器上把「晚上 8 点后」算成前一天。
 *
 * 用法：
 *   node scripts/sync-package-version.mjs           # 写入（幂等，无变化时不落盘）
 *   node scripts/sync-package-version.mjs --check   # 只校验，漂移时退出码 1
 *   node scripts/sync-package-version.mjs --print   # 只打印今天应得的版本号
 *   node scripts/sync-package-version.mjs --print --at 2026-09-01T00:00:00Z
 *                                                  # 打印指定时刻应得的版本号（用于验证边界）
 *
 * 该脚本被 `build:backend` / `build:frontend` 与 Dockerfile 的构建阶段调用，
 * 因此**不能依赖任何第三方包**，也不能假设 `frontend/` 一定存在
 * （backend 构建阶段只拷了仓库根，见 Dockerfile）。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 脚本位于 <repo>/scripts/，仓库根就是上一级。Docker 里同样成立（/app/scripts → /app）。 */
const REPO_ROOT = path.resolve(HERE, "..");

const BUILD_TIME_ZONE = "Asia/Shanghai";
/** 同步目标：仓库根与前端各自有一份 package.json，两份都要跟着日期走。 */
const TARGET_FILES = ["package.json", path.join("frontend", "package.json")];

/**
 * 按指定时区把某一时刻格式化成 `YY.MM.DD`。
 * 导出是为了让用例能钉住「跨 UTC 午夜」这类边界，而不是靠改系统时间。
 */
export function formatBuildVersion(date = new Date(), timeZone = BUILD_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(date);

  const pick = (type) => {
    const found = parts.find((part) => part.type === type);
    const value = found ? Number.parseInt(found.value, 10) : Number.NaN;
    if (!Number.isFinite(value)) {
      throw new Error(`无法从日期中解析 ${type}（timeZone=${timeZone}）`);
    }
    return value;
  };

  const year = pick("year");
  const month = pick("month");
  const day = pick("day");
  // 月/日补零：固定三段宽度，避免 26.9.10 与 26.10.1 在字典序上排反。
  const pad2 = (value) => String(value).padStart(2, "0");
  return `${String(year % 100).padStart(2, "0")}.${pad2(month)}.${pad2(day)}`;
}

/** 读改写单个 package.json，保留原有的 2 空格缩进与结尾换行。 */
function syncFile(relativePath, version, { check }) {
  const absolutePath = path.join(REPO_ROOT, relativePath);
  if (!fs.existsSync(absolutePath)) {
    // backend 构建阶段只拷了仓库根：这个阶段的 frontend/package.json 不存在，跳过即可。
    return { file: relativePath, status: "skipped" };
  }

  const raw = fs.readFileSync(absolutePath, "utf-8");
  const parsed = JSON.parse(raw);
  const current = typeof parsed.version === "string" ? parsed.version : "";

  if (current === version) return { file: relativePath, status: "unchanged", current };
  if (check) return { file: relativePath, status: "drift", current };

  parsed.version = version;
  const trailingNewline = raw.endsWith("\n") ? "\n" : "";
  fs.writeFileSync(absolutePath, `${JSON.stringify(parsed, null, 2)}${trailingNewline}`);
  return { file: relativePath, status: "updated", current };
}

function main(argv) {
  // `--at <iso>` 让「某个时刻应得哪个版本号」可以被直接验证（含跨 UTC 午夜的边界），
  // 而不必改系统时间或依赖用例的模块加载方式。
  const atIndex = argv.indexOf("--at");
  const at = atIndex >= 0 ? new Date(argv[atIndex + 1]) : new Date();
  if (Number.isNaN(at.getTime())) {
    console.error(`[version] --at 需要一个合法的时间戳，收到 ${JSON.stringify(argv[atIndex + 1])}`);
    return 2;
  }
  const version = formatBuildVersion(at);

  if (argv.includes("--print")) {
    console.log(version);
    return 0;
  }

  const check = argv.includes("--check");
  const results = TARGET_FILES.map((file) => syncFile(file, version, { check }));

  for (const result of results) {
    const label = result.file.split(path.sep).join("/").padEnd(24);
    if (result.status === "updated") {
      console.log(`[version] ${label} ${result.current} → ${version}`);
    } else if (result.status === "unchanged") {
      console.log(`[version] ${label} 已是 ${version}`);
    } else if (result.status === "skipped") {
      console.log(`[version] ${label} 不存在，跳过`);
    } else if (result.status === "drift") {
      console.error(`[version] ${label} 仍是 ${result.current || "(缺失)"}，应为 ${version}`);
    }
  }

  if (check && results.some((result) => result.status === "drift")) return 1;
  return 0;
}

// 只在作为入口执行时跑 main（被用例 import 时不应产生副作用）。
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
