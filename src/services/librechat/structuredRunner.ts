/**
 * 结构化抽取的编排层(X2-07 / X3-06)——纯编排,不碰传输。
 *
 * `invoke` 由调用方注入:
 *  - 生产:`libreChatService` 用真实 provider 通路绑一个进来;
 *  - 单测:塞一个假函数,把「一次过 / 修一次过 / 修不好 / 空输出 / 多票不一致」全部钉住;
 *  - 评测(X4):同一份 runner 配不同 prompt/model,就是回归用例。
 * 这一层的价值恰在于**它不需要网络也能被完整验证**。
 */

import { coverageOf, structuredConsensus, type FieldConsensus } from "./consensus";
import {
  buildRepairPrompt,
  buildStructuredSystemPrompt,
  formatStructuredIssues,
  parseAndValidate,
  validateStructuredPayload,
  extractJsonObject,
  type StructuredIssue,
  type StructuredNote,
  type StructuredSpec,
} from "./structured";
import type { ChatContentPart, WireChatContent } from "./wire";

export type StructuredErrorCode =
  | "INVALID_INPUT"
  | "EMPTY_OUTPUT"
  | "PARSE_FAILED"
  | "SCHEMA_FAILED"
  | "NO_CONSENSUS"
  | "INVOCATION_FAILED";

export interface StructuredInvokeTurn {
  system: string;
  messages: { role: "user" | "assistant"; content: WireChatContent }[];
  responseFormat?: "json";
  /** 第几票(从 0 起),便于注入方按票选不同 provider。 */
  vote: number;
  /** 第几轮修复(0 = 首次)。 */
  repair: number;
}

export type StructuredInvoke = (turn: StructuredInvokeTurn) => Promise<string>;

export interface StructuredExtractionSuccess {
  ok: true;
  value: Record<string, unknown>;
  raw: string;
  /** 用了多少轮修复(0 = 一次过)。 */
  repairs: number;
  notes: StructuredNote[];
  droppedKeys: string[];
}

export interface StructuredExtractionFailure {
  ok: false;
  code: StructuredErrorCode;
  message: string;
  issues: StructuredIssue[];
  notes: StructuredNote[];
  raw?: string;
  repairs: number;
}

export type StructuredExtractionOutcome = StructuredExtractionSuccess | StructuredExtractionFailure;

export const STRUCTURED_DEFAULT_MAX_REPAIR_TURNS = 1;
export const STRUCTURED_MAX_REPAIR_TURNS = 2;
export const STRUCTURED_DEFAULT_VOTES = 3;
export const STRUCTURED_MAX_VOTES = 5;

function userContentToText(content: WireChatContent): string {
  if (typeof content === "string") return content.trim();
  return (content as ChatContentPart[])
    .filter((part): part is { type: "text"; text: string } => part?.type === "text")
    .map((part) => String(part.text ?? "").trim())
    .filter((text) => text)
    .join("\n")
    .trim();
}

function repairTurns(value: unknown): number {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw < 0) return STRUCTURED_DEFAULT_MAX_REPAIR_TURNS;
  return Math.min(STRUCTURED_MAX_REPAIR_TURNS, Math.trunc(raw));
}

export interface RunStructuredInput {
  invoke: StructuredInvoke;
  spec: StructuredSpec;
  /** 用户可见的任务描述(不含输出格式要求,那由 spec 生成)。 */
  user: WireChatContent;
  /** 基础系统提示;会被追加 JSON 契约段。 */
  system?: string;
  maxRepairTurns?: number;
  /** 默认要求上游 JSON 模式;provider 不支持时上游会忽略该键,解析层仍然兜得住。 */
  responseFormat?: "json" | "text";
  onAttempt?: (info: { repair: number; raw: string; ok: boolean; issues: StructuredIssue[] }) => void;
}

/** 单次抽取(可含一次修复轮)。失败一定带 code,绝不返回"看起来像成功"的空对象。 */
export async function runStructuredExtraction(input: RunStructuredInput): Promise<StructuredExtractionOutcome> {
  const system = buildStructuredSystemPrompt(String(input.system || "你是信息抽取助手,只按要求输出 JSON。"), input.spec);
  const user = input.user;
  const userText = userContentToText(user);
  // 只有空白也算“没内容”:不然会为一句空话付一次上游调用(以及一个没人看的回答)。
  // 纯图片件仍然是有效输入 —— 能不能识图由服务层 fail-closed 判定(X1-06)。
  if (!userText && !(Array.isArray(user) && user.some((part) => part?.type === "image"))) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: "没有要处理的内容",
      issues: [],
      notes: [],
      repairs: 0,
    };
  }

  const maxRepairs = repairTurns(input.maxRepairTurns);
  const wantsJson = input.responseFormat !== "text";
  const messages: { role: "user" | "assistant"; content: WireChatContent }[] = [{ role: "user", content: user }];

  let repairs = 0;
  let lastIssues: StructuredIssue[] = [];
  let lastNotes: StructuredNote[] = [];
  let lastRaw = "";

  // 总轮次 = 1 次首发 + maxRepairs 次修复;循环条件用 attempts 计数,避免修复轮变成死循环。
  for (let attempt = 0; attempt <= maxRepairs; attempt += 1) {
    let raw = "";
    try {
      raw = await Promise.resolve(
        input.invoke({ system, messages, vote: 0, repair: attempt, ...(wantsJson ? { responseFormat: "json" as const } : {}) }),
      );
    } catch {
      // 注入方抛错 = 这一路没拿到内容;交由上层(投票/服务)按失败语义处理。
      return {
        ok: false,
        code: "INVOCATION_FAILED",
        message: "AI 服务调用失败",
        issues: lastIssues,
        notes: lastNotes,
        raw: lastRaw || undefined,
        repairs,
      };
    }
    lastRaw = typeof raw === "string" ? raw : "";

    const extracted = extractJsonObject(lastRaw);
    const validation = extracted.ok
      ? validateStructuredPayload(extracted.json, input.spec)
      : { ok: false, value: undefined, issues: [{ code: extracted.code, message: extracted.message } as StructuredIssue], notes: [] as StructuredNote[], droppedKeys: [] };

    input.onAttempt?.({ repair: attempt, raw: lastRaw, ok: validation.ok, issues: validation.issues });

    if (!lastRaw.trim()) {
      lastIssues = [{ code: "EMPTY_OUTPUT", message: "没有收到内容" }];
    } else if (validation.ok && validation.value) {
      return { ok: true, value: validation.value, raw: lastRaw, repairs, notes: validation.notes, droppedKeys: validation.droppedKeys };
    } else {
      lastIssues = validation.issues.length
        ? validation.issues
        : [{ code: "PARSE_FAILED", field: undefined, message: "无法解析成要求的结构" }];
      lastNotes = validation.notes;
    }

    if (attempt < maxRepairs) {
      repairs += 1;
      messages.push({ role: "assistant", content: lastRaw });
      messages.push({ role: "user", content: buildRepairPrompt(lastIssues, input.spec, lastRaw) });
    }
  }

  const code: StructuredErrorCode = !lastRaw.trim()
    ? "EMPTY_OUTPUT"
    : lastIssues.some((issue) => issue.code === "NO_JSON" || issue.code === "INVALID_JSON" || issue.code === "UNBALANCED_JSON" || issue.code === "NOT_AN_OBJECT")
      ? "PARSE_FAILED"
      : "SCHEMA_FAILED";
  return {
    ok: false,
    code,
    message: formatStructuredIssues(lastIssues).join("\n") || "输出不符合要求的结构",
    issues: lastIssues,
    notes: lastNotes,
    raw: lastRaw || undefined,
    repairs,
  };
}

export interface RunStructuredQuorumInput extends Omit<RunStructuredInput, "maxRepairTurns"> {
  /** 票数(默认 3,上限 5)。 */
  votes?: number;
  /** 字段采纳所需最少票数(默认 2)。 */
  minVotes?: number;
  threshold?: number;
  maxRepairTurns?: number;
  onVote?: (info: { vote: number; outcome: StructuredExtractionOutcome }) => void;
}

export interface QuorumSuccess {
  ok: true;
  value: Record<string, unknown>;
  consensus: FieldConsensus;
  /** 达成共识字段数 / 清单字段数(X4 的覆盖率横轴)。 */
  coverage: number;
  votes: { total: number; succeeded: number; failed: number };
}

export interface QuorumFailure {
  ok: false;
  code: StructuredErrorCode;
  message: string;
  consensus?: FieldConsensus;
  coverage: number;
  votes: { total: number; succeeded: number; failed: number };
  issues: StructuredIssue[];
}

export type StructuredQuorumOutcome = QuorumSuccess | QuorumFailure;

/**
 * 多票表决(X3-06)。
 *
 * 单票失败不影响其它票;成功票不足 `minVotes` 时直接判 `INVOCATION_FAILED`
 * (那是"没问到",不是"没谈拢"),够了但一个字段的多数都凑不出来才判 `NO_CONSENSUS`。
 * 这两种情况对使用者的意义完全不同,不能合并成一个"失败"。
 */
export async function runStructuredQuorum(input: RunStructuredQuorumInput): Promise<StructuredQuorumOutcome> {
  const totalVotes = Math.min(STRUCTURED_MAX_VOTES, Math.max(1, Math.trunc(Number(input.votes) || STRUCTURED_DEFAULT_VOTES)));
  // 注:不预先 buildStructuredSystemPrompt —— runStructuredExtraction 负把 base 拼上 JSON 契约,
  // 在这里预先拼一次会得到两份契约。
  const wantsJson = input.responseFormat !== "text";
  const minVotes = Math.max(1, Math.trunc(Number(input.minVotes) || 2));

  const payloads: Record<string, unknown>[] = [];
  const issues: StructuredIssue[] = [];
  let failed = 0;

  for (let vote = 0; vote < totalVotes; vote += 1) {
    const outcome = await runStructuredExtraction({
      ...input,
      invoke: async (turn) => input.invoke({ ...turn, vote }),
      maxRepairTurns: input.maxRepairTurns ?? 0,
      ...(wantsJson ? { responseFormat: "json" as const } : { responseFormat: "text" as const }),
    });
    input.onVote?.({ vote, outcome });
    if (outcome.ok) payloads.push(outcome.value);
    else {
      failed += 1;
      issues.push(...outcome.issues);
    }
  }

  const succeeded = payloads.length;
  if (succeeded < minVotes) {
    return {
      ok: false,
      code: "INVOCATION_FAILED",
      message: `可用的票数不足(${succeeded}/${totalVotes}),无法给出结论`,
      coverage: 0,
      votes: { total: totalVotes, succeeded, failed },
      issues,
    };
  }

  const consensus = structuredConsensus(payloads, input.spec, { minVotes, threshold: input.threshold });
  const kept = Object.keys(consensus.value).length;
  if (!kept) {
    return {
      ok: false,
      code: "NO_CONSENSUS",
      message: `${succeeded} 份结果没有一处一致,已放弃给出结论`,
      consensus,
      coverage: 0,
      votes: { total: totalVotes, succeeded, failed },
      issues,
    };
  }

  return {
    ok: true,
    value: consensus.value,
    consensus,
    coverage: coverageOf(consensus, input.spec),
    votes: { total: totalVotes, succeeded, failed },
  };
}

/** 便于服务层复用:只做解析,不发起调用(给已有会话通路加结构化出口)。 */
export function parseStructuredText(raw: string, spec: StructuredSpec) {
  return parseAndValidate(raw, spec);
}
