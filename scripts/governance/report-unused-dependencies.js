#!/usr/bin/env node

// 无用依赖审查（只报告，从不失败）。
//
// 与 `depcheck` 的差别：本脚本**不安装任何东西**、不读 node_modules，纯静态扫描仓库里的
// 引用面（源码 import/require、配置文件、package.json scripts、CI workflow、Dockerfile…），
// 因此可以在本机与 CI 上零成本运行，结论可逐条核对。
//
// 判定口径：
//   code     —— 源码里出现 import / require / import()（含子路径）
//   config   —— 出现在 vite/jest/tailwind/postcss/tsconfig/CI/Dockerfile 等配置与脚本命令里
//   unused   —— 以上都没有：需要人工确认后移除（有些包只被 CLI 调用，或被 peer 依赖间接需要）
//   types    —— @types/* 且对应包名在源码里出现：**保留**（类型检查要用，删了会挂 tsc）
//
// 用法：node scripts/governance/report-unused-dependencies.js [--json]

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const jsonOutput = process.argv.includes("--json");

const CODE_GLOBS = [
  "src",
  "scripts",
  "frontend/src",
];

const CONFIG_FILES = [
  "package.json",
  "jest.config.js",
  "jest.ci.config.js",
  "jest.integration.config.js",
  "jest.nightly.config.js",
  "jest.nightly.external.config.js",
  "tsconfig.json",
  "tsconfig.jest.json",
  "biome.json",
  "Dockerfile",
  "docker-compose.yml",
  "frontend/package.json",
  "frontend/vite.config.ts",
  "frontend/vitest.config.ts",
  "frontend/vitest.setup.ts",
  "frontend/tailwind.config.js",
  "frontend/tailwind.config.ts",
  "frontend/postcss.config.js",
  "frontend/postcss.config.cjs",
  "frontend/index.html",
  "frontend/playwright.config.ts",
  "frontend/tsconfig.json",
  "readme.md",
];

function walk(dir, accept) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "dist", "dist-obfuscated", "coverage", ".git"].includes(entry.name)) return [];
      return walk(full, accept);
    }
    return accept(full) ? [full] : [];
  });
}

function collectCorpus() {
  const codeFiles = [];
  for (const relative of CODE_GLOBS) {
    const absolute = path.join(root, relative);
    codeFiles.push(...walk(absolute, (file) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(file)));
  }
  const workflowFiles = walk(path.join(root, ".github"), (file) => /\.(yml|yaml)$/.test(file));
  const configFiles = CONFIG_FILES.map((file) => path.join(root, file)).filter((file) => fs.existsSync(file));

  return {
    code: codeFiles.map((file) => ({ file: path.relative(root, file).replace(/\\/g, "/"), text: fs.readFileSync(file, "utf8") })),
    config: [...workflowFiles, ...configFiles].map((file) => {
      const relative = path.relative(root, file).replace(/\\/g, "/");
      const raw = fs.readFileSync(file, "utf8");
      // package.json 只取 scripts：否则每个依赖名都会在自己的声明处「命中自己」。
      if (file.endsWith("package.json")) {
        let scripts = {};
        try {
          scripts = JSON.parse(raw).scripts || {};
        } catch {
          scripts = {};
        }
        return { file: relative, text: Object.values(scripts).join("\n") };
      }
      return { file: relative, text: raw };
    }),
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 依赖名 → 待匹配的引用串（含子路径写法）。 */
function referencePatterns(name) {
  const escaped = escapeRegExp(name);
  return {
    importPattern: new RegExp(`(?:from\\s*|require\\(\\s*|import\\(\\s*)["'\`]${escaped}(?:/[^"'\`]*)?["'\`]`),
    barePattern: new RegExp(`(^|[\\s"'\`(,=:])${escaped}([\\s"'\`),]|$)`, "m"),
  };
}

function auditTarget(targetLabel, packageJsonPath) {
  const manifest = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const sections = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
  const rows = [];

  for (const section of sections) {
    for (const name of Object.keys(manifest[section] || {})) {
      const { importPattern, barePattern } = referencePatterns(name);
      const codeHits = [];
      const configHits = [];

      for (const entry of CORPUS.code) {
        if (importPattern.test(entry.text)) codeHits.push(entry.file);
      }
      for (const entry of CORPUS.config) {
        if (importPattern.test(entry.text) || barePattern.test(entry.text)) configHits.push(entry.file);
      }

      // @types/x 的可用性取决于 x 是否在源码里被引用（类型包本身不会被 import）。
      const typesTarget = name.startsWith("@types/") ? name.slice("@types/".length).replace(/^node$/, "node") : null;
      if (typesTarget && codeHits.length === 0) {
        const targetPattern = referencePatterns(typesTarget.split("/").slice(-1)[0]).importPattern;
        for (const entry of CORPUS.code) {
          if (targetPattern.test(entry.text)) codeHits.push(`${entry.file} (类型对应包 ${typesTarget})`);
        }
      }

      rows.push({
        target: targetLabel,
        section,
        name,
        status: codeHits.length > 0 ? "code" : configHits.length > 0 ? "config" : name.startsWith("@types/") ? "types" : "unused",
        codeHits: [...new Set(codeHits)].slice(0, 4),
        configHits: [...new Set(configHits)].slice(0, 4),
      });
    }
  }

  return rows;
}

const CORPUS = collectCorpus();
const rows = [
  ...auditTarget("root", path.join(root, "package.json")),
  ...auditTarget("frontend", path.join(root, "frontend", "package.json")),
];

if (jsonOutput) {
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

const unused = rows.filter((row) => row.status === "unused");
const configOnly = rows.filter((row) => row.status === "config");
const typesOnly = rows.filter((row) => row.status === "types");

for (const row of rows.filter((item) => item.status === "unused")) {
  console.log(`  [unused] ${row.target}/${row.section}: ${row.name}`);
}
console.log(`\n合计 ${rows.length} 个依赖声明：code=${rows.filter((r) => r.status === "code").length}，` +
  `config=${configOnly.length}，types=${typesOnly.length}，unused=${unused.length}`);

if (configOnly.length > 0) {
  console.log("\n仅在配置/脚本/CI 中出现（多半是 CLI 工具，人工确认）：");
  for (const row of configOnly) {
    console.log(`  ${row.target}/${row.section}: ${row.name} <- ${row.configHits.join(", ")}`);
  }
}

if (typesOnly.length > 0) {
  console.log("\n@types/*（源码里没有直接 import；删前先确认 tsconfig 与编译依赖）：");
  for (const row of typesOnly) console.log(`  ${row.target}/${row.section}: ${row.name}`);
}

console.log("\n（本步骤只做可见性，不判定对错、不阻断构建。）");
