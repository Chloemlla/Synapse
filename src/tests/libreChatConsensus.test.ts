/**
 * X3-04/X3-05 一致性判定的纯函数层。
 *
 * 测的不是「模型更聪明」,而是**可测量的置信度**:同一件事问 N 个 provider,
 * 谈拢的字段才敢用,谈不拢的字段必须显式丢弃。所以这里的断言全部围绕三条纪律:
 *  1. 等价写法必须同票(否则一致性分数测的是排版习惯,不是判断是否一致);
 *  2. 平票 = 没共识 —— 即使最大票组已经达到了 minVotes 也不能采纳;
 *  3. 返回给调用方的永远是**原始值**,不是规范串(否则下游拿到的 score 会变成字符串 "3")。
 */

import {
  agreementOf,
  coverageOf,
  normalizeForAgreement,
  structuredConsensus,
  type ConsensusOptions,
  type FieldConsensus,
} from "../services/librechat/consensus";
import type { StructuredSpec } from "../services/librechat/structured";

const SPEC: StructuredSpec = {
  fields: [
    { name: "risk", type: "enum", enumValues: ["low", "high"], required: true },
    { name: "summary", type: "string" },
    { name: "score", type: "number" },
    { name: "topics", type: "string[]" },
  ],
};

const FIELD_LIST = ["risk", "summary", "score", "topics"];

function consensusOf(payloads: Record<string, unknown>[], options: ConsensusOptions = {}): FieldConsensus {
  return structuredConsensus(payloads, SPEC, options);
}

describe("normalizeForAgreement(X3-04)", () => {
  // 数字归一只发生在 number 通路:`3` ≡ `3.0` ≡ `"3"`(number 被规范成数字字面量串,与已经写成最简形式的
  // 字符串自然同串)。带小数尾巴的 `"3.0"` **不参与归一**,这是设计而不是缺口:数字字符串的类型纠正在
  // `structured.ts`(收进 number 字段并记 COERCED),表决层若再隐式做一次,`"007"`/`"7"`、版本号、
  // 比例就会被默默判成同票 —— 而一致率是要拿去画 risk-coverage 曲线的,它虚高比偏低难查得多。
  it("数字同义写法同票:3 ≡ 3.0 ≡ 「3」 ≡ 「 3 」;而「3.0」分票", () => {
    const canonical = normalizeForAgreement(3);
    expect(normalizeForAgreement(3.0)).toBe(canonical);
    expect(normalizeForAgreement("3")).toBe(canonical);
    expect(normalizeForAgreement("  3  ")).toBe(canonical);
    // 等价侧也得钉住:将来谁改坏了 number 通路,这里先红。
    expect(normalizeForAgreement("3.0")).not.toBe(canonical);
    expect(normalizeForAgreement("3.0")).toBe(normalizeForAgreement(" 3.0 "));
    expect(normalizeForAgreement("007")).not.toBe(normalizeForAgreement("7"));
  });

  it("浮点按精度位数归一,不是按字符串尾巴归一", () => {
    expect(normalizeForAgreement(1.0000001)).toBe(normalizeForAgreement(1));
    expect(normalizeForAgreement(1.0000001)).not.toBe(normalizeForAgreement(1.0001));
    // 位数是归一参数,只对同一次比较生效:两位精度下 1.234567 与 1.2345 同票。
    expect(normalizeForAgreement(1.234567, { numberDigits: 2 })).toBe(normalizeForAgreement(1.2345, { numberDigits: 2 }));
    expect(normalizeForAgreement(1.234567)).not.toBe(normalizeForAgreement(1.2345));
  });

  it("对象键顺序不影响结果,嵌套也照样归一", () => {
    const a = { risk: "high", meta: { level: 3, note: " 甲 " } };
    const b = { meta: { note: "甲", level: 3.0 }, risk: "HIGH" };
    expect(normalizeForAgreement(a)).toBe(normalizeForAgreement(b));
  });

  it("字符串做 NFKC + 折叠空白(全角/半角、多空格、制表符都算同一个答案)", () => {
    expect(normalizeForAgreement("ＡＢＣ")).toBe(normalizeForAgreement("abc"));
    expect(normalizeForAgreement("  是  ")).toBe(normalizeForAgreement("是"));
    expect(normalizeForAgreement("甲\t\n乙")).toBe(normalizeForAgreement("甲 乙"));
  });

  it("默认忽略大小写;ignoreCase:false 时大小写分别计票", () => {
    expect(normalizeForAgreement("HIGH")).toBe(normalizeForAgreement("high"));
    expect(normalizeForAgreement("HIGH", { ignoreCase: false })).not.toBe(normalizeForAgreement("high", { ignoreCase: false }));
  });

  it("数组默认顺序敏感;sortArrays 后顺序无关", () => {
    expect(normalizeForAgreement(["a", "b"])).not.toBe(normalizeForAgreement(["b", "a"]));
    expect(normalizeForAgreement(["a", "b"], { sortArrays: true })).toBe(normalizeForAgreement(["b", "a"], { sortArrays: true }));
  });

  it("布尔与空值各自成组,布尔不会和字符串 \"true\" 混为一谈", () => {
    // 布尔保持未引号形态(可直接当 Map key),字符串带引号:两者天然不撞。
    expect(normalizeForAgreement(true)).toBe("true");
    expect(normalizeForAgreement(true)).not.toBe(normalizeForAgreement("true"));
    expect(normalizeForAgreement(null)).toBe(normalizeForAgreement(undefined));
    expect(normalizeForAgreement(null)).not.toBe(normalizeForAgreement(""));
    expect(normalizeForAgreement(0)).not.toBe(normalizeForAgreement("null"));
  });

  it("返回的是可直接当作 Map key 的字符串(不是对象)", () => {
    expect(typeof normalizeForAgreement({ a: 1 })).toBe("string");
    expect(normalizeForAgreement({ a: [1, "x"] })).toBe(JSON.stringify({ a: ["1", "x"] }));
  });
});

describe("agreementOf(X3-04)", () => {
  it("全员一致:score=1、不平票、majority 是原值", () => {
    const report = agreementOf([3, "3", 3.0]);
    expect(report.total).toBe(3);
    expect(report.groups).toHaveLength(1);
    expect(report.groups[0]?.votes).toBe(3);
    expect(report.majority?.value).toBe(3);
    expect(report.tied).toBe(false);
    expect(report.score).toBe(1);
  });

  it("2:1 分票:多数方胜出但 score 反映真实比例", () => {
    const report = agreementOf(["high", "high", "low"]);
    expect(report.groups).toHaveLength(2);
    expect(report.majority?.value).toBe("high");
    expect(report.majority?.votes).toBe(2);
    expect(report.tied).toBe(false);
    expect(report.score).toBeCloseTo(2 / 3, 10);
  });

  it("平票:majority 为 null 且 tied=true(不硬挑一个)", () => {
    const report = agreementOf(["high", "low"]);
    expect(report.tied).toBe(true);
    expect(report.majority).toBeNull();
    expect(report.score).toBe(0.5);
    // 2:2 也是平票 —— 票数达到 minVotes 不等于有共识。
    const even = agreementOf(["a", "a", "b", "b"]);
    expect(even.tied).toBe(true);
    expect(even.majority).toBeNull();
  });

  it("平票时分组顺序仍按票数降序 + key 升序稳定排列(报表不抖动)", () => {
    const report = agreementOf(["z", "a", "m"]);
    expect(report.groups.map((group) => group.value)).toEqual(["a", "m", "z"]);
    expect(report.majority).toBeNull();
  });

  it("空输入:total=0、score=0、majority=null,不抛错", () => {
    const report = agreementOf([]);
    expect(report.total).toBe(0);
    expect(report.score).toBe(0);
    expect(report.majority).toBeNull();
    expect(report.tied).toBe(false);
    expect(report.groups).toEqual([]);
  });

  it("undefined 不参与计票(缺席不是意见)", () => {
    const report = agreementOf(["x", undefined, "x"]);
    expect(report.total).toBe(2);
    expect(report.groups[0]?.votes).toBe(2);
    expect(report.score).toBe(1);
  });
});

describe("structuredConsensus(X3-05)", () => {
  it("2/3 一致采纳、1 份独占丢弃、缺席字段也丢弃", () => {
    const result = consensusOf([
      { risk: "high", score: 3 },
      { risk: "high", score: 3 },
      { risk: "high", score: 9, topics: ["只有这一份提到"] },
    ]);
    expect(result.value).toEqual({ risk: "high", score: 3 });
    // score 是 2:1 分票拿到的结论,不是全员一致:一致率本身就是一项输出。
    expect(result.fieldAgreement.score).toBe(0.6667);
    // 丢弃是显式结果,不是隐藏的空值:dropped 里同时包含「谈不拢」和「没人提」。
    expect(result.dropped).toEqual(["summary", "topics"]);
    expect(result.fieldVotes).toEqual({ risk: 3, summary: 0, score: 3, topics: 1 });
    expect(result.fieldAgreement.risk).toBe(1);
    expect(result.fieldAgreement.topics).toBe(1);
    expect(result.fieldAgreement.summary).toBe(0);
    expect(result.total).toBe(3);
    expect(coverageOf(result, SPEC)).toBe(0.5);
  });

  it("同义写法算同一票:大小写/空白/最简数字串都不足以分票", () => {
    const result = consensusOf([
      { risk: "high", summary: "命中 风控", score: 3, topics: ["a", "b"] },
      { risk: "HIGH", summary: "  命中\t 风控 ", score: "3", topics: ["a", "b"] },
      { risk: "low", summary: "另一套说法", score: 9, topics: ["z"] },
    ]);
    expect(result.dropped).toEqual([]);
    expect(result.value).toEqual({ risk: "high", summary: "命中 风控", score: 3, topics: ["a", "b"] });
    // 交回调用方的是原始值(第一次出现那份),不是规范串:score 仍是数字,不是 "3"。
    expect(result.value.score).toBe(3);
    expect(result.value.risk).toBe("high");
    expect(result.fieldAgreement.risk).toBe(0.6667);
    expect(coverageOf(result, SPEC)).toBe(1);
  });

  it("「3.0」与 3 分票:表决层不做隐式数字纠偏(类型纠正属于 structured.ts)", () => {
    // 同一对数据只改字符串写法,结论就从「采纳」变成「弃权」。
    // 数字字面量(含上游写的 3.0)走 number 归一;带小数尾巴的字符串不参与,
    // 否则 "007"/"7"、版本号、比例会被默默判成同票,一致率虚高。
    expect(consensusOf([{ score: 3 }, { score: 3.0 }]).value).toEqual({ score: 3 });
    expect(consensusOf([{ score: 3 }, { score: "3" }]).value).toEqual({ score: 3 });
    const split = consensusOf([{ score: 3 }, { score: "3.0" }]);
    expect(split.value).toEqual({});
    expect(split.dropped).toContain("score");
    expect(split.fieldAgreement.score).toBe(0.5);
  });

  it("平票字段丢弃,即使最大票组票数已经够", () => {
    const result = consensusOf([
      { risk: "high", score: 1 },
      { risk: "high", score: 1 },
      { risk: "low", score: 2 },
      { risk: "low", score: 2 },
    ]);
    expect(result.value).toEqual({});
    expect(result.dropped).toEqual(FIELD_LIST);
    expect(result.fieldAgreement.risk).toBe(0.5);
    // 平票不是「少了一点」,而是「完全没有结论」:coverage 归零。
    expect(coverageOf(result, SPEC)).toBe(0);
  });

  it("默认阈值下 2/3 采纳;把 threshold 抬到 0.75 后同一份数据就谈不拢了", () => {
    const payloads = [{ risk: "high" }, { risk: "high" }, { risk: "low" }];
    expect(consensusOf(payloads).value).toEqual({ risk: "high" });
    const strict = consensusOf(payloads, { threshold: 0.75 });
    expect(strict.value).toEqual({});
    expect(strict.dropped).toContain("risk");
  });

  it("默认要求至少 2 票;单份结果不给出任何结论", () => {
    const single = consensusOf([{ risk: "high", score: 3 }]);
    expect(single.value).toEqual({});
    expect(single.total).toBe(1);
    expect(coverageOf(single, SPEC)).toBe(0);
    // 单 provider 复用时(票不够)显式降到 minVotes:1 才有结果。
    expect(consensusOf([{ risk: "high", score: 3 }], { minVotes: 1 }).value).toEqual({ risk: "high", score: 3 });
  });

  it("非对象份数被剔除,不参与分母", () => {
    // 运行时可能拿到字符串/数组/空位(上游输出本来就可能坿),这一层必须自己抹平。
    const dirty = [null, undefined, "整段文本", [{ risk: "high" }], { risk: "high" }, { risk: "high" }] as unknown as (
      | Record<string, unknown>
      | null
      | undefined
    )[];
    const result = structuredConsensus(dirty, SPEC);
    expect(result.total).toBe(2);
    expect(result.value).toEqual({ risk: "high" });
    expect(coverageOf(result, SPEC)).toBe(0.25);
  });

  it("数组顺序默认是信息;只有 sortArrays 时才按集合比", () => {
    const payloads = [{ topics: ["a", "b"] }, { topics: ["b", "a"] }];
    expect(consensusOf(payloads).value).toEqual({});
    expect(consensusOf(payloads).dropped).toContain("topics");
    const sorted = consensusOf(payloads, { sortArrays: true });
    expect(sorted.value).toEqual({ topics: ["a", "b"] });
  });

  it("份数里全都缺某个键时,该键记 0 票并丢弃", () => {
    const result = consensusOf([{ risk: "high" }, { risk: "high" }]);
    expect(result.fieldVotes.score).toBe(0);
    expect(result.fieldAgreement.score).toBe(0);
    expect(result.dropped).toContain("score");
    expect(result.value).toEqual({ risk: "high" });
  });

  it("没有任何可用份数 → 空结论,而不是抛错", () => {
    const result = structuredConsensus([], SPEC);
    expect(result.value).toEqual({});
    expect(result.dropped).toEqual(FIELD_LIST);
    expect(result.total).toBe(0);
    // 未达成一致的字段仍然在报表里(方便逐字段报告),不会被默默省略。
    expect(result.fieldVotes).toEqual({ risk: 0, summary: 0, score: 0, topics: 0 });
    expect(result.fieldAgreement).toEqual({ risk: 0, summary: 0, score: 0, topics: 0 });
  });

  it("空字段清单时不产出任何键,coverage 记 0 而不是 NaN", () => {
    const emptySpec: StructuredSpec = { fields: [] };
    const result = structuredConsensus([{ risk: "high" }], emptySpec);
    expect(result.value).toEqual({});
    expect(result.dropped).toEqual([]);
    expect(coverageOf(result, emptySpec)).toBe(0);
  });
});

describe("coverageOf(X3-06 的分母)", () => {
  it("按清单字段数归一,只数达成共识的字段", () => {
    const full = { value: { risk: "high", summary: "s", score: 3, topics: ["a"] } };
    expect(coverageOf(full, SPEC)).toBe(1);
    expect(coverageOf({ value: { risk: "high" } }, SPEC)).toBe(0.25);
    expect(coverageOf({ value: {} }, SPEC)).toBe(0);
  });

  it("清单外的键不计入分子(否则 coverage 会虚高)", () => {
    expect(coverageOf({ value: { unrelated: "x", unrelated2: 2 } }, SPEC)).toBe(0);
    expect(coverageOf({ value: { risk: undefined, summary: "有值" } }, SPEC)).toBe(0.25);
  });

  it("四舍五入到 4 位,便于直接画曲线", () => {
    const spec: StructuredSpec = { fields: [{ name: "a", type: "string" }, { name: "b", type: "string" }, { name: "c", type: "string" }, { name: "d", type: "string" }, { name: "e", type: "string" }] };
    expect(coverageOf({ value: { a: 1, b: 1, c: 1, d: 1 } }, spec)).toBe(0.8);
    const thirds: StructuredSpec = { fields: [{ name: "a", type: "string" }, { name: "b", type: "string" }, { name: "c", type: "string" }] };
    expect(coverageOf({ value: { a: 1, b: 1 } }, thirds)).toBe(0.6667);
  });
});
