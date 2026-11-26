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

export interface ChatFailureDiagnostics {
  /**
   * `vision_unavailable`:请求带了图片,但没有任何具备识图能力的提供者(X1-06)。
   * 单独一个原因而不是塞进 `no_provider_configured`,是为了让页面能说清
   * 「换一张纯文字的试试」而不是「服务未配置」。
   */
  reason: "no_provider_configured" | "all_providers_failed" | "vision_unavailable" | "content_rejected";
  summary: string;
  attempts: ChatProviderFailureAttempt[];
  occurredAt: Date;
}
