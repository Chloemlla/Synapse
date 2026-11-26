/**
 * X4 评测台的离线回归(X4-07,**进主 CI**)。
 *
 * 这里不碰任何上游:被测的是"评测台本身能不能如实反映一次回退"。假 `invoke` 就是判据 ——
 * 如果连人造的全对/回错/抛错都测不出来,那 nightly 拿真模型跑出来的绿灯也毫无意义。
 * golden 集直接吃 `src/eval/suites/*.json`,顺带钉住"文件合法、期望表与 spec 一致、不含真实个人信息"。
 */

import fs from "node:fs";
import path from "node:path";

import {
  EVAL_TASKS,
  compareReports,
  loadEvalSuite,
  renderReportMarkdown,
  runEvalSuite,
  scorerForTask,
  summarizeCases,
} from "../eval/harness";
import {
  canonicalLabel,
  isAbstain,
  resolveExpected,
  riskCoverageCurve,
  scoreExact,
  scoreLabel,
  scoreStructured,
} from "../eval/scorers";
import type { CaseResult, EvalInvoke, EvalReport, GoldenCase } from "../eval/types";

const PROVIDER = "m1@api.example.com";
const FIXED_NOW = 1_700_000_000_000;

/**
 * golden 用文件读而不是 `import … .json`:
 *  - X4-06 的判据就是“JSON 合法”,把它做成一条断言而不是依赖编译器;
 *  - 不依赖 `resolveJsonModule` 在 jest 模块解析下的默认导出行为 —— 评测集读不到时,
 *    要看见的是“文件坏了”而不是一句模块解析错误。
 */
function readSuiteFile(name: string): { raw: string; parsed: unknown } {
  const raw = fs.readFileSync(path.resolve(__dirname, "../eval/suites", name), "utf8");
  return { raw, parsed: JSON.parse(raw) as unknown };
}

const notifyFieldsFile = readSuiteFile("notify-fields.json");
const abstainSuiteFile = readSuiteFile("abstain.json");

const notify = loadEvalSuite(notifyFieldsFile.parsed);
const abstain = loadEvalSuite(abstainSuiteFile.parsed);

/** golden 的"满分答案":期望表去掉保留键 `abstained` 就是应当回灌的载荷。 */
function perfectAnswer(testCase: GoldenCase): Record<string, unknown> {
  const expected = testCase.expected;
  if (!expected || typeof expected !== "object") return { value: expected };
  const answer: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(expected as Record<string, unknown>)) {
    if (key === "abstained") continue;
    answer[key] = value;
  }
  return answer;
}

const perfectInvoke: EvalInvoke = async ({ testCase }) => JSON.stringify(perfectAnswer(testCase));

function pick(cases: readonly GoldenCase[], id: string): GoldenCase[] {
  const found = cases.filter((item) => item.id === id);
  expect(found.length).toBe(1);
  return found;
}

function run(cases: readonly GoldenCase[], invoke: EvalInvoke = perfectInvoke): Promise<EvalReport> {
  return runEvalSuite({ cases, invoke, providerKey: PROVIDER, clock: { now: () => FIXED_NOW } });
}

function resultOf(report: EvalReport, caseId: string): CaseResult {
  const found = report.cases.find((item) => item.caseId === caseId);
  if (!found) throw new Error(`报告里缺用例 ${caseId}`);
  return found;
}

function makeReport(cases: CaseResult[], suite = "synthetic"): EvalReport {
  return { suite, providerKey: PROVIDER, startedAt: FIXED_NOW, durationMs: 0, cases, summary: summarizeCases(cases) };
}

function caseResult(caseId: string, overrides: Partial<CaseResult> = {}): CaseResult {
  return { caseId, ok: false, score: 0, abstained: false, actual: null, confidence: 0, ...overrides };
}

/** 从源码文本里抠出所有模块说明符,用来钉住"评测层零服务耦合"。 */
function moduleSpecifiers(source: string): string[] {
  const found: string[] = [];
  const patterns = [/\bfrom\s+["']([^"']+)["']/g, /\brequire\(\s*["']([^"']+)["']\s*\)/g, /\bimport\(\s*["']([^"']+)["']\s*\)/g];
  for (const pattern of patterns) {
    let match = pattern.exec(source);
    while (match) {
      found.push(match[1]);
      match = pattern.exec(source);
    }
  }
  return found;
}

describe("loadEvalSuite — golden 文件本身", () => {
  it("两个 golden 文件都是合法 JSON", () => {
    expect(() => JSON.parse(notifyFieldsFile.raw)).not.toThrow();
    expect(() => JSON.parse(abstainSuiteFile.raw)).not.toThrow();
  });

  it("notify-fields 是 12 例,其中 3 例整份该弃权", () => {
    expect(notify.suite).toBe("notify-fields");
    expect(notify.cases).toHaveLength(12);
    expect(notify.cases.filter((item) => item.task === "abstain")).toHaveLength(3);
  });

  it("abstain 套件是 6 例,且每例都声明了该弃权的字段", () => {
    expect(abstain.suite).toBe("abstain");
    expect(abstain.cases).toHaveLength(6);
    for (const testCase of abstain.cases) {
      expect(testCase.task).toBe("abstain");
      expect(resolveExpected(testCase.expected).abstained.length).toBeGreaterThan(0);
    }
  });

  it("每例都写全了 id/input/user/note/tags,并带 expected", () => {
    for (const suite of [notify, abstain]) {
      for (const testCase of suite.cases) {
        expect(testCase.id.trim()).toBeTruthy();
        expect(testCase.input.trim()).toBeTruthy();
        expect(testCase.user.trim()).toBeTruthy();
        expect(testCase.note).toBeTruthy();
        expect(testCase.tags.length).toBeGreaterThan(0);
        expect(testCase.expected).toBeDefined();
        expect(testCase.expected).not.toBeNull();
      }
    }
  });

  it("期望表的键与 abstain 清单都落在 spec 字段之内(否则测的是拼错的字段名)", () => {
    for (const suite of [notify, abstain]) {
      const names: string[] = suite.spec ? suite.spec.fields.map((field) => field.name) : [];
      expect(names.length).toBeGreaterThan(0);
      for (const testCase of suite.cases) {
        const resolved = resolveExpected(testCase.expected);
        for (const key of Object.keys(resolved.fields)) expect(names).toContain(key);
        for (const key of resolved.abstained) expect(names).toContain(key);
      }
    }
  });

  it("样例全是编造的脱敏数据:没有手机号、身份证样式数字、邮箱", () => {
    const blob = notifyFieldsFile.raw + abstainSuiteFile.raw;
    expect(blob).not.toMatch(/1[3-9]\d{9}/);
    expect(blob).not.toMatch(/\d{15}(\d{2}[0-9xX])?/);
    expect(blob).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(blob).not.toMatch(/https?:\/\//);
  });

  it("拒绝坏文件:非对象、缺 cases、未知 task、缺 expected、重复 id、保留键冲突", () => {
    expect(() => loadEvalSuite(null)).toThrow();
    expect(() => loadEvalSuite({ suite: "x" })).toThrow(/cases/);
    expect(() => loadEvalSuite({ suite: "x", cases: [{ id: "a", task: "guess", expected: {} }] })).toThrow(/task/);
    expect(() => loadEvalSuite({ suite: "x", cases: [{ id: "a", task: "structured" }] })).toThrow(/expected/);
    expect(() =>
      loadEvalSuite({
        suite: "x",
        cases: [
          { id: "a", task: "structured", expected: { subject: "x" } },
          { id: "a", task: "structured", expected: { subject: "y" } },
        ],
      }),
    ).toThrow(/重复/);
    expect(() =>
      loadEvalSuite({
        suite: "x",
        spec: { fields: [{ name: "abstained", type: "string" }] },
        cases: [{ id: "a", task: "structured", expected: { subject: "x" } }],
      }),
    ).toThrow(/保留键/);
    expect(EVAL_TASKS).toEqual(["structured", "abstain", "exact", "label"]);
  });

  it("用例级 spec 覆盖套件级 spec", () => {
    const loaded = loadEvalSuite({
      suite: "override",
      spec: { fields: [{ name: "a", type: "string" }] },
      cases: [{ id: "c1", task: "structured", expected: { b: "1" }, spec: { fields: [{ name: "b", type: "string" }] } }],
    });
    expect(loaded.cases[0].spec?.fields.map((field) => field.name)).toEqual(["b"]);
  });
});

describe("scorers — 对/错/弃权三态", () => {
  it("isAbstain 认缺键、空串、「未知」类措辞,但不认 0 与 false", () => {
    for (const value of [undefined, null, "", "   ", "未知", " UNKNOWN ", "无法确定", "未提及", [], ["", " "]]) {
      expect(isAbstain(value)).toBe(true);
    }
    for (const value of [0, false, "否", "0", ["实验报告"], { subject: "教材费" }]) {
      expect(isAbstain(value)).toBe(false);
    }
    expect(isAbstain("看情况", ["看情况"])).toBe(true);
  });

  it("scoreExact 复用线上表决的归一化口径", () => {
    expect(scoreExact("3", 3.0)).toBe(1);
    expect(scoreExact(" 是 ", "是")).toBe(1);
    expect(scoreExact(["a", "b"], ["a", "b"])).toBe(1);
    expect(scoreExact(["a", "b"], ["b", "a"])).toBe(0);
    expect(scoreExact("实验报告", "读书笔记")).toBe(0);
    expect(scoreExact(undefined, "未知")).toBe(1);
  });

  it("scoreLabel 去包裹符号但不给包含关系送分", () => {
    expect(canonicalLabel("「紧急」。")).toBe("紧急");
    expect(canonicalLabel(" 3.0 ")).toBe("3");
    expect(scoreLabel("紧急", "「紧急」")).toBe(1);
    expect(scoreLabel("部分提交", "部分提交不了")).toBe(0);
    expect(scoreLabel("紧急", "未知")).toBe(0);
  });

  it("scoreStructured 逐字段区分 wrong / abstained / error", () => {
    const spec = notify.spec;
    const target = notify.cases.find((item) => item.id === "notify-01");
    expect(target).toBeDefined();
    const expected = (target as GoldenCase).expected;

    const perfect = scoreStructured(spec, expected, JSON.stringify(perfectAnswer(target as GoldenCase)));
    expect(perfect).toMatchObject({ score: 1, ok: true, abstained: false });
    expect(perfect.error).toBeUndefined();

    const wrong = scoreStructured(spec, expected, JSON.stringify({ subject: "另一件事" }));
    expect(wrong.fields.find((item) => item.field === "subject")?.status).toBe("wrong");
    expect(wrong.fields.find((item) => item.field === "dueAt")?.status).toBe("abstained");
    expect(wrong.ok).toBe(false);
    expect(wrong.abstained).toBe(true);
    expect(wrong.score).toBe(0);

    // 读不出对象 = 通道问题,记 error 而不是把模型按"答错"扣分。
    const unreadable = scoreStructured(spec, expected, "抱歉,这个我做不到。");
    expect(unreadable.error).toBe("PARSE_FAILED");
    expect(unreadable.ok).toBe(false);

    // golden 自己写歪了也要炸出来,而不是给个 1 分。
    expect(scoreStructured(spec, {}, '{"subject":"x"}').error).toBe("EMPTY_EXPECTED");

    // 该弃权的字段被填上 = 编造,状态是 wrong 而不是 correct。
    const fabricated = scoreStructured(abstain.spec, abstain.cases[0].expected, '{"subject":"作业","dueAt":"周五","submitWay":"群接龙"}');
    expect(fabricated.ok).toBe(false);
    expect(fabricated.score).toBe(0);
    expect(fabricated.fields.every((item) => item.status === "wrong")).toBe(true);
  });

  it("scorerForTask 把 abstain 与 structured 走同一条逐字段通路", () => {
    expect(scorerForTask("abstain")).toBe(scorerForTask("structured"));
    expect(scorerForTask(undefined)).toBe(scorerForTask("structured"));
    expect(scorerForTask("exact")).not.toBe(scorerForTask("label"));
  });
});

describe("runEvalSuite — 注入式假模型", () => {
  it("全对 → passed=12、零错误,并且该弃权的例被记成弃权", async () => {
    const report = await run(notify.cases);
    expect(report.suite).toBe("unnamed");
    expect(report.providerKey).toBe(PROVIDER);
    expect(report.cases).toHaveLength(12);
    expect(report.summary).toEqual({
      total: 12,
      passed: 12,
      failed: 0,
      abstained: 10,
      errors: 0,
      answered: 12,
      meanScore: 1,
      passRate: 1,
      errorRate: 0,
      abstainRate: 0.8333,
    });
    // 10 = 期望表里带 abstained 的用例数(notify-02…11)
    expect(notify.cases.filter((item) => resolveExpected(item.expected).abstained.length > 0)).toHaveLength(10);
    expect(report.cases.every((item) => item.error === undefined)).toBe(true);
    expect(report.cases.every((item) => item.confidence === 1)).toBe(true);
  });

  it("abstain 套件满分回灌 → 6 例全过,且全部记为弃权", async () => {
    const report = await run(abstain.cases);
    expect(report.summary).toMatchObject({ total: 6, passed: 6, failed: 0, errors: 0, abstained: 6 });
  });

  it("故意回错 → 计错不计弃权,得分按命中字段比例", async () => {
    const cases = pick(notify.cases, "notify-01");
    const report = await run(cases, async ({ testCase }) => JSON.stringify({ ...perfectAnswer(testCase), subject: "另一件事" }));
    const result = resultOf(report, "notify-01");
    expect(result).toMatchObject({ ok: false, abstained: false, score: 0.8, confidence: 0.8 });
    expect(result.error).toBeUndefined();
    expect(report.summary).toMatchObject({ passed: 0, failed: 1, errors: 0, meanScore: 0.8, errorRate: 1 });
  });

  it("回缺字段 → 记 abstained 且不算 pass", async () => {
    const cases = pick(notify.cases, "notify-01");
    const report = await run(cases, async () => JSON.stringify({ subject: "数据结构第三次实验报告" }));
    const result = resultOf(report, "notify-01");
    expect(result).toMatchObject({ ok: false, abstained: true, score: 0.2 });
    expect(report.summary).toMatchObject({ passed: 0, failed: 1, abstained: 1, errors: 0 });
  });

  it("填了本该没有的字段 → 不算 pass(整份该弃权的例)", async () => {
    const report = await run(pick(abstain.cases, "abstain-01"), async () => '{"subject":"作业","dueAt":"周五","submitWay":"群接龙"}');
    expect(resultOf(report, "abstain-01")).toMatchObject({ ok: false, score: 0 });
    expect(report.summary).toMatchObject({ failed: 1, errors: 0 });
  });

  it("一例抛错 → errors=1,其余照常跑完", async () => {
    const report = await run(notify.cases, async ({ testCase }) => {
      if (testCase.id === "notify-05") throw new Error("upstream 502");
      return JSON.stringify(perfectAnswer(testCase));
    });
    expect(report.cases).toHaveLength(12);
    expect(report.summary).toMatchObject({ total: 12, passed: 11, failed: 0, errors: 1, answered: 11 });
    expect(resultOf(report, "notify-05")).toMatchObject({ error: "INVOCATION_FAILED", ok: false, score: 0, confidence: 0, abstained: false });
    expect(resultOf(report, "notify-05").actual).toBeNull();
    expect(notify.cases.filter((item) => item.id !== "notify-05").every((item) => resultOf(report, item.id).ok)).toBe(true);
  });

  it("空输出 / 读不出对象都归入 errors,而不是当成答错", async () => {
    const cases = [notify.cases[0], notify.cases[1]];
    const empty = await run(pick(cases, cases[0].id), async () => "   ");
    expect(resultOf(empty, cases[0].id)).toMatchObject({ error: "EMPTY_OUTPUT" });
    const broken = await run(pick(cases, cases[1].id), async () => "抱歉,我没法处理这条通知。");
    expect(resultOf(broken, cases[1].id)).toMatchObject({ error: "PARSE_FAILED" });
    expect(broken.summary).toMatchObject({ answered: 0, passed: 0, failed: 0, errors: 1, meanScore: 0 });
  });

  it("retries=1 只救该救的那一例", async () => {
    const makeFlaky = (): { invoke: EvalInvoke; calls: Record<string, number> } => {
      const calls: Record<string, number> = {};
      const invoke: EvalInvoke = async ({ testCase, attempt }) => {
        calls[testCase.id] = (calls[testCase.id] ?? 0) + 1;
        if (testCase.id === "notify-03" && attempt === 0) throw new Error("upstream reset");
        return JSON.stringify(perfectAnswer(testCase));
      };
      return { invoke, calls };
    };

    const first = makeFlaky();
    const withoutRetry = await runEvalSuite({
      cases: notify.cases,
      invoke: first.invoke,
      providerKey: PROVIDER,
      clock: { now: () => FIXED_NOW },
    });
    expect(withoutRetry.summary).toMatchObject({ errors: 1, passed: 11 });
    expect(first.calls["notify-03"]).toBe(1);

    const second = makeFlaky();
    const withRetry = await runEvalSuite({
      cases: notify.cases,
      invoke: second.invoke,
      providerKey: PROVIDER,
      clock: { now: () => FIXED_NOW },
      retries: 1,
    });
    expect(withRetry.summary).toMatchObject({ errors: 0, passed: 12 });
    expect(second.calls["notify-03"]).toBe(2);
    expect(second.calls["notify-01"]).toBe(1);
  });

  it("live 通路可直接交已解析对象,并允许注入自定义 scorer 给出置信度", async () => {
    const report = await runEvalSuite({
      cases: pick(notify.cases, "notify-01"),
      invoke: () => ({ subject: "数据结构第三次实验报告", dueAt: "12月3日24:00", submitWay: "课程平台作业区", mandatory: true, material: ["实验报告", "原始数据表"] }),
      providerKey: PROVIDER,
      clock: { now: () => FIXED_NOW },
      scorer: (testCase, raw) => ({ score: 1, ok: true, abstained: false, actual: raw as Record<string, unknown>, confidence: 0.4 }),
    });
    expect(resultOf(report, "notify-01")).toMatchObject({ ok: true, confidence: 0.4 });
  });

  it("时钟可注入,坏用例记成 INVALID_CASE 而不是拖垮整轮", async () => {
    const ticks = [FIXED_NOW, FIXED_NOW + 7];
    const report = await runEvalSuite({
      cases: [{ id: "", task: "structured", user: "", input: "", expected: {}, tags: [] } as GoldenCase, ...notify.cases],
      invoke: perfectInvoke,
      providerKey: PROVIDER,
      clock: { now: () => ticks.shift() ?? FIXED_NOW },
      suite: "notify-fields",
    });
    expect(report.startedAt).toBe(FIXED_NOW);
    expect(report.durationMs).toBe(7);
    expect(report.suite).toBe("notify-fields");
    expect(resultOf(report, "invalid-case").error).toBe("INVALID_CASE");
    expect(report.summary).toMatchObject({ total: 13, passed: 12, errors: 1 });
  });

  it("没注入 invoke 属于编程错误,直接抛", async () => {
    const incomplete = { cases: notify.cases, providerKey: PROVIDER, clock: { now: () => FIXED_NOW } } as unknown as Parameters<
      typeof runEvalSuite
    >[0];
    await expect(runEvalSuite(incomplete)).rejects.toThrow(TypeError);
  });
});

describe("riskCoverageCurve — 覆盖率换错误率", () => {
  const results: CaseResult[] = [
    caseResult("a", { ok: true, score: 1, confidence: 0.9 }),
    caseResult("b", { ok: false, score: 0.5, confidence: 0.8 }),
    caseResult("c", { ok: true, score: 1, confidence: 0.5 }),
    caseResult("d", { ok: false, score: 0, confidence: 0.2 }),
  ];

  it("端点:最高阈值只留一例,最低阈值覆盖全部", () => {
    const curve = riskCoverageCurve(results);
    expect(curve).toHaveLength(4);
    expect(curve[0]).toMatchObject({ threshold: 0.9, accepted: 1, scored: 4, coverage: 0.25, errorRate: 0 });
    expect(curve[curve.length - 1]).toMatchObject({ threshold: 0.2, accepted: 4, coverage: 1, errorRate: 0.5 });
  });

  it("覆盖率升高时 errorRate 不凭空下降(低置信度那一挡凑巧全对也不行)", () => {
    const curve = riskCoverageCurve(results);
    for (let i = 1; i < curve.length; i += 1) {
      expect(curve[i].coverage).toBeGreaterThanOrEqual(curve[i - 1].coverage);
      expect(curve[i].errorRate).toBeGreaterThanOrEqual(curve[i - 1].errorRate);
    }
    // 阈值降到 0.5 时实测错误率回落到 1/3,但报出去的错误率仍停在 0.5。
    const atHalf = curve.find((point) => point.threshold === 0.5);
    expect(atHalf).toMatchObject({ observedErrorRate: 0.3333, errorRate: 0.5, coverage: 0.75 });
  });

  it("判定失败的例不进分母;没给置信度按 0 处理", () => {
    const curve = riskCoverageCurve([
      ...results,
      caseResult("e", { error: "INVOCATION_FAILED" }),
      caseResult("f", { ok: false, confidence: undefined }),
    ]);
    expect(curve[0]).toMatchObject({ scored: 5, accepted: 1, coverage: 0.2 });
    expect(curve[curve.length - 1]).toMatchObject({ coverage: 1, threshold: 0 });
    expect(curve.every((point) => point.errorRate >= point.observedErrorRate)).toBe(true);
  });

  it("没有可判定的用例时曲线为空(而不是画一条假线)", () => {
    expect(riskCoverageCurve([])).toEqual([]);
    expect(riskCoverageCurve([caseResult("x", { error: "EMPTY_OUTPUT" })])).toEqual([]);
  });
});

describe("compareReports — 人为回退必须被抓到", () => {
  it("一例由过转不过 → regressions", () => {
    const baseline = makeReport(
      ["a", "b", "c"].map((id) => caseResult(id, { ok: true, score: 1, confidence: 1 })),
      "s",
    );
    const candidate = makeReport(
      [caseResult("a", { ok: true, score: 1, confidence: 1 }), caseResult("b", { ok: false, score: 0.8, confidence: 0.8 }), caseResult("c", { ok: true, score: 1, confidence: 1 })],
      "s",
    );
    const diff = compareReports(baseline, candidate);
    expect(diff.regressions).toEqual([{ caseId: "b", from: 1, to: 0.8 }]);
    expect(diff.improvements).toEqual([]);
    expect(diff.newErrors).toEqual([]);
    expect(diff.missing).toEqual([]);
    expect(diff.added).toEqual([]);
    expect(diff.delta).toMatchObject({ passed: -1, failed: 1, meanScore: -0.0667 });
  });

  it("汇总数不变也拦得住:一涨一跌会被逐例对照分开", () => {
    const baseline = makeReport([
      caseResult("a", { ok: true, score: 1, confidence: 1 }),
      caseResult("b", { ok: false, score: 0, confidence: 0 }),
    ]);
    const candidate = makeReport([
      caseResult("a", { ok: false, score: 0, confidence: 0 }),
      caseResult("b", { ok: true, score: 1, confidence: 1 }),
    ]);
    const diff = compareReports(baseline, candidate);
    expect(diff.delta.passed).toBe(0);
    expect(diff.regressions.map((item) => item.caseId)).toEqual(["a"]);
    expect(diff.improvements.map((item) => item.caseId)).toEqual(["b"]);
  });

  it("新增判定失败计入 newErrors,恢复的计入 recoveredErrors", () => {
    const baseline = makeReport([caseResult("a", { ok: false, score: 0, error: "PARSE_FAILED" }), caseResult("b", { ok: true, score: 1 })]);
    const candidate = makeReport([caseResult("a", { ok: true, score: 1 }), caseResult("b", { ok: false, score: 0, error: "INVOCATION_FAILED" })]);
    const diff = compareReports(baseline, candidate);
    expect(diff.newErrors).toEqual(["b"]);
    expect(diff.recoveredErrors).toEqual(["a"]);
    expect(diff.regressions.map((item) => item.caseId)).toEqual(["b"]);
    expect(diff.improvements.map((item) => item.caseId)).toEqual(["a"]);
  });

  it("candidate 漏跑的用例列进 missing(漏跑不等于没回退)", () => {
    const baseline = makeReport([caseResult("a", { ok: true, score: 1 }), caseResult("b", { ok: true, score: 1 })]);
    const candidate = makeReport([caseResult("b", { ok: true, score: 1 }), caseResult("z", { ok: true, score: 1 })]);
    const diff = compareReports(baseline, candidate);
    expect(diff.missing).toEqual(["a"]);
    expect(diff.added).toEqual(["z"]);
  });

  it("两轮真实报告对照:notify-fields 里改坏一例", async () => {
    const baseline = await run(notify.cases);
    const candidate = await run(notify.cases, async ({ testCase }) => {
      if (testCase.id !== "notify-07") return JSON.stringify(perfectAnswer(testCase));
      return JSON.stringify({ ...perfectAnswer(testCase), dueAt: "下周", mandatory: false });
    });
    const diff = compareReports(baseline, candidate);
    expect(diff.regressions).toEqual([{ caseId: "notify-07", from: 1, to: 0.6 }]);
    expect(diff.delta.passed).toBe(-1);
  });
});

describe("renderReportMarkdown", () => {
  it("三段都在:汇总、逐条、风险-覆盖率", async () => {
    const report = await run(notify.cases);
    const markdown = renderReportMarkdown(report);
    expect(markdown).toContain("# 评测报告 · unnamed");
    expect(markdown).toContain(`\`${PROVIDER}\``);
    expect(markdown).toContain("通过 12/12(可判定)");
    expect(markdown).toContain("| notify-01 | 通过 | 1 |");
    expect(markdown).toContain("| 1 | 1 | 0 |");
    expect(markdown.split(/\r?\n/).length).toBeGreaterThan(report.cases.length);
  });

  it("空报告不装样子", () => {
    const markdown = renderReportMarkdown(makeReport([]));
    expect(markdown).toContain("本轮没有用例。");
    expect(markdown).not.toContain("| 阈值 |");
  });

  it("表格里的竖线被转义,不会把表撑坏", () => {
    const markdown = renderReportMarkdown(makeReport([caseResult("a|b", { error: "PIPE|FAILED" })]));
    expect(markdown).toContain("a\\|b");
    expect(markdown).toContain("PIPE\\|FAILED");
  });
});

describe("评测层零服务耦合(X4 能被主 CI 离线跑的前提)", () => {
  const FORBIDDEN = ["express", "mongoose", "axios", "libreChatService", "mongoService", "node:fs", "node:http", "node:net"];

  it("src/eval 只 import 相对路径的纯模块", () => {
    const dir = path.resolve(__dirname, "../eval");
    for (const name of ["types.ts", "scorers.ts", "harness.ts"]) {
      const source = fs.readFileSync(path.join(dir, name), "utf8");
      const specifiers = moduleSpecifiers(source);
      expect(specifiers.length).toBeGreaterThan(0);
      for (const specifier of specifiers) {
        expect(specifier.startsWith(".")).toBe(true);
        for (const forbidden of FORBIDDEN) expect(specifier).not.toContain(forbidden);
      }
    }
  });
});
