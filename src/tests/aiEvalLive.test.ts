/**
 * X4-08 真模型评测 —— 只在 nightly 显式开启时跑(`AI_LIVE_EVAL_CHECK=1`)。
 *
 * 为什么不进主 CI:上游可用性会抖,PR 门禁不能被一次 502 拖住;但"没跑过"也**不能**被记成
 * "跑过了"。所以这里的取舍是:
 *  - 开关关掉 → 整组 `describe.skip`,报告里以 skipped 出现,不会给任何人一个绿勾;
 *  - 开关打开但一个 provider 都没有 → **显式抛错**,而不是安静地空跑一轮(空跑的绿灯最骗人)。
 *
 * 断言刻意只打本服务的契约,不打模型的分数:
 *  ① 评测真的跑完了、账对得上;② 原文没有的信息绝不出现(G-06 的"不编造");
 *  ③ 风险-覆盖率曲线单调;④ 拒绝都落在稳定 code 上。
 * 提示词好不好、模型答得对不对,由 `notify-fields` 的通过率随时间说话,不该由一次 PR 判定。
 */

import fs from "node:fs";
import path from "node:path";

import { loadEvalSuite, renderReportMarkdown, runEvalSuite } from "../eval/harness";
import { clampRatio, isAbstain, resolveExpected, riskCoverageCurve, roundRatio, scoreStructured } from "../eval/scorers";
import type { CaseResult, EvalInvoke, EvalReport, EvalScorer, GoldenCase } from "../eval/types";
import type { StructuredSpec } from "../services/librechat/structured";
import type { StructuredQuorumOutcome } from "../services/librechat/structuredRunner";

/** 与离线回归同一份 golden;用文件读而不是 JSON import,免得评测集挂在解析器配置上。 */
function readSuiteFile(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.resolve(__dirname, "../eval/suites", name), "utf8")) as unknown;
}

const live = process.env.AI_LIVE_EVAL_CHECK === "1" ? describe : describe.skip;

/** 判定失败必须是这几个稳定 code 之一(G-06):出现自由文本就说明归因层漏了。 */
const STABLE_ERROR_CODES = ["INVOCATION_FAILED", "EMPTY_OUTPUT", "PARSE_FAILED", "SCORER_FAILED", "INVALID_CASE"];

function envCount(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(raw)));
}

function needSpec(testCase: GoldenCase): StructuredSpec {
  if (!testCase.spec) throw new Error(`${testCase.id}: golden 用例缺 spec,结构化评测无从判定`);
  return testCase.spec;
}

/**
 * 置信度取"被采纳字段的多数票占比",而不是模型自报。
 *
 * 这正是 X3 存在的理由:多票谈不拢的字段会被丢掉(X3-05),所以一致率就是可以拿去下注的程度。
 * 一份结论里没有任何被采纳字段时置信度记 0 —— "什么都没定下来"不该出现在曲线的右端。
 */
function quorumConfidence(outcome: StructuredQuorumOutcome | undefined, judged: readonly string[]): number {
  const consensus = outcome && outcome.ok ? outcome.consensus : undefined;
  if (!consensus) return 0;
  const kept = judged.filter((name) => consensus.value[name] !== undefined);
  if (!kept.length) return 0;
  const sum = kept.reduce((total, name) => total + clampRatio(consensus.fieldAgreement[name]), 0);
  return roundRatio(sum / kept.length);
}

live("notify-fields 真模型评测", () => {
  // golden 的 spec 刻意不用 `required`:X2-07 会把“必填缺失”当成整例失败(SCHEMA_FAILED → 票不够 → INVOCATION_FAILED),
  // 而 X4 要测的恰恰是“该弃权的字段有没有弃权”。去掉 required 后,一份全空的答案是**可计分的弃权**,
  // 而不是一次通道故障 —— 错误与弃权的分账才清得干净。
  const suite = loadEvalSuite(readSuiteFile("notify-fields.json"));
  const caseLimit = envCount("AI_LIVE_EVAL_CASES", suite.cases.length, 1, suite.cases.length);
  const cases = suite.cases.slice(0, caseLimit);
  const votes = envCount("AI_LIVE_EVAL_VOTES", 3, 2, 5);
  const minVotes = envCount("AI_LIVE_EVAL_MIN_VOTES", 2, 1, votes);

  const quorumByCase = new Map<string, StructuredQuorumOutcome>();
  let providerKeys = "";
  let report: EvalReport | undefined;

  function finished(): EvalReport {
    if (!report) throw new Error("评测没有跑起来 —— 请看 beforeAll 里 provider 配置的失败原因");
    return report;
  }

  beforeAll(async () => {
    // 动态 import:主 CI 里这个文件只会被 skip,不该把整个聊天服务(连带 mongoose)加载一遍。
    const { libreChatService } = await import("../services/libreChatService");
    const providers = await libreChatService.listProviderCandidates();
    if (!providers.length) {
      throw new Error(
        "AI_LIVE_EVAL_CHECK=1 但没有任何可用的聊天 provider:请配置 CHAT_BASE_URL/CHAT_API_KEY 或 chat_providers 集合。" +
          "本轮评测刻意不返回“空跑成功”,以免把没跑过当成通过。",
      );
    }
    providerKeys = providers.slice(0, 3).map((provider) => provider.key).join(" + ");

    const invoke: EvalInvoke = async ({ testCase }) => {
      quorumByCase.delete(testCase.id);
      const outcome = await libreChatService.extractStructuredQuorum({
        spec: needSpec(testCase),
        user: `${testCase.user}\n\n${testCase.input}`,
        system: suite.system,
        votes,
        minVotes,
      });
      quorumByCase.set(testCase.id, outcome);
      // 票谈不拢 = 显式弃权(覆盖率 0),这是结果,不是故障;拿不到票才是故障。
      if (!outcome.ok && outcome.code === "NO_CONSENSUS") return {};
      if (!outcome.ok) throw new Error(`quorum_failed:${outcome.code}`);
      return outcome.value;
    };

    const scorer: EvalScorer = (testCase, raw) => {
      const base = scoreStructured(testCase.spec, testCase.expected, raw);
      const expected = resolveExpected(testCase.expected);
      const judged = [...Object.keys(expected.fields), ...expected.abstained];
      return { ...base, confidence: base.error ? 0 : quorumConfidence(quorumByCase.get(testCase.id), judged) };
    };

    report = await runEvalSuite({
      cases,
      invoke,
      scorer,
      providerKey: providerKeys || "unknown",
      suite: `${suite.suite}(live)`,
      // 上游一次超时不该把整例判成"模型不行",给一次重试;再失败就记 error 并继续跑下一例。
      retries: 1,
    });
    console.log(renderReportMarkdown(report));
  }, 1_800_000); // 12 例 × 3 票串行上游调用;嫌慢用 AI_LIVE_EVAL_CASES 削面。

  it("评测真的跑完了,而且账对得上", () => {
    const result = finished();
    expect(result.cases).toHaveLength(cases.length);
    expect(result.providerKey).toBe(providerKeys || "unknown");
    expect(result.summary.total).toBe(cases.length);
    expect(result.summary.answered + result.summary.errors).toBe(result.summary.total);
    // 全军覆没 = 什么都没评测出来,不能算通过。
    expect(result.summary.answered).toBeGreaterThan(0);
    for (const item of result.cases) {
      expect(item.score).toBeGreaterThanOrEqual(0);
      expect(item.score).toBeLessThanOrEqual(1);
      expect(clampRatio(item.confidence)).toBe(item.confidence);
      if (item.ok) {
        expect(item.error).toBeUndefined();
        expect(item.score).toBe(1);
      }
    }
  });

  it("原文没有的信息绝不出现(G-06:拒绝要显式,不许编默认值)", () => {
    const fabricated: string[] = [];
    for (const testCase of finished().cases) {
      const golden = cases.find((item) => item.id === testCase.caseId);
      if (!golden) continue;
      const actual = testCase.actual && typeof testCase.actual === "object" ? (testCase.actual as Record<string, unknown>) : {};
      for (const field of resolveExpected(golden.expected).abstained) {
        if (!isAbstain(actual[field])) fabricated.push(`${testCase.caseId}.${field}=${String(actual[field])}`);
      }
    }
    expect(fabricated).toEqual([]);
  });

  it("风险-覆盖率曲线:覆盖升高时错误率不凭空下降", () => {
    const result = finished();
    const curve = riskCoverageCurve(result.cases);
    // “账对得上”那条已经保证至少一例可判定,所以这里曲线不该为空。
    expect(curve.length).toBeGreaterThan(0);
    expect(curve[curve.length - 1].coverage).toBe(1);
    for (let i = 1; i < curve.length; i += 1) {
      expect(curve[i].coverage).toBeGreaterThanOrEqual(curve[i - 1].coverage);
      expect(curve[i].errorRate).toBeGreaterThanOrEqual(curve[i - 1].errorRate);
      expect(curve[i].errorRate).toBeGreaterThanOrEqual(curve[i].observedErrorRate);
    }
    expect(result.summary.abstainRate).toBeGreaterThanOrEqual(0);
    expect(result.summary.abstainRate).toBeLessThanOrEqual(1);
  });

  it("每一例的拒绝都落在稳定 code 上", () => {
    const failures = finished().cases.filter((item: CaseResult) => item.error !== undefined);
    for (const item of failures) expect(STABLE_ERROR_CODES).toContain(item.error);
    // 允许上游抖,但不允许"整轮都只是在报错"却被当成评测通过。
    expect(failures.length).toBeLessThan(cases.length);
  });
});
