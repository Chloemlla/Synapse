/**
 * 排版契约引擎（src/docTool/contract/*）的单元测试。
 *
 * 与 docToolZip.test.ts 的分工：那份测「打包」这一半（crc32 / createZipBuffer），这份测「解开 → 校验 →
 * 改写 → 重打包」这一半，外加验收器 verifyDocx 的正样本与三个负样本。
 *
 * 全部用内存里自造的最小 docx，不 spawn pandoc、不读仓库里的二进制资源、不写用户目录：
 * CI 上没有 pandoc，也不该为跑一条断言去装它。真实 pandoc 产物的端到端数字由
 * scripts/doc-tool-contract/eval.js 在本地跑，两者不互相替代。
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyContract,
  CHECK_WEIGHTS,
  checkIdempotent,
  cmToTwips,
  CN_HANDOUT_V1,
  compileReferenceDoc,
  compileStyles,
  contractFromDocx,
  contractHash,
  contractIssues,
  countSourceMath,
  normalizeContract,
  readZip,
  repairPlan,
  rewriteZip,
  verifyDocx,
} from "../docTool/contract";
import { insertChildXml, orderIndex } from "../docTool/contract/order";
import { elements, isBalanced, scanTags } from "../docTool/contract/xmlScan";
import { createZipBuffer, type ZipEntryInput } from "../docTool/zipStore";

const tmpDirs: string[] = [];

function makeTmp(prefix = "doc-contract-"): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort：临时目录删不掉不影响断言结论
    }
  }
});

/** 用仓库现有的 createZipBuffer 打包（它只吃文件路径，所以先落盘）。 */
function makeDocx(entries: Record<string, string>, prefix = "pkg-"): Buffer {
  const dir = makeTmp(prefix);
  const inputs: ZipEntryInput[] = [];
  for (const [name, content] of Object.entries(entries)) {
    const abs = path.join(dir, name.replace(/[\\/]/g, "__"));
    fs.writeFileSync(abs, content, "utf8");
    inputs.push({ name, sourcePath: abs });
  }
  return createZipBuffer(inputs).buffer;
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const M = 'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"';
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";

/** 最小 styles.xml：docDefaults 只有主题字体（中文回退的根因），没有 Table 样式也没有 body text。 */
const MIN_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W}>
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsiaTheme="minorEastAsia"/><w:sz w:val="22"/></w:rPr>
    </w:rPrDefault>
  </w:docDefaults>
</w:styles>`;

/**
 * 最小 document.xml：一个三级标题段（pStyle 是数字 styleId，正是 pandoc 的写法）、一个中文正文段、
 * 一个两列表格，**没有 sectPr**（pandoc 带 --reference-doc 时就是这样，实测过）。
 */
const MIN_DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${W} ${M}>
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="1"/></w:pPr><w:r><w:t>第一讲 细胞的结构</w:t></w:r></w:p>
    <w:p><w:r><w:rPr><w:rFonts w:hint="eastAsia"/></w:rPr><w:t>细胞是生命活动的基本单位。</w:t></w:r></w:p>
    <w:tbl>
      <w:tblPr/>
      <w:tr><w:tc><w:tcPr/><w:p><w:r><w:t>名称</w:t></w:r></w:p></w:tc><w:tc><w:tcPr/><w:p><w:r><w:t>功能</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:tcPr/><w:p><w:r><w:t>细胞膜</w:t></w:r></w:p></w:tc><w:tc><w:tcPr/><w:p><w:r><w:t>控制物质进出</w:t></w:r></w:p></w:tc></w:tr>
    </w:tbl>
    <w:p/>
  </w:body>
</w:document>`;

const rawDocx = (): Buffer =>
  makeDocx({
    // 五件必需部件一个不少：C8 会把缺的部件当成容器不自洽扣分，测试样本自己得先像一个 docx
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${REL_NS}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/_rels/document.xml.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${REL_NS}"/>`,
    "word/document.xml": MIN_DOCUMENT,
    "word/styles.xml": MIN_STYLES,
  });

/**
 * 真实链路的前半段：把契约编译进 styles.xml（声明层）。
 * 单独用 rawDocx 测「修复」会误判 —— C2 的决定因素是 docDefaults，而不是产物里的 run，
 * 那一项本来就该由声明层负责（实测：只编译 styles.xml 就能把 C2 拉成 42/42）。
 */
const declaredDocx = (): Buffer => compileReferenceDoc(rawDocx(), CN_HANDOUT_V1).buffer;

/** 读 → 改某个部件 → 重打包（负样本都靠它，避免把「构造坏文档」的逻辑散落在各条断言里）。 */
function patchDocx(docx: Buffer, name: string, patch: (text: string) => string): Buffer {
  const archive = readZip(docx);
  const text = archive.text(name);
  if (text === null) throw new Error(`没有 ${name}`);
  const next = patch(text);
  expect(next).not.toBe(text);
  return rewriteZip(archive, new Map([[name, Buffer.from(next, "utf8")]])).buffer;
}

const ratioOf = (verdict: ReturnType<typeof verifyDocx>, id: string): number =>
  verdict.checks.find((check) => check.id === id)?.ratio ?? -1;

describe("ZIP 读 / 写往返", () => {
  it("readZip 能拿回全部条目与原文", () => {
    const docx = rawDocx();
    const archive = readZip(docx);
    expect(archive.names.sort()).toEqual(["[Content_Types].xml", "word/document.xml", "word/styles.xml"]);
    expect(archive.text("word/document.xml")).toBe(MIN_DOCUMENT);
    expect(archive.get("word/styles.xml")?.data.equals(Buffer.from(MIN_STYLES, "utf8"))).toBe(true);
  });

  it("rewriteZip 的产物是逐字节确定的（时间戳固定，两遍相同）", () => {
    const archive = readZip(rawDocx());
    const replacement = new Map([["word/styles.xml", Buffer.from(MIN_STYLES.replace("Calibri", "Arial"), "utf8")]]);
    const first = rewriteZip(archive, replacement);
    const second = rewriteZip(archive, replacement);
    // 这条是幂等性判据的基石：时间戳/压缩级别只要带一点随机（或用当前时间），
    // 「两轮产物 sha256 相等」就永远测不出来
    expect(first.buffer.equals(second.buffer)).toBe(true);
    expect(readZip(first.buffer).text("word/styles.xml")).toContain("Arial");
  });

  it("截断的 ZIP 抛错而不是返回半个包", () => {
    const docx = rawDocx();
    expect(() => readZip(docx.subarray(0, Math.floor(docx.length / 2)))).toThrow();
  });
});

describe("XML 扫描（不 parse→stringify）", () => {
  it("嵌套表格按深度配对，不把内层当成外层的一部分", () => {
    const xml = `<w:tbl><w:tr><w:tc><w:tbl><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl></w:tc></w:tr></w:tbl>`;
    const tables = elements(xml, "w:tbl");
    expect(tables).toHaveLength(2);
    // 外层的 span 覆盖整串，内层被外层包含 —— 若用非贪婪正则，这里只会拿到「从头到第一个 </w:tbl>」
    expect(tables[0].end).toBe(xml.length);
    expect(tables[0].start).toBeLessThan(tables[1].start);
    expect(tables[1].end).toBeLessThan(tables[0].end);
    expect(isBalanced(xml)).toBe(true);
  });

  it("属性值里的 > 不会让开标签提前收尾", () => {
    const xml = `<w:p><w:pPr><w:pStyle w:val="a>b"/></w:pPr></w:p>`;
    const tags = scanTags(xml);
    expect(tags[1].name).toBe("w:pPr");
    expect(tags[2].name).toBe("w:pStyle");
    expect(tags[2].raw).toContain('w:val="a>b"');
  });

  it("isEmpty 的标签也算平衡，注释与 CDATA 里的尖括号不算标签", () => {
    const xml = `<w:p><w:r><w:rPr/><!-- <w:b> <w:i> --><w:t><![CDATA[<w:x>]]></w:t></w:r></w:p>`;
    expect(isBalanced(xml)).toBe(true);
    expect(elements(xml, "w:p")).toHaveLength(1);
  });
});

describe("子元素顺序（OOXML 的 sequence 是硬约束）", () => {
  it("w:pPr 里 spacing 必须排在 ind 前面、jc 前面", () => {
    expect(orderIndex("w:pPr", "w:spacing")).toBeLessThan(orderIndex("w:pPr", "w:ind"));
    expect(orderIndex("w:pPr", "w:ind")).toBeLessThan(orderIndex("w:pPr", "w:jc"));
    // rPr 在 pPr 的最后，sectPr 更靠后
    expect(orderIndex("w:pPr", "w:jc")).toBeLessThan(orderIndex("w:pPr", "w:rPr"));
    expect(orderIndex("w:pPr", "w:rPr")).toBeLessThan(orderIndex("w:pPr", "w:sectPr"));
  });

  it("insertChildXml 插到「第一个顺序更靠后的兄弟」之前", () => {
    const xml = `<w:p><w:pPr><w:jc w:val="both"/></w:pPr></w:p>`;
    const pPr = elements(xml, "w:pPr")[0];
    const next = insertChildXml(xml, pPr, "w:ind", `<w:ind w:firstLine="420" />`);
    expect(next.indexOf("<w:ind")).toBeLessThan(next.indexOf("<w:jc"));
    expect(isBalanced(next)).toBe(true);
  });

  it("未知名字不会被插到中间（退回追加，且不破坏 XML）", () => {
    expect(orderIndex("w:pPr", "w:没这个")).toBeGreaterThan(orderIndex("w:pPr", "w:jc"));
  });
});

describe("契约模型", () => {
  it("厘米→twips 的换算与 OOXML 一致（2.54cm = 1440 twips）", () => {
    expect(cmToTwips(2.54)).toBe(1440);
    expect(cmToTwips(21)).toBe(11907);
  });

  it("normalizeContract 把非法值修成可用值，contractIssues 报出结构性矛盾", () => {
    const bad = normalizeContract({ ...CN_HANDOUT_V1, body: { eastAsia: "", sizePt: -3 } });
    expect(bad.body.eastAsia).toBe(CN_HANDOUT_V1.body.eastAsia);
    expect(bad.body.sizePt).toBeGreaterThan(0);
    // 左右边距之和超过纸宽 = 正文区宽度为负，Word 会开出一张空白页
    const broken = normalizeContract({ ...CN_HANDOUT_V1, page: { ...CN_HANDOUT_V1.page, marginLeftCm: 12, marginRightCm: 12 } });
    expect(contractIssues(broken).join(";")).toContain("页边距");
  });

  it("contractHash 只看内容不看键顺序（同契约同哈希）", () => {
    const a = { ...CN_HANDOUT_V1 };
    const b = { ...CN_HANDOUT_V1, id: "cn-handout-v1" };
    expect(contractHash(normalizeContract(a))).toBe(contractHash(normalizeContract(b)));
    expect(contractHash(normalizeContract(a))).toMatch(/^[0-9a-f]{64}$/);
  });

  it("countSourceMath 不把货币当公式，围栏代码里的 $$ 不算", () => {
    expect(countSourceMath("价格 $5 和 $6 元")).toBe(0);
    expect(countSourceMath("行内 $a^2+b^2=c^2$ 一个")).toBe(1);
    expect(countSourceMath("$$\nE=mc^2\n$$")).toBe(1);
    expect(countSourceMath("```\n$$\n$$\n```")).toBe(0);
  });
});

describe("声明层：compileStyles", () => {
  it("把 docDefaults 的主题字体换成显式字体名，且 XML 仍然平衡", () => {
    const report = compileStyles(MIN_STYLES, CN_HANDOUT_V1);
    expect(report.xml).toContain(`w:eastAsia="${CN_HANDOUT_V1.body.eastAsia}"`);
    expect(report.xml).not.toContain("minorEastAsia");
    expect(report.applied.length).toBeGreaterThan(0);
    expect(isBalanced(report.xml)).toBe(true);
  });

  it("模板里没有 Table 样式时会创建它（否则 pandoc 写的 tblStyle 指不到任何样式）", () => {
    const report = compileStyles(MIN_STYLES, CN_HANDOUT_V1);
    expect(report.xml).toContain("w:styleId=\"Table\"");
    expect(report.xml).toContain("w:tblBorders");
    expect(isBalanced(report.xml)).toBe(true);
  });

  it("契约里的 XML 特殊字符被转义（契约是用户可改的 JSON，不能直接拼进 XML）", () => {
    const nasty = normalizeContract({ ...CN_HANDOUT_V1, body: { ...CN_HANDOUT_V1.body, eastAsia: '宋</w:rFonts><w:b x="' } });
    const report = compileStyles(MIN_STYLES, nasty);
    expect(report.xml).not.toContain('</w:rFonts><w:b x="');
    expect(report.xml).toContain("&lt;");
    expect(isBalanced(report.xml)).toBe(true);
  });
});

describe("管线：verify → repair → verify", () => {
  it("裸产物不过线（缺 sectPr、表格无框线、行无 cantSplit）", () => {
    const verdict = verifyDocx(rawDocx(), { contract: CN_HANDOUT_V1 });
    expect(verdict.fatal).toBeUndefined();
    expect(verdict.score).toBeLessThan(CN_HANDOUT_V1.accept.minScore);
    expect(ratioOf(verdict, "C3")).toBe(0); // 完全没有 sectPr → 8 项全缺
    expect(ratioOf(verdict, "C1")).toBe(0);
    expect(ratioOf(verdict, "C2")).toBe(0); // 只有主题字体
    expect(verdict.defects.map((defect) => defect.code)).toEqual(
      expect.arrayContaining(["E_PAGE_SETUP", "E_TABLE_BORDER", "E_FONT_EASTASIA"]),
    );
  });

  it("applyContract 把它修到过线，且报告的 applied 与缺陷一致", () => {
    const result = applyContract({ docx: declaredDocx(), contract: CN_HANDOUT_V1 });
    expect(result.verdict.score).toBeGreaterThanOrEqual(CN_HANDOUT_V1.accept.minScore);
    expect(result.verdict.grade).toBe("pass");
    expect(result.rounds).toBeGreaterThanOrEqual(1);
    expect(result.applied).toContain("sectPr");
    // 修复后各检查项都满：任一 ratio < 1 就说明「过线」是靠权重凑出来的
    for (const check of result.verdict.checks) expect(`${check.id}:${check.ratio}`).toBe(`${check.id}:1`);
  });

  it("repairPlan 受 contract.passes 约束：关掉某项就不许偷偷修", () => {
    const verdict = verifyDocx(rawDocx(), { contract: CN_HANDOUT_V1 });
    expect(repairPlan(verdict, CN_HANDOUT_V1)).toContain("tableBorders");
    const noTable = normalizeContract({ ...CN_HANDOUT_V1, passes: ["sectPr", "tableRow", "fontRun"] });
    expect(repairPlan(verifyDocx(rawDocx(), { contract: noTable }), noTable)).not.toContain("tableBorders");
  });

  it("checkIdempotent：两遍管线 sha256 相同且第二遍 0 轮", () => {
    const result = checkIdempotent({ docx: declaredDocx(), contract: CN_HANDOUT_V1 });
    expect(result.stable).toBe(true);
    expect(result.hashFirst).toBe(result.hashSecond);
    expect(result.detail).toContain("0 轮修复");
  });

  it("产出的字节可被再次完整解析（写坏 XML 会被 isBalanced 兜住）", () => {
    const result = applyContract({ docx: declaredDocx(), contract: CN_HANDOUT_V1 });
    const archive = readZip(result.docx);
    for (const name of archive.names) {
      const text = archive.text(name);
      if (text && name.endsWith(".xml")) expect(`${name}:${isBalanced(text)}`).toBe(`${name}:true`);
    }
  });
});

describe("负样本：每改坏一项，只掉它那一项的权重", () => {
  const repaired = (): Buffer => applyContract({ docx: declaredDocx(), contract: CN_HANDOUT_V1 }).docx;

  it("N1 拆掉表格框线 → C1 归零，其它项不受连累", () => {
    const broken = patchDocx(repaired(), "word/document.xml", (xml) =>
      xml.replace(/<w:tblBorders>[\s\S]*?<\/w:tblBorders>/g, ""),
    );
    const verdict = verifyDocx(broken, { contract: CN_HANDOUT_V1 });
    expect(ratioOf(verdict, "C1")).toBe(0);
    expect(verdict.score).toBeCloseTo(100 - CHECK_WEIGHTS.C1, 5);
    expect(verdict.defects.map((defect) => defect.code)).toContain("E_TABLE_BORDER");
  });

  it("N2 字体改回主题引用 → C2 归零", () => {
    const broken = patchDocx(repaired(), "word/styles.xml", (xml) => xml.replace(/w:eastAsia="[^"]*"/g, 'w:eastAsiaTheme="minorEastAsia"'));
    const verdict = verifyDocx(broken, { contract: CN_HANDOUT_V1 });
    expect(ratioOf(verdict, "C2")).toBe(0);
    expect(verdict.score).toBeCloseTo(100 - CHECK_WEIGHTS.C2, 5);
  });

  it("N3 上边距改错 → C3 按 7/8 扣分（不是全有全无）", () => {
    const expected = cmToTwips(CN_HANDOUT_V1.page.marginTopCm);
    const broken = patchDocx(repaired(), "word/document.xml", (xml) =>
      xml.replace(new RegExp(`w:top="${expected}"`), 'w:top="720"'),
    );
    const verdict = verifyDocx(broken, { contract: CN_HANDOUT_V1 });
    expect(ratioOf(verdict, "C3")).toBeCloseTo(7 / 8, 5);
    expect(verdict.score).toBeCloseTo(100 - CHECK_WEIGHTS.C3 * (1 / 8), 5);
  });

  it("N4 产物缺公式 → C4 按源 Markdown 扣分（无源时说明「无法对照」）", () => {
    const withoutSource = verifyDocx(repaired(), { contract: CN_HANDOUT_V1 });
    expect(ratioOf(withoutSource, "C4")).toBe(1);
    expect(withoutSource.checks.find((check) => check.id === "C4")?.detail).toContain("无法对照");

    const withSource = verifyDocx(repaired(), { contract: CN_HANDOUT_V1, sourceMarkdown: "$$\nE=mc^2\n$$\n\n行内 $a+b$\n" });
    expect(ratioOf(withSource, "C4")).toBe(0);
    expect(withSource.defects.map((defect) => defect.code)).toContain("E_MATH_LOST");
  });

  it("N5 不是 ZIP → 唯一一项 C8 归零并给 fatal，后续检查全部跳过", () => {
    const verdict = verifyDocx(Buffer.from("这不是一个 docx", "utf8"), { contract: CN_HANDOUT_V1 });
    expect(verdict.fatal).toBeTruthy();
    expect(verdict.score).toBe(0);
    expect(verdict.checks.map((check) => check.id)).toEqual(["C8"]);
  });
});

describe("样式文档：编译 / 反编译往返", () => {
  it("compileReferenceDoc 只改 styles.xml，其它部件逐字节不变", () => {
    const base = rawDocx();
    const { buffer, report } = compileReferenceDoc(base, CN_HANDOUT_V1);
    const before = readZip(base);
    const after = readZip(buffer);
    expect(after.names.sort()).toEqual(before.names.sort());
    expect(after.get("word/document.xml")?.data.equals(before.get("word/document.xml")?.data as Buffer)).toBe(true);
    expect(report.applied.length).toBeGreaterThan(0);
  });

  it("contractFromDocx 能从产出的样式里读回「它实际在用的排版」", () => {
    const repairedDoc = applyContract({ docx: declaredDocx(), contract: CN_HANDOUT_V1 }).docx;
    const readBack = contractFromDocx(repairedDoc, { id: "my-template", name: "我的范本" });
    expect(readBack.id).toBe("my-template");
    expect(readBack.name).toBe("我的范本");
    expect(readBack.body.eastAsia).toBe(CN_HANDOUT_V1.body.eastAsia);
    expect(readBack.page.marginTopCm).toBeCloseTo(CN_HANDOUT_V1.page.marginTopCm, 2);
    expect(readBack.table.borders.top.sizeEighthPt).toBe(CN_HANDOUT_V1.table.borders.top.sizeEighthPt);
  });
});
