import { isIP } from "node:net";
import { isBlockedAddress } from "../utils/ssrfGuard";

/** Third-party gateway credentials, unrelated to the Android request-signing key. */
export interface CdictUpstreamRuntimeConfig {
  translateBaseUrl: string;
  translateAppId: string;
  ttsUrl: string;
  ttsAppId: string;
  ttsAppKey: string;
}

export const CDICT_UPSTREAM_DEFAULTS: Readonly<CdictUpstreamRuntimeConfig> = Object.freeze({
  translateBaseUrl: "https://vivotrans.vivo.com",
  translateAppId: "9023957766",
  ttsUrl: "https://vivotrans.vivo.com.cn/fy/tts",
  ttsAppId: "1336541186",
  ttsAppKey: "",
});

export class CdictUpstreamValidationError extends Error {}

/** Reject reserved/transition ranges too; the shared guard predates some of these. */
export function isPublicCdictUpstreamAddress(address: string): boolean {
  if (isBlockedAddress(address)) return false;
  if (isIP(address) === 4) {
    const [first, second] = address.split(".").map(Number);
    return first < 224 && !(first === 198 && (second === 18 || second === 19)) &&
      !(first === 192 && second === 88);
  }
  // Only globally routable unicast IPv6; no mapped, NAT64, 6to4, Teredo or special-use 2001::/23.
  const first = Number.parseInt(address.split(":")[0], 16);
  const second = Number.parseInt(address.split(":")[1] || "0", 16);
  return isIP(address) === 6 && first >= 0x2000 && first <= 0x3fff &&
    first !== 0x2002 && first !== 0x3fff && !(first === 0x2001 && (second < 0x200 || second === 0xdb8));
}

function invalid(field: string, detail: string): never {
  // Never interpolate supplied values: URLs and rejected secrets may contain credentials.
  throw new CdictUpstreamValidationError(`${field} ${detail}`);
}

export function normalizeCdictUpstreamUrl(value: unknown, field: "translateBaseUrl" | "ttsUrl"): string {
  if (typeof value !== "string" || !value.trim() || value.length > 2048 || /[\x00-\x1f\x7f\\]/.test(value) || /\s/.test(value.trim())) {
    invalid(field, "必须是有效的 HTTPS 公网地址");
  }
  let url: URL;
  try { url = new URL(value.trim()); } catch { invalid(field, "必须是有效的 HTTPS 公网地址"); }
  if (url.protocol !== "https:" || url.username || url.password || value.includes("#") || value.includes("?")) {
    invalid(field, "仅支持 HTTPS，不能包含凭据、查询参数或片段");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (!isPublicCdictUpstreamAddress(host)) invalid(field, "不能指向内网或保留地址");
  } else if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(host) ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion)$/i.test(host)) {
    invalid(field, "必须使用公网主机名");
  }
  return field === "translateBaseUrl" ? url.toString().replace(/\/+$/, "") : url.toString();
}

function normalizeId(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) {
    invalid(field, "必须是 1 到 256 个字符的字符串，不能包含控制字符");
  }
  return value.trim();
}

function normalizeKey(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048 || /[\x00-\x1f\x7f]/.test(value)) {
    invalid("ttsAppKey", "必须是最多 2048 个字符的字符串，不能包含控制字符");
  }
  const key = value.trim();
  if (/[\*•●…]/.test(key) || /^(?:\[?redacted\]?|<redacted>|masked)$/i.test(key)) {
    invalid("ttsAppKey", "不能保存掩码占位符，请留空保留当前密钥");
  }
  return key;
}

export function mergeCdictUpstreamUpdate(value: unknown, current: CdictUpstreamRuntimeConfig): CdictUpstreamRuntimeConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("config", "必须是对象");
  const input = value as Record<string, unknown>;
  const next = { ...current };
  for (const field of ["translateBaseUrl", "ttsUrl"] as const) {
    if (Object.prototype.hasOwnProperty.call(input, field)) next[field] = normalizeCdictUpstreamUrl(input[field], field);
  }
  for (const field of ["translateAppId", "ttsAppId"] as const) {
    if (Object.prototype.hasOwnProperty.call(input, field)) next[field] = normalizeId(input[field], field);
  }
  if (Object.prototype.hasOwnProperty.call(input, "clearTtsAppKey") && typeof input.clearTtsAppKey !== "boolean") {
    invalid("clearTtsAppKey", "必须是布尔值");
  }
  // Validate even when clearing, so a masked placeholder is never accepted as a write.
  const key = Object.prototype.hasOwnProperty.call(input, "ttsAppKey") ? normalizeKey(input.ttsAppKey) : "";
  next.ttsAppKey = input.clearTtsAppKey === true ? "" : key || current.ttsAppKey;
  return next;
}

/** Missing fields inherit deployment defaults; an explicitly stored empty key does NOT. */
export function normalizeStoredCdictUpstreamConfig(value: unknown, defaults: CdictUpstreamRuntimeConfig): CdictUpstreamRuntimeConfig {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const next = { ...defaults };
  for (const field of ["translateBaseUrl", "ttsUrl"] as const) {
    if (input[field] === undefined) continue;
    try { next[field] = normalizeCdictUpstreamUrl(input[field], field); } catch { /* use deployment default */ }
  }
  for (const field of ["translateAppId", "ttsAppId"] as const) {
    if (input[field] === undefined) continue;
    try { next[field] = normalizeId(input[field], field); } catch { /* use deployment default */ }
  }
  if (Object.prototype.hasOwnProperty.call(input, "ttsAppKey")) {
    // Corrupt stored credentials fail closed, rather than reviving an env key.
    try { next.ttsAppKey = normalizeKey(input.ttsAppKey); } catch { next.ttsAppKey = ""; }
  }
  return next;
}

export function buildCdictUpstreamDefaultsFromEnv(env: NodeJS.ProcessEnv): CdictUpstreamRuntimeConfig {
  return normalizeStoredCdictUpstreamConfig({
    translateBaseUrl: env.VIVO_TRANSLATE_BASE_URL?.trim() || undefined,
    translateAppId: env.VIVO_TRANSLATE_APP_ID?.trim() || undefined,
    ttsUrl: env.VIVO_TTS_URL?.trim() || undefined,
    ttsAppId: env.VIVO_TTS_APP_ID?.trim() || undefined,
    ttsAppKey: env.VIVO_TTS_APP_KEY?.trim() || "",
  }, CDICT_UPSTREAM_DEFAULTS);
}

export function maskedCdictUpstreamSetting(config: CdictUpstreamRuntimeConfig) {
  return { ...config, ttsAppKey: config.ttsAppKey ? "********" : "", hasTtsAppKey: Boolean(config.ttsAppKey) };
}
