// 「排版契约」（Layout Contract）：把学校教务/教研组那套「中文排版要求」写成**可校验的数据**，
// 而不是写在纸上、每次靠人手去 Word 里对一遍。
//
// 为什么要分成「声明层」和「后处理层」两半（实测结论，不是猜的）：
//   pandoc 只读 reference.docx 的 word/styles.xml，**完全忽略它的 word/document.xml**
//   （探针：只改 reference 的 document.xml 注入 sectPr，输出 pgMar 仍是默认 720 twips、纸张仍是 A4）。
// 所以：
//   声明层（compile.ts）—— 字体 / 字号 / 缩进 / 行距 / 表格框线，靠编译参考样式文档生效；
//   后处理层（passes.ts）—— 页边距 / 纸张 / 行不跨页，只能改产物 document.xml。
// 这个分工带来了本方案最关键的一条自证判据：契约里每一项都必须能被 verify.ts 从**产物字节**里数出来，
// 数不出来就不算契约 —— 不许有「设置了但没人验证」的字段。
//
// 本文件零第三方依赖（只 import node:crypto），可以被 jest、HTTP 层、离线评测脚本共用。
import crypto from "node:crypto";

/** 契约结构版本：字段含义变了就 +1，老 JSON 由 normalizeContract 逐字段回落默认。 */
export const CONTRACT_VERSION = 1;

/** 后处理 pass 的名字。声明层做不到的事全部收敛到这四个里，别再加第五个近义 pass。 */
export type PassId = "sectPr" | "tableBorders" | "tableRow" | "fontRun";

export const PASS_IDS: PassId[] = ["sectPr", "tableBorders", "tableRow", "fontRun"];

export const PASS_LABELS: Record<PassId, string> = {
  sectPr: "页面设置（页边距 / 纸张）",
  tableBorders: "表格框线（产物级兜底）",
  tableRow: "表格行不跨页",
  fontRun: "字体（产物级兜底）",
};

/** 字体三元组：中文/西文分开写，`eastAsia` 必须是具体字体名，不能是主题字体引用。 */
export interface FontSpec {
  /** 西文字体 → w:ascii / w:hAnsi */
  latin: string;
  /** 中文字体 → w:eastAsia。写 "宋体" 而不是 "minorEastAsia"：主题字体在缺字体的机器上会静默回退。 */
  eastAsia: string;
  /** 字号（磅 pt）。w:sz 是半磅，换算见 ptToHalfPt()。 */
  sizePt: number;
}

/** 纸张与页边距。全部用厘米，换算成 twips 的精度损失由 round 吸收（1 cm = 567 twips）。 */
export interface PageSpec {
  widthCm: number;
  heightCm: number;
  marginTopCm: number;
  marginBottomCm: number;
  marginLeftCm: number;
  marginRightCm: number;
  /** 页眉/页脚到边界的距离，Word 默认页眉 1.5cm / 页脚 1.75cm。 */
  headerCm: number;
  footerCm: number;
}

/** 正文段落。 */
export interface ParagraphSpec {
  /** 行距磅值；lineRule=exact 时就是「固定值 N 磅」，auto 时乘以单倍行距。 */
  lineSpacingPt: number;
  lineRule: "exact" | "auto";
  /** 首行缩进字符数（中文字体下 2 = 两个字符宽）。同时写 firstLineChars 与 firstLine 两套属性。 */
  firstLineIndentChars: number;
  spaceBeforePt: number;
  spaceAfterPt: number;
  justify: "both" | "left" | "center" | "right" | "distribute";
}

/** 单条框线。w:sz 的单位是 1/8 磅，4 = 0.5 磅。 */
export interface BorderSpec {
  style: "single" | "double" | "thick" | "dashed" | "none";
  sizeEighthPt: number;
  /** 6 位十六进制，不带 # */
  color: string;
}

export interface TableBorders {
  top: BorderSpec;
  left: BorderSpec;
  bottom: BorderSpec;
  right: BorderSpec;
  insideH: BorderSpec;
  insideV: BorderSpec;
}

export interface TableSpec {
  borders: TableBorders;
  /** 单元格左右留白（twips），Word 默认 108。 */
  cellMarginTwips: number;
  /** 表格行不跨页（w:cantSplit）。 */
  rowCannotSplit: boolean;
  /** 首行作为表头跨页重复（w:tblHeader；pandoc 默认已写，此处作为契约声明与验收依据）。 */
  repeatHeaderRow: boolean;
  /** 表头加粗（产物级不改写，只作为人工检查项）。 */
  headerBold: boolean;
}

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export interface HeadingSpec {
  level: HeadingLevel;
  font: FontSpec;
  bold: boolean;
  spaceBeforePt: number;
  spaceAfterPt: number;
  /** 标题保持与下段同页（w:keepNext），避免标题孤零零掉在页尾。 */
  keepNext: boolean;
}

/** 验收门槛：分数下限与允许的修复轮数（幂等性由「两轮 pass 字节相同」单独验，不在这里）。 */
export interface AcceptSpec {
  minScore: number;
  maxRepairRounds: number;
}

/** 一份完整契约。 */
export interface StyleContract {
  version: number;
  /** 稳定标识（内置预设用固定 id；用户导入的用 "user-" 前缀 + 时间戳）。 */
  id: string;
  name: string;
  description?: string;
  body: FontSpec;
  page: PageSpec;
  paragraph: ParagraphSpec;
  table: TableSpec;
  /** 必须覆盖 1..6 级；缺的级别在 normalizeContract 里按上一级回填。 */
  headings: HeadingSpec[];
  /** 允许自动执行的后处理 pass。verify 的缺陷修复也受它约束（关掉的 pass 只报修不了）。 */
  passes: PassId[];
  accept: AcceptSpec;
}

/** 列表页用的契约摘要（不含 headings 数组，避免下拉框拖着一坨数据）。 */
export interface ContractSummary {
  id: string;
  name: string;
  description?: string;
  body: FontSpec;
  page: PageSpec;
  builtin: boolean;
  /** 可读的排版描述，给前端下拉项做副标题 */
  subtitle: string;
}

// ---- 单位换算：OOXML 的四个陷阱单位 ----

/** 1 cm = 566.929133858 twips（1440 twips = 1 inch = 2.54 cm）。 */
export const cmToTwips = (cm: number): number => Math.round(cm * 567);
export const twipsToCm = (twips: number): number => Math.round((twips / 567) * 100) / 100;
/** w:sz / w:szCs 是**半磅**：12pt → 24。 */
export const ptToHalfPt = (pt: number): number => Math.round(pt * 2);
/** w:spacing 的 line（固定值）与 w:ind 是**twips**：1pt = 20 twips。 */
export const ptToTwips = (pt: number): number => Math.round(pt * 20);
/** 框线 w:sz 是**1/8 磅**：0.5pt → 4。 */
export const ptToEighthPt = (pt: number): number => Math.round(pt * 8);

const clamp = (value: number, min: number, max: number): number =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;

const asString = (value: unknown, fallback: string): string =>
  typeof value === "string" && value.trim() ? value.trim() : fallback;

const asNumber = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const asBool = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback);

const JUSTIFY = ["both", "left", "center", "right", "distribute"] as const;
const LINE_RULE = ["exact", "auto"] as const;
const BORDER_STYLE = ["single", "double", "thick", "dashed", "none"] as const;

function normBorder(raw: unknown, fallback: BorderSpec): BorderSpec {
  const src = (raw ?? {}) as Partial<BorderSpec>;
  return {
    style: BORDER_STYLE.includes(src.style as (typeof BORDER_STYLE)[number]) ? (src.style as BorderSpec["style"]) : fallback.style,
    sizeEighthPt: clamp(asNumber(src.sizeEighthPt, fallback.sizeEighthPt), 0, 96),
    color: /^[0-9a-fA-F]{6}$/.test(String(src.color ?? "")) ? String(src.color).toUpperCase() : fallback.color,
  };
}

export function normalizeFont(raw: unknown, fallback: FontSpec): FontSpec {
  const src = (raw ?? {}) as Partial<FontSpec>;
  return {
    latin: asString(src.latin, fallback.latin),
    // 主题字体引用（minorEastAsia 等）在 verify 的 C2 里等价于「没有设置中文字体」，这里直接判非法回落
    eastAsia: /^[A-Za-z]*[Tt]heme$/.test(asString(src.eastAsia, "")) ? fallback.eastAsia : asString(src.eastAsia, fallback.eastAsia),
    sizePt: clamp(asNumber(src.sizePt, fallback.sizePt), 5, 72),
  };
}

function normPage(raw: unknown, fallback: PageSpec): PageSpec {
  const src = (raw ?? {}) as Partial<PageSpec>;
  return {
    widthCm: clamp(asNumber(src.widthCm, fallback.widthCm), 5, 100),
    heightCm: clamp(asNumber(src.heightCm, fallback.heightCm), 5, 100),
    marginTopCm: clamp(asNumber(src.marginTopCm, fallback.marginTopCm), 0, 20),
    marginBottomCm: clamp(asNumber(src.marginBottomCm, fallback.marginBottomCm), 0, 20),
    marginLeftCm: clamp(asNumber(src.marginLeftCm, fallback.marginLeftCm), 0, 20),
    marginRightCm: clamp(asNumber(src.marginRightCm, fallback.marginRightCm), 0, 20),
    headerCm: clamp(asNumber(src.headerCm, fallback.headerCm), 0, 20),
    footerCm: clamp(asNumber(src.footerCm, fallback.footerCm), 0, 20),
  };
}

function normParagraph(raw: unknown, fallback: ParagraphSpec): ParagraphSpec {
  const src = (raw ?? {}) as Partial<ParagraphSpec>;
  return {
    lineSpacingPt: clamp(asNumber(src.lineSpacingPt, fallback.lineSpacingPt), 6, 96),
    lineRule: LINE_RULE.includes(src.lineRule as (typeof LINE_RULE)[number]) ? (src.lineRule as ParagraphSpec["lineRule"]) : fallback.lineRule,
    firstLineIndentChars: clamp(asNumber(src.firstLineIndentChars, fallback.firstLineIndentChars), 0, 8),
    spaceBeforePt: clamp(asNumber(src.spaceBeforePt, fallback.spaceBeforePt), 0, 200),
    spaceAfterPt: clamp(asNumber(src.spaceAfterPt, fallback.spaceAfterPt), 0, 200),
    justify: JUSTIFY.includes(src.justify as (typeof JUSTIFY)[number]) ? (src.justify as ParagraphSpec["justify"]) : fallback.justify,
  };
}

function normTable(raw: unknown, fallback: TableSpec): TableSpec {
  const src = (raw ?? {}) as Partial<TableSpec>;
  const b = (src.borders ?? {}) as Partial<TableBorders>;
  return {
    borders: {
      top: normBorder(b.top, fallback.borders.top),
      left: normBorder(b.left, fallback.borders.left),
      bottom: normBorder(b.bottom, fallback.borders.bottom),
      right: normBorder(b.right, fallback.borders.right),
      insideH: normBorder(b.insideH, fallback.borders.insideH),
      insideV: normBorder(b.insideV, fallback.borders.insideV),
    },
    cellMarginTwips: clamp(asNumber(src.cellMarginTwips, fallback.cellMarginTwips), 0, 1080),
    rowCannotSplit: asBool(src.rowCannotSplit, fallback.rowCannotSplit),
    repeatHeaderRow: asBool(src.repeatHeaderRow, fallback.repeatHeaderRow),
    headerBold: asBool(src.headerBold, fallback.headerBold),
  };
}

function normHeading(raw: unknown, fallback: HeadingSpec): HeadingSpec {
  const src = (raw ?? {}) as Partial<HeadingSpec>;
  const level = Number(src.level ?? fallback.level);
  return {
    level: (level >= 1 && level <= 6 ? Math.round(level) : fallback.level) as HeadingLevel,
    font: normalizeFont(src.font, fallback.font),
    bold: asBool(src.bold, fallback.bold),
    spaceBeforePt: clamp(asNumber(src.spaceBeforePt, fallback.spaceBeforePt), 0, 200),
    spaceAfterPt: clamp(asNumber(src.spaceAfterPt, fallback.spaceAfterPt), 0, 200),
    keepNext: asBool(src.keepNext, fallback.keepNext),
  };
}

/** 只认 PASS_IDS 里的名字：契约里写错一个字母等于开了个没人执行的 pass，必须静默丢掉而不是存着。 */
function normPasses(raw: unknown, fallback: PassId[]): PassId[] {
  if (!Array.isArray(raw)) return [...fallback];
  const out = PASS_IDS.filter((id) => raw.includes(id));
  return out.length ? out : [...fallback];
}

/**
 * 把任意 JSON（用户导入的、老版本存下来的、手工改库塞进去的）收敛成一份合法契约。
 * 原则：坏字段回落默认，不让整个契约作废 —— 契约失效会让转换直接失去排版，代价远大于「某一项用了默认值」。
 */
export function normalizeContract(raw: unknown, fallback: StyleContract = CN_HANDOUT_V1): StyleContract {
  const src = (raw ?? {}) as Partial<StyleContract>;
  const headingsRaw = Array.isArray(src.headings) ? src.headings : [];
  const headings: HeadingSpec[] = [];
  for (let level = 1; level <= 6; level += 1) {
    const base = fallback.headings.find((h) => h.level === level) ?? fallback.headings[fallback.headings.length - 1];
    const given = headingsRaw.find((h) => Number((h as HeadingSpec)?.level) === level);
    headings.push(normHeading(given, base));
  }
  return {
    version: CONTRACT_VERSION,
    id: asString(src.id, fallback.id),
    name: asString(src.name, fallback.name),
    description: typeof src.description === "string" ? src.description : fallback.description,
    body: normalizeFont(src.body, fallback.body),
    page: normPage(src.page, fallback.page),
    paragraph: normParagraph(src.paragraph, fallback.paragraph),
    table: normTable(src.table, fallback.table),
    headings,
    passes: normPasses(src.passes, fallback.passes),
    accept: {
      minScore: clamp(asNumber(src.accept?.minScore, fallback.accept.minScore), 0, 100),
      maxRepairRounds: clamp(asNumber(src.accept?.maxRepairRounds, fallback.accept.maxRepairRounds), 0, 5),
    },
  };
}

/** 契约自检：只报「设了但做不到 / 设了但不可能通过验收」的项，格式问题已由 normalize 吃掉。 */
export function contractIssues(contract: StyleContract): string[] {
  const issues: string[] = [];
  const { page } = contract;
  if (page.marginLeftCm + page.marginRightCm >= page.widthCm) issues.push("左右页边距之和大于纸张宽度");
  if (page.marginTopCm + page.marginBottomCm >= page.heightCm) issues.push("上下页边距之和大于纸张高度");
  if (page.headerCm >= page.marginTopCm) issues.push("页眉距离不小于上边距，页眉会压到正文");
  if (page.footerCm >= page.marginBottomCm) issues.push("页脚距离不小于下边距，页脚会压到正文");
  if (!contract.headings.length) issues.push("缺少标题级别定义");
  for (const h of contract.headings) {
    if (h.font.sizePt <= contract.body.sizePt && h.level <= 2) issues.push(`${h.level} 级标题字号不大于正文字号`);
  }
  if (contract.table.borders.top.style === "none" && contract.table.borders.insideH.style === "none") {
    issues.push("表格内外框线全为 none，产物会被判为「无框线表格」");
  }
  return issues;
}

/** 稳定序列化：键名排序后 JSON，保证同一份契约永远得到同一个 hash（缓存文件名靠它）。 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** 契约内容指纹（sha256，64 位十六进制）。编译产物文件名 = <id>-<hash 前 12 位>.docx。 */
export function contractHash(contract: StyleContract): string {
  return crypto.createHash("sha256").update(stableStringify(contract), "utf8").digest("hex");
}

export function summarizeContract(contract: StyleContract, builtin: boolean): ContractSummary {
  return {
    id: contract.id,
    name: contract.name,
    description: contract.description,
    body: contract.body,
    page: contract.page,
    builtin,
    subtitle: `${contract.body.eastAsia} ${contract.body.sizePt}pt · A4 ${contract.page.marginTopCm}/${contract.page.marginBottomCm}/${contract.page.marginLeftCm}/${contract.page.marginRightCm}cm · 行距 ${contract.paragraph.lineSpacingPt}pt`,
  };
}

const border = (sizeEighthPt = 4): BorderSpec => ({ style: "single", sizeEighthPt, color: "000000" });

function headingSet(body5: FontSpec, sizes: number[], font = "黑体"): HeadingSpec[] {
  return sizes.map((sizePt, index) => ({
    level: (index + 1) as HeadingLevel,
    font: { latin: font === "黑体" ? "Times New Roman" : "Times New Roman", eastAsia: font, sizePt },
    bold: false,
    spaceBeforePt: index === 0 ? 18 : 12,
    spaceAfterPt: index === 0 ? 12 : 8,
    keepNext: true,
  })) as HeadingSpec[];
}

/**
 * 内置预设一：中文讲义（最常用）。五号宋体、固定行距 22 磅、首行缩进 2 字符、0.5 磅全框线表格。
 * 这些具体数值来自中学教研组通行的排版要求，用户可以在界面上另存/导入成自己的契约。
 */
export const CN_HANDOUT_V1: StyleContract = {
  version: CONTRACT_VERSION,
  id: "cn-handout-v1",
  name: "中文讲义（五号宋体 · 1.5 倍行距）",
  description: "讲义/学案类：正文五号宋体，固定行距 22 磅，首行缩进 2 字符，表格 0.5 磅全框线，行不跨页。",
  body: { latin: "Times New Roman", eastAsia: "宋体", sizePt: 10.5 },
  page: {
    widthCm: 21,
    heightCm: 29.7,
    marginTopCm: 2.54,
    marginBottomCm: 2.54,
    marginLeftCm: 3.17,
    marginRightCm: 3.17,
    headerCm: 1.5,
    footerCm: 1.75,
  },
  paragraph: { lineSpacingPt: 22, lineRule: "exact", firstLineIndentChars: 2, spaceBeforePt: 0, spaceAfterPt: 0, justify: "both" },
  table: {
    borders: { top: border(), left: border(), bottom: border(), right: border(), insideH: border(), insideV: border() },
    cellMarginTwips: 108,
    rowCannotSplit: true,
    repeatHeaderRow: true,
    headerBold: true,
  },
  headings: headingSet({ latin: "Times New Roman", eastAsia: "黑体", sizePt: 10.5 }, [16, 14, 12, 10.5, 10.5, 10.5]),
  passes: ["sectPr", "tableBorders", "tableRow", "fontRun"],
  accept: { minScore: 85, maxRepairRounds: 2 },
};

/** 内置预设二：试卷。五号宋体、固定 18 磅（省纸）、页边距 2cm、表格细线。 */
export const CN_EXAM_V1: StyleContract = normalizeContract(
  {
    version: CONTRACT_VERSION,
    id: "cn-exam-v1",
    name: "试卷（五号宋体 · 紧凑）",
    description: "试卷类：五号宋体，固定行距 18 磅，页边距 2cm，表格 0.5 磅框线，适合题量大、要省纸。",
    body: { latin: "Times New Roman", eastAsia: "宋体", sizePt: 10.5 },
    page: { widthCm: 21, heightCm: 29.7, marginTopCm: 2, marginBottomCm: 2, marginLeftCm: 2, marginRightCm: 2, headerCm: 1.2, footerCm: 1.4 },
    paragraph: { lineSpacingPt: 18, lineRule: "exact", firstLineIndentChars: 0, spaceBeforePt: 0, spaceAfterPt: 0, justify: "both" },
    table: {
      borders: { top: border(), left: border(), bottom: border(), right: border(), insideH: border(), insideV: border() },
      cellMarginTwips: 72,
      rowCannotSplit: true,
      repeatHeaderRow: true,
      headerBold: true,
    },
    headings: headingSet({ latin: "Times New Roman", eastAsia: "黑体", sizePt: 10.5 }, [14, 12, 10.5, 10.5, 10.5, 10.5]),
    passes: ["sectPr", "tableBorders", "tableRow", "fontRun"],
    accept: { minScore: 85, maxRepairRounds: 2 },
  },
  CN_HANDOUT_V1,
);

/** 内置预设三：公文式报告。三号仿宋、固定 28 磅、上 3.7 下 3.5 左 2.8 右 2.6。 */
export const CN_REPORT_V1: StyleContract = normalizeContract(
  {
    version: CONTRACT_VERSION,
    id: "cn-report-v1",
    name: "报告（三号仿宋 · 公文式）",
    description: "总结/报告类：三号仿宋，固定行距 28 磅，公文式页边距，标题黑体分级。",
    body: { latin: "Times New Roman", eastAsia: "仿宋", sizePt: 16 },
    page: { widthCm: 21, heightCm: 29.7, marginTopCm: 3.7, marginBottomCm: 3.5, marginLeftCm: 2.8, marginRightCm: 2.6, headerCm: 1.5, footerCm: 2.8 },
    paragraph: { lineSpacingPt: 28, lineRule: "exact", firstLineIndentChars: 2, spaceBeforePt: 0, spaceAfterPt: 0, justify: "both" },
    table: {
      borders: { top: border(), left: border(), bottom: border(), right: border(), insideH: border(), insideV: border() },
      cellMarginTwips: 108,
      rowCannotSplit: true,
      repeatHeaderRow: true,
      headerBold: true,
    },
    headings: headingSet({ latin: "Times New Roman", eastAsia: "黑体", sizePt: 16 }, [22, 16, 16, 16, 16, 16]),
    passes: ["sectPr", "tableBorders", "tableRow", "fontRun"],
    accept: { minScore: 85, maxRepairRounds: 2 },
  },
  CN_HANDOUT_V1,
);

/** 内置预设清单（顺序即界面下拉框顺序）。 */
export const BUILTIN_CONTRACTS: StyleContract[] = [CN_HANDOUT_V1, CN_EXAM_V1, CN_REPORT_V1];

/** 不指定契约时的默认值：与 DocPrefs.contractId 的空串语义一致（= 不启用契约，退回原行为）。 */
export const DEFAULT_CONTRACT_ID = CN_HANDOUT_V1.id;

export function findBuiltinContract(id: string): StyleContract | null {
  return BUILTIN_CONTRACTS.find((contract) => contract.id === id) ?? null;
}
