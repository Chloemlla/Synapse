import { config } from "../config/config";

// GeoGebra AI 提供方的「解析原语」：只负责把**环境变量**映射成一份 provider 描述。
//
// 管理端在线配置（运行时配置 → GeoGebra AI 提供商）走 src/geogebra/aiProviderConfigService.ts，
// 它复用本文件里的类型与地址校验，再叠加「独立配置 / 复用 LibreChat 提供者」两种来源。
// 拆成独立文件是为了避免 aiService ⇄ configService 的循环依赖。
export type GeoGebraAiProvider = {
  configured: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 只有显式开启且模型确实支持图片时才允许把参考图发出去。 */
  vision: boolean;
  reason?: string;
};

/** provider 的实际来源，管理诊断只用来说明「这份配置从哪来」，不回显地址与密钥。 */
export type GeoGebraAiProviderSource = "env" | "custom" | "librechat";

export type GeoGebraAiProviderResolution = GeoGebraAiProvider & { source: GeoGebraAiProviderSource };

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

/** 供应商地址来自服务端配置（受保护 env 或管理端运行时配置），但仍要挡住 https 之外与明显的内网目标。 */
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
