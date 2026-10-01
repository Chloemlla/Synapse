#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const root = path.resolve(__dirname, "..", "..");
const distDir = path.join(root, "frontend", "dist");
const manifestPath = path.join(distDir, ".vite", "manifest.json");
const entryMaxGzipBytes = Number(process.env.FRONTEND_ENTRY_MAX_GZIP_KB || 220) * 1024;
// diagrams/mermaid can exceed 1.5MB gzip even when isolated; keep it separate and budget it.
const chunkMaxGzipBytes = Number(process.env.FRONTEND_CHUNK_MAX_GZIP_KB || 1800) * 1024;
// Provider-management UI intentionally grew the production surface; retain a
// narrow, deterministic margin above the measured post-obfuscation baseline.
const totalMaxGzipBytes = Number(process.env.FRONTEND_TOTAL_MAX_GZIP_KB || 4600) * 1024;
// Require isolation for heavy deps that actually split. code-highlight may fold into other chunks depending on imports.
const heavyChunkNames = ["documents", "pdf", "mermaid", "katex", "charts", "fingerprint"];

/**
 * 首屏（entry 静态 import 闭包）预算。
 *
 * 背景：/captcha-verify 的线上 trace 显示首屏被塞进了 11 个 chunk（≈2.5 MiB gzip / 7.7 MiB 原始），
 * 其中 mermaid+katex 单包 5.43 MB，直接导致 FCP 6.7 s；随后 621 ms 的同步模块求值里
 * 有 ~200 ms 花在全量 Prism（298 个语法）注册上。
 * 见 docs/perf/2026-10-01-captcha-verify-trace-analysis.md。
 *
 * 这里用 Vite manifest 的 `imports`（静态依赖，不含 `dynamicImports`）还原首屏闭包，
 * 一旦这些重包重新回到首屏关键路径，CI 立刻红灯。
 *
 * 2026-10-01 放宽（用户要求）：实测基线 1629.8 KiB gzip（mermaid 仍在首屏闭包内），
 * 因此预算由 800 KiB 调到 1800 KiB，并把 mermaid 登记为**已知例外**（仍会在日志里告警）。
 * 收紧路径：把 mermaid 改成动态加载后，把预算降回 800 KiB 并从 `firstScreenAllowedNamePatterns` 移除例外。
 */
const firstScreenForbiddenName =
  /^(?:mermaid|katex|diagrams|pdf|charts|code-highlight|prism|markdown|docx|swagger|hugeicons)[.-]/;
/** 已登记的例外：仍在首屏闭包内但暂不判失败的重包（会在日志里以 warning 形式列出）。 */
const firstScreenAllowedNamePatterns = [/^mermaid[.-]/];
const firstScreenMaxGzipBytes = Number(process.env.FRONTEND_FIRST_SCREEN_MAX_GZIP_KB || 1800) * 1024;

/**
 * 从 manifest 还原入口的静态 import 闭包（不含 dynamicImports）。
 * @param {Record<string, any>} manifest
 * @returns {{ files: Set<string>, css: Set<string>, sources: Set<string> }}
 */
function collectEntryStaticClosure(manifest) {
  const files = new Set();
  const css = new Set();
  const sources = new Set();
  const visited = new Set();
  const stack = Object.entries(manifest)
    .filter(([, item]) => item && item.isEntry && item.file)
    .map(([source, item]) => [source, item]);

  while (stack.length > 0) {
    const [source, item] = stack.pop();
    if (!item || !item.file || visited.has(source)) continue;
    visited.add(source);
    sources.add(source);
    files.add(item.file);
    for (const asset of item.css || []) css.add(asset);
    for (const imported of item.imports || []) {
      if (manifest[imported]) stack.push([imported, manifest[imported]]);
    }
  }

  return { files, css, sources };
}

function assetBaseName(relative) {
  return path.basename(relative);
}

function gzipSize(file) {
  return zlib.gzipSync(fs.readFileSync(file), { level: 9 }).byteLength;
}

function listFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(file) : [file];
  });
}

if (!fs.existsSync(manifestPath)) {
  console.error(`Missing Vite manifest: ${path.relative(root, manifestPath)}`);
  console.error("Run the frontend production build before checking its budget.");
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const entries = Object.values(manifest).filter((item) => item && item.isEntry && item.file);
if (entries.length === 0) {
  console.error("Vite manifest has no entry chunk.");
  process.exit(1);
}

const assetFiles = listFiles(path.join(distDir, "assets")).filter((file) => /\.(?:js|css)$/.test(file));
const measured = assetFiles.map((file) => ({
  file,
  relative: path.relative(distDir, file).replace(/\\/g, "/"),
  gzipBytes: gzipSize(file),
}));
const failures = [];

for (const entry of entries) {
  const match = measured.find((item) => item.relative === entry.file);
  if (!match) {
    failures.push(`entry asset missing: ${entry.file}`);
  } else if (match.gzipBytes > entryMaxGzipBytes) {
    failures.push(`entry ${match.relative} is ${(match.gzipBytes / 1024).toFixed(1)} KiB gzip (budget ${entryMaxGzipBytes / 1024} KiB)`);
  }
}

for (const item of measured.filter((entry) => entry.relative.endsWith(".js"))) {
  if (item.gzipBytes > chunkMaxGzipBytes) {
    failures.push(`chunk ${item.relative} is ${(item.gzipBytes / 1024).toFixed(1)} KiB gzip (budget ${chunkMaxGzipBytes / 1024} KiB)`);
  }
}

const totalGzipBytes = measured.reduce((sum, item) => sum + item.gzipBytes, 0);
if (totalGzipBytes > totalMaxGzipBytes) {
  failures.push(`total JS/CSS is ${(totalGzipBytes / 1024).toFixed(1)} KiB gzip (budget ${totalMaxGzipBytes / 1024} KiB)`);
}

const emittedNames = measured.map((item) => path.basename(item.relative));
for (const chunkName of heavyChunkNames) {
  if (!emittedNames.some((name) => name.startsWith(`${chunkName}.`) || name.startsWith(`${chunkName}-`))) {
    failures.push(`expected isolated heavy-dependency chunk was not emitted: ${chunkName}`);
  }
}

const entryFiles = new Set(entries.map((entry) => entry.file));
for (const [source, item] of Object.entries(manifest)) {
  if (!item || !item.file || entryFiles.has(item.file)) continue;
  if (/MarkdownExportPage|Mermaid|CommandManager|NexAISecurityDashboard|fingerprint/.test(source)) {
    if (item.isEntry) failures.push(`${source} unexpectedly became an entry chunk`);
  }
}

// 首屏静态闭包：重包不得回流，且闭包总量必须有预算。
const firstScreen = collectEntryStaticClosure(manifest);
const firstScreenAssets = [...firstScreen.files, ...firstScreen.css];
const allowedLeaks = [];
for (const relative of firstScreenAssets) {
  const name = assetBaseName(relative);
  if (!firstScreenForbiddenName.test(name)) continue;
  if (firstScreenAllowedNamePatterns.some((pattern) => pattern.test(name))) {
    allowedLeaks.push(relative);
    continue;
  }
  failures.push(`heavy chunk leaked onto the first screen (static import of the entry): ${relative}`);
}
const firstScreenGzipBytes = firstScreenAssets.reduce((sum, relative) => {
  const file = path.join(distDir, relative);
  return fs.existsSync(file) ? sum + gzipSize(file) : sum;
}, 0);
if (firstScreenGzipBytes > firstScreenMaxGzipBytes) {
  failures.push(
    `first-screen static closure is ${(firstScreenGzipBytes / 1024).toFixed(1)} KiB gzip (budget ${firstScreenMaxGzipBytes / 1024} KiB): ${[...firstScreen.files].sort().join(", ")}`,
  );
}

measured
  .sort((a, b) => b.gzipBytes - a.gzipBytes)
  .slice(0, 15)
  .forEach((item) => console.log(`${item.relative}: ${(item.gzipBytes / 1024).toFixed(1)} KiB gzip`));
console.log(`Total JS/CSS: ${(totalGzipBytes / 1024).toFixed(1)} KiB gzip`);
console.log(
  `First-screen static closure: ${(firstScreenGzipBytes / 1024).toFixed(1)} KiB gzip across ${firstScreen.files.size} JS + ${firstScreen.css.size} CSS asset(s)`,
);
if (allowedLeaks.length > 0) {
  console.log(
    `  [allowed] 首屏闭包内已登记的重包例外（不判失败，仍计入总量）：${allowedLeaks.sort().join(", ")}`,
  );
}
console.log(`  ${[...firstScreen.files].sort().join("\n  ")}`);
if (firstScreen.css.size > 0) {
  console.log(`  css:\n  ${[...firstScreen.css].sort().join("\n  ")}`);
}

if (failures.length > 0) {
  console.error(`Frontend bundle budget failed (${failures.length} violation(s)):`);
  failures.forEach((failure) => console.error(`  - ${failure}`));
  process.exit(1);
}

console.log("Frontend bundle budget passed.");
