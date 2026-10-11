#!/usr/bin/env node
/**
 * 治理闸门：软删除纪律（RC-21.4）与响应切片（RC-58）。
 *
 * 为什么需要一条**会拦 CI** 的规则：
 * - RC-21 把「用户可见的删除」统一改成软删除后，只要有人写一行
 *   `Model.deleteOne(...)`，数据就从“保留待取证”变回“当场消失”，而这个回退**没有任何编译期征兆**；
 * - RC-58 的“资产颗粒度”不是“爬虫无法还原”这种不可验证目标，而是可验证的
 *   「列表接口不得无条件返回整表」。
 *
 * 基线机制（与 `check-ts-file-size` 的 legacy 预算同思路）：仓库里**存量**违规很多，
 * 一次性拦下会让闸门立刻变红并很快被无视。因此把当前违规快照写进
 * `docs/governance/slicing-and-softdelete-baseline.json`，闸门只报**新增**项。
 * 用 `--update` 重新生成基线（必须在“确实修完了若干条”时才更新，并在提交信息里说明）。
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const baselinePath = path.join(root, "docs", "governance", "slicing-and-softdelete-baseline.json");

const SCAN_DIRS = ["src/routes", "src/controllers", "src/services"];
/** 允许裸删除的文件/路径：软删除服务自身、用户级联清理、TTL/清理任务、迁移脚本。 */
const SOFT_DELETE_ALLOWLIST = [
  "src/services/softDeleteService.ts",
  "src/services/userService.ts", // 级联“真删”白名单与 hardDeleteUser 本身
  "src/services/migrationRunner.ts",
  "src/services/migrations/",
  "src/services/legalHoldService.ts",
  "src/services/accountRiskService.ts", // step_up grant 主动作废（瞬时令牌，非用户数据）
];

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (/\.tsx?$/.test(entry.name)) files.push(full);
  }
  return files;
}

function relative(file) {
  return path.relative(root, file).replace(/\\/g, "/");
}

function isAllowlisted(file) {
  const rel = relative(file);
  return SOFT_DELETE_ALLOWLIST.some((entry) => rel === entry || rel.startsWith(entry));
}

/** 裸删除：`deleteOne(` / `deleteMany(` / `findByIdAndDelete(` / `findOneAndDelete(`（排除 `.deleteOne(` 后跟 TTL 之类的误解）。 */
function findHardDeletes(file, source) {
  const hits = [];
  const lines = source.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (/^\s*(\/\/|\*)/.test(line)) return; // 注释行
    if (/\b(deleteOne|deleteMany|findByIdAndDelete|findOneAndDelete)\s*\(/.test(line)) {
      // 允许显式标注为“真删”的行（`// soft-delete-exempt: 理由`）
      if (/soft-delete-exempt/i.test(line)) return;
      hits.push({ file: relative(file), line: index + 1, text: line.trim().slice(0, 160) });
    }
  });
  return hits;
}

/** 响应切片：`res.json(<标识符>)`，且该标识符在同一文件里由 `find(`/`find({})` 赋值而没有 `.limit(`。 */
function findUnslicedResponses(file, source) {
  const hits = [];
  const lines = source.split(/\r?\n/);
  const unslicedVars = new Map();
  lines.forEach((line, index) => {
    const assignment = line.match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?[A-Za-z_$][\w$.]*\.find\s*\(/);
    if (assignment) {
      // 同一行或后续 6 行内没有 .limit( 就记为“未切片”
      const window = lines.slice(index, index + 6).join(" ");
      if (!/\.limit\s*\(/.test(window) && !/\.lean\s*\(\s*\)\s*\.\s*limit/.test(window)) {
        unslicedVars.set(assignment[1], index + 1);
      }
    }
    const response = line.match(/res\.json\(\s*([A-Za-z_$][\w$]*)\s*\)/);
    if (response && unslicedVars.has(response[1])) {
      hits.push({
        file: relative(file),
        line: index + 1,
        text: line.trim().slice(0, 160),
        note: `${response[1]} 来自未加 limit 的 find()`,
      });
    }
  });
  return hits;
}

function scan() {
  const hardDeletes = [];
  const unsliced = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(path.join(root, dir))) {
      const source = fs.readFileSync(file, "utf8");
      if (!isAllowlisted(file)) hardDeletes.push(...findHardDeletes(file, source));
      unsliced.push(...findUnslicedResponses(file, source));
    }
  }
  return { hardDeletes, unsliced };
}

function keyOf(hit) {
  return `${hit.file}:${hit.line}`;
}

const result = scan();
const current = {
  hardDeletes: result.hardDeletes.map(keyOf).sort(),
  unslicedResponses: result.unsliced.map(keyOf).sort(),
};

if (process.argv.includes("--update")) {
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  fs.writeFileSync(
    baselinePath,
    `${JSON.stringify(
      {
        note: "存量基线（RC-21.4 裸删除闸门 / RC-58 响应切片闸门）。新增违规会被 CI 拦下；修完一条再 --update。",
        updatedAt: new Date().toISOString().slice(0, 10),
        hardDeletes: current.hardDeletes,
        unslicedResponses: current.unslicedResponses,
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `基线已更新：裸删除 ${current.hardDeletes.length} 处、未切片响应 ${current.unslicedResponses.length} 处`,
  );
  process.exit(0);
}

const baseline = fs.existsSync(baselinePath)
  ? JSON.parse(fs.readFileSync(baselinePath, "utf8"))
  : { hardDeletes: [], unslicedResponses: [] };
const knownHardDeletes = new Set(baseline.hardDeletes || []);
const knownUnsliced = new Set(baseline.unslicedResponses || []);

const newHardDeletes = result.hardDeletes.filter((hit) => !knownHardDeletes.has(keyOf(hit)));
const newUnsliced = result.unsliced.filter((hit) => !knownUnsliced.has(keyOf(hit)));

if (newHardDeletes.length > 0) {
  console.error("新增裸删除（必须走 softDeleteService，或在本行标注 `// soft-delete-exempt: <理由>`）：");
  for (const hit of newHardDeletes) console.error(`  ${hit.file}:${hit.line}  ${hit.text}`);
  process.exitCode = 1;
}

if (newUnsliced.length > 0) {
  // 响应切片先作告警（存量多、语义需要逐个人工确认），不拦 CI；修完一批后把基线收紧再说。
  console.warn("新增未切片响应（列表接口应带 limit/分页）：");
  for (const hit of newUnsliced) console.warn(`  ${hit.file}:${hit.line}  ${hit.text}  (${hit.note})`);
}

if (!process.exitCode) {
  console.log(
    `治理闸门通过：裸删除 ${result.hardDeletes.length} 处（基线 ${knownHardDeletes.size}）、` +
      `未切片响应 ${result.unsliced.length} 处（基线 ${knownUnsliced.size}）`,
  );
}
