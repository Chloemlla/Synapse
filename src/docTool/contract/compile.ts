// 声明层：把契约编译进 reference.docx 的 word/styles.xml。
//
// 为什么只能改 styles.xml（实测，不是推断）：
//   探针四组对照（pandoc 3.12.1，同一份 md）：
//     ① 裸 pandoc                       → 表格 0 条 tblBorders、run 级无 eastAsia、pgMar 720
//     ② --reference-doc=仓库自带模板     → **与①字节完全相同**（cmp 通过），即现行中文模板对中文零作用
//     ③ 只改 reference 的 styles.xml     → docDefaults 里出现显式宋体、Table 样式里出现 tblBorders
//     ④ 只改 reference 的 document.xml   → 输出 pgMar 仍是 720、纸张仍是 A4
//   ④ 是这张表里最关键的一格：pandoc **完全忽略** reference 的 document.xml。
//   所以「字体/框线/缩进/行距」走这里（编译 styles.xml），「页边距/纸张/行不跨页」走后处理 pass。
//
// styles.xml 的根因（为什么现行模板对中文无效）：
//   它的 docDefaults 写的是 `w:eastAsiaTheme="minorEastAsia"`（主题字体引用）而不是具体字体名。
//   主题字体在中文字体缺失的环境里会静默回退，而「静默回退」正是验收时最容易漏掉的一类缺陷：
//   文档能打开、字能显示，就是不是宋体。这里把主题引用整条换成显式字体名，这是 C2 判据的靶子。
import { insertChildXml } from "./order";
import {
  attr,
  attrLocal,
  elementAfter,
  elements,
  expandSelfClosing,
  firstDirectChildIn,
  type Element,
} from "./xmlScan";
import { readZip } from "./zipRead";
import { rewriteZip } from "./zipRewrite";
import {
  cmToTwips,
  normalizeContract,
  ptToHalfPt,
  ptToTwips,
  type BorderSpec,
  type FontSpec,
  type StyleContract,
  type TableBorders,
} from "./types";

const XML_ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };

/** 字体名/字符串进 XML 前必须转义：契约是用户可编辑的 JSON，不转义等于把 XML 注入放进 docx。 */
export function escXml(value: string): string {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => XML_ESC[ch]);
}

export const openTagOf = (xml: string, el: Element): string => xml.slice(el.start, el.openEnd);

/** 取 `w:val`（前缀由文档自己决定，用 attrLocal 忽略前缀）。 */
export const valOf = (tagRaw: string): string => attrLocal(tagRaw, "val") ?? "";

function childVal(xml: string, parent: Element, childName: string): string | null {
  const child = firstDirectChildIn(xml, parent, childName);
  return child ? valOf(child.raw) : null;
}

/** 按 (name, start) 重新定位元素：插入式改写只会在 start 之后动手，所以 start 恒为稳定锚点。 */
function at(xml: string, name: string, start: number): Element | null {
  return elements(xml, name).find((el) => el.start === start) ?? null;
}

/**
 * 在 parent 里「有就替换、没有就按 schema 顺序插入」一个直接子元素。
 * parent 是 `<x />` 自闭合时先展开成 `<x></x>`（Word 两种写法都认，但插入必须有内容位置）。
 */
export function setChild(xml: string, parent: Element, childName: string, childXml: string): string {
  let cur = xml;
  let el = parent;
  if (el.selfClosing) {
    cur = expandSelfClosing(cur, el);
    const again = at(cur, el.name, el.start);
    if (!again) return cur;
    el = again;
  }
  const existing = firstDirectChildIn(cur, el, childName);
  if (existing) return cur.slice(0, existing.start) + childXml + cur.slice(existing.end);
  return insertChildXml(cur, el, childName, childXml);
}

/**
 * 沿 path 逐级下钻（没有就建一个空壳），最后把 leafXml 写进最里层。
 * 例：upsert(xml, 样式元素, ["w:pPr", "w:spacing"], "<w:spacing .../>")。
 */
export function upsert(xml: string, root: Element, path: string[], leafXml: string): string {
  let cur = xml;
  let parent = at(cur, root.name, root.start) ?? root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const name = path[index];
    let child = firstDirectChildIn(cur, parent, name);
    if (!child) {
      cur = setChild(cur, parent, name, `<${name}></${name}>`);
      const refreshed = at(cur, parent.name, parent.start);
      if (!refreshed) return cur;
      parent = refreshed;
      child = firstDirectChildIn(cur, parent, name);
      if (!child) return cur;
    }
    parent = child;
  }
  return setChild(cur, parent, path[path.length - 1], leafXml);
}

/** 样式定位：先按 w:name（大小写无关）找，找不到再按 w:styleId 找。 */
export function findStyle(xml: string, names: string[], styleIds: string[] = []): Element | null {
  const wanted = names.map((name) => name.toLowerCase());
  const all = elements(xml, "w:style");
  for (const style of all) {
    const name = childVal(xml, style, "w:name");
    if (name && wanted.includes(name.toLowerCase())) return style;
  }
  for (const style of all) {
    const id = attrLocal(openTagOf(xml, style), "styleId");
    if (id && styleIds.includes(id)) return style;
  }
  return null;
}

export function rFontsXml(font: FontSpec): string {
  // 四个槽位全部写成**显式字体名**，一个主题引用都不留（这是 C2 的根因修复）
  return `<w:rFonts w:ascii="${escXml(font.latin)}" w:hAnsi="${escXml(font.latin)}" w:eastAsia="${escXml(
    font.eastAsia,
  )}" w:cs="${escXml(font.latin)}" />`;
}

export function borderXml(tag: string, spec: BorderSpec): string {
  if (spec.style === "none") return `<${tag} w:val="none" w:sz="0" w:space="0" w:color="auto" />`;
  return `<${tag} w:val="${spec.style}" w:sz="${spec.sizeEighthPt}" w:space="0" w:color="${escXml(spec.color)}" />`;
}

export function tblBordersXml(borders: TableBorders): string {
  return (
    `<w:tblBorders>${borderXml("w:top", borders.top)}${borderXml("w:left", borders.left)}` +
    `${borderXml("w:bottom", borders.bottom)}${borderXml("w:right", borders.right)}` +
    `${borderXml("w:insideH", borders.insideH)}${borderXml("w:insideV", borders.insideV)}</w:tblBorders>`
  );
}

export function tblCellMarXml(twips: number): string {
  return (
    `<w:tblCellMar><w:top w:w="${twips}" w:type="dxa" /><w:left w:w="${twips}" w:type="dxa" />` +
    `<w:bottom w:w="${twips}" w:type="dxa" /><w:right w:w="${twips}" w:type="dxa" /></w:tblCellMar>`
  );
}

export interface CompileReport {
  xml: string;
  /** 实际改到的位置（写进日志与体检报告，让「契约生效了」可核对而不是靠相信） */
  applied: string[];
  /** 契约要求了但模板里找不到对应样式的位置 */
  skipped: string[];
}

const BODY_STYLE_NAMES = ["body text", "first paragraph", "normal", "compact"];
/** 只给真正的正文段落加首行缩进：Compact 被 pandoc 用在列表项与**表格单元格**里，加缩进会挤坏版面。 */
const INDENT_STYLE_NAMES = new Set(["body text", "first paragraph", "normal"]);

function spacingXml(contract: StyleContract): string {
  return (
    `<w:spacing w:before="${ptToTwips(contract.paragraph.spaceBeforePt)}" w:after="${ptToTwips(
      contract.paragraph.spaceAfterPt,
    )}" w:line="${ptToTwips(contract.paragraph.lineSpacingPt)}" w:lineRule="${contract.paragraph.lineRule}" />`
  );
}

function indentXml(contract: StyleContract): string {
  const chars = Math.round(contract.paragraph.firstLineIndentChars * 100);
  const twips = Math.round(contract.paragraph.firstLineIndentChars * contract.body.sizePt * 20);
  return `<w:ind w:firstLineChars="${chars}" w:firstLine="${twips}" />`;
}

/** 把契约编译进 styles.xml。纯函数：同一 (stylesXml, contract) 永远得到同一结果。 */
export function compileStyles(stylesXml: string, contract: StyleContract): CompileReport {
  const applied: string[] = [];
  const skipped: string[] = [];
  let xml = stylesXml;
  const root = elements(xml, "w:styles")[0];
  if (!root) throw new Error("styles.xml 里没有 <w:styles> 根元素");
  // upsert 只用 name+start 做锚点（每次都会重新解析，所以插入引起的位移不会失效）
  const anchor: Element = root;

  // ---- 1) docDefaults：字体改成显式字体名（这是中文回退的根因） ----
  xml = upsert(xml, anchor, ["w:docDefaults", "w:rPrDefault", "w:rPr", "w:rFonts"], rFontsXml(contract.body));
  xml = upsert(xml, anchor, ["w:docDefaults", "w:rPrDefault", "w:rPr", "w:sz"], `<w:sz w:val="${ptToHalfPt(contract.body.sizePt)}" />`);
  xml = upsert(xml, anchor, ["w:docDefaults", "w:rPrDefault", "w:rPr", "w:szCs"], `<w:szCs w:val="${ptToHalfPt(contract.body.sizePt)}" />`);
  applied.push(`docDefaults 字体 = ${contract.body.eastAsia} / ${contract.body.latin}（主题字体引用已移除）`);

  // ---- 2) 正文样式：字号、行距、首行缩进、两端对齐 ----
  for (const name of BODY_STYLE_NAMES) {
    const style = findStyle(xml, [name]);
    if (!style) {
      skipped.push(`样式「${name}」不存在`);
      continue;
    }
    xml = upsert(xml, style, ["w:pPr", "w:spacing"], spacingXml(contract));
    if (INDENT_STYLE_NAMES.has(name)) xml = upsert(xml, style, ["w:pPr", "w:ind"], indentXml(contract));
    xml = upsert(xml, style, ["w:pPr", "w:jc"], `<w:jc w:val="${contract.paragraph.justify}" />`);
    xml = upsert(xml, style, ["w:rPr", "w:sz"], `<w:sz w:val="${ptToHalfPt(contract.body.sizePt)}" />`);
    applied.push(`正文样式「${name}」：行距 ${contract.paragraph.lineSpacingPt}pt，字号 ${contract.body.sizePt}pt`);
  }

  // ---- 3) 表格样式：补 tblBorders（零宽框线等于不可见，这是 C1 的靶子） ----
  const tableStyle = findStyle(xml, ["table"], ["Table"]);
  if (!tableStyle) {
    const created =
      `<w:style w:type="table" w:customStyle="1" w:styleId="Table"><w:name w:val="Table" />` +
      `<w:tblPr>${tblBordersXml(contract.table.borders)}${tblCellMarXml(contract.table.cellMarginTwips)}</w:tblPr></w:style>`;
    xml = xml.replace(/<\/w:styles>\s*$/, `${created}</w:styles>`);
    applied.push("新建 Table 表格样式（原模板里没有）");
  } else {
    xml = upsert(xml, tableStyle, ["w:tblPr", "w:tblBorders"], tblBordersXml(contract.table.borders));
    xml = upsert(xml, tableStyle, ["w:tblPr", "w:tblCellMar"], tblCellMarXml(contract.table.cellMarginTwips));
    applied.push(`Table 样式框线 = ${contract.table.borders.top.sizeEighthPt}/8 磅 ${contract.table.borders.top.style}`);
  }

  // ---- 4) 标题：中文字体 + 字号 + 段前段后 + 保持同页 ----
  for (const heading of contract.headings) {
    const style = findStyle(xml, [`heading ${heading.level}`], [`Heading${heading.level}`]);
    if (!style) {
      skipped.push(`样式 heading ${heading.level} 不存在`);
      continue;
    }
    xml = upsert(xml, style, ["w:rPr", "w:rFonts"], rFontsXml(heading.font));
    xml = upsert(xml, style, ["w:rPr", "w:sz"], `<w:sz w:val="${ptToHalfPt(heading.font.sizePt)}" />`);
    if (heading.bold) xml = upsert(xml, style, ["w:rPr", "w:b"], "<w:b />");
    xml = upsert(
      xml,
      style,
      ["w:pPr", "w:spacing"],
      `<w:spacing w:before="${ptToTwips(heading.spaceBeforePt)}" w:after="${ptToTwips(heading.spaceAfterPt)}" />`,
    );
    if (heading.keepNext) xml = upsert(xml, style, ["w:pPr", "w:keepNext"], "<w:keepNext />");
    applied.push(`heading ${heading.level} = ${heading.font.eastAsia} ${heading.font.sizePt}pt`);
  }

  return { xml, applied, skipped };
}

/** 契约 → reference.docx 字节。base 可以是 pandoc 内置默认样式，也可以是用户自己上传的模板。 */
export function compileReferenceDoc(base: Buffer, contract: StyleContract): { buffer: Buffer; report: CompileReport } {
  const archive = readZip(base);
  const styles = archive.text("word/styles.xml");
  if (!styles) throw new Error("参考样式文档里没有 word/styles.xml");
  const report = compileStyles(styles, contract);
  const next = rewriteZip(archive, new Map([["word/styles.xml", Buffer.from(report.xml, "utf8")]]));
  return { buffer: next.buffer, report };
}

// ---- 反编译：从一份用户给的 .docx 里读出「他实际上在用的排版」，变成一份契约 ----

function num(raw: string | null | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

const twipsToCmLocal = (twips: number): number => Math.round((twips / 567) * 100) / 100;

/**
 * 反编译（contract ← docx）。这是「老师手上已经有一份排好的范本」时最实用的一条入口：
 * 不用手工填 20 个数字，直接读他那份范本里的 styles.xml + document.xml。
 * 读不到的项目保留默认值（宁可少读一项，也不要因为一项缺失就整体失败）。
 */
export function contractFromDocx(docx: Buffer, meta: { id: string; name: string }): StyleContract {
  const archive = readZip(docx);
  const styles = archive.text("word/styles.xml") ?? "";
  const document = archive.text("word/document.xml") ?? "";
  const partial: Record<string, unknown> = { id: meta.id, name: meta.name };

  const root = styles ? elements(styles, "w:styles")[0] : null;
  if (root && styles) {
    const defaults = firstDirectChildIn(styles, root, "w:docDefaults");
    const rPrDefault = defaults ? firstDirectChildIn(styles, defaults, "w:rPrDefault") : null;
    const rPr = rPrDefault ? firstDirectChildIn(styles, rPrDefault, "w:rPr") : null;
    const fonts = rPr ? firstDirectChildIn(styles, rPr, "w:rFonts") : null;
    if (fonts) {
      const sizeHalf = rPr ? firstDirectChildIn(styles, rPr, "w:sz") : null;
      partial.body = {
        eastAsia: attr(fonts.raw, "w:eastAsia") ?? undefined,
        latin: attr(fonts.raw, "w:ascii") ?? undefined,
        sizePt: sizeHalf ? num(valOf(sizeHalf.raw), 21) / 2 : undefined,
      };
    }
    const bodyStyle = findStyle(styles, ["body text", "normal"]);
    const pPr = bodyStyle ? firstDirectChildIn(styles, bodyStyle, "w:pPr") : null;
    const spacing = pPr ? firstDirectChildIn(styles, pPr, "w:spacing") : null;
    const ind = pPr ? firstDirectChildIn(styles, pPr, "w:ind") : null;
    if (spacing || ind) {
      partial.paragraph = {
        lineSpacingPt: spacing && attr(spacing.raw, "w:line") ? num(attr(spacing.raw, "w:line"), 440) / 20 : undefined,
        lineRule: spacing && attr(spacing.raw, "w:lineRule") === "auto" ? "auto" : spacing ? "exact" : undefined,
        firstLineIndentChars:
          ind && attr(ind.raw, "w:firstLineChars") ? num(attr(ind.raw, "w:firstLineChars"), 200) / 100 : undefined,
      };
    }
    const tableStyle = findStyle(styles, ["table"], ["Table"]);
    const tblPr = tableStyle ? firstDirectChildIn(styles, tableStyle, "w:tblPr") : null;
    const borders = tblPr ? firstDirectChildIn(styles, tblPr, "w:tblBorders") : null;
    const top = borders ? firstDirectChildIn(styles, borders, "w:top") : null;
    if (top) {
      partial.table = {
        borders: {
          top: {
            style: attr(top.raw, "w:val") ?? "single",
            sizeEighthPt: num(attr(top.raw, "w:sz"), 4),
            color: attr(top.raw, "w:color") ?? "000000",
          },
        },
      };
    }
  }

  const sect = document ? elements(document, "w:sectPr").pop() : null;
  if (sect && document) {
    const pgSz = firstDirectChildIn(document, sect, "w:pgSz");
    const pgMar = firstDirectChildIn(document, sect, "w:pgMar");
    partial.page = {
      widthCm: pgSz ? twipsToCmLocal(num(attr(pgSz.raw, "w:w"), 11906)) : undefined,
      heightCm: pgSz ? twipsToCmLocal(num(attr(pgSz.raw, "w:h"), 16838)) : undefined,
      marginTopCm: pgMar ? twipsToCmLocal(num(attr(pgMar.raw, "w:top"), 1440)) : undefined,
      marginBottomCm: pgMar ? twipsToCmLocal(num(attr(pgMar.raw, "w:bottom"), 1440)) : undefined,
      marginLeftCm: pgMar ? twipsToCmLocal(num(attr(pgMar.raw, "w:left"), 1440)) : undefined,
      marginRightCm: pgMar ? twipsToCmLocal(num(attr(pgMar.raw, "w:right"), 1440)) : undefined,
      headerCm: pgMar ? twipsToCmLocal(num(attr(pgMar.raw, "w:header"), 851)) : undefined,
      footerCm: pgMar ? twipsToCmLocal(num(attr(pgMar.raw, "w:footer"), 992)) : undefined,
    };
  }

  return normalizeContract(partial);
}

/** 给报告用的换算出口（测试与评测脚本会用）。 */
export const twipsToCmValue = twipsToCmLocal;
export const cmToTwipsValue = cmToTwips;
export const elementAfterOffset = elementAfter;
