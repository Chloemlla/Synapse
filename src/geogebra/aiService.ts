import axios from "axios";
import { config } from "../config/config";
import { GeoGebraDomainError } from "./projectService";
import { validateGeoGebraCommands } from "./scriptValidation";

// GeoGebra AI 能力的服务端唯一出口（GEO-15/16）。
//
// 三条硬约束：
//  1) 只在服务端调用已配置 provider；密钥/模型名不进客户端，也不回显给用户。
//  2) 未配置就 fail-closed：返回明确的「暂不可用」，绝不静默走公开端点或降级成假结果。
//  3) 模型输出一律按不可信输入处理：必须通过 JSON 解析、字段白名单、长度与命令校验，
//     再交给用户预览确认；AI 输出不绕过既有脚本预检。
export type GeoGebraAiProvider = {
  configured: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 只有显式开启且模型确实支持图片时才允许把参考图发出去。 */
  vision: boolean;
  reason?: string;
};

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^\[?::1\]?$/,
  /^0\.0\.0\.0$/,
];

/** 供应商地址来自服务端配置（受保护 env），但仍要挡住 https 之外与明显的内网目标。 */
export function isAllowedGeoGebraAiBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return false;
    if (url.username || url.password) return false;
    if (PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(url.hostname))) return false;
    return true;
  } catch {
    return false;
  }
}

export function resolveGeoGebraAiProvider(
  env: NodeJS.ProcessEnv = process.env,
  options: { useConfigFallback?: boolean } = {},
): GeoGebraAiProvider {
  // 默认允许回退到站内既有的 OpenAI 配置；测试可以只认显式 env，避免被本机配置干扰。
  const configFallbackAllowed = options.useConfigFallback !== false;
  const baseUrl = String(env.GEOGEBRA_AI_BASE_URL || (configFallbackAllowed ? config.openaiBaseUrl : "") || "").trim();
  const apiKey = String(env.GEOGEBRA_AI_API_KEY || (configFallbackAllowed ? config.openaiApiKey : "") || "").trim();
  const model = String(env.GEOGEBRA_AI_MODEL || (configFallbackAllowed ? config.openaiModel : "") || "").trim();
  const visionRequested = String(env.GEOGEBRA_AI_VISION || "").trim().toLowerCase() === "true";

  if (!baseUrl || !apiKey || !model) {
    return { configured: false, baseUrl: "", apiKey: "", model: "", vision: false, reason: "AI 能力尚未配置。" };
  }
  if (!isAllowedGeoGebraAiBaseUrl(baseUrl)) {
    // 配置错了也要 fail-closed，而不是回退到别的地址。
    return { configured: false, baseUrl: "", apiKey: "", model: "", vision: false, reason: "AI 服务地址不可用。" };
  }
  return { configured: true, baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, model, vision: visionRequested };
}

export const GEOGEBRA_AI_KINDS = ["ai-drawing", "ai-insight", "ai-annotation", "ai-explanation"] as const;
export type GeoGebraAiKind = (typeof GEOGEBRA_AI_KINDS)[number];

export type GeoGebraAiRequest = {
  kind: GeoGebraAiKind;
  canvasMode: string;
  code: string;
  prompt?: string;
  objectNames?: string[];
  focusObject?: string;
  /** 参考图：只在 kind === "ai-drawing" 且 provider.vision 为真时使用。 */
  referenceImageDataUrl?: string;
};

export type GeoGebraAiResult = {
  summary: string;
  commands: string[];
  notes: string[];
  confidence: number | null;
};

const MAX_SUMMARY_CHARS = 4_000;
const MAX_NOTE_CHARS = 500;
const MAX_NOTES = 20;
const MAX_AI_COMMANDS = 200;
const REQUEST_TIMEOUT_MS = 60_000;
const SYSTEM_PROMPT = [
  "你是 GeoGebra 脚本助手。只输出 JSON 对象，不要输出解释性文字或 Markdown。",
  'JSON 形状：{"summary": string, "commands": string[], "notes": string[], "confidence": number}',
  "commands 必须是可直接在 GeoGebra 命令行执行的独立指令，一行一条，不要包含 Markdown 代码块或编号。",
  "不要生成 eval、javascript:、<script> 等可执行内容；不要引用网络资源。",
].join("\n");

function kindInstruction(kind: GeoGebraAiKind): string {
  switch (kind) {
    case "ai-drawing":
      return "根据用户描述（或参考图）生成一段可运行的 GeoGebra 构造脚本；commands 是完整脚本。summary 用一句中文说明思路。";
    case "ai-insight":
      return "解读给定脚本：summary 说明它构造了什么、关键点是什么；commands 返回空数组，notes 给出可选的讲解步骤。";
    case "ai-annotation":
      return "为给定对象给出标注建议：summary 概述，commands 是建议写回的标注/文本指令，notes 说明每条建议的理由。";
    case "ai-explanation":
      return "解释指定对象与其他对象的依赖关系：summary 说明依赖链，commands 返回空数组，notes 列出关键依赖。";
  }
}

function clampText(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function parseJsonObject(payload: string): Record<string, unknown> | null {
  const trimmed = payload.trim();
  const candidates = [trimmed];
  // 模型有时会套一层 ```json 代码块：只在完全解析失败时做一次保守剥离。
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  if (fenced) candidates.push(fenced[1]);
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      // try next candidate
    }
  }
  return null;
}

/** 把模型返回体收敛成白名单结构；任何不合规都抛业务错，不把原始文本透给用户。 */
export function normalizeGeoGebraAiResult(payload: string, kind: GeoGebraAiKind): GeoGebraAiResult {
  const parsed = parseJsonObject(payload);
  if (!parsed) throw new GeoGebraDomainError("生成结果暂时无法解析，请重试。", 502, "GEOGEBRA_AI_INVALID_OUTPUT");

  const summary = clampText(parsed.summary, MAX_SUMMARY_CHARS);
  const notes = Array.isArray(parsed.notes)
    ? parsed.notes.map((note) => clampText(note, MAX_NOTE_CHARS)).filter(Boolean).slice(0, MAX_NOTES)
    : [];

  let commands: string[] = [];
  const rawCommands = Array.isArray(parsed.commands) ? parsed.commands : [];
  if (rawCommands.length > 0) {
    // 模型可能给出超量或含危险片段的指令：先裁剪数量，再用与分享同一套校验器过一遍。
    const clipped = rawCommands.slice(0, MAX_AI_COMMANDS);
    try {
      commands = validateGeoGebraCommands(clipped);
    } catch {
      throw new GeoGebraDomainError("生成结果包含无法执行的内容，请重试。", 502, "GEOGEBRA_AI_INVALID_COMMANDS");
    }
  }
  if (kind === "ai-drawing" && commands.length === 0) {
    throw new GeoGebraDomainError("这次没有生成可用的指令，请调整描述后重试。", 502, "GEOGEBRA_AI_EMPTY_OUTPUT");
  }

  const rawConfidence = typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
    ? Math.min(1, Math.max(0, parsed.confidence))
    : null;

  return { summary, commands, notes, confidence: rawConfidence };
}

type ChatMessageContent = string | Array<Record<string, unknown>>;

function buildMessages(request: GeoGebraAiRequest, provider: GeoGebraAiProvider): Array<{ role: string; content: ChatMessageContent }> {
  const parts = [
    `画布模式：${request.canvasMode}`,
    `当前脚本：\n${request.code.slice(0, 20_000)}`,
  ];
  if (request.prompt) parts.push(`用户描述：${request.prompt.slice(0, 2_000)}`);
  if (request.objectNames?.length) parts.push(`画布对象：${request.objectNames.slice(0, 200).join(", ")}`);
  if (request.focusObject) parts.push(`关注对象：${request.focusObject.slice(0, 200)}`);
  const text = `${kindInstruction(request.kind)}\n\n${parts.join("\n\n")}`;

  if (request.kind === "ai-drawing" && request.referenceImageDataUrl) {
    if (!provider.vision) {
      throw new GeoGebraDomainError("当前 AI 配置不支持参考图，请改用文字描述。", 409, "GEOGEBRA_AI_VISION_UNAVAILABLE");
    }
    return [{
      role: "user",
      content: [
        { type: "text", text },
        { type: "image_url", image_url: { url: request.referenceImageDataUrl } },
      ],
    }];
  }
  return [{ role: "user", content: text }];
}

export async function requestGeoGebraAi(request: GeoGebraAiRequest, env: NodeJS.ProcessEnv = process.env): Promise<GeoGebraAiResult> {
  const provider = resolveGeoGebraAiProvider(env);
  if (!provider.configured) {
    throw new GeoGebraDomainError("AI 能力暂不可用，请稍后再试。", 503, "GEOGEBRA_AI_UNAVAILABLE");
  }

  const response = await axios.post(
    `${provider.baseUrl}/chat/completions`,
    {
      model: provider.model,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...buildMessages(request, provider)],
      temperature: 0.2,
      response_format: { type: "json_object" },
    },
    {
      timeout: REQUEST_TIMEOUT_MS,
      maxRedirects: 0,
      maxBodyLength: 8 * 1024 * 1024,
      maxContentLength: 4 * 1024 * 1024,
      headers: { Authorization: `Bearer ${provider.apiKey}`, "Content-Type": "application/json" },
    },
  );

  const payload = response.data as { choices?: Array<{ message?: { content?: unknown } }> } | undefined;
  const content = payload?.choices?.[0]?.message?.content;
  const text = typeof content === "string" ? content : "";
  if (!text) throw new GeoGebraDomainError("生成结果为空，请重试。", 502, "GEOGEBRA_AI_EMPTY_OUTPUT");
  return normalizeGeoGebraAiResult(text, request.kind);
}
