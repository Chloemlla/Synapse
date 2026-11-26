/**
 * X4 的调度与对照层(X4-04 / X4-05)——仍然是纯函数,`invoke` 由调用方注入。
 *
 * 三条设计取舍:
 *  - **单例失败绝不中断整轮**。评测台的产出是"这一版提示词比上一版差了哪几例";
 *    一个 provider 超时就把整轮丢掉,得到的永远是"没数据",而不是"有问题"。
 *  - **错误(pass/fail)与未过是两本账**。调用失败/空输出/读不出 JSON 记进 `errors`,
 *    不进 `failed`,也不进 `meanScore` 的分母:把可用率问题折算成"模型不准",
 *    下次改提示词就会朝错误的方向改。
 *  - **不读环境、不连服务**。nightly 想拿真模型跑,就把 `libreChatService` 包成 `invoke` 传进来
 *    (见 `src/tests/aiEvalLive.test.ts`);这里保持零耦合,主 CI 才能离线跑同一份 golden。
 */

import {
  RESERVED_EXPECTED_FIELD,
  clampRatio,
  isAbstain,
  rawToText,
  canonicalLabel,
  riskCoverageCurve,
  roundRatio,
  scoreExact,
  scoreLabel,
  scoreStructured,
} from "./scorers";
import type {
  CaseResult,
  CaseScore,
  EvalClock,
  EvalExpected,
  EvalInvoke,
  EvalRaw,
  EvalReport,
  EvalScorer,
  EvalSummary,
  EvalSuiteFile,
  EvalTask,
  GoldenCase,
} from "./types";
import type { StructuredSpec } from "../services/librechat/structured";

export const EVAL_TASKS: readonly EvalTask[] = ["structured", "abstain", "exact", "label"];

/** 默认时钟;注入它才能让 `startedAt`/`durationMs` 在单测里被钉死。 */
export const SYSTEM_EVAL_CLOCK: EvalClock = { now: () => Date.now() };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const scoreStructuredTask: EvalScorer = (testCase, raw) => {
  const result = scoreStructured(testCase.spec, testCase.expected, raw);
  return {
    score: result.score,
    ok: result.ok,
    abstained: result.abstained,
    actual: result.actual,
    ...(result.error ? { error: result.error } : {}),
  };
};

/**
 * 整段答案比对。
 *
 * 期望值本身是空值(`""` / `"未知"`)时按"这题就该答不上来"处理 —— 与结构化通路同一个口径,
 * 免得同一种弃权在两个 task 下得出相反的结论。
 */
const scoreExactTask: EvalScorer = (testCase, raw) => {
  const answer = rawToText(raw).trim();
  const wantAbstain = isAbstain(testCase.expected);
  const gaveUp = !answer || isAbstain(answer);
  if (wantAbstain) {
    return { score: gaveUp ? 1 : 0, ok: gaveUp, abstained: gaveUp, actual: answer };
  }
  if (gaveUp) return { score: 0, ok: false, abstained: true, actual: answer };
  const score = roundRatio(scoreExact(testCase.expected, answer));
  return { score, ok: score === 1, abstained: false, actual: answer };
};

/** 单选标签:比 `exact` 更宽(去包裹符号、大小写无关),但绝不模糊匹配。 */
const scoreLabelTask: EvalScorer = (testCase, raw) => {
  const answer = canonicalLabel(rawToText(raw));
  const wantAbstain = isAbstain(testCase.expected);
  if (wantAbstain) {
    const gaveUp = !answer || isAbstain(answer);
    return { score: gaveUp ? 1 : 0, ok: gaveUp, abstained: gaveUp, actual: answer };
  }
  if (!answer) return { score: 0, ok: false, abstained: true, actual: answer };
  const score = roundRatio(scoreLabel(testCase.expected, answer));
  return { score, ok: score === 1, abstained: false, actual: answer };
};

/** `abstain` 与 `structured` 共用逐字段通路:弃权例只是"期望值=弃权"的结构化例。 */
export function scorerForTask(task: EvalTask | undefined): EvalScorer {
  if (task === "exact") return scoreExactTask;
  if (task === "label") return scoreLabelTask;
  return scoreStructuredTask;
}

function toCaseResult(caseId: string, score: CaseScore): CaseResult {
  const error = typeof score.error === "string" && score.error ? score.error : undefined;
  const value = clampRatio(score.score);
  // 判定不了的例没有置信度可言:给 0,让它落在曲线最左端而不是被阈值采纳。
  const confidence = error ? 0 : clampRatio(score.confidence ?? value);
  return {
    caseId,
    ok: score.ok === true && !error,
    score: error ? 0 : value,
    abstained: score.abstained === true,
    actual: score.actual ?? null,
    confidence,
    ...(error ? { error } : {}),
  };
}

const UNJUDGED_RESULT = (caseId: string, error: string): CaseResult => ({
  caseId,
  ok: false,
  score: 0,
  abstained: false,
  actual: null,
  confidence: 0,
  error,
});

/** 重试次数收敛到 [0,2]:再多就是在用等待时间掩盖上游故障。 */
function attemptsOf(retries: unknown): number {
  const raw = Number(retries);
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  return 1 + Math.min(2, Math.trunc(raw));
}

/** 坏用例也要落到报告里:丢掉一行等于把"漏跑"伪装成"没回退"。 */
function invalidCaseId(value: unknown): string {
  return (isPlainObject(value) && text(value.id).trim()) || "invalid-case";
}

async function runOneCase(input: {
  testCase: GoldenCase;
  providerKey: string;
  attempts: number;
  invoke: EvalInvoke;
  scorer: EvalScorer;
}): Promise<CaseResult> {
  const caseId = text(input.testCase.id).trim() || "unknown";
  let lastError = "INVOCATION_FAILED";
  for (let attempt = 0; attempt < input.attempts; attempt += 1) {
    let raw: EvalRaw;
    try {
      raw = await Promise.resolve(input.invoke({ testCase: input.testCase, providerKey: input.providerKey, attempt }));
    } catch {
      // 注入方抛错 = 这一例没问到。记下来,继续下一例。
      lastError = "INVOCATION_FAILED";
      continue;
    }
    if (raw === undefined || raw === null || (typeof raw === "string" && !raw.trim())) {
      lastError = "EMPTY_OUTPUT";
      continue;
    }
    try {
      return toCaseResult(caseId, input.scorer(input.testCase, raw));
    } catch {
      // 评分器炸了(golden 写歪、spec 不合法)也必须看得见,而不是让整轮崩掉。
      lastError = "SCORER_FAILED";
      continue;
    }
  }
  return UNJUDGED_RESULT(caseId, lastError);
}

export interface RunEvalSuiteInput {
  cases: readonly GoldenCase[];
  /** 离线注入假模型,nightly 注入真 provider。 */
  invoke: EvalInvoke;
  /** 缺省按用例的 `task` 取评分器。 */
  scorer?: EvalScorer;
  providerKey: string;
  clock?: EvalClock;
  suite?: string;
  /** 单例失败后的重试次数(默认 0)。 */
  retries?: number;
  onCase?: (result: CaseResult, testCase: GoldenCase) => void;
}

/** 跑一整轮评测。任何单例异常都被吸收成该例的 `error`,函数本身不 reject。 */
export async function runEvalSuite(input: RunEvalSuiteInput): Promise<EvalReport> {
  if (typeof input.invoke !== "function") throw new TypeError("runEvalSuite 需要注入 invoke(离线用假模型,nightly 用真 provider)");
  const providerKey = text(input.providerKey).trim() || "unknown";
  const clock = input.clock ?? SYSTEM_EVAL_CLOCK;
  const startedAt = clock.now();
  const attempts = attemptsOf(input.retries);
  const cases: readonly GoldenCase[] = Array.isArray(input.cases) ? input.cases : [];

  const results: CaseResult[] = [];
  for (const testCase of cases) {
    const result =
      isPlainObject(testCase) && text(testCase.id).trim()
        ? await runOneCase({
            testCase,
            providerKey,
            attempts,
            invoke: input.invoke,
            scorer: input.scorer ?? scorerForTask(testCase.task),
          })
        : UNJUDGED_RESULT(invalidCaseId(testCase), "INVALID_CASE");
    results.push(result);
    input.onCase?.(result, testCase);
  }

  return {
    suite: text(input.suite).trim() || "unnamed",
    providerKey,
    startedAt,
    durationMs: Math.max(0, clock.now() - startedAt),
    cases: results,
    summary: summarizeCases(results),
  };
}

/** 汇总口径见文件头:errors 与 failed 分账,准确率只在可判定的例上计算。 */
export function summarizeCases(results: readonly CaseResult[]): EvalSummary {
  const list: CaseResult[] = Array.isArray(results) ? results.filter((item) => isPlainObject(item)) : [];
  const errors = list.filter((item) => item.error !== undefined).length;
  const answered = list.length - errors;
  const passed = list.filter((item) => item.ok === true).length;
  const abstained = list.filter((item) => item.abstained === true).length;
  const failed = Math.max(0, answered - passed);
  const scoreSum = list.reduce((sum, item) => (item.error === undefined ? sum + clampRatio(item.score) : sum), 0);
  return {
    total: list.length,
    passed,
    failed,
    abstained,
    errors,
    answered,
    meanScore: answered ? roundRatio(scoreSum / answered) : 0,
    passRate: answered ? roundRatio(passed / answered) : 0,
    errorRate: answered ? roundRatio(failed / answered) : 0,
    abstainRate: answered ? roundRatio(abstained / answered) : 0,
  };
}

export interface EvalDiffCase {
  caseId: string;
  from: number;
  to: number;
}

export interface EvalDiff {
  /** 由过转不过,或两边都没过但得分下降。 */
  regressions: EvalDiffCase[];
  /** 与 `regressions` 同口径的反向变化。 */
  improvements: EvalDiffCase[];
  /** candidate 新出现的判定失败(调用挂了 / 读不出结果)。 */
  newErrors: string[];
  recoveredErrors: string[];
  /** baseline 有、candidate 没有的用例:漏跑不是"没有回退"。 */
  missing: string[];
  added: string[];
  delta: { passed: number; failed: number; abstained: number; errors: number; meanScore: number };
}

function indexResults(report: EvalReport): Map<string, CaseResult> {
  const map = new Map<string, CaseResult>();
  const items: CaseResult[] = Array.isArray(report.cases) ? report.cases : [];
  for (const item of items) {
    if (!isPlainObject(item)) continue;
    map.set(text(item.caseId), item);
  }
  return map;
}

/**
 * 两轮报告的逐例对照(X4-05)。
 *
 * 只看汇总数会漏:12 例里"一例回退一例进步"会让 `passed` 纹丝不动,而这恰好是提示词
 * 改动最危险的形态——平均分没变,但某个具体场景已经坏了。
 */
export function compareReports(baseline: EvalReport, candidate: EvalReport): EvalDiff {
  const before = indexResults(baseline);
  const after = indexResults(candidate);
  const regressions: EvalDiffCase[] = [];
  const improvements: EvalDiffCase[] = [];
  const newErrors: string[] = [];
  const recoveredErrors: string[] = [];
  const missing: string[] = [];
  const added: string[] = [];

  for (const [caseId, from] of before) {
    const to = after.get(caseId);
    if (!to) {
      missing.push(caseId);
      continue;
    }
    const entry = { caseId, from: clampRatio(from.score), to: clampRatio(to.score) };
    if (from.ok && !to.ok) regressions.push(entry);
    else if (!from.ok && to.ok) improvements.push(entry);
    else if (entry.to < entry.from) regressions.push(entry);
    else if (entry.to > entry.from) improvements.push(entry);

    if (to.error !== undefined && from.error === undefined) newErrors.push(caseId);
    if (from.error !== undefined && to.error === undefined) recoveredErrors.push(caseId);
  }
  for (const caseId of after.keys()) {
    if (!before.has(caseId)) added.push(caseId);
  }

  const base = reportSummary(baseline);
  const next = reportSummary(candidate);
  return {
    regressions,
    improvements,
    newErrors,
    recoveredErrors,
    missing,
    added,
    delta: {
      passed: next.passed - base.passed,
      failed: next.failed - base.failed,
      abstained: next.abstained - base.abstained,
      errors: next.errors - base.errors,
      meanScore: roundRatio(next.meanScore - base.meanScore),
    },
  };
}

/** 手写报告对象也照得跑:汇总缺失时就地重算,而不是抱一个 undefined 进去。 */
function reportSummary(report: EvalReport): EvalSummary {
  return report.summary ?? summarizeCases(report.cases ?? []);
}

function verdictLabel(result: CaseResult): string {
  if (result.error !== undefined) return "判定失败";
  if (result.ok) return "通过";
  return result.abstained ? "弃权" : "未过";
}

function cell(value: string | number | undefined | null): string {
  const text2 = value === undefined || value === null ? "" : String(value);
  return text2.replace(/\|/g, "\\|") || "-";
}

/** 报告渲染(X4-05):给人看的三段 —— 汇总、逐例、风险-覆盖率曲线。 */
export function renderReportMarkdown(report: EvalReport): string {
  const summary = reportSummary(report);
  const lines: string[] = [];
  lines.push(`# 评测报告 · ${cell(report.suite)}`);
  lines.push("");
  lines.push(`- provider: \`${cell(report.providerKey)}\``);
  lines.push(`- 开始: ${cell(new Date(Number(report.startedAt) || 0).toISOString())}`);
  lines.push(`- 用时: ${Number(report.durationMs) || 0} ms`);
  lines.push(
    `- 结果: 通过 ${summary.passed}/${summary.answered}(可判定) · 未过 ${summary.failed} · 判定失败 ${summary.errors} · 弃权 ${summary.abstained} · 平均分 ${summary.meanScore}`,
  );
  lines.push("");
  lines.push("## 逐条用例");
  lines.push("");
  if (!summary.total) {
    lines.push("本轮没有用例。");
    return lines.join("\n");
  }
  lines.push("| 用例 | 结果 | 得分 | 置信度 | 错误 |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const item of report.cases) {
    lines.push(
      `| ${cell(item.caseId)} | ${verdictLabel(item)} | ${clampRatio(item.score)} | ${
        item.confidence === undefined ? "-" : clampRatio(item.confidence)
      } | ${cell(item.error)} |`,
    );
  }
  const curve = riskCoverageCurve(report.cases);
  lines.push("");
  lines.push("## 风险-覆盖率曲线");
  lines.push("");
  if (!curve.length) {
    lines.push("没有可判定的用例,画不出曲线。");
    return lines.join("\n");
  }
  lines.push("只采纳置信度不低于阈值的结论时:");
  lines.push("");
  lines.push("| 阈值 | 覆盖率 | 错误率 |");
  lines.push("| --- | --- | --- |");
  for (const point of curve) {
    lines.push(`| ${point.threshold} | ${point.coverage} | ${point.errorRate} |`);
  }
  return lines.join("\n");
}

function specFieldNames(spec: StructuredSpec | undefined): string[] {
  if (!spec || !Array.isArray(spec.fields)) return [];
  return spec.fields.filter((field) => isPlainObject(field)).map((field) => text(field.name).trim());
}

function normalizeCase(rawCase: unknown, index: number, suiteSpec: StructuredSpec | undefined, suite: string): GoldenCase {
  if (!isPlainObject(rawCase)) throw new Error(`${suite}: 第 ${index + 1} 例不是对象`);
  const id = text(rawCase.id).trim();
  if (!id) throw new Error(`${suite}: 第 ${index + 1} 例缺 id`);
  const task = text(rawCase.task) as EvalTask;
  if (!EVAL_TASKS.includes(task)) {
    throw new Error(`${suite}/${id}: task 只能是 ${EVAL_TASKS.join(" / ")},实际是 "${text(rawCase.task)}"`);
  }
  if (rawCase.expected === undefined || rawCase.expected === null) {
    throw new Error(`${suite}/${id}: 没有 expected —— 没有期望值的用例无法判定,不能收进 golden`);
  }
  const spec = (isPlainObject(rawCase.spec) ? (rawCase.spec as unknown as StructuredSpec) : suiteSpec) ?? undefined;
  // expected 用扁平写法,`abstained` 是保留键;spec 里出现同名字段会让弃权清单和真字段撞车。
  if (specFieldNames(spec).includes(RESERVED_EXPECTED_FIELD)) {
    throw new Error(`${suite}/${id}: spec 字段名 "${RESERVED_EXPECTED_FIELD}" 与期望表保留键冲突`);
  }
  const tags: string[] = Array.isArray(rawCase.tags) ? rawCase.tags.map((tag) => text(tag)).filter((tag) => tag) : [];
  const testCase: GoldenCase = {
    id,
    task,
    user: text(rawCase.user),
    input: text(rawCase.input),
    expected: rawCase.expected as EvalExpected,
    tags,
  };
  if (spec) testCase.spec = spec;
  if (text(rawCase.note)) testCase.note = text(rawCase.note);
  return testCase;
}

/**
 * 收拢盘面上的 golden 文件(X4-06)。
 *
 * 校验放在加载时而不是跑起来之后:一个拼错的 `task` 或漏写的 `expected`,
 * 如果只表现为"这一例没通过",看报告的人会去改提示词,而真正坏的是用例本身。
 */
export function loadEvalSuite(input: unknown, fallbackSuite = "unnamed"): EvalSuiteFile {
  const root = isPlainObject(input) ? input : null;
  if (!root) throw new Error("评测集必须是一个对象");
  const suite = text(root.suite).trim() || fallbackSuite;
  if (!Array.isArray(root.cases)) throw new Error(`${suite}: 缺少 cases 数组`);
  const spec = isPlainObject(root.spec) ? (root.spec as unknown as StructuredSpec) : undefined;
  const cases = root.cases.map((item, index) => normalizeCase(item, index, spec, suite));

  const seen = new Set<string>();
  for (const testCase of cases) {
    if (seen.has(testCase.id)) throw new Error(`${suite}: 用例 id 重复 —— "${testCase.id}",报告按 id 对照,重复会覆盖掉一条`);
    seen.add(testCase.id);
  }

  const loaded: EvalSuiteFile = { suite, cases };
  if (text(root.system).trim()) loaded.system = text(root.system).trim();
  if (spec) loaded.spec = spec;
  return loaded;
}
