/**
 * X2 结构化抽取的纯函数层:取值(extractJsonObject)、校验(validateStructuredPayload)、提示生成。
 *
 * 为什么这些用例要写得很难看(全是原因码):
 *  - 仓库里原有的 `text.match(/\{[\s\S]*\}/)` 是贪婪的,「JSON + 后面一段带花括号的废话」会被整段吞掉,
 *    解析失败在守护类服务里表现为**降级为"没问题"** —— 形状问题会直接变成业务判定问题;
 *  - 校验层失败必须带稳定的 code 与逐字段原因(G-06),不能返回"看起来像成功"的空对象,
 *    所以下面每个分支都断言到具体 code,而不是 `ok === false` 就完事。
 */

import {
  STRUCTURED_REPAIR_PREVIOUS_BUDGET,
  buildRepairPrompt,
  buildStructuredSystemPrompt,
  extractJsonObject,
  fieldNames,
  formatStructuredIssues,
  parseAndValidate,
  validateStructuredPayload,
  type StructuredIssue,
  type StructuredSpec,
} from "../services/librechat/structured";

const SPEC: StructuredSpec = {
  fields: [
    { name: "risk", type: "enum", enumValues: ["low", "medium", "high"], required: true, description: "风险等级" },
    { name: "summary", type: "string", maxLen: 10 },
    { name: "score", type: "number", min: 0, max: 10 },
    { name: "urgent", type: "boolean" },
    { name: "topics", type: "string[]", maxItems: 3 },
  ],
};

describe("extractJsonObject · 括号配对扫描(X2-02)", () => {
  it("前导人话 + ```json 围栏 + 尾随一段带 } 的废话:取到围栏里那个完整对象", () => {
    const raw = '我看完之后,结果如下:\n```json\n{"risk":"high","score":3}\n```\n以上是我的判断 } 供参考';
    const result = extractJsonObject(raw);
    if (!result.ok) throw new Error(`期望解析成功,实际 ${result.code}:${result.message}`);
    expect(result.json).toEqual({ risk: "high", score: 3 });
    // 贪婪正则会一路吃到最后一个 `}`,这里钉住"只取第一个完整对象"。
    expect(result.raw).toBe('{"risk":"high","score":3}');
    expect(result.raw).not.toContain("供参考");
  });

  it("没有围栏时,前导人话里不含花括号也能取到对象", () => {
    const result = extractJsonObject('这是结果: {"a":1,"b":2} 后面是废话 } 不影响');
    if (!result.ok) throw new Error(`期望解析成功,实际 ${result.code}`);
    expect(result.json).toEqual({ a: 1, b: 2 });
    expect(result.raw).toBe('{"a":1,"b":2}');
  });

  it("嵌套对象与数组按深度配平,不是取最后一个 }", () => {
    const result = extractJsonObject('{"a":{"b":[1,2],"c":"x"}} 尾注 }');
    if (!result.ok) throw new Error(`期望解析成功,实际 ${result.code}`);
    expect(result.json).toEqual({ a: { b: [1, 2], c: "x" } });
    expect(result.raw).toBe('{"a":{"b":[1,2],"c":"x"}}');
  });

  it("字符串里的 } 与转义引号不参与配平", () => {
    const result = extractJsonObject('{"s":"a}b\\"c","n":2} 之后的 } 不算数');
    if (!result.ok) throw new Error(`期望解析成功,实际 ${result.code}`);
    expect(result.json).toEqual({ s: 'a}b"c', n: 2 });
    expect(result.raw).toBe('{"s":"a}b\\"c","n":2}');
  });

  it("字符串里的反斜杠转义不会吞掉收尾引号", () => {
    const result = extractJsonObject('{"p":"C:\\\\dir\\\\"} 尾巴');
    if (!result.ok) throw new Error(`期望解析成功,实际 ${result.code}`);
    expect(result.json).toEqual({ p: "C:\\dir\\" });
  });

  it("围栏里的对象优先于围栏外的花括号", () => {
    const result = extractJsonObject('兜底 { 之前有个单独的左括号\n```json\n{"k":"v"}\n```');
    if (!result.ok) throw new Error(`期望解析成功,实际 ${result.code}`);
    expect(result.json).toEqual({ k: "v" });
  });

  it("半个对象(括号不配平)→ INVALID_JSON,而不是静默返回半截内容", () => {
    expect(extractJsonObject('{"a":1')).toEqual({
      ok: false,
      code: "INVALID_JSON",
      message: "内容里有花括号,但不是合法的 JSON 对象",
    }));
  });

  it("括号配平但语法非法(尾逗号)→ INVALID_JSON", () => {
    const result = extractJsonObject('{"a":1,}');
    expect(result).toMatchObject({ ok: false, code: "INVALID_JSON" });
  });

  it("完全没有花括号 → NO_JSON", () => {
    expect(extractJsonObject("我什么也没抽到")).toMatchObject({ ok: false, code: "NO_JSON" });
    expect(extractJsonObject("[1,2,3]")).toMatchObject({ ok: false, code: "NO_JSON" });
  });

  it("空/非字符串输入 → NO_JSON(而不是抛错)", () => {
    expect(extractJsonObject("")).toMatchObject({ ok: false, code: "NO_JSON" });
    expect(extractJsonObject("   \n  ")).toMatchObject({ ok: false, code: "NO_JSON" });
    expect(extractJsonObject(undefined)).toMatchObject({ ok: false, code: "NO_JSON" });
    expect(extractJsonObject(42)).toMatchObject({ ok: false, code: "NO_JSON" });
    expect(extractJsonObject({ already: "object" })).toMatchObject({ ok: false, code: "NO_JSON" });
  });
});

describe("validateStructuredPayload · 逐类 issue 与 note(X2-04)", () => {
  it("未知键进 droppedKeys 并产生 UNKNOWN_FIELD note,但绝不进结果", () => {
    const result = validateStructuredPayload({ risk: "high", confidence: 0.99, reason: "模型自己加的" }, SPEC);
    expect(result.ok).toBe(true);
    expect(result.droppedKeys).toEqual(["confidence", "reason"]);
    expect(result.value).toEqual({ risk: "high" });
    expect(result.value).not.toHaveProperty("confidence");
    const note = result.notes.find((item) => item.code === "UNKNOWN_FIELD");
    expect(note?.field).toBe("confidence,reason");
    expect(note?.message).toContain("confidence、reason");
  });

  it("输入不是对象 → NOT_AN_OBJECT 且不产生 value", () => {
    for (const input of [null, undefined, "high", 42, [{ risk: "high" }]]) {
      const result = validateStructuredPayload(input, SPEC);
      expect(result.ok).toBe(false);
      expect(result.issues).toEqual([{ code: "NOT_AN_OBJECT", message: "内容不是一个 JSON 对象" }]);
      expect(result.value).toBeUndefined();
    }
  });

  it("required 缺失 → MISSING_FIELD 且 ok=false(缺失不猜默认值,G-06)", () => {
    const result = validateStructuredPayload({ summary: "还行" }, SPEC);
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([{ code: "MISSING_FIELD", field: "risk", message: "缺少「风险等级」" }]);
    expect(result.value).toEqual({ summary: "还行" });
  });

  it("把「未知/无法确定」当弃权:必填字段仍判 MISSING_FIELD,而不是收下这个占位串", () => {
    for (const placeholder of ["未知", "无法确定", "unknown", "null", "无", "  "]) {
      const result = validateStructuredPayload({ risk: placeholder }, SPEC);
      expect(result.ok).toBe(false);
      expect(result.issues).toEqual([{ code: "MISSING_FIELD", field: "risk", message: "缺少「风险等级」" }]);
      expect(result.value).toEqual({});
    }
  });

  it("数字字符串被接受并记 COERCED", () => {
    const result = validateStructuredPayload({ risk: "high", score: "3.0" }, SPEC);
    expect(result.ok).toBe(true);
    expect(result.value?.score).toBe(3);
    expect(result.notes).toEqual([{ code: "COERCED", field: "score", message: "「score」按数字理解" }]);
  });

  it("0 是有效数字,不被当成「没填」", () => {
    const result = validateStructuredPayload({ risk: "high", score: 0 }, SPEC);
    expect(result.ok).toBe(true);
    expect(result.value?.score).toBe(0);
    expect(result.notes).toEqual([]);
  });

  it("非数字内容 → TYPE_MISMATCH", () => {
    const result = validateStructuredPayload({ risk: "high", score: "abc" }, SPEC);
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([{ code: "TYPE_MISMATCH", field: "score", message: "「score」应是数字" }]);
    expect(result.value).not.toHaveProperty("score");
  });

  it("越界 min/max → OUT_OF_RANGE", () => {
    const below = validateStructuredPayload({ risk: "high", score: -1 }, SPEC);
    expect(below.issues).toEqual([{ code: "OUT_OF_RANGE", field: "score", message: "「score」不能小于 0" }]);
    const above = validateStructuredPayload({ risk: "high", score: 11 }, SPEC);
    expect(above.issues).toEqual([{ code: "OUT_OF_RANGE", field: "score", message: "「score」不能大于 10" }]);
    // 边界值本身要过,否则 min/max 就成了排除端点的语义。
    expect(validateStructuredPayload({ risk: "high", score: 10 }, SPEC).ok).toBe(true);
  });

  it("枚举精确命中不记 note;大小写/空白归一后命中记 COERCED;不在清单里 → OUT_OF_ENUM", () => {
    const exact = validateStructuredPayload({ risk: "high" }, SPEC);
    expect(exact.value?.risk).toBe("high");
    expect(exact.notes).toEqual([]);

    const coerced = validateStructuredPayload({ risk: " HIGH " }, SPEC);
    expect(coerced.ok).toBe(true);
    expect(coerced.value?.risk).toBe("high");
    expect(coerced.notes).toEqual([{ code: "COERCED", field: "risk", message: "「risk」大小写已归一" }]);

    const outside = validateStructuredPayload({ risk: "critical" }, SPEC);
    expect(outside.ok).toBe(false);
    expect(outside.issues).toEqual([{ code: "OUT_OF_ENUM", field: "risk", message: "「risk」只能是:low / medium / high" }]);
    expect(outside.value).not.toHaveProperty("risk");
  });

  it("超长字符串截断并记 TRUNCATED(而不是整段塞进下游)", () => {
    const result = validateStructuredPayload({ risk: "high", summary: "一二三四五六七八九十超标了" }, SPEC);
    expect(result.ok).toBe(true);
    expect(result.value?.summary).toBe("一二三四五六七八九十");
    expect(result.notes).toEqual([{ code: "TRUNCATED", field: "summary", message: "「summary」过长,已截断" }]);
  });

  it("字符串里的换行/缩进被折叠(否则枚举比较永远不相等)", () => {
    const spec: StructuredSpec = { fields: [{ name: "title", type: "string", maxLen: 20 }] };
    const result = validateStructuredPayload({ title: "  第一\n行   第二行  " }, spec);
    expect(result.value?.title).toBe("第一 行 第二行");
  });

  it("空字符串字段:可选则省略,必填则 EMPTY_VALUE", () => {
    const optional: StructuredSpec = { fields: [{ name: "title", type: "string" }] };
    expect(validateStructuredPayload({ title: "   " }, optional)).toEqual({
      ok: true,
      value: {},
      issues: [],
      notes: [],
      droppedKeys: [],
    });

    const required: StructuredSpec = { fields: [{ name: "title", type: "string", required: true }] };
    const result = validateStructuredPayload({ title: "   " }, required);
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([{ code: "EMPTY_VALUE", field: "title", message: "「title」是空的" }]);
  });

  it("布尔字段容忍字符串/0/1 写法并记 COERCED,其余判 TYPE_MISMATCH", () => {
    const yes = validateStructuredPayload({ risk: "high", urgent: "是" }, SPEC);
    expect(yes.value?.urgent).toBe(true);
    expect(yes.notes).toEqual([{ code: "COERCED", field: "urgent", message: "「urgent」按是否理解" }]);

    const no = validateStructuredPayload({ risk: "high", urgent: 0 }, SPEC);
    expect(no.value?.urgent).toBe(false);

    // false 是有效答案,不能和「没填」混为一谈。
    expect(validateStructuredPayload({ risk: "high", urgent: false }, SPEC).value?.urgent).toBe(false);

    const bad = validateStructuredPayload({ risk: "high", urgent: "maybe" }, SPEC);
    expect(bad.issues).toEqual([{ code: "TYPE_MISMATCH", field: "urgent", message: "「urgent」应是「是/否」" }]);
  });

  it("string[] 传单个字符串时按换行或逗号拆条并记 COERCED", () => {
    const byLine = validateStructuredPayload({ risk: "high", topics: "甲\n乙" }, SPEC);
    expect(byLine.value?.topics).toEqual(["甲", "乙"]);
    expect(byLine.notes).toEqual([{ code: "COERCED", field: "topics", message: "「topics」按多条理解" }]);

    const byComma = validateStructuredPayload({ risk: "high", topics: "甲, 乙 , 丙" }, SPEC);
    expect(byComma.value?.topics).toEqual(["甲", "乙", "丙"]);
  });

  it("string[] 超过 maxItems → TRUNCATED 并裁到上限", () => {
    const result = validateStructuredPayload({ risk: "high", topics: ["甲", "乙", "丙", "丁", "戊"] }, SPEC);
    expect(result.ok).toBe(true);
    expect(result.value?.topics).toEqual(["甲", "乙", "丙"]);
    expect(result.notes).toEqual([{ code: "TRUNCATED", field: "topics", message: "「topics」最多 3 条,已裁到 3 条" }]);
  });

  it("string[] 里非字符串元素被剔除并记 DROPPED_ITEM", () => {
    const result = validateStructuredPayload({ risk: "high", topics: ["甲", 2, null, "乙"] }, SPEC);
    expect(result.ok).toBe(true);
    expect(result.value?.topics).toEqual(["甲", "乙"]);
    expect(result.notes).toEqual([{ code: "DROPPED_ITEM", field: "topics", message: "「topics」去掉了 2 条不是文字的内容" }]);
  });

  it("string[] 里的重复条目静默去重(去重不是「丢弃非法内容」,不该冒 DROPPED_ITEM)", () => {
    const result = validateStructuredPayload({ risk: "high", topics: ["甲", "甲", "乙", "  "] }, SPEC);
    expect(result.value?.topics).toEqual(["甲", "乙"]);
    expect(result.notes).toEqual([]);
  });

  it("string[] 传对象 → TYPE_MISMATCH", () => {
    const result = validateStructuredPayload({ risk: "high", topics: { a: 1 } }, SPEC);
    expect(result.issues).toEqual([{ code: "TYPE_MISMATCH", field: "topics", message: "「topics」应是一组文字" }]);
  });

  it("字段类型不认识时按 TYPE_MISMATCH 报出来,不会悄悄产出值", () => {
    const spec = { fields: [{ name: "weird", type: "date" as unknown as StructuredSpec["fields"][number]["type"] }] };
    const result = validateStructuredPayload({ weird: "2026-11-26" }, spec);
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([{ code: "TYPE_MISMATCH", field: "weird", message: "「weird」的字段定义无法识别" }]);
  });

  it("多个字段的问题一次全报出来(调用方要给用户逐条原因)", () => {
    const result = validateStructuredPayload({ risk: "critical", score: 99, summary: 5 }, SPEC);
    expect(result.issues.map((issue) => issue.code)).toEqual(["OUT_OF_ENUM", "TYPE_MISMATCH", "OUT_OF_RANGE"]);
  });

  it("空 spec 的字段清单:任何键都是未知键", () => {
    const result = validateStructuredPayload({ a: 1 }, { fields: [] });
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({});
    expect(result.droppedKeys).toEqual(["a"]);
  });

  it("spec 里名字非法的字段被忽略(不参与校验,也不参与白名单)", () => {
    const spec = { fields: [{ name: "", type: "string" }, { name: "ok", type: "string" }] } as unknown as StructuredSpec;
    expect(fieldNames(spec)).toEqual(["ok"]);
    const result = validateStructuredPayload({ ok: "x" }, spec);
    expect(result.droppedKeys).toEqual([]);
  });
});

describe("parseAndValidate · 解析与校验串起来", () => {
  it("脏样输出(围栏 + 前后废话)解析成功后继续校验字段", () => {
    const result = parseAndValidate('结论:\n```json\n{"risk":"HIGH","score":"2"}\n```\n就这样 }', SPEC);
    expect(result.ok).toBe(true);
    expect(result.value).toEqual({ risk: "high", score: 2 });
    expect(result.notes.map((note) => note.code)).toEqual(["COERCED", "COERCED"]);
  });

  it("解析失败时把解析层的 code 原样透出,不伪装成字段问题", () => {
    const result = parseAndValidate("抱歉,我没法给出 JSON", SPEC);
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([{ code: "NO_JSON", message: "没有找到 JSON 对象" }]);
    expect(result.droppedKeys).toEqual([]);
    expect(result.notes).toEqual([]);
  });

  it("只取第一个完整对象:后面残留的半截花括号不参与判定", () => {
    const result = parseAndValidate('前置说明 {"a":1} {"risk":', SPEC);
    // 取到的是 `{"a":1}`(未知键被丢弃),risk 仍是缺失 —— 不能因为尾部有 `{` 就判成解析失败。
    expect(result.ok).toBe(false);
    expect(result.issues[0]?.code).toBe("MISSING_FIELD");
    expect(result.droppedKeys).toEqual(["a"]);
  });
});

describe("buildStructuredSystemPrompt(X2-05)", () => {
  const prompt = buildStructuredSystemPrompt("你是消息分析助手。", SPEC);

  it("每个字段名与枚举取值都出现在清单里", () => {
    for (const name of fieldNames(SPEC)) expect(prompt).toContain(name);
    expect(prompt).toContain("只能取:low / medium / high");
    expect(prompt).toContain("risk: enum;必填;风险等级");
    expect(prompt).toContain("score: number;不小于 0;不大于 10");
    expect(prompt).toContain("topics: string[];不超过 3 条");
    expect(prompt).toContain("summary: string;不超过 10 字");
  });

  it("禁 fence 与「只输出 JSON」的措辞钉住(否则解析层要面对代码块)", () => {
    expect(prompt).toContain("只输出一个 JSON 对象,不要输出任何其他文字,不要用代码块包裹。");
    expect(prompt.startsWith("你是消息分析助手。")).toBe(true);
  });

  it("保留弃权出口:不确定就省略键(为 X3 的逐字段表决铺路)", () => {
    expect(prompt).toContain("无法确定的字段请**直接省略该键**,不要猜测、不要填 null、不要写「未知」。");
    expect(prompt).toContain("不在清单里的键会被丢弃");
  });

  it("给出对象形状骨架", () => {
    expect(prompt).toContain('形如:{"risk":<enum>,"summary":<string>,"score":<number>,"urgent":<boolean>,"topics":<string[]>}');
  });

  it("base 为空串时仍然产出可用的提示", () => {
    const bare = buildStructuredSystemPrompt("", SPEC);
    expect(bare).toContain("【输出要求】");
    expect(bare.startsWith("\n")).toBe(true);
  });

  it("defaultMaxLen 覆盖 500 的默认上限", () => {
    const spec: StructuredSpec = { fields: [{ name: "title", type: "string" }], defaultMaxLen: 20 };
    expect(buildStructuredSystemPrompt("BASE", spec)).toContain("title: string;不超过 20 字");
  });
});

describe("formatStructuredIssues / buildRepairPrompt(X2-06)", () => {
  const issues: StructuredIssue[] = [
    { code: "OUT_OF_ENUM", field: "risk", message: "「risk」只能是:low / medium / high" },
    { code: "NOT_AN_OBJECT", message: "内容不是一个 JSON 对象" },
  ];

  it("每条 issue 翻成一行用户可读文本,字段级问题带字段名", () => {
    expect(formatStructuredIssues(issues)).toEqual(["- 字段 risk:「risk」只能是:low / medium / high", "- 内容不是一个 JSON 对象"]);
  });

  it("修复提示里逐条列出问题,并重申输出形状", () => {
    const prompt = buildRepairPrompt(issues, SPEC);
    expect(prompt).toContain("上一次的输出不符合要求,请修正后重新给出。");
    expect(prompt).toContain("- 字段 risk:「risk」只能是:low / medium / high");
    expect(prompt).toContain("内容不是一个 JSON 对象");
    expect(prompt).toContain('只输出一个 JSON 对象(形如 {"risk":…,"summary":…,"score":…,"urgent":…,"topics":…}),不要任何解释、不要代码块。');
    expect(prompt).toContain("仍然无法确定的字段请省略该键。");
  });

  it("没有 issue 时给出一条兜底说明,而不是空列表", () => {
    expect(buildRepairPrompt([], SPEC)).toContain("- 无法解析成 JSON 对象");
  });

  it("previousRaw 超过预算时截断到 2000 字并加省略号", () => {
    const long = "x".repeat(STRUCTURED_REPAIR_PREVIOUS_BUDGET + 500);
    const prompt = buildRepairPrompt(issues, SPEC, long);
    expect(prompt).toContain("上一次输出的内容(可能已截断):");
    expect(prompt).toContain("x".repeat(STRUCTURED_REPAIR_PREVIOUS_BUDGET));
    expect(prompt).not.toContain("x".repeat(STRUCTURED_REPAIR_PREVIOUS_BUDGET + 1));
  });

  it("previousRaw 未超预算时原样附上;空/非字符串时整段省略", () => {
    expect(buildRepairPrompt(issues, SPEC, '{"risk":"high"}')).toContain('{"risk":"high"}');
    expect(buildRepairPrompt(issues, SPEC)).not.toContain("上一次输出的内容");
    expect(buildRepairPrompt(issues, SPEC, "   ")).not.toContain("上一次输出的内容");
    expect(buildRepairPrompt(issues, SPEC, 42)).not.toContain("上一次输出的内容");
  });
});
