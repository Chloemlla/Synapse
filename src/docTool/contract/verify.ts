// 验收器：从**产物字节**里数出 8 项指标，给一个 0-100 分。
//
// 这个文件是全方案的「判据自建」部分，也是最容易被质疑的部分，所以先把两条设计原则写死：
//   1) 每一项都必须能从 .docx 里数出来，且数法写在代码里（不是人工看一眼说「挺好的」）。
//      数不出来的项不许进契约 —— 这是 types.ts 里那句「no field without verification」的落地。
//   2) 分数必须能被故意做坏。配套的 5 个负样本（eval/negative/make-negative.mjs）就是拿来做这件事的：
//      删掉框线 → C1 掉到 0；把 eastAsia 改回主题字体 → C2 掉到 0；pgMar 改回 720 → C3 掉到 0；
//      把公式换成纯文本 → C4 掉到 0；截断 ZIP → C8 直接 fatal。
//      如果一个验证器对负样本仍然满分，那它测的不是文档，是它自己。
//
// 权重之和 = 100，所以 score 就是加权通过率的直接读数（不做二次归一化，读数才好对账）。
import { attrLocal, directChildTags, elements, firstDirectChildIn, isBalanced, type Element } from "./xmlScan";
import { openTagOf, valOf } from "./compile";
import { readZip, type ZipArchive } from "./zipRead";
import { cmToTwips, type PassId, type StyleContract } from "./types";

export type CheckId = "C1" | "C2" | "C3" | "C4" | "C5" | "C6" | "C7" | "C8";

export interface CheckResult {
  id: CheckId;
  name: string;
  weight: number;
  /** 0..1 的通过率（部分通过给比例，不给「差不多算过」） */
  ratio: number;
  pass: boolean;
  detail: string;
}

export interface Defect {
  code: string;
  check: CheckId;
  message: string;
  /** 能自动修就给出对应的 pass；null = 只能进人工清单 */
  fixable: PassId | null;
}

export interface Verdict {
  score: number;
  grade: "pass" | "review" | "fail";
  checks: CheckResult[];
  defects: Defect[];
  /** 体检报告里直接展示的原始计数，答辩时可以被逐条追问 */
  stats: Record<string, number>;
  fatal?: string;
}

export const CHECK_WEIGHTS: Record<CheckId, number> = {
  C1: 20,
  C2: 20,
  C3: 15,
  C4: 15,
  C5: 10,
  C6: 5,
  C7: 5,
  C8: 10,
};

export const CHECK_NAMES: Record<CheckId, string> = {
  C1: "表格框线覆盖",
  C2: "中文字体覆盖",
  C3: "页面设置合规",
  C4: "公式完整",
  C5: "图片完整",
  C6: "表格行不跨页",
  C7: "标题无跳级",
  C8: "文档容器自洽",
};

const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f]/;
const REQUIRED_ENTRIES = ["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/styles.xml", "word/_rels/document.xml.rels"];

interface StyleInfo {
  el: Element;
  id: string;
  name: string;
  basedOn: string | null;
  eastAsia: string | null;
  /** 表格样式的框线：true/false；null = 该样式没写 tblBorders */
  borders: boolean | null;
}

interface StyleIndex {
  byId: Map<string, StyleInfo>;
  byName: Map<string, StyleInfo>;
  docDefaultsEastAsia: string | null;
}

function buildStyleIndex(styles: string): StyleIndex {
  const byId = new Map<string, StyleInfo>();
  const byName = new Map<string, StyleInfo>();
  for (const el of elements(styles, "w:style")) {
    const id = attrLocal(openTagOf(styles, el), "styleId") ?? "";
    const nameEl = firstDirectChildIn(styles, el, "w:name");
    const name = nameEl ? valOf(nameEl.raw) : "";
    const basedOnEl = firstDirectChildIn(styles, el, "w:basedOn");
    const rPr = firstDirectChildIn(styles, el, "w:rPr");
    const rFonts = rPr ? firstDirectChildIn(styles, rPr, "w:rFonts") : null;
    const tblPr = firstDirectChildIn(styles, el, "w:tblPr");
    const bordersEl = tblPr ? firstDirectChildIn(styles, tblPr, "w:tblBorders") : null;
    const info: StyleInfo = {
      el,
      id,
      name,
      basedOn: basedOnEl ? valOf(basedOnEl.raw) || null : null,
      eastAsia: rFonts ? attrLocal(rFonts.raw, "eastAsia") : null,
      borders: bordersEl ? visibleBorders(styles, bordersEl) : null,
    };
    if (id && !byId.has(id)) byId.set(id, info);
    if (name && !byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), info);
  }

  let docDefaultsEastAsia: string | null = null;
  const root = elements(styles, "w:styles")[0];
  const defaults = root ? firstDirectChildIn(styles, root, "w:docDefaults") : null;
  const rPrDefault = defaults ? firstDirectChildIn(styles, defaults, "w:rPrDefault") : null;
  const rPr = rPrDefault ? firstDirectChildIn(styles, rPrDefault, "w:rPr") : null;
  const rFonts = rPr ? firstDirectChildIn(styles, rPr, "w:rFonts") : null;
  // 只认**显式字体名**：`w:eastAsiaTheme="minorEastAsia"` 不算设置过中文字体（这正是现行模板的病根）
  if (rFonts && attrLocal(rFonts.raw, "eastAsia")) docDefaultsEastAsia = attrLocal(rFonts.raw, "eastAsia");
  return { byId, byName, docDefaultsEastAsia };
}

function visibleBorders(xml: string, bordersEl: Element): boolean {
  const sides = directChildTags(xml, bordersEl).filter((tag) =>
    /^w:(top|left|bottom|right|insideH|insideV|start|end)$/.test(tag.name),
  );
  return sides.some((tag) => {
    const val = (attrLocal(tag.raw, "val") ?? "").toLowerCase();
    const size = Number(attrLocal(tag.raw, "sz") ?? "0");
    if (!val || val === "none" || val === "nil") return false;
    // 零宽框线（sz=0）在 Word 里等于不可见 —— 现行 reference.docx 的 firstRow 条件格式就是 w:sz="0"
    return Number.isFinite(size) ? size > 0 : true;
  });
}

function styleBorders(index: StyleIndex, styleId: string | null, depth = 0): boolean | null {
  if (!styleId || depth > 5) return null;
  const info = index.byId.get(styleId);
  if (!info) return null;
  if (info.borders !== null) return info.borders;
  return styleBorders(index, info.basedOn, depth + 1);
}

function tableHasBorders(doc: string, index: StyleIndex, table: Element): { ok: boolean; via: "self" | "style" | "none" } {
  const tblPr = firstDirectChildIn(doc, table, "w:tblPr");
  if (!tblPr) return { ok: false, via: "none" };
  const own = firstDirectChildIn(doc, tblPr, "w:tblBorders");
  if (own && visibleBorders(doc, own)) return { ok: true, via: "self" };
  const styleEl = firstDirectChildIn(doc, tblPr, "w:tblStyle");
  const byStyle = styleEl ? styleBorders(index, valOf(styleEl.raw) || null) : null;
  if (byStyle) return { ok: true, via: "style" };
  return { ok: false, via: "none" };
}

/** 源 Markdown 里的图片数量（启发式：`![](...)` 与 `<img src=...>`；代码块里的不算）。 */
export function countSourceImages(md: string): number {
  const text = stripCode(md);
  const mdImages = text.match(/!\[[^\]]*\]\([^)]+\)/g) ?? [];
  const htmlImages = text.match(/<img\b[^>]*\bsrc\s*=/gi) ?? [];
  return mdImages.length + htmlImages.length;
}

function stripCode(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "")
    .replace(/`[^`\n]*`/g, "");
}

/**
 * 源 Markdown 里的公式数量（启发式）。
 * 口径说明（答辩会被追问的地方，所以写清楚）：
 *   - `$$...$$`、`\[...\]`、`\(...\)` 各算一个；
 *   - 行内 `$...$` 只在「$ 后面不是空白、也不是数字」时才算，用来排除 "花费 $5 与 $6" 这种货币写法；
 *   - 代码块/行内代码里的 `$` 一律不算。
 * 这是**上界估计**，配合 C4 的判据（产物里的公式数 ≥ 源里的公式数才算通过）使用：
 * 少算不会误判通过，多算会误判失败，所以宁可按上界算，逼着转换链路别丢公式。
 */
export function countSourceMath(md: string): number {
  let text = stripCode(md);
  let count = 0;
  const take = (re: RegExp): void => {
    const matches = text.match(re) ?? [];
    count += matches.length;
    text = text.replace(re, " ");
  };
  take(/\$\$[\s\S]+?\$\$/g);
  take(/\\\[[\s\S]+?\\\]/g);
  take(/\\\([\s\S]+?\\\)/g);
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "$") continue;
    const next = text[i + 1] ?? "";
    if (!next || /\s/.test(next) || /\d/.test(next)) continue;
    const close = text.indexOf("$", i + 1);
    if (close < 0) break;
    if (close - i < 3) continue;
    count += 1;
    i = close;
  }
  return count;
}

function headingLevels(doc: string, index: StyleIndex): number[] {
  const levels: number[] = [];
  for (const paragraph of elements(doc, "w:p")) {
    const pPr = firstDirectChildIn(doc, paragraph, "w:pPr");
    const pStyle = pPr ? firstDirectChildIn(doc, pPr, "w:pStyle") : null;
    if (!pStyle) continue;
    const id = valOf(pStyle.raw);
    const info = index.byId.get(id);
    const name = (info?.name ?? "").toLowerCase();
    const match = name.match(/heading\s*([1-9])/) ?? id.match(/heading\s*([1-9])/i);
    if (match) levels.push(Number(match[1]));
  }
  return levels;
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

/**
 * 体检主入口。sourceMarkdown 只用于 C4/C5 的「源里应该有几个」；不传就把这两项当作无法判定（按满分给，
 * 并在 detail 里注明「无源对照」）—— 瞒着不说会让分数虚高，比不判更糟。
 */
export function verifyDocx(docx: Buffer, opts: { contract: StyleContract; sourceMarkdown?: string }): Verdict {
  const { contract } = opts;
  const checks: CheckResult[] = [];
  const defects: Defect[] = [];
  const stats: Record<string, number> = {};

  let archive: ZipArchive;
  try {
    archive = readZip(docx);
  } catch (error) {
    return {
      score: 0,
      grade: "fail",
      checks: [
        {
          id: "C8",
          name: CHECK_NAMES.C8,
          weight: CHECK_WEIGHTS.C8,
          ratio: 0,
          pass: false,
          detail: error instanceof Error ? error.message : String(error),
        },
      ],
      defects: [
        {
          code: "E_ZIP",
          check: "C8",
          message: `产物不是可解析的 ZIP：${error instanceof Error ? error.message : String(error)}`,
          fixable: null,
        },
      ],
      stats,
      fatal: "ZIP 无法解析，后续检查全部跳过",
    };
  }

  const doc = archive.text("word/document.xml");
  const styles = archive.text("word/styles.xml");
  if (!doc || !styles) {
    return {
      score: 0,
      grade: "fail",
      checks: [],
      defects: [{ code: "E_ENTRY", check: "C8", message: "docx 缺少 word/document.xml 或 word/styles.xml", fixable: null }],
      stats,
      fatal: "缺少必需部件",
    };
  }

  const index = buildStyleIndex(styles);
  const push = (id: CheckId, ratio: number, detail: string): void => {
    const clamped = Math.max(0, Math.min(1, ratio));
    checks.push({ id, name: CHECK_NAMES[id], weight: CHECK_WEIGHTS[id], ratio: round3(clamped), pass: clamped >= 0.999, detail });
  };

  // ---- C1 表格框线覆盖 ----
  const tables = elements(doc, "w:tbl");
  stats.tables = tables.length;
  let bordered = 0;
  for (const table of tables) {
    if (tableHasBorders(doc, index, table).ok) bordered += 1;
  }
  stats.tablesBordered = bordered;
  push("C1", tables.length ? bordered / tables.length : 1, `${bordered}/${tables.length} 个表格有可见框线`);
  if (tables.length && bordered < tables.length) {
    defects.push({
      code: "E_TABLE_BORDER",
      check: "C1",
      message: `${tables.length - bordered} 个表格没有可见框线（零宽框线等于不可见）`,
      fixable: "tableBorders",
    });
  }

  // ---- C2 中文字体覆盖 ----
  let cjkRuns = 0;
  let cjkOk = 0;
  // 预建 start → run 的索引：段落里逐个 run 去 elements() 全表扫一遍是 O(n²)，几十页的讲义会明显变慢
  const runsByStart = new Map(elements(doc, "w:r").map((el) => [el.start, el]));
  for (const paragraph of elements(doc, "w:p")) {
    const pPr = firstDirectChildIn(doc, paragraph, "w:pPr");
    const pStyleEl = pPr ? firstDirectChildIn(doc, pPr, "w:pStyle") : null;
    const pStyleEastAsia = pStyleEl ? (index.byId.get(valOf(pStyleEl.raw))?.eastAsia ?? null) : null;
    for (const tag of directChildTags(doc, paragraph)) {
      if (tag.name !== "w:r") continue;
      const run = runsByStart.get(tag.start);
      if (!run) continue;
      const text = runSelf(doc, run);
      if (!CJK_RE.test(text)) continue;
      cjkRuns += 1;
      const rPr = firstDirectChildIn(doc, run, "w:rPr");
      const rFonts = rPr ? firstDirectChildIn(doc, rPr, "w:rFonts") : null;
      if (rFonts && attrLocal(rFonts.raw, "eastAsia")) {
        cjkOk += 1;
        continue;
      }
      const rStyleEl = rPr ? firstDirectChildIn(doc, rPr, "w:rStyle") : null;
      if (rStyleEl && index.byId.get(valOf(rStyleEl.raw))?.eastAsia) {
        cjkOk += 1;
        continue;
      }
      if (pStyleEastAsia) {
        cjkOk += 1;
        continue;
      }
      if (index.docDefaultsEastAsia) cjkOk += 1;
    }
  }
  stats.cjkRuns = cjkRuns;
  stats.cjkRunsOk = cjkOk;
  push("C2", cjkRuns ? cjkOk / cjkRuns : 1, `${cjkOk}/${cjkRuns} 个含中文的 run 有显式中文字体`);
  if (cjkRuns && cjkOk < cjkRuns) {
    defects.push({
      code: "E_FONT_EASTASIA",
      check: "C2",
      message: `${cjkRuns - cjkOk} 个含中文的 run 没有显式中文字体（主题字体回退）`,
      fixable: "fontRun",
    });
  }

  // ---- C3 页面设置合规 ----
  const sect = elements(doc, "w:sectPr").pop() ?? null;
  const pageItems: Array<{ key: string; expected: number; raw: string | null }> = [];
  if (sect) {
    const pgSz = firstDirectChildIn(doc, sect, "w:pgSz");
    const pgMar = firstDirectChildIn(doc, sect, "w:pgMar");
    // 注意 w:w / w:h 的**本地名**就叫 w / h（键名是 "w:w"、"w:h"），attrLocal 会忽略前缀匹配
    pageItems.push(
      { key: "纸张宽", expected: cmToTwips(contract.page.widthCm), raw: pgSz ? attrLocal(pgSz.raw, "w") : null },
      { key: "纸张高", expected: cmToTwips(contract.page.heightCm), raw: pgSz ? attrLocal(pgSz.raw, "h") : null },
      { key: "上边距", expected: cmToTwips(contract.page.marginTopCm), raw: pgMar ? attrLocal(pgMar.raw, "top") : null },
      { key: "下边距", expected: cmToTwips(contract.page.marginBottomCm), raw: pgMar ? attrLocal(pgMar.raw, "bottom") : null },
      { key: "左边距", expected: cmToTwips(contract.page.marginLeftCm), raw: pgMar ? attrLocal(pgMar.raw, "left") : null },
      { key: "右边距", expected: cmToTwips(contract.page.marginRightCm), raw: pgMar ? attrLocal(pgMar.raw, "right") : null },
      { key: "页眉", expected: cmToTwips(contract.page.headerCm), raw: pgMar ? attrLocal(pgMar.raw, "header") : null },
      { key: "页脚", expected: cmToTwips(contract.page.footerCm), raw: pgMar ? attrLocal(pgMar.raw, "footer") : null },
    );
  }
  // 容差 2 twips：契约里的 cm 是两位小数，往返换算会差 1-2 twips，这不叫不合规
  const pageOk = pageItems.filter((item) => item.raw !== null && Math.abs(Number(item.raw) - item.expected) <= 2).length;
  stats.pageItems = pageItems.length;
  stats.pageItemsOk = pageOk;
  push("C3", pageItems.length ? pageOk / pageItems.length : 0, `${pageOk}/${pageItems.length || 8} 项页面设置与契约一致`);
  if (pageOk < 8 || pageItems.length < 8) {
    const missing = pageItems.filter((item) => item.raw === null).map((item) => item.key);
    defects.push({
      code: "E_PAGE_SETUP",
      check: "C3",
      message: sect
        ? `页面设置不符：${pageItems.filter((item) => item.raw !== null && Math.abs(Number(item.raw) - item.expected) > 2).map((item) => item.key).join("、") || "——"}${
            missing.length ? `（缺失：${missing.join("、")}）` : ""
          }`
        : "产物里没有 sectPr（页边距/纸张完全没设置）",
      fixable: "sectPr",
    });
  }

  // ---- C4 公式完整 ----
  const mathActual = elements(doc, "m:oMath").length;
  stats.mathActual = mathActual;
  if (opts.sourceMarkdown === undefined) {
    push("C4", 1, `产物含 ${mathActual} 个公式；未提供源 Markdown，无法对照`);
  } else {
    const expected = countSourceMath(opts.sourceMarkdown);
    stats.mathExpected = expected;
    const ratio = expected === 0 ? 1 : Math.min(1, mathActual / expected);
    push("C4", ratio, `产物 ${mathActual} / 源 ${expected} 个公式`);
    if (mathActual < expected) {
      defects.push({
        code: "E_MATH_LOST",
        check: "C4",
        message: `源里有 ${expected} 个公式，产物只找到 ${mathActual} 个（丢了 ${expected - mathActual} 个）`,
        fixable: null,
      });
    }
  }

  // ---- C5 图片完整 ----
  const media = archive.names.filter((name) => /^word\/media\/[^/]+$/.test(name)).length;
  stats.mediaActual = media;
  if (opts.sourceMarkdown === undefined) {
    push("C5", 1, `产物含 ${media} 个图片资源；未提供源 Markdown，无法对照`);
  } else {
    const expected = countSourceImages(opts.sourceMarkdown);
    stats.mediaExpected = expected;
    push("C5", expected === 0 ? 1 : Math.min(1, media / expected), `产物 ${media} / 源 ${expected} 张图片`);
    if (media < expected) {
      defects.push({
        code: "E_IMAGE_MISSING",
        check: "C5",
        message: `源里有 ${expected} 张图片，产物只有 ${media} 个媒体文件（常见原因：图片路径不在 --resource-path 里）`,
        fixable: null,
      });
    }
  }

  // ---- C6 表格行不跨页 ----
  let rows = 0;
  let rowsProtected = 0;
  // 注意：directChildTags 返回的是**标签**，tag.end 只到开标签的 `>` 为止。
  // 要判断行里有没有 cantSplit，必须拿到整个元素的范围，否则永远查不到（这个坑踩过一次）。
  const trByStart = new Map(elements(doc, "w:tr").map((el) => [el.start, el]));
  for (const table of tables) {
    for (const tag of directChildTags(doc, table)) {
      if (tag.name !== "w:tr") continue;
      rows += 1;
      const row = trByStart.get(tag.start);
      if (!row || row.selfClosing) continue;
      const span = doc.slice(row.start, row.closeStart >= 0 ? row.closeStart : row.end);
      if (/<w:cantSplit\b/.test(span)) rowsProtected += 1;
    }
  }
  stats.tableRows = rows;
  stats.tableRowsProtected = rowsProtected;
  if (!contract.table.rowCannotSplit) {
    push("C6", 1, "契约未要求行不跨页，跳过");
  } else {
    push("C6", rows ? rowsProtected / rows : 1, `${rowsProtected}/${rows} 个表格行设置了 cantSplit`);
    if (rows && rowsProtected < rows) {
      defects.push({
        code: "E_ROW_SPLIT",
        check: "C6",
        message: `${rows - rowsProtected} 个表格行没有 cantSplit（跨页时会被拦腰截断）`,
        fixable: "tableRow",
      });
    }
  }

  // ---- C7 标题无跳级 ----
  const levels = headingLevels(doc, index);
  stats.headings = levels.length;
  let jumps = 0;
  for (let i = 1; i < levels.length; i += 1) {
    if (levels[i] - levels[i - 1] > 1) jumps += 1;
  }
  push("C7", levels.length <= 1 ? 1 : 1 - jumps / (levels.length - 1), `${levels.length} 个标题，跳级 ${jumps} 处`);
  if (jumps > 0) {
    defects.push({
      code: "E_HEADING_SKIP",
      check: "C7",
      message: `${jumps} 处标题跳级（如一级直接到三级），只能人工改源 Markdown`,
      fixable: null,
    });
  }

  // ---- C8 容器自洽 ----
  const present = REQUIRED_ENTRIES.filter((name) => archive.names.includes(name)).length;
  const balanced = [doc, styles, archive.text("[Content_Types].xml") ?? "", archive.text("word/_rels/document.xml.rels") ?? ""].filter(
    (xml) => xml && isBalanced(xml),
  ).length;
  const c8Ratio = (present / REQUIRED_ENTRIES.length) * 0.5 + (balanced / 4) * 0.5;
  stats.entriesPresent = present;
  stats.xmlBalanced = balanced;
  push("C8", c8Ratio, `必需部件 ${present}/${REQUIRED_ENTRIES.length}，XML 配平 ${balanced}/4`);
  if (c8Ratio < 1) {
    defects.push({
      code: "E_CONTAINER",
      check: "C8",
      message: `容器自洽检查未全通过（部件 ${present}/${REQUIRED_ENTRIES.length}，配平 ${balanced}/4）`,
      fixable: null,
    });
  }

  const score = round3(checks.reduce((sum, check) => sum + (check.weight * check.ratio) / 100, 0) * 100);
  const grade: Verdict["grade"] = score >= contract.accept.minScore ? "pass" : score >= 60 ? "review" : "fail";
  return { score, grade, checks, defects, stats };
}

/** run 里的文本（不含属性）。表格单元格里的段落也走这条路径，所以不需要额外分支。 */
function runSelf(doc: string, run: Element): string {
  if (run.selfClosing) return "";
  const body = doc.slice(run.openEnd, run.closeStart);
  const texts = body.match(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g) ?? [];
  return texts
    .map((chunk) => chunk.replace(/<[^>]*>/g, ""))
    .join("")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/** 缺陷 → 可执行的修复 pass（同一 pass 只排一次，顺序固定，保证幂等）。 */
export function repairPlan(verdict: Verdict, contract: StyleContract): PassId[] {
  const wanted = new Set<PassId>();
  for (const defect of verdict.defects) {
    if (defect.fixable && contract.passes.includes(defect.fixable)) wanted.add(defect.fixable);
  }
  const order: PassId[] = ["sectPr", "tableBorders", "tableRow", "fontRun"];
  return order.filter((id) => wanted.has(id));
}
