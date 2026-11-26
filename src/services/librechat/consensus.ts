/**
 * 多份输出的一致性判定(X3-04 / X3-05)——纯函数层。
 *
 * 目的不是"让模型更聪明",而是**给系统一个可测量的置信度**:同一件事问 N 个 provider,
 * 一致的字段才敢用,不一致的字段直接弃权。这样下游(H1 核查、H4 出题)才有
 * "覆盖率 vs 错误率"这条曲线可画 —— 弃权必须是显式结果,不是隐藏的空值。
 */

import { fieldNames, type StructuredSpec } from "./structured";

export interface AgreementOptions {
  /** 数组是否排序后再比(默认 false:顺序本身是信息)。 */
  sortArrays?: boolean;
  /** 字符串是否忽略大小写比较(默认 true)。 */
  ignoreCase?: boolean;
  /** 数字归一精度位数,默认 6。 */
  numberDigits?: number;
}

function normalizeNumber(value: number, digits: number): string {
  if (!Number.isFinite(value)) return "null";
  if (Number.isInteger(value)) return String(value);
  return String(Number(value.toFixed(digits)));
}

/**
 * 把任意值压成"可比较的规范串"(X3-04)。
 *
 * `3` / `3.0` / `"3.0"` 必须同票,`" 是 "` 与 `"是"` 必须同票,对象键顺序不得影响结果 ——
 * 否则一致性分数测的是"模型排版习惯",不是"模型判断是否一致"。
 */
export function normalizeForAgreement(value: unknown, options: AgreementOptions = {}): string {
  const digits = Number.isFinite(Number(options.numberDigits)) ? Math.trunc(Number(options.numberDigits)) : 6;
  const ignoreCase = options.ignoreCase !== false;

  const walk = (input: unknown): unknown => {
    if (input === null || input === undefined) return null;
    if (typeof input === "number") return normalizeNumber(input, digits);
    if (typeof input === "boolean") return input;
    if (typeof input === "string") {
      const collapsed = input.normalize("NFKC").replace(/\s+/g, " ").trim();
      return ignoreCase ? collapsed.toLowerCase() : collapsed;
    }
    if (Array.isArray(input)) {
      const mapped = input.map(walk);
      if (options.sortArrays) {
        mapped.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
      }
      return mapped;
    }
    if (typeof input === "object") {
      const record = input as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) out[key] = walk(record[key]);
      return out;
    }
    return String(input);
  };

  return JSON.stringify(walk(value)) ?? "null";
}

export interface AgreementGroup {
  key: string;
  votes: number;
  /** 该组里第一次出现的**原始**值(返回给调用方的永远是原值,不是规范串)。 */
  value: unknown;
}

export interface AgreementReport {
  groups: AgreementGroup[];
  /** 最大票组;完全平票时为 null(不硬挑一个)。 */
  majority: AgreementGroup | null;
  total: number;
  /** majority.votes / total;total 为 0 时得 0。 */
  score: number;
  /** 最大票组是否与第二票组同分(平票 = 没共识,不能算通过)。 */
  tied: boolean;
}

export function agreementOf(values: readonly unknown[], options: AgreementOptions = {}): AgreementReport {
  const groups: AgreementGroup[] = [];
  const index = new Map<string, AgreementGroup>();
  let total = 0;
  for (const value of values) {
    if (value === undefined) continue;
    total += 1;
    const key = normalizeForAgreement(value, options);
    const existing = index.get(key);
    if (existing) existing.votes += 1;
    else {
      const group = { key, votes: 1, value };
      index.set(key, group);
      groups.push(group);
    }
  }
  groups.sort((a, b) => b.votes - a.votes || (a.key < b.key ? -1 : 1));
  const top = groups[0];
  const second = groups[1];
  const tied = Boolean(top && second && top.votes === second.votes);
  return {
    groups,
    majority: tied || !top ? null : top,
    total,
    score: total && top ? top.votes / total : 0,
    tied,
  };
}

export interface ConsensusOptions extends AgreementOptions {
  /** 至少多少票才采纳(默认 2)。 */
  minVotes?: number;
  /** 至少占多少比例才采纳(默认 0.5,即简单多数)。 */
  threshold?: number;
}

export interface FieldConsensus {
  /** 达成共识的字段值(原样,未规范)。 */
  value: Record<string, unknown>;
  /** 每个字段的 采纳票/总票;未采纳的字段也在这里,便于报告。 */
  fieldAgreement: Record<string, number>;
  /** 被弃权的字段名(X3-05 的核心输出:不是"没抽到",是"没谈拢")。 */
  dropped: string[];
  /** 每个字段实际参与投票的份数(有些份数里没有该键)。 */
  fieldVotes: Record<string, number>;
  total: number;
}

/**
 * 逐字段多数表决(X3-05)。
 *
 * 为什么逐字段而不是整份:整份表决下,一个字段跑偏会把**已经一致**的结论一起丢掉;
 * 逐字段才能把"覆盖率"这个量单独测出来 —— 它是 risk-coverage 曲线的横轴。
 * 平票、票数不足、份数不足一律弃权,绝不"挑第一个"。
 */
export function structuredConsensus(
  payloads: readonly (Record<string, unknown> | null | undefined)[],
  spec: StructuredSpec,
  options: ConsensusOptions = {},
): FieldConsensus {
  const clean = payloads.filter((payload): payload is Record<string, unknown> => Boolean(payload && typeof payload === "object" && !Array.isArray(payload)));
  const minVotes = Number.isFinite(Number(options.minVotes)) ? Math.max(1, Math.trunc(Number(options.minVotes))) : 2;
  const threshold = Number.isFinite(Number(options.threshold)) ? Number(options.threshold) : 0.5;

  const value: Record<string, unknown> = {};
  const fieldAgreement: Record<string, number> = {};
  const fieldVotes: Record<string, number> = {};
  const dropped: string[] = [];

  for (const name of fieldNames(spec)) {
    const observed = clean.map((payload) => payload[name]).filter((item) => item !== undefined);
    fieldVotes[name] = observed.length;
    if (!observed.length) {
      fieldAgreement[name] = 0;
      dropped.push(name);
      continue;
    }
    const report = agreementOf(observed, options);
    const votes = report.majority?.votes ?? 0;
    fieldAgreement[name] = observed.length ? Number((report.score || 0).toFixed(4)) : 0;
    const accepted = !report.tied && votes >= minVotes && votes / observed.length >= threshold;
    if (accepted) value[name] = report.majority!.value;
    else dropped.push(name);
  }

  return { value, fieldAgreement, dropped, fieldVotes, total: clean.length };
}

/** 达成共识字段数 / 清单字段数;清单为空时记 0(而不是 NaN)。 */
export function coverageOf(consensus: Pick<FieldConsensus, "value">, spec: StructuredSpec): number {
  const names = fieldNames(spec);
  if (!names.length) return 0;
  const kept = names.filter((name) => consensus.value?.[name] !== undefined).length;
  return Number((kept / names.length).toFixed(4));
}
