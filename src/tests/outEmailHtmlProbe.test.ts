import { containsHtmlTag } from "../services/outEmailHtmlProbe";

/**
 * 期望值全部取自原探测正则
 * `/<(?:[a-z][a-z0-9]*)(?:\s[^>]*)?\/?>|<\/[a-z][a-z0-9]*\s*>/i`
 * 的实测结果，用来钉住「线性扫描 == 旧正则」这条等价关系。
 */
const equivalenceCases: Array<[string, boolean]> = [
  ["", false],
  ["<", false],
  ["<<", false],
  ["5 > 3", false],
  ["<3>", false],
  ["a<b 成立", false], // 没有 `>` 闭合
  ["<div", false],
  ["<div id=x", false],
  ["<a ", false],
  ["< img>", false], // `<` 后不是字母
  ["</ div>", false], // 闭标签斜杠后不是字母
  ["<div>hello</div>", true],
  ["<br/>", true],
  ["<div/>", true],
  ['<a href="https://example.com">x</a>', true],
  ["<div id=x>", true],
  ["<div >", true],
  ["<div\tclass=x>", true],
  ["</div>", true],
  ["</div >", true],
  ["</div  \t>", true],
  ["</div/>", false], // 闭标签分支只允许 `\s*>`
  ["<A HREF='x'>", true], // 大小写不敏感
  ["</A>", true],
  ["<a<b>", true],
  ["<a b<c>", true],
  ["<div id='a>b'>", true], // 属性区遇到第一个 `>` 即闭合
  ["<a1-b>", false], // 名字后的 `-` 不属于三种开标签形态
  ["使用 <em>强调</em> 的正文", true],
];

describe("containsHtmlTag（对外邮件正文 HTML 探测）", () => {
  it.each(equivalenceCases)("%j -> %s", (input, expected) => {
    expect(containsHtmlTag(input)).toBe(expected);
  });

  // 旧正则在这两条输入上是 O(n²)：`[^>]*` 在每个候选起点扫到串尾再回溯失败。
  // 现在的实现在毫秒级返回；若有人改回正则，这两条会先超时而不是悄悄放过。
  it("在不含 `>` 的长输入上保持线性（旧正则 O(n²)，CodeQL js/polynomial-redos）", () => {
    const pathological = "<a ".repeat(50_000);
    expect(pathological.length).toBe(150_000);
    expect(containsHtmlTag(pathological)).toBe(false);
  });

  it("在含 `>` 的长输入上不回溯", () => {
    const pathological = `${"<1".repeat(50_000)}>`;
    expect(containsHtmlTag(pathological)).toBe(false);
    expect(containsHtmlTag(`${"<a ".repeat(50_000)}>`)).toBe(true);
  });
});
