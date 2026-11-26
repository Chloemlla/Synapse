#!/usr/bin/env node
/**
 * 排版契约引擎的可复现评测（不是 CI 测试，是「拿证据」的工具）。
 *
 * 做三件事：
 *   1) 用仓库自己的 tsc 把 src/docTool/contract 编成 JS（不改仓库任何 tsconfig、输出到临时目录）；
 *   2) 把 corpus/ 下每份 Markdown 过三遍 pandoc：
 *        基线      —— 裸 pandoc
 *        +声明层    —— pandoc --reference-doc=<编译了契约的 reference.docx>
 *        +管线      —— 在上一步产物上跑 applyContract（验 → 修 → 再验），并验幂等性；
 *   3) 对管线产物做五个负样本（拆框线 / 回退主题字体 / 改错边距 / 丢公式 / 截断 ZIP），
 *      确认「验收器真的在数东西」，而不是恒返回满分。
 *
 * 为什么必须真跑 pandoc：verify.ts 数的是产物字节（sectPr 在不在、框线是不是零宽、run 有没有显式
 * 中文字体）。这些东西只有真 pandoc 写出来的 docx 才能代表真实情况，手搓的 XML 只能证明解析器对，
 * 不能证明「pandoc 确实会漏掉这些项」。
 *
 * 用法：
 *   node scripts/doc-tool-contract/eval.js                    # 全跑，结果写 outputs/doc-tool-contract-eval.json
 *   node scripts/doc-tool-contract/eval.js --only 01,02       # 只跑名字以 01/02 开头的语料
 *   node scripts/doc-tool-contract/eval.js --keep             # 保留临时产物（要打开 docx 人工核对时用）
 *   node scripts/doc-tool-contract/eval.js --pandoc <path>    # 指定 pandoc（默认读 DOC_TOOL_PANDOC 或 PATH）
 *   node scripts/doc-tool-contract/eval.js --tsc <path> --type-roots <dir>   # node_modules 不完整时借用别处的 TS
 *
 * 退出码：0 = 全部语料都达到各自契约的 minScore 且负样本都按预期掉分；1 = 有反例（会逐条列出）。
 */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..", "..");
const CORPUS = path.join(__dirname, "corpus");
const OUT_DEFAULT = path.join(REPO, "outputs", "doc-tool-contract-eval.json");

function arg(name, fallback = "") {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const pandocBin = arg("pandoc", process.env.DOC_TOOL_PANDOC || "pandoc");
const tscBin = arg("tsc", path.join(REPO, "node_modules", "typescript", "bin", "tsc"));
const typeRoots = arg("type-roots", "");
const keep = has("keep");
const only = arg("only")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const outPath = arg("out", OUT_DEFAULT);

const log = (line = "") => process.stdout.write(`${line}\n`);
const die = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(2);
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "doc-contract-eval-"));
const buildDir = path.join(tmpRoot, "build");
const workDir = path.join(tmpRoot, "work");
fs.mkdirSync(workDir, { recursive: true });

// ---- 1. 编出可 require 的 JS（只用仓库自己的 tsc，不装任何包） ----
function build() {
  if (!fs.existsSync(tscBin)) die(`找不到 tsc：${tscBin}\n先 pnpm install，或用 --tsc <path> 指向别的 typescript。`);
  const args = [
    "--ignoreConfig",
    "--target",
    "es2022",
    "--module",
    "node16",
    "--moduleResolution",
    "node16",
    "--esModuleInterop",
    "--skipLibCheck",
    "--lib",
    "es2022",
    "--rootDir",
    path.join(REPO, "src", "docTool"),
    "--outDir",
    buildDir,
    path.join(REPO, "src", "docTool", "contract", "index.ts"),
  ];
  if (typeRoots) args.push("--types", "node", "--typeRoots", typeRoots);
  const result = spawnSync(process.execPath, [tscBin, ...args], { cwd: REPO, encoding: "utf8" });
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim();
  if (!fs.existsSync(path.join(buildDir, "contract", "index.js"))) die(`编译失败：\n${output || "(无输出)"}`);
  const errors = output.split("\n").filter((line) => /\berror TS\d+/.test(line));
  if (errors.length) die(`编译有错（即使产出了 JS 也不可信）：\n${errors.join("\n")}`);
  return require(path.join(buildDir, "contract", "index.js"));
}

// ---- 2. pandoc ----
function pandoc(args) {
  const result = spawnSync(pandocBin, args, { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) die(`调不动 pandoc（${pandocBin}）：${result.error.message}`);
  if (result.status !== 0) die(`pandoc 退出码 ${result.status}：\n${String(result.stderr || "")}`);
  return result.stdout;
}

const contract = build();

// ---- 3. 语料：静态 md + 一份运行时合成的带图 md（图片必须真的存在，C5 才有意义） ----
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+g6wAAAAASUVORK5CYII=",
  "base64",
);

function corpusFiles() {
  const files = fs
    .readdirSync(CORPUS)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => ({ id: name.replace(/\.md$/, ""), src: path.join(CORPUS, name) }));
  // 带图那份在临时目录里现造：仓库里不放二进制，但 C5 必须有一份真的引用到图片的源
  const imageDir = path.join(workDir, "image");
  fs.mkdirSync(path.join(imageDir, "fig"), { recursive: true });
  fs.writeFileSync(path.join(imageDir, "fig", "dot.png"), ONE_PIXEL_PNG);
  const imageMd = path.join(imageDir, "08-with-image.md");
  fs.writeFileSync(
    imageMd,
    [
      "# 带图的讲义",
      "",
      "下面这张图必须出现在产物里（`word/media/` 下的文件数就是证据）。",
      "",
      "![一像素](fig/dot.png)",
      "",
      "| 项目 | 说明 |",
      "| --- | --- |",
      "| 图 | 相对路径引用 |",
      "",
    ].join("\n"),
    "utf8",
  );
  files.push({ id: "08-with-image", src: imageMd });
  return only.length ? files.filter((entry) => only.some((tag) => entry.id.startsWith(tag))) : files;
}

// ---- 4. 三遍转换 + 幂等 ----
const DEFAULT_CONTRACT = contract.CN_HANDOUT_V1;

const referencePath = path.join(workDir, "reference.docx");
function prepareReference() {
  const printed = pandoc(["--print-default-data-file", "reference.docx"]);
  const compiled = contract.compileReferenceDoc(printed, DEFAULT_CONTRACT);
  fs.writeFileSync(referencePath, compiled.buffer);
  return { ...compiled, baseBytes: printed.length };
}

function toDocx(src, outName, withReference) {
  const out = path.join(workDir, outName);
  const args = [src, "-o", out, `--resource-path=${path.dirname(src)}`];
  if (withReference) args.push(`--reference-doc=${referencePath}`);
  pandoc(args);
  return fs.readFileSync(out);
}

const pct = (value) => `${Math.round(value * 100) / 100}`.padStart(6);
const pad = (text, width) => {
  const str = String(text);
  return str.length >= width ? str : str + " ".repeat(width - str.length);
};

function runCase(entry) {
  const sourceMarkdown = fs.readFileSync(entry.src, "utf8");
  const baseline = toDocx(entry.src, `${entry.id}-baseline.docx`, false);
  const declared = toDocx(entry.src, `${entry.id}-declared.docx`, true);

  const baselineVerdict = contract.verifyDocx(baseline, { contract: DEFAULT_CONTRACT, sourceMarkdown });
  const declaredVerdict = contract.verifyDocx(declared, { contract: DEFAULT_CONTRACT, sourceMarkdown });
  const run = contract.applyContract({ docx: declared, contract: DEFAULT_CONTRACT, sourceMarkdown });
  const idem = contract.checkIdempotent({ docx: declared, contract: DEFAULT_CONTRACT, sourceMarkdown });

  const finalPath = path.join(workDir, `${entry.id}-final.docx`);
  fs.writeFileSync(finalPath, run.docx);

  return {
    id: entry.id,
    src: entry.src,
    bytes: { baseline: baseline.length, declared: declared.length, final: run.docx.length },
    scores: {
      baseline: baselineVerdict.score,
      declared: declaredVerdict.score,
      final: run.verdict.score,
    },
    grade: run.verdict.grade,
    minScore: DEFAULT_CONTRACT.accept.minScore,
    rounds: run.rounds,
    applied: run.applied,
    idempotent: idem.stable,
    idempotentDetail: idem.detail,
    defects: run.verdict.defects,
    checks: run.verdict.checks.map((check) => ({ id: check.id, ratio: check.ratio, detail: check.detail })),
    declaredChecks: declaredVerdict.checks.map((check) => ({ id: check.id, ratio: check.ratio })),
    finalPath,
  };
}

// ---- 5. 五个负样本：每改坏一项，只该掉它那一项的权重 ----
function patchPart(docx, name, mutate) {
  const archive = contract.readZip(docx);
  const text = archive.text(name);
  if (text === null) return { ok: false, reason: `没有 ${name}` };
  const next = mutate(text);
  if (next === text) return { ok: false, reason: `${name} 没有可改的目标` };
  return { ok: true, docx: contract.rewriteZip(archive, new Map([[name, Buffer.from(next, "utf8")]])).buffer };
}

function negatives(finalDocx, sourceMarkdown) {
  const out = [];
  // 不做「不适用也算过」这种事：先把这份语料到底有没有表格/中文/公式数出来
  const stats = contract.verifyDocx(finalDocx, { contract: DEFAULT_CONTRACT, sourceMarkdown }).stats;
  const add = (id, name, broken, expect) => {
    if (expect.applicable === false) {
      out.push({ id, name, ok: true, skipped: true, reason: expect.why || "本语料不适用", expect: expect.check });
      return;
    }
    if (!broken.ok) {
      // 这份语料里没有可改坏的目标（例如没有表格就跑不了「拆框线」）：
      // 记成「不适用」而不是「通过」—— 答辩时不能把不适用说成 5/5 全过。
      out.push({ id, name, ok: true, skipped: true, reason: broken.reason, expect: expect.check });
      return;
    }
    const verdict = contract.verifyDocx(broken.docx, { contract: DEFAULT_CONTRACT, sourceMarkdown });
    const failing = verdict.checks.filter((check) => check.ratio < 0.999).map((check) => check.id);
    out.push({
      id,
      name,
      ok: failing.includes(expect.check),
      expect: expect.check,
      score: verdict.score,
      failing,
      codes: verdict.defects.map((defect) => defect.code),
    });
  };

  // 优先拆样式层（编译后的 Table 样式带着框线，产物里本来就没有 tableBorders 才是正常状态）
  const dropBorders = (xml) => xml.replace(/<w:tblBorders>[\s\S]*?<\/w:tblBorders>/g, "");
  const styleBroken = patchPart(finalDocx, "word/styles.xml", dropBorders);
  add("N1", "拆掉表格框线 → C1 归零", styleBroken.ok ? styleBroken : patchPart(finalDocx, "word/document.xml", dropBorders), {
    check: "C1",
    applicable: stats.tables > 0,
    why: "本语料没有表格，C1 是空项",
  });
  add(
    "N2",
    "字体改回主题引用 → C2 归零",
    patchPart(finalDocx, "word/styles.xml", (xml) => xml.replace(/w:eastAsia="[^"]*"/g, 'w:eastAsiaTheme="minorEastAsia"')),
    { check: "C2", applicable: stats.cjkRuns > 0, why: "本语料没有中文 run" },
  );
  add(
    "N3",
    "上边距改回 720 → C3 掉分",
    patchPart(finalDocx, "word/document.xml", (xml) =>
      xml.replace(new RegExp(`w:top="${contract.cmToTwips(DEFAULT_CONTRACT.page.marginTopCm)}"`), 'w:top="720"'),
    ),
    { check: "C3" },
  );
  add(
    "N4",
    "公式换成纯文本 → C4 掉分",
    patchPart(finalDocx, "word/document.xml", (xml) =>
      xml.replace(/<m:oMath[\s\S]*?<\/m:oMath>/g, "").replace(/<m:oMathPara[\s\S]*?<\/m:oMathPara>/g, ""),
    ),
    { check: "C4", applicable: stats.mathActual > 0, why: "本语料没有公式" },
  );
  const truncated = finalDocx.subarray(0, Math.floor(finalDocx.length / 2));
  const truncatedVerdict = contract.verifyDocx(truncated, { contract: DEFAULT_CONTRACT, sourceMarkdown });
  out.push({
    id: "N5",
    name: "截断 ZIP → fatal，只有 C8 计分",
    ok: Boolean(truncatedVerdict.fatal) && truncatedVerdict.checks.length === 1 && truncatedVerdict.score === 0,
    expect: "C8/fatal",
    score: truncatedVerdict.score,
    failing: truncatedVerdict.checks.map((check) => check.id),
    codes: truncatedVerdict.defects.map((defect) => defect.code),
  });
  return out;
}

// ---- 6. 主流程 ----
function main() {
  if (!fs.existsSync(CORPUS)) die(`找不到语料目录：${CORPUS}`);
  log(`pandoc : ${pandocBin}`);
  log(`tsc    : ${tscBin}`);
  log(`build  : ${buildDir}`);
  log(`work   : ${workDir}`);
  log("");

  const reference = prepareReference();
  log(`参考样式：${reference.buffer.length} 字节（原 ${reference.baseBytes}），` +
    `契约写入 ${reference.report.applied.length} 处，跳过 ${reference.report.skipped.length} 处`);
  for (const line of reference.report.skipped) log(`  跳过：${line}`);
  log("");

  const cases = corpusFiles();
  const results = [];
  log(`语料                         基线   +声明层   +管线  rounds 幂等  负样本`);
  log("-".repeat(88));
  for (const entry of cases) {
    const result = runCase(entry);
    result.negatives = negatives(fs.readFileSync(result.finalPath), fs.readFileSync(entry.src, "utf8"));
    results.push(result);
    const neg = result.negatives.map((item) => `${item.id}${item.skipped ? "-" : item.ok ? "✓" : "✗"}`).join(" ");
    log(
      `${pad(entry.id, 26)} ${pct(result.scores.baseline)}  ${pct(result.scores.declared)}  ${pct(result.scores.final)}` +
        `  ${String(result.rounds).padStart(4)}  ${result.idempotent ? " ✓ " : " ✗ "}  ${neg}`,
    );
  }
  log("-".repeat(88));

  // 判定：分数过线 + 幂等 + 负样本全部按预期掉分，三条都满足才算这份语料通过
  const bad = [];
  for (const result of results) {
    if (result.scores.final < result.minScore) bad.push(`${result.id}: 终评分 ${result.scores.final} < ${result.minScore}`);
    if (!result.idempotent) bad.push(`${result.id}: 幂等性失败（${result.idempotentDetail}）`);
    for (const item of result.negatives) {
      if (!item.ok) bad.push(`${result.id}: 负样本 ${item.id} 未按预期掉分（${item.reason ?? `失败项 ${item.failing.join(",") || "无"}`}）`);
    }
  }

    const report = {
    generatedAt: new Date().toISOString(),
    pandoc: pandocBin,
    contract: { id: DEFAULT_CONTRACT.id, name: DEFAULT_CONTRACT.name, hash: contract.contractHash(DEFAULT_CONTRACT) },
    referenceDocxBytes: reference.buffer.length,
    // finalPath 指向临时目录，默认跑完就删，写进报告只会留下一个失效路径
    cases: results.map(({ finalPath, ...rest }) => (keep ? { ...rest, finalPath } : rest)),
    failures: bad,
  };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  log(`\n报告：${outPath}`);
  log(`语料 ${results.length} 份，通过 ${results.length - new Set(bad.map((line) => line.split(":")[0])).size} 份`);

  if (bad.length) {
    log("\n反例：");
    for (const line of bad) log(`  - ${line}`);
  }
  if (!keep) {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  } else {
    log(`\n中间产物保留在 ${workDir}`);
  }
  process.exit(bad.length ? 1 : 0);
}

main();
