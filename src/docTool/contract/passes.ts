// 后处理层：改产物 document.xml 的四个 pass。
//
// 全部是「按偏移插入/替换」，绝不 parse→stringify（理由见 xmlScan.ts 顶部）。
// 每个 pass 都是幂等的：跑第二遍时「已经有了就跳过」，所以 applyContract 可以放心地
// 「验 → 修 → 再验」，也可以用「两轮 pass 后 sha256 相等」来验证幂等性。
//
// 为什么页面设置必须在这里做（而不是编译参考样式）：
//   pandoc 完全忽略 reference.docx 的 document.xml（实测：注入了 pgMar=1418/1134 + Letter 纸张，
//   产物仍是 pgMar=720、A4 11906×16838）。而 pandoc 没有暴露页边距的命令行参数。
//   所以「页边距/纸张」这一项无法靠声明层实现，只能改产物 —— 这也是契约里唯一必须走后处理的项。
import { insertChildXml } from "./order";
import { attr, directChildTags, elements, firstDirectChildIn, type Element } from "./xmlScan";
import { borderXml, escXml, rFontsXml, setChild, tblBordersXml, tblCellMarXml } from "./compile";
import { cmToTwips, type PassId, type StyleContract } from "./types";

const at = (xml: string, name: string, start: number): Element | null =>
  elements(xml, name).find((el) => el.start === start) ?? null;

/** 页面设置：sectPr 里的 pgSz + pgMar。这是「唯一无法靠 reference.docx 实现」的一项。 */
export function sectPrPass(xml: string, contract: StyleContract): string {
  let cur = xml;
  const sections = elements(cur, "w:sectPr");
  const target = sections[sections.length - 1];
  if (!target) {
    // 模板里完全没有 sectPr（仓库自带的 reference.docx 就是这样，探针已确认）：
    // Word 会按内置默认（A4 + 1.27cm 边距）打开，所以必须补一个 body 级 sectPr
    const close = cur.lastIndexOf("</w:body>");
    const sect = `<w:sectPr>${sectPrChildren(contract)}</w:sectPr>`;
    if (close >= 0) return cur.slice(0, close) + sect + cur.slice(close);
    return cur;
  }
  // 自闭合的 <w:sectPr /> 先展开，再逐项写
  if (target.selfClosing) {
    cur = cur.slice(0, target.start) + `<w:sectPr></w:sectPr>` + cur.slice(target.end);
  }
  const refreshed = at(cur, "w:sectPr", target.start);
  if (!refreshed) return cur;
  const page = contract.page;
  cur = setChild(
    cur,
    refreshed,
    "w:pgSz",
    `<w:pgSz w:w="${cmToTwips(page.widthCm)}" w:h="${cmToTwips(page.heightCm)}" w:orient="portrait" />`,
  );
  const again = at(cur, "w:sectPr", target.start);
  if (!again) return cur;
  cur = setChild(cur, again, "w:pgMar", `<w:pgMar ${pgMarAttrs(contract)} />`);
  return cur;
}

function pgMarAttrs(contract: StyleContract): string {
  const page = contract.page;
  // w:gutter="0" 必须写：某些模板把装订线放在这里，不归零会让左右边距悄悄偏掉
  return (
    `w:top="${cmToTwips(page.marginTopCm)}" w:right="${cmToTwips(page.marginRightCm)}" ` +
    `w:bottom="${cmToTwips(page.marginBottomCm)}" w:left="${cmToTwips(page.marginLeftCm)}" ` +
    `w:header="${cmToTwips(page.headerCm)}" w:footer="${cmToTwips(page.footerCm)}" w:gutter="0"`
  );
}

function sectPrChildren(contract: StyleContract): string {
  return (
    `<w:pgSz w:w="${cmToTwips(contract.page.widthCm)}" w:h="${cmToTwips(contract.page.heightCm)}" w:orient="portrait" />` +
    `<w:pgMar ${pgMarAttrs(contract)} />`
  );
}

/**
 * 表格框线兜底：把 tblBorders 直接写进每个表格自己的 tblPr。
 *
 * 为什么在「已经编译进 Table 样式」之后还要这一层：用户可能上传自己的模板，而模板里根本没有
 * 名为 Table 的表格样式（或它基于 TableNormal → 无框线），此时 pandoc 仍会写 `<w:tblStyle w:val="Table"/>`，
 * Word 找不到该样式就退回「无框线」。声明层管不到「样式不存在」这种情况，产物级兜底才能把 C1 拉满。
 */
export function tableBordersPass(xml: string, contract: StyleContract): string {
  const starts = elements(xml, "w:tbl").map((el) => el.start);
  let cur = xml;
  for (let index = starts.length - 1; index >= 0; index -= 1) {
    const table = at(cur, "w:tbl", starts[index]);
    if (!table) continue;
    let tblPr = firstDirectChildIn(cur, table, "w:tblPr");
    if (!tblPr) {
      cur = insertChildXml(cur, table, "w:tblPr", "<w:tblPr></w:tblPr>");
      const again = at(cur, "w:tbl", starts[index]);
      tblPr = again ? firstDirectChildIn(cur, again, "w:tblPr") : null;
      if (!tblPr) continue;
    }
    cur = setChild(cur, tblPr, "w:tblBorders", tblBordersXml(contract.table.borders));
    const afterBorders = at(cur, "w:tbl", starts[index]);
    const pr = afterBorders ? firstDirectChildIn(cur, afterBorders, "w:tblPr") : null;
    if (pr) cur = setChild(cur, pr, "w:tblCellMar", tblCellMarXml(contract.table.cellMarginTwips));
  }
  return cur;
}

/** 表格行：cantSplit（行不跨页）+ 首行 tblHeader（跨页重复表头）。 */
export function tableRowPass(xml: string, contract: StyleContract): string {
  const starts = elements(xml, "w:tbl").map((el) => el.start);
  let cur = xml;
  for (let index = starts.length - 1; index >= 0; index -= 1) {
    const table = at(cur, "w:tbl", starts[index]);
    if (!table) continue;
    // 只取直接子行：嵌套表格的行属于内层表格，内层会自己走一遍（否则同一个行会被处理两次）
    const rows = directChildTags(cur, table).filter((tag) => tag.name === "w:tr");
    if (!rows.length) continue;
    const rowStarts = rows.map((tag) => tag.start);
    for (let r = rowStarts.length - 1; r >= 0; r -= 1) {
      const row = elements(cur, "w:tr").find((el) => el.start === rowStarts[r]);
      if (!row) continue;
      let trPr = firstDirectChildIn(cur, row, "w:trPr");
      if (!trPr) {
        cur = insertChildXml(cur, row, "w:trPr", "<w:trPr></w:trPr>");
        const again = elements(cur, "w:tr").find((el) => el.start === rowStarts[r]);
        trPr = again ? firstDirectChildIn(cur, again, "w:trPr") : null;
        if (!trPr) continue;
      }
      if (contract.table.rowCannotSplit && !firstDirectChildIn(cur, trPr, "w:cantSplit")) {
        cur = setChild(cur, trPr, "w:cantSplit", "<w:cantSplit />");
      }
      if (r === 0 && contract.table.repeatHeaderRow) {
        const refreshed = elements(cur, "w:tr").find((el) => el.start === rowStarts[r]);
        const pr = refreshed ? firstDirectChildIn(cur, refreshed, "w:trPr") : null;
        if (pr && !firstDirectChildIn(cur, pr, "w:tblHeader")) {
          cur = setChild(cur, pr, "w:tblHeader", "<w:tblHeader />");
        }
      }
    }
  }
  return cur;
}

const THEME_ATTRS = ["w:eastAsiaTheme", "w:asciiTheme", "w:hAnsiTheme", "w:cstheme"];

/**
 * 字体兜底：把 run 上的**主题字体引用**换成显式字体名。
 *
 * 正常路径不需要它（docDefaults 已经改成显式字体，run 级继承就够了）。它存在的意义是
 * 覆盖「用户模板的 docDefaults 结构太怪、编译期没改到」这种情况 —— 此时 run 上会留下
 * `w:eastAsiaTheme="minorEastAsia"`，Word 会按主题字体回退，中文就不是宋体了。
 */
export function fontRunPass(xml: string, contract: StyleContract): string {
  const runs = elements(xml, "w:r");
  let cur = xml;
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index];
    const spanEnd = run.selfClosing ? run.end : run.closeStart;
    if (spanEnd <= run.start) continue;
    const body = cur.slice(run.openEnd, spanEnd);
    const match = body.match(/<w:rFonts\b[^>]*>/);
    if (!match) continue;
    const raw = match[0];
    if (!THEME_ATTRS.some((name) => raw.includes(`${name}=`))) continue;
    let next = raw;
    for (const name of THEME_ATTRS) {
      next = next.replace(new RegExp(`\\s${name}="[^"]*"`, "g"), "");
    }
    next = next.replace(
      /\s*\/?>$/,
      ` w:eastAsia="${escXml(contract.body.eastAsia)}" w:ascii="${escXml(contract.body.latin)}" w:hAnsi="${escXml(
        contract.body.latin,
      )}" />`,
    );
    const offset = run.openEnd + (match.index ?? 0);
    cur = cur.slice(0, offset) + next + cur.slice(offset + raw.length);
  }
  return cur;
}

export const PASS_IMPL: Record<PassId, (xml: string, contract: StyleContract) => string> = {
  sectPr: sectPrPass,
  tableBorders: tableBordersPass,
  tableRow: tableRowPass,
  fontRun: fontRunPass,
};

/** 按顺序应用指定 pass。契约里没开的 pass 一律不执行（verify 的修复计划也受它约束）。 */
export function applyPasses(xml: string, contract: StyleContract, ids: PassId[]): string {
  let cur = xml;
  for (const id of ids) {
    const impl = PASS_IMPL[id];
    if (impl) cur = impl(cur, contract);
  }
  return cur;
}

/** 单条框线的 XML（评测脚本与测试会用；导出是为了「契约 → 字节」这条链路可被外部复用）。 */
export const borderXmlFor = borderXml;
export const rFontsXmlFor = rFontsXml;
