// OOXML 子元素顺序表 + 「按顺序插入」。
//
// 为什么必须有这张表：Word 对 CT_SectPr / CT_TblPr / CT_RPr 这类 sequence 类型的子元素是**顺序敏感**的，
// 顺序错了轻则设置被忽略（框线写了但不显示、页边距写了但仍是默认值），重则打开时报「内容有问题」。
// 而 pandoc 产物 + 我们的插入式改写最容易犯的错就是「往尾部追加」：`<w:sectPr>` 里原来的
// `w:docGrid` 在后面，新追加的 `w:pgMar` 就落在它后面 → Word 忽略。
//
// 表内容来自 ECMA-376 CT_RPr / CT_PPr / CT_TblPr / CT_TrPr / CT_TcPr / CT_SectPr / CT_Style 的定义，
// 只收录本方案会插入或检查的元素；表里没有的元素视为「未知」，一律排到最后（宁可追加到末尾，
// 也不要把已知元素挤到非法位置）。
import { directChildTags, type Element } from "./xmlScan";

const ORDER: Record<string, string[]> = {
  "w:sectPr": [
    "w:headerReference",
    "w:footerReference",
    "w:footnotePr",
    "w:endnotePr",
    "w:type",
    "w:pgSz",
    "w:pgMar",
    "w:paperSrc",
    "w:pgBorders",
    "w:lnNumType",
    "w:pgNumType",
    "w:cols",
    "w:formProt",
    "w:vAlign",
    "w:noEndnote",
    "w:titlePg",
    "w:textDirection",
    "w:bidi",
    "w:rtlGutter",
    "w:docGrid",
    "w:printerSettings",
    "w:sectPrChange",
  ],
  "w:tblPr": [
    "w:tblStyle",
    "w:tblpPr",
    "w:tblOverlap",
    "w:bidiVisual",
    "w:tblStyleRowBandSize",
    "w:tblStyleColBandSize",
    "w:tblW",
    "w:jc",
    "w:tblCellSpacing",
    "w:tblInd",
    "w:tblBorders",
    "w:shd",
    "w:tblLayout",
    "w:tblCellMar",
    "w:tblLook",
    "w:tblCaption",
    "w:tblDescription",
  ],
  "w:trPr": [
    "w:cnfStyle",
    "w:divId",
    "w:gridBefore",
    "w:gridAfter",
    "w:wBefore",
    "w:wAfter",
    "w:cantSplit",
    "w:trHeight",
    "w:tblHeader",
    "w:tblCellSpacing",
    "w:jc",
    "w:hidden",
    "w:ins",
    "w:del",
    "w:trPrChange",
  ],
  "w:tcPr": [
    "w:cnfStyle",
    "w:tcW",
    "w:gridSpan",
    "w:hMerge",
    "w:vMerge",
    "w:tcBorders",
    "w:shd",
    "w:noWrap",
    "w:tcMar",
    "w:textDirection",
    "w:tcFitText",
    "w:vAlign",
    "w:hideMark",
    "w:headers",
    "w:cellIns",
    "w:cellDel",
    "w:cellMerge",
    "w:tcPrChange",
  ],
  "w:rPr": [
    "w:rStyle",
    "w:rFonts",
    "w:b",
    "w:bCs",
    "w:i",
    "w:iCs",
    "w:caps",
    "w:smallCaps",
    "w:strike",
    "w:dstrike",
    "w:outline",
    "w:shadow",
    "w:emboss",
    "w:imprint",
    "w:noProof",
    "w:snapToGrid",
    "w:vanish",
    "w:webHidden",
    "w:color",
    "w:spacing",
    "w:w",
    "w:kern",
    "w:position",
    "w:sz",
    "w:szCs",
    "w:highlight",
    "w:u",
    "w:effect",
    "w:bdr",
    "w:shd",
    "w:fitText",
    "w:vertAlign",
    "w:rtl",
    "w:cs",
    "w:em",
    "w:lang",
    "w:eastAsianLayout",
    "w:specVanish",
    "w:oMath",
  ],
  "w:pPr": [
    "w:pStyle",
    "w:keepNext",
    "w:keepLines",
    "w:pageBreakBefore",
    "w:framePr",
    "w:widowControl",
    "w:numPr",
    "w:suppressLineNumbers",
    "w:pBdr",
    "w:shd",
    "w:tabs",
    "w:suppressAutoHyphens",
    "w:kinsoku",
    "w:wordWrap",
    "w:overflowPunct",
    "w:topLinePunct",
    "w:autoSpaceDE",
    "w:autoSpaceDN",
    "w:bidi",
    "w:adjustRightInd",
    "w:snapToGrid",
    "w:spacing",
    "w:ind",
    "w:contextualSpacing",
    "w:mirrorIndents",
    "w:suppressOverlap",
    "w:jc",
    "w:textDirection",
    "w:textAlignment",
    "w:textboxTightWrap",
    "w:outlineLvl",
    "w:divId",
    "w:cnfStyle",
    "w:rPr",
    "w:sectPr",
    "w:pPrChange",
  ],
  "w:style": [
    "w:name",
    "w:aliases",
    "w:basedOn",
    "w:next",
    "w:link",
    "w:autoRedefine",
    "w:hidden",
    "w:uiPriority",
    "w:semiHidden",
    "w:unhideWhenUsed",
    "w:qFormat",
    "w:locked",
    "w:personal",
    "w:personalCompose",
    "w:personalReply",
    "w:rsid",
    "w:pPr",
    "w:rPr",
    "w:tblPr",
    "w:trPr",
    "w:tcPr",
    "w:tblStylePr",
  ],
  "w:tblBorders": ["w:top", "w:left", "w:bottom", "w:right", "w:insideH", "w:insideV"],
  "w:tblCellMar": ["w:top", "w:left", "w:bottom", "w:right"],
  "w:styles": ["w:docDefaults", "w:latentStyles", "w:style"],
  "w:docDefaults": ["w:rPrDefault", "w:pPrDefault"],
  "w:rPrDefault": ["w:rPr"],
  "w:pPrDefault": ["w:pPr"],
};

/** 未知元素一律排在最后：用一个比任何已知下标都大的值表示。 */
const UNKNOWN = 1000;

export function orderIndex(parent: string, child: string): number {
  const list = ORDER[parent];
  if (!list) return UNKNOWN;
  const index = list.indexOf(child);
  return index < 0 ? UNKNOWN : index;
}

/** 父元素里第一个「顺序应该排在新元素之后」的直接子标签；没有就返回 null（= 追加到末尾）。 */
export function insertionPoint(xml: string, parent: Element, childName: string): number | null {
  const mine = orderIndex(parent.name, childName);
  if (mine >= UNKNOWN) return null;
  for (const tag of directChildTags(xml, parent)) {
    if (tag.name === childName) continue;
    if (orderIndex(parent.name, tag.name) > mine) return tag.start;
  }
  return null;
}

/** 按 schema 顺序插入一个子元素。parent 必须是非自闭合元素（自闭合先 expandSelfClosing）。 */
export function insertChildXml(xml: string, parent: Element, childName: string, childXml: string): string {
  if (parent.selfClosing) return xml; // 调用方有 bug：先展开
  const at = insertionPoint(xml, parent, childName) ?? parent.closeStart;
  return xml.slice(0, at) + childXml + xml.slice(at);
}

/** 父元素的第一个同名直接子标签（用于「存在就替换」）。 */
export function firstDirectChild(xml: string, parent: Element, childName: string) {
  return directChildTags(xml, parent).find((tag) => tag.name === childName) ?? null;
}

/** 关系表：本方案只会读它，不会写（写 rels 等于造文档，超出职责边界）。 */
export const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
