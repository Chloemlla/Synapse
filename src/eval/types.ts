/**
 * X4 提示词/模型回归评测台的数据形状(X4-01)。
 *
 * 这里**只有类型,没有运行时耦合**,因为同一批 golden 用例要被两种裁判消费:
 *  - 主 CI:注入假 `invoke` —— 必须离线、必须可断言,所以不能碰 express/mongoose/axios,
 *    也不能碰 `libreChatService`(它一加载就要连库);
 *  - nightly:注入真 provider —— 关心的是覆盖率与弃权行为,不是"模型答得对不对"。
 * 一旦这个文件掺进任何服务耦合,"离线跑同一份用例" 就断了,评测台也就退化成一个只能手跑的脚本。
 */

import type { StructuredSpec } from "../services/librechat/structured";

/**
 * 判定口径。
 *  - `structured` / `abstain`:输出应是 JSON 对象,逐字段比对(`abstain` 只是"期望值=弃权"的结构化例);
 *  - `exact`:整段答案与期望值等价(走 X3-04 的归一化);
 *  - `label`:单选标签,归一化后必须严格相等。
 */
export type EvalTask = "structured" | "abstain" | "exact" | "label";

/** 结构化例的期望:`{ 字段: 值, abstained: ["字段"] }`。 */
export interface EvalExpectedFields {
  [field: string]: unknown;
}

/**
 * 标量例的期望写成字符串/数字/布尔;对象例写成扁平字段表。
 *
 * `abstained` 是**保留键**:它列的是"原文没有依据、模型必须不给值"的字段。
 * 之所以用保留键而不是另开一层,是因为 golden 要能用手写 JSON 一眼读完;
 * `loadEvalSuite` 会拒绝 spec 里出现同名字段,免得这个约定变成静默陷阱。
 */
export type EvalExpected = string | number | boolean | EvalExpectedFields;

export interface GoldenCase {
  id: string;
  task: EvalTask;
  /** 字段清单;标量例可省略。缺省时评分只按 `expected` 里出现的字段做判定。 */
  spec?: StructuredSpec;
  /** 给人的指令(会被拼进系统提示之外的用户轮)。 */
  user: string;
  /** 待处理的材料(通知原文之类)。 */
  input: string;
  expected: EvalExpected;
  tags: readonly string[];
  /** 为什么有这一例 —— 回退时最先要看的就是这句。 */
  note?: string;
}

/** 模型侧可读到的原始输出:文本(未解析)或已解析对象(live 通路直接给值)。 */
export type EvalRaw = string | Record<string, unknown> | null | undefined;

/** 记进报告的实际值:结构化例是字段表,标量例是归一后的文本。 */
export type EvalActual = Record<string, unknown> | string | null;

export interface EvalInvokeContext {
  testCase: GoldenCase;
  providerKey: string;
  /** 第几次尝试(0 起);`retries` 为 0 时永远是 0。 */
  attempt: number;
}

export type EvalInvoke = (context: EvalInvokeContext) => Promise<EvalRaw> | EvalRaw;

/** 单例判定结果 —— `scorer` 的返回值,比 `CaseResult` 少 `caseId`,便于复用。 */
export interface CaseScore {
  score: number;
  ok: boolean;
  abstained: boolean;
  actual: EvalActual;
  /** 0..1;缺省时由得分推导(live 用多票一致率覆盖它)。 */
  confidence?: number;
  /** 稳定 code(不写自由文本):`INVOCATION_FAILED` / `EMPTY_OUTPUT` / `PARSE_FAILED` … */
  error?: string;
}

export type EvalScorer = (testCase: GoldenCase, raw: EvalRaw) => CaseScore;

/** 时钟可注入,否则 `durationMs` 没法在单测里钉住。 */
export interface EvalClock {
  now(): number;
}

export interface CaseResult {
  caseId: string;
  /** 与 golden 完全一致才为真 —— 部分命中不算通过。 */
  ok: boolean;
  /** 命中字段 / 期望字段,0..1。 */
  score: number;
  /** 模型是否显式不给值(行为计数,与 `ok` 不互斥:该弃权的例弃权了就是 `ok:true`)。 */
  abstained: boolean;
  /** 有值 = 这一例没能判定(调用失败/空输出/读不出对象),计入 `summary.errors` 而不是 `failed`。 */
  error?: string;
  actual?: EvalActual;
  confidence?: number;
}

export interface EvalSummary {
  total: number;
  passed: number;
  /** 有可读输出但不全对的例数(含"该给值却弃权"的例)。 */
  failed: number;
  /** 显式弃权的例数;与 `passed`/`failed` 可重叠,它回答的是"模型有多敢弃权"。 */
  abstained: number;
  errors: number;
  /** 可判定的例数 = total - errors。 */
  answered: number;
  /** 只在 answered 上求平均:调用失败是通路问题,不该污染"准不准"。 */
  meanScore: number;
  passRate: number;
  /** answered 里不正确的比例,与 `passRate` 互补。 */
  errorRate: number;
  /** abstained / answered。 */
  abstainRate: number;
}

/**
 * 风险-覆盖率曲线上的一个采样点(X4-03)。
 *
 * 横轴是覆盖率:阈值越低 → 敢用的例越多 → 覆盖率越高。
 */
export interface RiskCoveragePoint {
  /** 置信度下界。 */
  threshold: number;
  /** 被采纳的例 / 可判定的例。 */
  coverage: number;
  /** 采纳集里不正确的比例;已按前缀最大值收敛,见 `riskCoverageCurve`。 */
  errorRate: number;
  /** 该点的实测错误率(未收敛),用来核对 `errorRate` 有没有被人为抬高。 */
  observedErrorRate: number;
  accepted: number;
  scored: number;
}

export interface EvalReport {
  suite: string;
  /** 评测用的 provider 标识(`model@host`,永不含凭据)。 */
  providerKey: string;
  /** epoch 毫秒(来自注入的 clock,便于断言)。 */
  startedAt: number;
  durationMs: number;
  cases: CaseResult[];
  summary: EvalSummary;
}

/** golden 集文件的落盘形状(X4-06)。 */
export interface EvalSuiteFile {
  suite: string;
  /** 套件级基础提示,会被拼在 X2-05 的 JSON 契约之前。 */
  system?: string;
  /** 套件级字段清单,用例没写 `spec` 时套用它。 */
  spec?: StructuredSpec;
  cases: GoldenCase[];
}
