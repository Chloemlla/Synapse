import type { AiErrorDetails, AiFailureReason, AiProviderFailure } from "../types/aiDiagnostics";

/**
 * 合法原因码 + 面向管理员的一句话。
 *
 * 为什么不止是一份字面量列表:`Record<AiFailureReason, string>` 缺一个键就编译错,
 * 而旧的 `reason !== "a" && reason !== "b"` 守卫在后端新增原因时**静默把诊断丢掉**
 * —— 用户只看得到“没回答”,管端也查不到原因。
 */
const AI_FAILURE_REASON_LABELS: Record<AiFailureReason, string> = {
  no_provider_configured: "没有可用的对话服务配置",
  all_providers_failed: "所有对话服务调用都失败了",
  vision_unavailable: "没有支持识图的模型，带图请求被直接拦下",
  content_rejected: "图片不合格（外链、格式不支持或太大），未发起调用",
};
const KNOWN_AI_FAILURE_REASONS: ReadonlySet<string> = new Set(Object.keys(AI_FAILURE_REASON_LABELS));

/** 原因码的人话说明;未知码回落到码本身（诊断面不能编造解释,但也不能空着）。 */
export function describeAiFailureReason(reason: unknown): string {
  if (typeof reason === "string" && KNOWN_AI_FAILURE_REASONS.has(reason)) {
    return AI_FAILURE_REASON_LABELS[reason as AiFailureReason];
  }
  return typeof reason === "string" && reason ? reason : "未知原因";
}

function readFailureReason(value: unknown): AiFailureReason | undefined {
  return typeof value === "string" && KNOWN_AI_FAILURE_REASONS.has(value)
    ? (value as AiFailureReason)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseProviderFailure(value: unknown): AiProviderFailure | null {
  if (!isRecord(value)) return null;
  const baseUrl = readString(value.baseUrl);
  const model = readString(value.model);
  const message = readString(value.message);
  const occurredAt = readString(value.occurredAt);
  const code = readString(value.code);
  if (!baseUrl || !model || !message || !occurredAt) return null;

  return {
    baseUrl,
    model,
    message,
    occurredAt,
    ...(typeof value.status === "number" && Number.isFinite(value.status) ? { status: value.status } : {}),
    ...(code ? { code } : {}),
  };
}

export function parseAiErrorDetails(value: unknown): AiErrorDetails | undefined {
  if (!isRecord(value)) return undefined;
  const reason = readFailureReason(value.reason);
  const summary = readString(value.summary);
  const occurredAt = readString(value.occurredAt);
  if (!reason || !summary || !occurredAt) {
    return undefined;
  }

  const attempts = Array.isArray(value.attempts)
    ? value.attempts.map(parseProviderFailure).filter((attempt): attempt is AiProviderFailure => Boolean(attempt))
    : [];
  return { reason, summary, attempts, occurredAt };
}
