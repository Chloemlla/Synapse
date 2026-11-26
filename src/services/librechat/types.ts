export interface ImageRecord {
  updateTime: string;
  updateTimeShanghai?: string;
  imageUrl: string;
}

export interface ChatMessage {
  id: string;
  message: string;
  role?: "user" | "assistant";
  timestamp: string;
  /** Canonical, namespaced digest used for all new ownership checks. */
  ownerKey?: string;
  /** Legacy fields are read only while normalizing older file-backed data. */
  token?: string;
  userId?: string;
  aiErrorDetails?: ChatFailureDiagnostics;
}

export interface ChatHistory {
  messages: ChatMessage[];
  total: number;
}

export interface PaginationOptions {
  page: number;
  limit: number;
}

export interface SSEClient {
  id: string;
  ownerKey: string;
  res: any;
  lastPing: number;
}

export interface ChatProviderFailureAttempt {
  baseUrl: string;
  model: string;
  wire?: string;
  status?: number;
  code?: string;
  message: string;
  occurredAt: Date;
}

/**
 * AI 失败原因码的**单一口径**。
 *
 * 为什么强调单一:`ticketModel` 的 mongoose enum 与前端 `aiDiagnostics` 的解析守卫都校这个集合,
 * 各处手写副本的结果是「新增一个原因 → 写工单时 enum 拒写、页面又把诊断当非法丢弃」,
 * 两种都很静默。后端侧由 `diagnostics.ts` 的 `CHAT_FAILURE_REASONS` 从本类型派生,
 * 带不了编译期检查的前端侧至少留了注释成对。
 *
 * - `vision_unavailable`:请求带了图片,但没有任何具备识图能力的提供者(X1-06)。
 * - `content_rejected`:附件本身不合法(外链 / 不支持的格式 / 过大),未发起上游调用。
 */
export type ChatFailureReason =
  | "no_provider_configured"
  | "all_providers_failed"
  | "vision_unavailable"
  | "content_rejected";

export interface ChatFailureDiagnostics {
  reason: ChatFailureReason;
  summary: string;
  attempts: ChatProviderFailureAttempt[];
  occurredAt: Date;
}
