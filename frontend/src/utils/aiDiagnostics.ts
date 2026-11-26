import type { AiErrorDetails, AiFailureReason, AiProviderFailure } from "../types/aiDiagnostics";

/**
 * 合法原因码集合。
 *
 * 为什么丌是一份字面量列表:`Record<AiFailureReason, true>` 缺一个键就编译错,
 * 而旧的 `reason !== "a" && reason !== "b"` 守卫在后端新增原因时**静默把诊断丢掉**
 * —— 用户只看得到“没回答”,管端也查不到原因。
 */
const AI_FAILURE_REASON_KEYS: Record<AiFailureReason, true> = {
  no_provider_configured: true,
  all_providers_failed: true,
  vision_unavailable: true,
  content_rejected: true,
};
const KNOWN_AI_FAILURE_REASONS: ReadonlySet<string> = new Set(Object.keys(AI_FAILURE_REASON_KEYS));

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
