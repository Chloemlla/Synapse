/**
 * LibreChat 通道线格式(wire)抽象:请求构建 + 响应解析的纯函数层。
 *
 * 三种可配置格式:
 *  - openai-chat:      OpenAI Chat Completions(POST /v1/chat/completions)—— 现状默认
 *  - openai-responses: OpenAI Responses API(POST /v1/responses)
 *  - anthropic:        Anthropic Messages API(POST /v1/messages)
 *
 * 本模块不发起任何网络请求、不读 env/DB,只做确定性的构造与解析,便于单测钉住。
 * 实际 axios 调用留在 libreChatService,按 provider.wire 分派到这里。
 */

export const CHAT_WIRE_FORMATS = ["openai-chat", "openai-responses", "anthropic"] as const;

export type ChatWireFormat = (typeof CHAT_WIRE_FORMATS)[number];

export const DEFAULT_CHAT_WIRE: ChatWireFormat = "openai-chat";

export function isChatWireFormat(value: unknown): value is ChatWireFormat {
  return typeof value === "string" && (CHAT_WIRE_FORMATS as readonly string[]).includes(value);
}

/** 空/非法一律回退默认(openai-chat),保证老数据零迁移、行为不变。 */
export function normalizeWire(value: unknown): ChatWireFormat {
  return isChatWireFormat(value) ? value : DEFAULT_CHAT_WIRE;
}

/**
 * 多模态内容件(X1-01)。
 *
 * 只支持**内联 data URL**:上游若接受 `http(s)://` 图片地址,就是让上游替我们去取一个
 * 调用方指定的 URL(SSRF 面 + 我们无从校验大小/类型),因此外链一律拒绝(X1-02)。
 */
export interface WireTextPart {
  type: "text";
  text: string;
}

export interface WireImagePart {
  type: "image";
  /** `data:<mime>;base64,<payload>` */
  dataUrl: string;
}

export type ChatContentPart = WireTextPart | WireImagePart;

/** 纯字符串保持既有形态(文本请求体逐字节不变,G-04);数组只在调用方显式传件时出现。 */
export type WireChatContent = string | ChatContentPart[];

/** 上层已归一为 system/user/assistant;openai-chat 依赖 system 拼回 messages 首位。 */
export interface WireChatMessage {
  role: "user" | "assistant";
  content: WireChatContent;
}

export const INLINE_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type InlineImageMimeType = (typeof INLINE_IMAGE_MIME_TYPES)[number];

/** 单图 base64 解码后的字节上限(G-04:上限要小,否则一个请求就能把上游请求体撑到几十 MB)。 */
export const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024;
/** 单次调用的图片件上限。 */
export const MAX_INLINE_IMAGES_PER_REQUEST = 4;

export type InlineImageRejection =
  | "EXTERNAL_IMAGE_NOT_ALLOWED"
  | "NOT_A_DATA_URL"
  | "NOT_BASE64"
  | "UNSUPPORTED_IMAGE_TYPE"
  | "EMPTY_IMAGE"
  | "IMAGE_TOO_LARGE"
  | "TOO_MANY_IMAGES";

export interface ParsedInlineImage {
  mediaType: InlineImageMimeType;
  /** 纯 base64 载荷(已去掉 `data:` 头,anthropic 的 `source.data` 要的就是这一段)。 */
  data: string;
  /** 解码后的近似字节数(用于体积判定,不复制缓冲区)。 */
  bytes: number;
}

export type InlineImageResult =
  | { ok: true; image: ParsedInlineImage }
  | { ok: false; code: InlineImageRejection };

const DATA_IMAGE_RE = /^data:([^;,\s]+)((?:;[^;,\s]*)*),([\s\S]*)$/i;

/**
 * 解析并校验内联图片(X1-02/X1-03)。
 *
 * 顺序有意为之:先拒外链(最危险),再判格式,再判体积——外链那句必须排在
 * `NOT_A_DATA_URL` 前面,否则 `https://…` 只会得到一个含糊的「不是 data URL」。
 */
export function parseInlineImageDataUrl(value: unknown): InlineImageResult {
  if (typeof value !== "string" || !value.trim()) return { ok: false, code: "NOT_A_DATA_URL" };
  const trimmed = value.trim();
  if (/^(https?:)?\/\//i.test(trimmed)) return { ok: false, code: "EXTERNAL_IMAGE_NOT_ALLOWED" };
  const match = DATA_IMAGE_RE.exec(trimmed);
  if (!match) return { ok: false, code: "NOT_A_DATA_URL" };
  const [, mime, params, payload] = match;
  if (!/;base64/i.test(params || "")) return { ok: false, code: "NOT_BASE64" };
  const lowered = String(mime || "").toLowerCase();
  if (!(INLINE_IMAGE_MIME_TYPES as readonly string[]).includes(lowered)) {
    return { ok: false, code: "UNSUPPORTED_IMAGE_TYPE" };
  }
  const data = String(payload || "").replace(/\s+/g, "");
  if (!data) return { ok: false, code: "EMPTY_IMAGE" };
  const bytes = Math.floor((data.length * 3) / 4);
  if (bytes > MAX_INLINE_IMAGE_BYTES) return { ok: false, code: "IMAGE_TOO_LARGE" };
  return { ok: true, image: { mediaType: lowered as InlineImageMimeType, data, bytes } };
}

/** 字符串内容不是「件」,返回 null 让调用方走既有文本通路。 */
export function toContentParts(content: WireChatContent | undefined | null): ChatContentPart[] | null {
  return Array.isArray(content) ? content : null;
}

export function countContentImages(content: WireChatContent | undefined | null): number {
  const parts = toContentParts(content);
  if (!parts) return 0;
  return parts.filter((part) => part?.type === "image").length;
}

/** 历史只存文本件(X1-08):图不入库、不进隐私数据地图(G-05)。逐件裁空白，空件丢弃。 */
export function contentPartsToPlainText(content: WireChatContent | undefined | null): string {
  if (typeof content === "string") return content;
  const parts = toContentParts(content);
  if (!parts) return "";
  return parts
    .filter((part): part is WireTextPart => part?.type === "text")
    .map((part) => String(part.text ?? "").trim())
    .filter((text) => text)
    .join("\n");
}

export interface ContentPartsIssue {
  code: InlineImageRejection;
  /** 出问题的件下标;张数超限时为 -1(不属于单个件)。 */
  index: number;
}

/**
 * 件级校验:逐件解析 + 张数上限。返回空数组 = 可用。
 *
 * 一次性收集所有问题而不是首个就返回:调用方要据此给用户「哪一张不行」,而不是
 * 一个笼统的失败。
 */
export function validateContentParts(content: WireChatContent | undefined | null): ContentPartsIssue[] {
  const parts = toContentParts(content);
  if (!parts) return [];
  const issues: ContentPartsIssue[] = [];
  let images = 0;
  parts.forEach((part, index) => {
    if (part?.type !== "image") return;
    images += 1;
    const result = parseInlineImageDataUrl(part.dataUrl);
    if (!result.ok) issues.push({ code: result.code, index });
  });
  if (images > MAX_INLINE_IMAGES_PER_REQUEST) issues.push({ code: "TOO_MANY_IMAGES", index: -1 });
  return issues;
}

function inlineImageToWirePayload(wire: ChatWireFormat, image: ParsedInlineImage): Record<string, unknown> {
  const dataUrl = `data:${image.mediaType};base64,${image.data}`;
  if (wire === "anthropic") {
    return { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } };
  }
  if (wire === "openai-responses") {
    return { type: "input_image", image_url: dataUrl, detail: "auto" };
  }
  return { type: "image_url", image_url: { url: dataUrl } };
}

/**
 * 把内容序列化成该线格式的正文。
 *
 * 字符串原样返回 —— 这是 G-04「文本请求体逐字节不变」的支点:没有件就没有任何形状变化。
 */
export function wireMessageContent(wire: ChatWireFormat, content: WireChatContent): string | Record<string, unknown>[] {
  const parts = toContentParts(content);
  if (!parts) return typeof content === "string" ? content : "";
  const blocks: Record<string, unknown>[] = [];
  for (const part of parts) {
    if (part?.type === "text") {
      const text = String(part.text ?? "");
      if (text) blocks.push({ type: wire === "openai-responses" ? "input_text" : "text", text });
      continue;
    }
    if (part?.type === "image") {
      const parsed = parseInlineImageDataUrl(part.dataUrl);
      // 校验应已在服务层做完,这里对非法件直接跳过而不是抛错:构造层要保持纯函数可预测。
      if (parsed.ok) blocks.push(inlineImageToWirePayload(wire, parsed.image));
    }
  }
  return blocks;
}

export interface WireBuildInput {
  baseUrl: string;
  apiKey: string;
  model: string;
  wire: ChatWireFormat;
  /** 顶层 system 提示;openai-chat 会拼回 messages[0] 以保持现状请求体逐字节一致。 */
  system: string;
  /** 用户/助手上下文(不含 system)。 */
  messages: WireChatMessage[];
  temperature: number;
  stream: boolean;
  maxTokens: number;
  /**
   * X2-01:`"json"` 时要求上游只回 JSON。
   * 缺省不设 —— 不设就不产生任何新键,老调用方请求体不变。
   */
  responseFormat?: "json";
}

export interface WireRequestSpec {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function joinEndpoint(baseUrl: string, path: string): string {
  return `${String(baseUrl || "").replace(/\/+$/, "")}${path}`;
}

/** 单条正文提取(openai-chat 现状 / anthropic content blocks / responses output)。 */
export function extractWireText(wire: ChatWireFormat, payload: unknown): string {
  const data = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  if (wire === "openai-responses") {
    const output = Array.isArray(data.output) ? data.output : [];
    const parts: string[] = [];
    for (const item of output) {
      const it = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      if (it.type !== "message") continue;
      const content = Array.isArray(it.content) ? it.content : [];
      for (const block of content) {
        const b = block && typeof block === "object" ? (block as Record<string, unknown>) : {};
        if (b.type === "output_text" && typeof b.text === "string") parts.push(b.text);
      }
    }
    return parts.join("");
  }
  if (wire === "anthropic") {
    const content = Array.isArray(data.content) ? data.content : [];
    const parts: string[] = [];
    for (const block of content) {
      const b = block && typeof block === "object" ? (block as Record<string, unknown>) : {};
      if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
    }
    return parts.join("");
  }
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const first = choices[0] && typeof choices[0] === "object" ? (choices[0] as Record<string, unknown>) : {};
  const message = first.message && typeof first.message === "object" ? (first.message as Record<string, unknown>) : {};
  return typeof message.content === "string" ? message.content : "";
}

/**
 * 构造一次上游请求。openai-chat 输出与改造前逐字节一致:
 * messages 首位为 system,body 固定含 model/messages/temperature/stream/max_tokens。
 */
export function buildWireRequest(input: WireBuildInput): WireRequestSpec {
  const { baseUrl, apiKey, model, wire, system, messages, temperature, stream, maxTokens, responseFormat } = input;
  if (wire === "openai-responses") {
    return {
      url: joinEndpoint(baseUrl, "/v1/responses"),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: {
        model,
        instructions: system,
        input: messages.map((m) => ({ role: m.role, content: wireMessageContent(wire, m.content) })),
        ...(temperature === undefined ? {} : { temperature }),
        stream,
        max_output_tokens: maxTokens,
        // Responses API 的 JSON 模式挂在 text.format 上,不是 response_format。
        ...(responseFormat === "json" ? { text: { format: { type: "json_object" } } } : {}),
      },
    };
  }
  if (wire === "anthropic") {
    return {
      url: joinEndpoint(baseUrl, "/v1/messages"),
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: {
        model,
        max_tokens: maxTokens,
        system,
        messages: messages.map((m) => ({ role: m.role, content: wireMessageContent(wire, m.content) })),
        ...(temperature === undefined ? {} : { temperature }),
        stream,
        // 刻意不加任何 JSON 参数:Anthropic Messages API 没有 `json_object` 这一档,
        // 硬塞会被上游 400。JSON 约束落在提示层与解析层(X2-05/X2-02)。
      },
    };
  }
  return {
    url: joinEndpoint(baseUrl, "/v1/chat/completions"),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: {
      model,
      messages: [{ role: "system", content: system }, ...messages.map((m) => ({ role: m.role, content: wireMessageContent(wire, m.content) }))],
      temperature,
      stream,
      max_tokens: maxTokens,
      ...(responseFormat === "json" ? { response_format: { type: "json_object" } } : {}),
    },
  };
}

export type WireStreamEvent = { kind: "text"; text: string } | { kind: "none" };

/**
 * 流式:把一个 SSE 的 data JSON(已 JSON.parse)按格式转成文本增量或空。
 * 结束事件(message_stop / response.completed)同样返回 none——流以 socket end 收尾,
 * 与 openai-chat 的 [DONE] 语义保持一致(那也在 socket end 前由上层跳过)。
 */
export function wireStreamEvent(wire: ChatWireFormat, obj: unknown): WireStreamEvent {
  const o = obj && typeof obj === "object" ? (obj as Record<string, unknown>) : {};
  if (wire === "openai-responses") {
    if (o.type === "response.output_text.delta" && typeof o.delta === "string") {
      return { kind: "text", text: o.delta };
    }
    return { kind: "none" };
  }
  if (wire === "anthropic") {
    if (
      o.type === "content_block_delta" &&
      o.delta &&
      typeof o.delta === "object" &&
      (o.delta as Record<string, unknown>).type === "text_delta" &&
      typeof (o.delta as Record<string, unknown>).text === "string"
    ) {
      return { kind: "text", text: (o.delta as Record<string, unknown>).text as string };
    }
    return { kind: "none" };
  }
  const choices = Array.isArray(o.choices) ? o.choices : [];
  const first = choices[0] && typeof choices[0] === "object" ? (choices[0] as Record<string, unknown>) : {};
  const delta = first.delta && typeof first.delta === "object" ? (first.delta as Record<string, unknown>) : {};
  return typeof delta.content === "string" ? { kind: "text", text: delta.content } : { kind: "none" };
}
