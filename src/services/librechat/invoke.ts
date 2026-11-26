/**
 * 一次性上游调用(X3-03)——不含历史、不含 SSE、不含业务规则。
 *
 * 为什么单独一层:
 *  - `libreChatService.sendMessage()` 走的是"客服会话"通路(带 ownerKey 历史、内置 system、
 *    模型身份问题静默),内部服务(审查/抽取/评测)真正要的只是**一次纯请求**;
 *  - 复用会话通路会让一次性审查把上一轮内容读进上下文 —— `conversations.ts` 里那条
 *    "每次全新会话"的教训正是这么来的;
 *  - 护栏必须成对保留:`maxContentLength`(响应体上限)、`proxy:false`(系统代理造成的 302 循环)、
 *    `maxRedirects`、逐次超时。抄一份少一条就等于给线上留一颗雷。
 */

import axios from "axios";
import { buildChatProviderFailureAttempt, mergeChatProviderFailureAttempt } from "./diagnostics";
import { sanitizeAssistantText } from "./sanitize";
import {
  buildWireRequest,
  extractWireText,
  normalizeWire,
  type WireChatMessage,
} from "./wire";
import type { ResolvedProvider } from "./selection";
import type { ChatProviderFailureAttempt } from "./types";

/** 非流式响应体上限:与会话通路同口径(G7-17)。 */
export const INVOKE_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const INVOKE_DEFAULT_TIMEOUT_MS = 60_000;
export const INVOKE_MAX_TIMEOUT_MS = 300_000;
export const INVOKE_DEFAULT_MAX_TOKENS = 2048;
export const INVOKE_MAX_ATTEMPTS = 8;

export interface InvokeRequest {
  system: string;
  messages: WireChatMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: "json";
}

export type InvokeOutcome =
  | { ok: true; text: string; provider: ResolvedProvider }
  | { ok: false; text?: undefined; provider: ResolvedProvider; attempt: ChatProviderFailureAttempt };

function timeoutOf(value: unknown): number {
  const raw = Number(value);
  if (!Number.isFinite(raw) || raw <= 0) return INVOKE_DEFAULT_TIMEOUT_MS;
  return Math.min(INVOKE_MAX_TIMEOUT_MS, Math.trunc(raw));
}

/** 调用**一个** provider;失败不抛,归因成 attempt 交回上层。 */
export async function invokeChatOnce(provider: ResolvedProvider, request: InvokeRequest, timeoutMs?: number): Promise<InvokeOutcome> {
  const wire = normalizeWire(provider.wire);
  const spec = buildWireRequest({
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: provider.model,
    wire,
    system: request.system,
    messages: request.messages,
    temperature: Number.isFinite(Number(request.temperature)) ? Number(request.temperature) : 0.2,
    stream: false,
    maxTokens: Number.isFinite(Number(request.maxTokens))
      ? Math.max(1, Math.trunc(Number(request.maxTokens)))
      : INVOKE_DEFAULT_MAX_TOKENS,
    ...(request.responseFormat === "json" ? { responseFormat: "json" as const } : {}),
  });

  try {
    const resp = await axios.post(spec.url, spec.body, {
      headers: spec.headers,
      timeout: timeoutOf(timeoutMs),
      responseType: "json",
      proxy: false,
      maxRedirects: 5,
      maxContentLength: INVOKE_MAX_RESPONSE_BYTES,
      maxBodyLength: INVOKE_MAX_RESPONSE_BYTES,
    });
    const text = sanitizeAssistantText(extractWireText(wire, resp?.data) || "");
    if (!text) {
      return {
        ok: false,
        provider,
        attempt: buildChatProviderFailureAttempt(provider, {
          code: "EMPTY_UPSTREAM_OUTPUT",
          message: "上游返回了空内容",
        }),
      };
    }
    return { ok: true, text, provider };
  } catch (error) {
    return { ok: false, provider, attempt: buildChatProviderFailureAttempt(provider, error) };
  }
}

export interface InvokeFailoverInput {
  providers: readonly ResolvedProvider[];
  request: InvokeRequest;
  timeoutMs?: number;
  attempts?: readonly ChatProviderFailureAttempt[];
}

export interface InvokeFailoverResult {
  outcome: InvokeOutcome | null;
  attempts: ChatProviderFailureAttempt[];
}

/** 依序尝试,把每次失败并进 attempts(同一 provider+model 只保留最后一次,与既有归并口径一致)。 */
export async function invokeWithFailover(input: InvokeFailoverInput): Promise<InvokeFailoverResult> {
  let attempts = [...(input.attempts || [])];
  const list = input.providers.slice(0, INVOKE_MAX_ATTEMPTS);
  for (const provider of list) {
    const outcome = await invokeChatOnce(provider, input.request, input.timeoutMs);
    if (outcome.ok) return { outcome, attempts };
    attempts = mergeChatProviderFailureAttempt(attempts, outcome.attempt);
  }
  return { outcome: null, attempts };
}
