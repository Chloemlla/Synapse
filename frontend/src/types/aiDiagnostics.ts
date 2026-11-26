export interface AiProviderFailure {
  baseUrl: string;
  model: string;
  status?: number;
  code?: string;
  message: string;
  occurredAt: string;
}

/**
 * 失败原因码。与后端 `src/services/librechat/types.ts` 的 `ChatFailureReason` 一一对应：
 * 前端构建碰不到后端源码,所以这里是**必须人工成对**的第二份 —— 后端新增原因时这里不改,
 * `parseAiErrorDetails` 会把诊断当成非法直接丢掉,用户就只看得到“没回答”而看不到原因。
 */
export type AiFailureReason =
  | "no_provider_configured"
  | "all_providers_failed"
  | "vision_unavailable"
  | "content_rejected";

export interface AiErrorDetails {
  reason: AiFailureReason;
  summary: string;
  attempts: AiProviderFailure[];
  occurredAt: string;
}
