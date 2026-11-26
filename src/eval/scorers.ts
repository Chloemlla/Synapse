/**
 * X4 的评分器(X4-02 / X4-03)——全部是纯函数。
 *
 * 为什么要把评分单独一层:提示词回归的失败模式不是"红了",而是**看起来还在跑**。
 * 一个模型把"没提到的字段"编出来了,整份输出依然合法、依然能被下游消费,只有拿
 * golden 逐字段比才看得见。所以这里把三件事钉死:
 *  ① 比对口径复用 X3-04 的 `normalizeForAgreement` —— 评测说"对"必须和线上表决说"一致"
 *     是同一件事,否则评测绿灯而生产分票,曲线就毫无意义;
 *  ② **弃权是显式状态**,不是空值:`isAbstain()` 认"缺键 / null / 空串 / 「未知」类措辞";
 *  ③ 判定用的是**校验后的载荷**(`validateStructuredPayload`),即生产真正会拿到的东西,
 *     而不是模型裸输出。
 */

import { normalizeForAgreement } from "../services/librechat/consensus";
import { extractJsonObject, validateStructuredPayload, type StructuredSpec } from "../services/librechat/structured";
import type { CaseResult, EvalRaw, RiskCoveragePoint } from "./types";

/** 浮点比较容差:阈值来自除法与四舍五入,严格 `>=` 会在 0.3 这种值上抖。 */
const RATIO_EPSILON = 1e-9;

/**
 * 期望表里的保留键:列在 `expected.abstained` 里的字段是"原文没有依据、必须不给值"。
 * golden 用扁平写法(字段即键),所以要有一个不可能当字段名的键 —— 冲突由 `loadEvalSuite` 拒掉。
 */
export const RESERVED_EXPECTED_FIELD = "abstained";

/**
 * 被视为"没给答案"的写法。
 *
 * 这份清单是**行为约定**而不是枚举装饰:模型被要求"不确定就省略该键"(X2-05)时,
 * 现实里最常见的违抗形式就是把「未知」原样填进字段。把它算作弃权,测的是"模型诚实吗";
 * 把它算作一个普通错值,就会把诚实的模型按错误扣分,下次改提示词就没人敢留出口了。
 */
export const ABSTAIN_TOKENS: readonly string[] = [
  "",
  "null",
  "undefined",
  "nan",
  "none",
  "nil",
  "n/a",
  "na",
  "-",
  "--",
  "—",
  "?",
  "unknown",
  "不确定",
  "未知",
  "不详",
  "无法确定",
  "无法判断",
  "未提供",
  "未提及",
  "没提到",
  "没有提到",
  "原文未提",
  "略",
];

export function roundRatio(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10000) / 10000;
}

export function clampRatio(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.min(1, Math.max(0, num));
}

function canonicalText(value: unknown): string {
  return String(value).normalize("NFKC").replace(/\s+/g, " ").trim();
}

/**
 * 这一例的值算不算"弃权"(X4-02)。
 *
 * `0` 与 `false` **不是**弃权:它们是答案。把零值当空,会让"是否必交"这类布尔字段
 * 的正确答案永远测不出来。
 */
export function isAbstain(value: unknown, extraTokens?: readonly string[]): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") {
    const normalized = canonicalText(value).toLowerCase();
    if (!normalized) return true;
    if (ABSTAIN_TOKENS.includes(normalized)) return true;
    if (!extraTokens) return false;
    return extraTokens.some((token) => canonicalText(token).toLowerCase() === normalized);
  }
  if (typeof value === "number") return !Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isAbstain(item, extraTokens));
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length === 0;
  return false;
}

/** 整份答案级别的等价判定:与线上"同票"完全同一套归一化。 */
export function scoreExact(expected: unknown, actual: unknown): number {
  if (isAbstain(expected) && isAbstain(actual)) return 1;
  if (isAbstain(expected) || isAbstain(actual)) return 0;
  return normalizeForAgreement(expected) === normalizeForAgreement(actual) ? 1 : 0;
}

const LABEL_HEAD_TRIM = /^["'“”‘’『「【《(\[]+/;
const LABEL_TAIL_TRIM = /["'“”‘’『」】》)\].。,，;；:：!?！？]+$/;

/** 标签归一:折叠空白、去包裹符号、大小写无关、`"3.0"` 视作 `3`。 */
export function canonicalLabel(value: unknown): string {
  if (value === undefined || value === null) return "";
  const raw = Array.isArray(value) ? value.map((item) => String(item)).join("、") : String(value);
  let text = canonicalText(raw).toLowerCase();
  if (!text) return "";
  text = text.replace(LABEL_HEAD_TRIM, "").replace(LABEL_TAIL_TRIM, "").trim();
  if (/^-?\d+(\.\d+)?$/.test(text)) return String(Number(text));
  return text;
}

/**
 * 单选标签判定。
 *
 * 刻意**不做包含匹配**:「部分提交」与「部分提交不了」互为子串却是两个答案,
 * 模糊匹配会把枚举跑偏测成对。需要宽松一点的地方应该由 `canonicalLabel` 的归一化承担。
 */
export function scoreLabel(expected: unknown, actual: unknown): number {
  const want = canonicalLabel(expected);
  const got = canonicalLabel(actual);
  if (!want || !got) return 0;
  return want === got ? 1 : 0;
}

export interface ResolvedExpected {
  /** 需要给出正确值的字段。 */
  fields: Record<string, unknown>;
  /** 原文没有依据、必须弃权的字段。 */
  abstained: string[];
}

/** 展开扁平期望表:`{ subject:"…", abstained:["dueAt"] }`。期望值本身是空值也算弃权。 */
export function resolveExpected(expected: unknown): ResolvedExpected {
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) return { fields: {}, abstained: [] };
  const record = expected as Record<string, unknown>;
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === RESERVED_EXPECTED_FIELD) continue;
    fields[key] = value;
  }
  const rawList = record[RESERVED_EXPECTED_FIELD];
  const abstained: string[] = Array.isArray(rawList) ? rawList.map((item) => canonicalText(item)).filter((item) => item) : [];
  return { fields, abstained };
}

/** 把模型侧输出还原成"未校验的 JSON 对象";读不出来就返回 null(由调用方定性为错误)。 */
export function rawToObject(raw: EvalRaw): Record<string, unknown> | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw.trim()) return null;
  const extracted = extractJsonObject(raw);
  if (!extracted.ok) return null;
  const json = extracted.json;
  return json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : null;
}

export function rawToText(raw: EvalRaw): string {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") return canonicalText(JSON.stringify(raw));
  return "";
}

export type FieldVerdictStatus = "correct" | "wrong" | "abstained";

export interface FieldVerdict {
  field: string;
  status: FieldVerdictStatus;
  expected: unknown;
  actual: unknown;
}

export interface StructuredScore {
  score: number;
  ok: boolean;
  abstained: boolean;
  /** 校验后的载荷(白名单 + 类型纠正),即生产会拿到的值。 */
  actual: Record<string, unknown> | null;
  fields: FieldVerdict[];
  /** 读不出对象 / 期望表为空时的稳定 code。 */
  error?: string;
}

/**
 * 逐字段比对(X4-02)。
 *
 * 三种状态必须分开数,因为它们要修的是不同的东西:
 *  - `wrong`:模型给了值但不对 → 提示词或字段描述要改;
 *  - `abstained`:该给的没给 → 覆盖率问题,可能是能力不足也可能是提示词过于保守;
 *  - `error`:连对象都读不出来 → 解析/通道问题,记进 `summary.errors`,不污染准确率。
 * 整例 `ok` 要求"零 wrong 且零漏答":部分命中在评测里不是通过,否则"12 例里有 3 例半对"
 * 会在报告里伪装成全绿。
 */
export function scoreStructured(spec: StructuredSpec | undefined, expected: unknown, raw: EvalRaw): StructuredScore {
  const { fields: expectedFields, abstained: explicitAbstain } = resolveExpected(expected);
  const names: string[] = [];
  for (const name of Object.keys(expectedFields)) if (!names.includes(name)) names.push(name);
  for (const name of explicitAbstain) if (!names.includes(name)) names.push(name);

  const json = rawToObject(raw);
  if (!json) {
    return { score: 0, ok: false, abstained: false, actual: null, fields: [], error: "PARSE_FAILED" };
  }
  if (!names.length) {
    // golden 没写期望字段 = 用例本身坏了,静默给 1 分等于把这套评测变成自我安慰。
    return { score: 0, ok: false, abstained: false, actual: json, fields: [], error: "EMPTY_EXPECTED" };
  }

  // 走一遍生产同款校验:未知键被丢弃、"3.0" 归成 3、布尔措辞归一。
  const projection = spec ? (validateStructuredPayload(json, spec).value as Record<string, unknown>) : json;

  const fields: FieldVerdict[] = [];
  let correct = 0;
  let wrong = 0;
  let missed = 0;
  let honored = 0;
  for (const name of names) {
    const wantAbstain = explicitAbstain.includes(name) || isAbstain(expectedFields[name]);
    const present = Object.prototype.hasOwnProperty.call(json, name);
    const rawValue = json[name];
    const gaveUp = !present || isAbstain(rawValue);

    if (wantAbstain) {
      // 该弃权的字段填了值 = 编造,这是整套评测最不能放过的一档。
      if (gaveUp) {
        correct += 1;
        honored += 1;
        fields.push({ field: name, status: "correct", expected: undefined, actual: undefined });
      } else {
        wrong += 1;
        fields.push({ field: name, status: "wrong", expected: undefined, actual: rawValue });
      }
      continue;
    }
    if (gaveUp) {
      missed += 1;
      fields.push({ field: name, status: "abstained", expected: expectedFields[name], actual: undefined });
      continue;
    }
    const value = projection[name] !== undefined ? projection[name] : rawValue;
    if (scoreExact(expectedFields[name], value) === 1) {
      correct += 1;
      fields.push({ field: name, status: "correct", expected: expectedFields[name], actual: value });
    } else {
      wrong += 1;
      fields.push({ field: name, status: "wrong", expected: expectedFields[name], actual: value });
    }
  }

  return {
    score: roundRatio(correct / names.length),
    ok: wrong === 0 && missed === 0,
    // 行为计数:只要有一个 golden 关心的字段没给值(无论是该答没答,还是正确地没乱答)就算弃权。
    // 它与 `ok` 不互斥 —— 否则报告里永远算不出"这版提示词有多敢弃权"。
    abstained: missed > 0 || honored > 0,
    actual: projection,
    fields,
  };
}

/**
 * 风险-覆盖率曲线(X4-03)。
 *
 * 逐字段弃权的价值就体现在这条曲线上:“只信高置信度的答案”能把错误率压到多低、
 * 代价是多少覆盖率。两个关键做法:
 *  1. **分母是“可判定的例”**(排掉 `error`):调用失败是可用率问题,混进来会让曲线把
 *     “服务挂了”误读成“置信度阈值选得好”;
 *  2. 报出的 `errorRate` 取**前缀最大值**:多采纳低置信度的样本不可能凭空把错误率变得更好,
 *     实测出现回落只说明“低置信度那一挡样本凑巧简单”——把它当成改善就是在给报表编数据。
 *     所以 `errorRate` 保证单调不降,同时把未收敛的 `observedErrorRate` 一并交出去。
 * 未给 `confidence` 的例按 0 处理:不知道多可信 = 最不可信,而不是白送一个采纳。
 */
export function riskCoverageCurve(results: readonly CaseResult[]): RiskCoveragePoint[] {
  const scored = results.filter((item): item is CaseResult => Boolean(item) && item.error === undefined);
  if (!scored.length) return [];

  const points = scored.map((item) => ({ confidence: clampRatio(item.confidence), wrong: item.ok !== true }));
  const thresholds = Array.from(new Set(points.map((item) => item.confidence))).sort((a, b) => b - a);

  const curve: RiskCoveragePoint[] = [];
  let worst = 0;
  for (const threshold of thresholds) {
    const accepted = points.filter((item) => item.confidence >= threshold - RATIO_EPSILON);
    const wrong = accepted.filter((item) => item.wrong).length;
    const observed = accepted.length ? wrong / accepted.length : 0;
    worst = Math.max(worst, observed);
    curve.push({
      threshold: roundRatio(threshold),
      coverage: roundRatio(accepted.length / scored.length),
      errorRate: roundRatio(worst),
      observedErrorRate: roundRatio(observed),
      accepted: accepted.length,
      scored: scored.length,
    });
  }
  return curve;
}
