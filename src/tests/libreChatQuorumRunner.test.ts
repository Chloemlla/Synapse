/**
 * X2-07 / X3-06 编排层:runStructuredExtraction 与 runStructuredQuorum。
 *
 * 这一层的价值在于**它不需要网络也能被完整验证**:`invoke` 由外部注入,所以这里用假 invoke
 * 就能把「一次过 / 修一次过 / 修不好 / 空输出 / 调用炸 / 票不够 / 全不一致」全部钉住。
 * 断言一律指向稳定 code(G-06):把 `ok:false` 当成结论是用例在骗自己 —— 上层要按 code 分流,
 * 「没问到」(INVOCATION_FAILED)和「没谈拢」(NO_CONSENSUS)对使用者的意义完全不同。
 */

import {
  STRUCTURED_MAX_REPAIR_TURNS,
  STRUCTURED_MAX_VOTES,
  parseStructuredText,
  runStructuredExtraction,
  runStructuredQuorum,
  type StructuredInvoke,
  type StructuredInvokeTurn,
} from "../services/librechat/structuredRunner";
import type { StructuredSpec } from "../services/librechat/structured";
import type { ChatContentPart, WireChatContent } from "../services/librechat/wire";

const SPEC: StructuredSpec = {
  fields: [
    { name: "risk", type: "enum", enumValues: ["low", "high"], required: true, description: "风险等级" },
    { name: "score", type: "number", min: 0, max: 10 },
    { name: "topics", type: "string[]", maxItems: 3 },
  ],
};

/** 三份都各说各话时用来构造「全不一致」的规格(每个字段都能取出 3 个互不相同的值)。 */
const TRIPLE_SPEC: StructuredSpec = {
  fields: [{ name: "note", type: "string" }, { name: "level", type: "number" }, { name: "tags", type: "string[]" }],
};

const VALID = '{"risk":"high","score":3,"topics":["a","b"]}';
const VALID_VALUE = { risk: "high", score: 3, topics: ["a", "b"] };
const USER = "把这段告警日志抽成结构化结果";

function missing(turn: StructuredInvokeTurn): never {
  throw new Error(`注入方没有准备第 ${turn.vote} 票第 ${turn.repair} 轮的回复`);
}

function makeInvoke(replyFor: (turn: StructuredInvokeTurn) => string): { invoke: StructuredInvoke; turns: StructuredInvokeTurn[] } {
  const turns: StructuredInvokeTurn[] = [];
  const invoke: StructuredInvoke = async (turn) => {
    turns.push(turn);
    return replyFor(turn);
  };
  return { invoke, turns };
}

/** 按修复轮次给回复(单票场景)。 */
function scripted(replies: string[]) {
  return makeInvoke((turn) => replies[turn.repair] ?? missing(turn));
}

/** 按票号给回复;每张票可以给一串(对应它的修复轮)。 */
function byVote(map: Record<number, string | string[]>) {
  return makeInvoke((turn) => {
    const entry = map[turn.vote] ?? missing(turn);
    const list = Array.isArray(entry) ? entry : [entry];
    return list[turn.repair] ?? missing(turn);
  });
}

describe("runStructuredExtraction · 成功通路(X2-07)", () => {
  it("一次过:repairs=0,notes/droppedKeys 干净,提示里带了基础 system 与 JSON 契约", async () => {
    const stub = scripted([VALID]);
    const outcome = await runStructuredExtraction({ invoke: stub.invoke, spec: SPEC, user: USER, system: "你是消息分析助手。" });
    if (!outcome.ok) throw new Error(`期望成功,实际 ${outcome.code}:${outcome.message}`);
    expect(outcome.value).toEqual(VALID_VALUE);
    expect(outcome.raw).toBe(VALID);
    expect(outcome.repairs).toBe(0);
    expect(outcome.notes).toEqual([]);
    expect(outcome.droppedKeys).toEqual([]);

    expect(stub.turns).toHaveLength(1);
    const turn = stub.turns[0]!;
    expect(turn.vote).toBe(0);
    expect(turn.repair).toBe(0);
    expect(turn.responseFormat).toBe("json");
    expect(turn.system).toContain("你是消息分析助手。");
    expect(turn.system).toContain("只输出一个 JSON 对象");
    expect(turn.messages).toEqual([{ role: "user", content: USER }]);
  });

  it("脏样输出经一次修复通过:repairs=1,修复历史按 assistant/user 成对追加", async () => {
    const dirty = "{}";
    const stub = scripted([dirty, VALID]);
    const outcome = await runStructuredExtraction({ invoke: stub.invoke, spec: SPEC, user: USER });
    if (!outcome.ok) throw new Error(`期望成功,实际 ${outcome.code}`);
    expect(outcome.repairs).toBe(1);
    expect(stub.turns).toHaveLength(2);
    // 修复轮必须带上「上一轮原始输出 + 逐条原因」,否则模型无从知道自己哪里跑偏。
    expect(stub.turns[1]!.messages).toEqual([
      { role: "user", content: USER },
      { role: "assistant", content: dirty },
      { role: "user", content: expect.stringContaining("字段 risk:") },
    ]);
    const repairPrompt = stub.turns[1]!.messages[2]!.content;
    expect(typeof repairPrompt).toBe("string");
    expect(String(repairPrompt)).toContain("缺少「风险等级」");
    expect(stub.turns[1]!.repair).toBe(1);
  });

  it("只有图片件时仍然发起调用(能不能识图是服务层的 fail-closed 判定,X1-06,不在这里)", async () => {
    const imageOnly: ChatContentPart[] = [{ type: "image", dataUrl: "data:image/png;base64,AAAA" }];
    const stub = scripted([VALID]);
    const outcome = await runStructuredExtraction({ invoke: stub.invoke, spec: SPEC, user: imageOnly });
    expect(outcome.ok).toBe(true);
    expect(stub.turns).toHaveLength(1);
    expect(stub.turns[0]!.messages[0].content).toEqual(imageOnly);
  });

  it("内容件原样透传给注入方(图不解析、不复制)", async () => {
    const parts: ChatContentPart[] = [{ type: "text", text: "识别这张截图" }, { type: "image", dataUrl: "data:image/png;base64,AAAA" }];
    const stub = scripted([VALID]);
    const outcome = await runStructuredExtraction({ invoke: stub.invoke, spec: SPEC, user: parts });
    expect(outcome.ok).toBe(true);
    expect(stub.turns[0]!.messages[0].content).toEqual(parts);
  });

  it("围栏 + 前后废话也能一次过,并记下类型纠正", async () => {
    const stub = scripted(['先说结论:\n```json\n{"risk":"HIGH","score":"4"}\n```\n以上 }']);
    const outcome = await runStructuredExtraction({ invoke: stub.invoke, spec: SPEC, user: USER });
    if (!outcome.ok) throw new Error(`期望成功,实际 ${outcome.code}`);
    expect(outcome.value).toEqual({ risk: "high", score: 4 });
    expect(outcome.repairs).toBe(0);
    expect(outcome.notes.map((note) => note.code)).toEqual(["COERCED", "COERCED"]);
  });

  it("未知键被丢弃但仍然算成功(丢弃信息在 droppedKeys 里,不静默改写)", async () => {
    const stub = scripted(['{"risk":"high","confidence":0.9}']);
    const outcome = await runStructuredExtraction({ invoke: stub.invoke, spec: SPEC, user: USER });
    if (!outcome.ok) throw new Error(`期望成功,实际 ${outcome.code}`);
    expect(outcome.value).toEqual({ risk: "high" });
    expect(outcome.droppedKeys).toEqual(["confidence"]);
    expect(outcome.notes).toHaveLength(1);
    expect(outcome.notes[0]?.code).toBe("UNKNOWN_FIELD");
  });

  it("responseFormat:\"text\" 时不给注入方传 responseFormat 键(不支持 JSON 模式的 provider 不会被拖去 400)", async () => {
    const stub = scripted([VALID]);
    await runStructuredExtraction({ invoke: stub.invoke, spec: SPEC, user: USER, responseFormat: "text" });
    expect("responseFormat" in stub.turns[0]!).toBe(false);
  });

  it("onAttempt 每轮都收到本轮的判定结果", async () => {
    const stub = scripted(["{}", VALID]);
    const seen: { repair: number; ok: boolean; codes: string[] }[] = [];
    const outcome = await runStructuredExtraction({
      invoke: stub.invoke,
      spec: SPEC,
      user: USER,
      onAttempt: (info) => seen.push({ repair: info.repair, ok: info.ok, codes: info.issues.map((issue) => issue.code) }),
    });
    expect(outcome.ok).toBe(true);
    expect(seen).toEqual([
      { repair: 0, ok: false, codes: ["MISSING_FIELD"] },
      { repair: 1, ok: true, codes: [] },
    ]);
  });
});

describe("runStructuredExtraction · 失败 code 稳定(X2-07 / G-06)", () => {
  it("修不好 → SCHEMA_FAILED,并把最后一轮的逐字段原因带回去", async () => {
    const stub = scripted(["{}", '{"risk":null}']);
    const outcome = await runStructuredExtraction({ invoke: stub.invoke, spec: SPEC, user: USER });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("SCHEMA_FAILED");
    expect(outcome.repairs).toBe(1);
    expect(outcome.issues).toEqual([{ code: "MISSING_FIELD", field: "risk", message: "缺少「风险等级」" }]);
    expect(outcome.message).toContain("字段 risk:");
    expect(outcome.raw).toBe('{"risk":null}');
    expect(stub.turns).toHaveLength(2);
    // 失败绝不返回编造的空结论
    expect("value" in outcome).toBe(false);
  });

  it("输出根本解析不出对象 → PARSE_FAILED(与 SCHEMA_FAILED 分流)", async () => {
    const stub = scripted(["我什么都没写 {", "还是什么都没有 {"]);
    const outcome = await runStructuredExtraction({ invoke: stub.invoke, spec: SPEC, user: USER });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("PARSE_FAILED");
    expect(outcome.issues.map((issue) => issue.code)).toEqual(["INVALID_JSON"]);
  });

  it("空输出 → EMPTY_OUTPUT,且仍然走满修复轮", async () => {
    const stub = scripted(["   \n ", ""]);
    const outcome = await runStructuredExtraction({ invoke: stub.invoke, spec: SPEC, user: USER });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("EMPTY_OUTPUT");
    expect(outcome.issues).toEqual([{ code: "EMPTY_OUTPUT", message: "没有收到内容" }]);
    // 失败消息是逐条 issue 的人话拼接(X2-06),不是内部术语。
    expect(outcome.message).toContain("没有收到内容");
    expect(outcome.repairs).toBe(1);
    expect(stub.turns).toHaveLength(2);
  });

  it("invoke 抛错 → INVOCATION_FAILED(不冒泡、不编造结果)", async () => {
    const invoke: StructuredInvoke = async () => {
      throw new Error("上游 502");
    };
    const outcome = await runStructuredExtraction({ invoke, spec: SPEC, user: USER });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("INVOCATION_FAILED");
    expect(outcome.message).toBe("AI 服务调用失败");
    expect(outcome.repairs).toBe(0);
    expect(outcome.raw).toBeUndefined();
    expect(outcome.issues).toEqual([]);
  });

  it("修复轮才抛错时,保留上一轮的原因与原文", async () => {
    const stub = makeInvoke((turn) => (turn.repair === 0 ? "{}" : missing(turn)));
    const outcome = await runStructuredExtraction({ invoke: stub.invoke, spec: SPEC, user: USER });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("INVOCATION_FAILED");
    expect(outcome.repairs).toBe(1);
    expect(outcome.raw).toBe("{}");
    expect(outcome.issues).toEqual([{ code: "MISSING_FIELD", field: "risk", message: "缺少「风险等级」" }]);
  });

  it("没有可处理的内容 → INVALID_INPUT,且一次都不调用", async () => {
    const empties: WireChatContent[] = ["", "   \n  ", []];
    for (const user of empties) {
      const stub = scripted([VALID]);
      const outcome = await runStructuredExtraction({ invoke: stub.invoke, spec: SPEC, user });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) continue;
      expect(outcome.code).toBe("INVALID_INPUT");
      expect(outcome.message).toBe("没有要处理的内容");
      expect(outcome.issues).toEqual([]);
      expect(stub.turns).toHaveLength(0);
    }
  });

  it("maxRepairTurns=0 时不给第二次机会", async () => {
    const stub = scripted(["{}"]);
    const outcome = await runStructuredExtraction({ invoke: stub.invoke, spec: SPEC, user: USER, maxRepairTurns: 0 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.repairs).toBe(0);
    expect(stub.turns).toHaveLength(1);
  });

  it("maxRepairTurns 被夹在上限 2:负数回退默认 1", async () => {
    expect(STRUCTURED_MAX_REPAIR_TURNS).toBe(2);
    const greedy = scripted(["{}", "{}", "{}"]);
    const capped = await runStructuredExtraction({ invoke: greedy.invoke, spec: SPEC, user: USER, maxRepairTurns: 99 });
    expect(capped.ok).toBe(false);
    expect(greedy.turns).toHaveLength(1 + STRUCTURED_MAX_REPAIR_TURNS);
    if (capped.ok) return;
    expect(capped.repairs).toBe(STRUCTURED_MAX_REPAIR_TURNS);

    const fallback = scripted(["{}", "{}"]);
    const negative = await runStructuredExtraction({ invoke: fallback.invoke, spec: SPEC, user: USER, maxRepairTurns: -5 });
    expect(negative.ok).toBe(false);
    // 非法值不是「关掉修复」,而是回到默认 1 轮 —— 否则一次抖动就把结论判死。
    expect(fallback.turns).toHaveLength(2);
  });
});

describe("runStructuredQuorum · 多票表决(X3-06)", () => {
  it("三票一致:coverage=1、repairs 不消耗、每票换一个 vote 号", async () => {
    const stub = byVote({ 0: VALID, 1: VALID, 2: VALID });
    const outcome = await runStructuredQuorum({ invoke: stub.invoke, spec: SPEC, user: USER, votes: 3 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toEqual(VALID_VALUE);
    expect(outcome.coverage).toBe(1);
    expect(outcome.votes).toEqual({ total: 3, succeeded: 3, failed: 0 });
    expect(outcome.consensus.dropped).toEqual([]);
    expect(Object.values(outcome.consensus.fieldAgreement)).toEqual([1, 1, 1]);

    // 票与票之间用同一个 system(契约段只拼一次),但 vote 号必须可区分(X3-07 靠它排 provider)。
    expect(stub.turns.map((turn) => turn.vote)).toEqual([0, 1, 2]);
    expect(stub.turns.every((turn) => turn.repair === 0)).toBe(true);
    expect(stub.turns[0]!.system).toBe(stub.turns[1]!.system);
    expect(stub.turns[0]!.system.match(/【输出要求】/g)).toHaveLength(1);
  });

  it("三份各说各话 → NO_CONSENSUS、coverage=0,而不是挑一个看起来对的", async () => {
    const stub = byVote({
      0: '{"note":"甲","level":1,"tags":["a"]}',
      1: '{"note":"乙","level":2,"tags":["b"]}',
      2: '{"note":"丙","level":3,"tags":["c"]}',
    });
    const outcome = await runStructuredQuorum({ invoke: stub.invoke, spec: TRIPLE_SPEC, user: USER, votes: 3 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("NO_CONSENSUS");
    expect(outcome.coverage).toBe(0);
    expect(outcome.votes).toEqual({ total: 3, succeeded: 3, failed: 0 });
    expect(outcome.consensus?.value).toEqual({});
    expect(outcome.consensus?.dropped).toEqual(["note", "level", "tags"]);
    expect(outcome.message).toContain("没有一处一致");
    expect("value" in outcome).toBe(false);
  });

  it("票不够(全部解析失败)→ INVOCATION_FAILED,与「没谈拢」分流", async () => {
    const stub = byVote({ 0: "没有 JSON", 1: "也没有 JSON", 2: "还是没有 JSON" });
    const outcome = await runStructuredQuorum({ invoke: stub.invoke, spec: SPEC, user: USER, votes: 3 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("INVOCATION_FAILED");
    expect(outcome.coverage).toBe(0);
    expect(outcome.votes).toEqual({ total: 3, succeeded: 0, failed: 3 });
    expect(outcome.consensus).toBeUndefined();
    expect(outcome.issues).toHaveLength(3);
    expect(outcome.issues.every((issue) => issue.code === "NO_JSON")).toBe(true);
    expect(outcome.message).toContain("0/3");
  });

  it("只有一票能用也算票不够(默认 minVotes=2)", async () => {
    const stub = byVote({ 0: VALID, 1: "坏票", 2: "也坏" });
    const outcome = await runStructuredQuorum({ invoke: stub.invoke, spec: SPEC, user: USER, votes: 3, minVotes: 2 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("INVOCATION_FAILED");
    expect(outcome.votes).toEqual({ total: 3, succeeded: 1, failed: 2 });
  });

  it("单票失败不中断整轮:2 票一致就能出结论", async () => {
    const stub = byVote({ 0: "这票没内容", 1: VALID, 2: VALID });
    const outcome = await runStructuredQuorum({ invoke: stub.invoke, spec: SPEC, user: USER, votes: 3 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toEqual(VALID_VALUE);
    expect(outcome.votes).toEqual({ total: 3, succeeded: 2, failed: 1 });
    expect(outcome.coverage).toBe(1);
  });

  it("部分字段谈不拢时仍然成功返回,coverage 反映保留比例", async () => {
    const stub = byVote({
      0: '{"risk":"high","score":3,"topics":["a"]}',
      1: '{"risk":"high","score":3,"topics":["b"]}',
      2: '{"risk":"high","score":3,"topics":["c"]}',
    });
    const outcome = await runStructuredQuorum({ invoke: stub.invoke, spec: SPEC, user: USER, votes: 3 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toEqual({ risk: "high", score: 3 });
    expect(outcome.consensus.dropped).toEqual(["topics"]);
    expect(outcome.coverage).toBe(0.6667);
    expect(outcome.votes).toEqual({ total: 3, succeeded: 3, failed: 0 });
  });

  it("票数上限 5,非法票数回退默认 3", async () => {
    expect(STRUCTURED_MAX_VOTES).toBe(5);
    const allValid = byVote({ 0: VALID, 1: VALID, 2: VALID, 3: VALID, 4: VALID });
    const clamped = await runStructuredQuorum({ invoke: allValid.invoke, spec: SPEC, user: USER, votes: 99 });
    expect(clamped.ok).toBe(true);
    expect(allValid.turns).toHaveLength(STRUCTURED_MAX_VOTES);
    if (!clamped.ok) return;
    expect(clamped.votes.total).toBe(STRUCTURED_MAX_VOTES);

    const defaulted = byVote({ 0: VALID, 1: VALID, 2: VALID });
    const bogus = await runStructuredQuorum({ invoke: defaulted.invoke, spec: SPEC, user: USER, votes: 0 });
    expect(bogus.ok).toBe(true);
    expect(defaulted.turns).toHaveLength(3);
  });

  it("votes 被夹到至少 1:票源只剩一个时按 1 票跑,再按 minVotes 判不足", async () => {
    const stub = byVote({ 0: VALID });
    const outcome = await runStructuredQuorum({ invoke: stub.invoke, spec: SPEC, user: USER, votes: -2 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // 单 provider 复用要拿到结论必须显式降到 minVotes:1,否则这里永远是「没问到」。
    expect(outcome.code).toBe("INVOCATION_FAILED");
    expect(outcome.votes).toEqual({ total: 1, succeeded: 1, failed: 0 });
    expect(stub.turns).toHaveLength(1);

    const relaxed = byVote({ 0: VALID });
    const single = await runStructuredQuorum({ invoke: relaxed.invoke, spec: SPEC, user: USER, votes: 1, minVotes: 1 });
    expect(single.ok).toBe(true);
    if (!single.ok) return;
    expect(single.value).toEqual(VALID_VALUE);
    expect(single.coverage).toBe(1);
  });

  it("每票默认不带修复轮;显式开启时修复预算是按票计的", async () => {
    const noRepair = byVote({ 0: ["{}", VALID], 1: VALID, 2: VALID });
    const defaultOutcome = await runStructuredQuorum({ invoke: noRepair.invoke, spec: SPEC, user: USER, votes: 3 });
    // 第一票首发是空对象、没有修复机会 → 只有 2 票可用,仍然够表决。
    expect(defaultOutcome.ok).toBe(true);
    expect(noRepair.turns.filter((turn) => turn.vote === 0)).toHaveLength(1);

    const withRepair = byVote({ 0: ["{}", VALID], 1: ["{}", VALID], 2: ["{}", VALID] });
    const outcome = await runStructuredQuorum({ invoke: withRepair.invoke, spec: SPEC, user: USER, votes: 3, maxRepairTurns: 1 });
    expect(outcome.ok).toBe(true);
    expect(withRepair.turns).toHaveLength(6);
    expect(withRepair.turns.filter((turn) => turn.vote === 1).map((turn) => turn.repair)).toEqual([0, 1]);
  });

  it("onVote 按票序回报,包含每张票的成败", async () => {
    const stub = byVote({ 0: "坏", 1: VALID, 2: VALID });
    const seen: { vote: number; ok: boolean; code?: string }[] = [];
    const outcome = await runStructuredQuorum({
      invoke: stub.invoke,
      spec: SPEC,
      user: USER,
      votes: 3,
      onVote: (info) => seen.push({ vote: info.vote, ok: info.outcome.ok, code: info.outcome.ok ? undefined : info.outcome.code }),
    });
    expect(outcome.ok).toBe(true);
    expect(seen).toEqual([
      { vote: 0, ok: false, code: "PARSE_FAILED" },
      { vote: 1, ok: true, code: undefined },
      { vote: 2, ok: true, code: undefined },
    ]);
  });

  it("内容件与 responseFormat 都按票透传", async () => {
    const parts: ChatContentPart[] = [{ type: "text", text: "看这张图" }, { type: "image", dataUrl: "data:image/png;base64,AAAA" }];
    const stub = byVote({ 0: VALID, 1: VALID, 2: VALID });
    await runStructuredQuorum({ invoke: stub.invoke, spec: SPEC, user: parts, votes: 3, responseFormat: "text" });
    expect(stub.turns).toHaveLength(3);
    for (const turn of stub.turns) {
      expect(turn.messages[0].content).toEqual(parts);
      expect("responseFormat" in turn).toBe(false);
    }
  });

  it("用户内容为空时每票直接判定无效,合计起来就是票不够", async () => {
    const stub = byVote({ 0: VALID, 1: VALID, 2: VALID });
    const outcome = await runStructuredQuorum({ invoke: stub.invoke, spec: SPEC, user: "", votes: 3 });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe("INVOCATION_FAILED");
    expect(outcome.votes).toEqual({ total: 3, succeeded: 0, failed: 3 });
    // 输入不合法不是模型的问题:不把每票的 INVALID_INPUT 吹成上游失败。
    expect(stub.turns).toHaveLength(0);
  });
});

describe("parseStructuredText(服务层复用入口)", () => {
  it("只做解析与校验,不发起调用", () => {
    const ok = parseStructuredText(`\`\`\`json\n${VALID}\n\`\`\``, SPEC);
    expect(ok.ok).toBe(true);
    expect(ok.value).toEqual(VALID_VALUE);

    const bad = parseStructuredText("模型这次没给对象", SPEC);
    expect(bad.ok).toBe(false);
    expect(bad.issues).toEqual([{ code: "NO_JSON", message: "没有找到 JSON 对象" }]);
  });
});
