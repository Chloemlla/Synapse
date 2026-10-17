import GeoGebraAiConfigModel, { type GeoGebraAiProviderMode } from "../models/geogebraAiConfigModel";
import { ChatProviderModel } from "../services/librechat/models";
import { normalizeWire } from "../services/librechat/wire";
import { mongoose } from "../services/mongoService";
import logger from "../utils/logger";
import {
  isAllowedGeoGebraAiBaseUrl,
  resolveGeoGebraAiProvider,
  type GeoGebraAiProviderResolution,
} from "./aiProvider";

// GeoGebra AI 提供方的「运行时来源」：管理端在线配置（Mongo 单例文档）优先；
// 没有文档时沿用环境变量。三种来源互相排斥，解析结果只输出一份 provider 描述。
//
// 安全口径：
//  - 密钥明文落库（与 chat_providers 一致），但模型字段 select:false，只有解析与超管读取时显式取出；
//  - 地址一律过 isAllowedGeoGebraAiBaseUrl（https + 非内网），配置错了 fail-closed，不回退到别的地址；
//  - 复用 LibreChat 提供者时只接受 openai-chat 线格式：GeoGebra AI 只会发 /chat/completions。
export const GEOGEBRA_AI_PROVIDER_MODES = ["env", "custom", "librechat"] as const;

const SETTING_ID = "default";
const MAX_PROVIDER_OPTIONS = 200;
const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

export class GeoGebraAiConfigError extends Error {
  constructor(
    message: string,
    public readonly status: number = 400,
    public readonly code: string = "GEOGEBRA_AI_CONFIG_INVALID",
  ) {
    super(message);
    this.name = "GeoGebraAiConfigError";
  }
}

export interface GeoGebraAiSettingLike {
  mode: GeoGebraAiProviderMode;
  baseUrl: string;
  apiKey: string;
  model: string;
  vision: boolean;
  librechatProviderId: string;
}

export interface GeoGebraChatProviderLike {
  baseUrl: string;
  apiKey: string;
  model: string;
  wire?: string;
  enabled?: boolean;
}

export interface GeoGebraAiAdminConfig {
  mode: GeoGebraAiProviderMode;
  baseUrl: string;
  model: string;
  vision: boolean;
  librechatProviderId: string;
  hasApiKey: boolean;
  apiKeyMasked: string;
  updatedAt: string | null;
  updatedBy: string;
}

export interface GeoGebraLibreChatProviderOption {
  id: string;
  baseUrl: string;
  model: string;
  wire: string;
  group: string;
  enabled: boolean;
  /** 能否被 GeoGebra AI 复用（仅 openai-chat 线格式）。 */
  compatible: boolean;
}

export interface GeoGebraAiAdminStatus {
  configured: boolean;
  source: GeoGebraAiProviderMode;
  reason: string | null;
}

export interface GeoGebraAiAdminSetting {
  config: GeoGebraAiAdminConfig;
  providers: GeoGebraLibreChatProviderOption[];
  status: GeoGebraAiAdminStatus;
}

export function normalizeGeoGebraAiProviderMode(value: unknown): GeoGebraAiProviderMode | null {
  return (GEOGEBRA_AI_PROVIDER_MODES as readonly string[]).includes(String(value))
    ? (String(value) as GeoGebraAiProviderMode)
    : null;
}

function maskedKey(value: string): string {
  return value.length > 8 ? `${value.slice(0, 2)}***${value.slice(-4)}` : "***";
}

function trimUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

/** 纯函数：由「设置 + 被复用的 LibreChat 提供者 + env」算出实际生效的 provider。 */
export function buildGeoGebraAiResolution(input: {
  setting?: GeoGebraAiSettingLike | null;
  librechatProvider?: GeoGebraChatProviderLike | null;
  env?: NodeJS.ProcessEnv;
}): GeoGebraAiProviderResolution {
  const setting = input.setting ?? null;
  const mode = setting?.mode ?? "env";

  if (mode === "env") {
    return { ...resolveGeoGebraAiProvider(input.env ?? process.env), source: "env" };
  }

  if (mode === "custom") {
    const baseUrl = trimUrl(String(setting?.baseUrl ?? ""));
    const apiKey = String(setting?.apiKey ?? "").trim();
    const model = String(setting?.model ?? "").trim();
    const vision = Boolean(setting?.vision);
    if (!baseUrl || !apiKey || !model) {
      return { configured: false, baseUrl: "", apiKey: "", model: "", vision: false, source: "custom", reason: "请补全服务地址、API Key 与模型。" };
    }
    if (!isAllowedGeoGebraAiBaseUrl(baseUrl)) {
      return { configured: false, baseUrl: "", apiKey: "", model: "", vision: false, source: "custom", reason: "AI 服务地址不可用（必须是 https，且不能是内网/环回地址）。" };
    }
    return { configured: true, baseUrl, apiKey, model, vision, source: "custom" };
  }

  // mode === "librechat"
  const vision = Boolean(setting?.vision);
  const provider = input.librechatProvider ?? null;
  const notConfigured = (reason: string): GeoGebraAiProviderResolution => ({
    configured: false, baseUrl: "", apiKey: "", model: "", vision: false, source: "librechat", reason,
  });
  if (!setting?.librechatProviderId) return notConfigured("尚未选择要复用的 LibreChat 提供者。");
  if (!provider) return notConfigured("所选 LibreChat 提供者不存在或已被删除。");
  if (provider.enabled === false) return notConfigured("所选 LibreChat 提供者已停用。");
  if (normalizeWire(provider.wire) !== "openai-chat") {
    return notConfigured("所选 LibreChat 提供者的协议格式与 GeoGebra AI 不兼容（仅支持 OpenAI Chat Completions）。");
  }
  const baseUrl = trimUrl(String(provider.baseUrl ?? ""));
  const apiKey = String(provider.apiKey ?? "").trim();
  const model = String(provider.model ?? "").trim();
  if (!baseUrl || !apiKey || !model) return notConfigured("所选 LibreChat 提供者配置不完整。");
  if (!isAllowedGeoGebraAiBaseUrl(baseUrl)) return notConfigured("所选 LibreChat 提供者的服务地址不可用。");
  return { configured: true, baseUrl, apiKey, model, vision, source: "librechat" };
}

async function readSettingDoc(): Promise<(GeoGebraAiSettingLike & { updatedAt?: Date; updatedBy?: string }) | null> {
  if (mongoose.connection.readyState !== 1) return null;
  const doc = await GeoGebraAiConfigModel.findById(SETTING_ID).select("+apiKey").lean();
  if (!doc) return null;
  return {
    mode: normalizeGeoGebraAiProviderMode(doc.mode) ?? "env",
    baseUrl: String(doc.baseUrl ?? ""),
    apiKey: String(doc.apiKey ?? ""),
    model: String(doc.model ?? ""),
    vision: Boolean(doc.vision),
    librechatProviderId: String(doc.librechatProviderId ?? ""),
    updatedAt: doc.updatedAt,
    updatedBy: String(doc.updatedBy ?? ""),
  };
}

async function readLibreChatProvider(id: string): Promise<GeoGebraChatProviderLike | null> {
  if (!OBJECT_ID_PATTERN.test(id) || mongoose.connection.readyState !== 1) return null;
  const doc = await ChatProviderModel.findById(id)
    .select("baseUrl apiKey model wire enabled")
    .lean();
  if (!doc) return null;
  return {
    baseUrl: String(doc.baseUrl ?? ""),
    apiKey: String(doc.apiKey ?? ""),
    model: String(doc.model ?? ""),
    wire: String(doc.wire ?? ""),
    enabled: doc.enabled !== false,
  };
}

export async function listGeoGebraLibreChatProviders(): Promise<GeoGebraLibreChatProviderOption[]> {
  if (mongoose.connection.readyState !== 1) return [];
  const docs = await ChatProviderModel.find({})
    .select("baseUrl model wire group enabled updatedAt")
    .sort({ updatedAt: -1 })
    .limit(MAX_PROVIDER_OPTIONS)
    .lean();
  return (docs || []).map((doc: Record<string, unknown>) => {
    const wire = normalizeWire(doc.wire);
    return {
      id: String(doc._id),
      baseUrl: String(doc.baseUrl ?? ""),
      model: String(doc.model ?? ""),
      wire,
      group: String(doc.group ?? ""),
      enabled: doc.enabled !== false,
      compatible: wire === "openai-chat",
    };
  });
}

function toAdminConfig(setting: Awaited<ReturnType<typeof readSettingDoc>>): GeoGebraAiAdminConfig {
  const apiKey = setting?.apiKey ?? "";
  return {
    mode: setting?.mode ?? "env",
    baseUrl: setting?.baseUrl ?? "",
    model: setting?.model ?? "",
    vision: Boolean(setting?.vision),
    librechatProviderId: setting?.librechatProviderId ?? "",
    hasApiKey: Boolean(apiKey),
    apiKeyMasked: apiKey ? maskedKey(apiKey) : "",
    updatedAt: setting?.updatedAt instanceof Date ? setting.updatedAt.toISOString() : null,
    updatedBy: setting?.updatedBy ?? "",
  };
}

function toAdminStatus(resolution: GeoGebraAiProviderResolution): GeoGebraAiAdminStatus {
  return {
    configured: resolution.configured,
    source: resolution.source,
    reason: resolution.configured ? null : resolution.reason ?? "AI 能力尚未配置。",
  };
}

/** 实际调用 AI 时的唯一入口：管理端配置优先，DB 不可用时退回环境变量（历史行为）。 */
export async function resolveGeoGebraAiProviderForRuntime(
  env: NodeJS.ProcessEnv = process.env,
): Promise<GeoGebraAiProviderResolution> {
  let setting: Awaited<ReturnType<typeof readSettingDoc>> = null;
  try {
    setting = await readSettingDoc();
  } catch (error) {
    logger.warn("[GeoGebraAI] Failed to read provider setting; falling back to environment variables", {
      errorType: error instanceof Error ? error.name : "unknown",
    });
  }
  let librechatProvider: GeoGebraChatProviderLike | null = null;
  if (setting?.mode === "librechat" && setting.librechatProviderId) {
    try {
      librechatProvider = await readLibreChatProvider(setting.librechatProviderId);
    } catch (error) {
      logger.warn("[GeoGebraAI] Failed to read the reused LibreChat provider", {
        errorType: error instanceof Error ? error.name : "unknown",
      });
    }
  }
  return buildGeoGebraAiResolution({ setting, librechatProvider, env });
}

/** 管理端读取：返回脱敏配置、可复用的 LibreChat 提供者清单与当前生效状态。 */
export async function getGeoGebraAiAdminSetting(): Promise<GeoGebraAiAdminSetting> {
  const setting = await readSettingDoc();
  const providers = await listGeoGebraLibreChatProviders();
  const librechatProvider = setting?.mode === "librechat" && setting.librechatProviderId
    ? await readLibreChatProvider(setting.librechatProviderId)
    : null;
  const resolution = buildGeoGebraAiResolution({ setting, librechatProvider });
  return { config: toAdminConfig(setting), providers, status: toAdminStatus(resolution) };
}

/** 管理端保存：校验通过才落库；apiKey 留空表示沿用已保存的密钥。 */
export async function saveGeoGebraAiSetting(input: unknown, actor: string): Promise<GeoGebraAiAdminSetting> {
  if (mongoose.connection.readyState !== 1) {
    throw new GeoGebraAiConfigError("数据库未连接，暂时无法保存。", 503, "GEOGEBRA_AI_CONFIG_UNAVAILABLE");
  }
  const body = input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
  const mode = normalizeGeoGebraAiProviderMode(body.mode);
  if (!mode) {
    throw new GeoGebraAiConfigError("mode 只能是 env / custom / librechat。");
  }

  const current = await readSettingDoc();
  const apiKeyInput = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  const next: GeoGebraAiSettingLike = {
    mode,
    baseUrl: typeof body.baseUrl === "string" ? body.baseUrl.trim().slice(0, 2_048) : (current?.baseUrl ?? ""),
    // 表单不回显密钥：留空就是「保持原值」，避免管理员每次保存都要重填。
    apiKey: apiKeyInput ? apiKeyInput.slice(0, 2_048) : (current?.apiKey ?? ""),
    model: typeof body.model === "string" ? body.model.trim().slice(0, 200) : (current?.model ?? ""),
    vision: typeof body.vision === "boolean" ? body.vision : Boolean(current?.vision),
    librechatProviderId: typeof body.librechatProviderId === "string"
      ? body.librechatProviderId.trim().slice(0, 80)
      : (current?.librechatProviderId ?? ""),
  };

  if (mode === "custom") {
    if (!next.baseUrl || !next.apiKey || !next.model) {
      throw new GeoGebraAiConfigError("独立配置需要填写服务地址、API Key 与模型。");
    }
    if (!isAllowedGeoGebraAiBaseUrl(next.baseUrl)) {
      throw new GeoGebraAiConfigError("服务地址必须是 https，且不能是内网/环回地址。");
    }
  }

  if (mode === "librechat") {
    if (!OBJECT_ID_PATTERN.test(next.librechatProviderId)) {
      throw new GeoGebraAiConfigError("请选择要复用的 LibreChat 提供者。");
    }
    const provider = await readLibreChatProvider(next.librechatProviderId);
    if (!provider) {
      throw new GeoGebraAiConfigError("所选 LibreChat 提供者不存在或已被删除。", 404, "GEOGEBRA_AI_PROVIDER_NOT_FOUND");
    }
    if (provider.enabled === false) {
      throw new GeoGebraAiConfigError("所选 LibreChat 提供者已停用，请先在上方启用它。");
    }
    if (normalizeWire(provider.wire) !== "openai-chat") {
      throw new GeoGebraAiConfigError(
        "所选 LibreChat 提供者使用 Anthropic 或 Responses 协议，GeoGebra AI 只支持 OpenAI Chat Completions。",
        409,
        "GEOGEBRA_AI_PROVIDER_INCOMPATIBLE",
      );
    }
    if (!isAllowedGeoGebraAiBaseUrl(trimUrl(provider.baseUrl))) {
      throw new GeoGebraAiConfigError("所选 LibreChat 提供者的服务地址不可用（必须是 https，且不能是内网/环回地址）。");
    }
  }

  await GeoGebraAiConfigModel.findByIdAndUpdate(
    SETTING_ID,
    { ...next, updatedAt: new Date(), updatedBy: actor.slice(0, 120) },
    { upsert: true, setDefaultsOnInsert: true },
  );
  logger.info("[GeoGebraAI] Provider setting updated", { mode, actor });
  return getGeoGebraAiAdminSetting();
}
