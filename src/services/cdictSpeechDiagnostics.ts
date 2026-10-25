type SpeechFailureReason = "configuration_missing" | "configuration_invalid" | "http_error" |
  "transport_error" | "upstream_rejected" | "empty_audio" | "unexpected_content_type" |
  "audio_conversion_failed" | "unexpected_failure";
export interface CDictSpeechDiagnostic {
  reason: SpeechFailureReason;
  setting?: "VIVO_TTS_APP_KEY" | "VIVO_TTS_URL";
  upstreamStatus?: number;
  transportCode?: string;
  causeCode?: string;
  upstreamCode?: number;
  upstreamContentType?: string;
  responseBytes?: number;
}
export class CDictSpeechError extends Error {
  constructor(message: string, public readonly diagnostic: CDictSpeechDiagnostic) {
    super(message);
    this.name = "CDictSpeechError";
  }
}
const TRANSPORT_CODES = new Set(["ECONNABORTED", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED",
  "ENOTFOUND", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "EPIPE", "ERR_NETWORK",
  "ERR_BAD_REQUEST", "ERR_BAD_RESPONSE", "ERR_CANCELED", "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "CDICT_UPSTREAM_ADDRESS_REJECTED"]);
const CONTENT_TYPES = new Set(["audio/mpeg", "audio/wav", "audio/x-wav", "audio/l16", "audio/pcm",
  "application/json", "application/octet-stream", "text/html", "text/plain"]);
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function businessCode(value: unknown): number | undefined {
  const code = typeof value === "string" && /^-?\d{1,9}$/.test(value) ? Number(value) : value;
  return typeof code === "number" && Number.isInteger(code) && Math.abs(code) <= 999999999 ? code : undefined;
}
export function safeCDictTransportCode(value: unknown): string | undefined {
  return typeof value === "string" && TRANSPORT_CODES.has(value) ? value : undefined;
}
function responseBody(value: unknown): Record<string, unknown> {
  if (Buffer.isBuffer(value) || value instanceof ArrayBuffer || typeof value === "string") {
    const size = typeof value === "string" ? Buffer.byteLength(value) : value instanceof ArrayBuffer ? value.byteLength : value.length;
    if (size > 8192) return {};
    const text = typeof value === "string" ? value
      : value instanceof ArrayBuffer ? Buffer.from(value).toString("utf8") : value.toString("utf8");
    try { return record(JSON.parse(text)); } catch { return {}; }
  }
  return record(value);
}
export function cdictSpeechResponseMetadata(value: unknown): Omit<CDictSpeechDiagnostic, "reason"> {
  const response = record(value);
  const result: Omit<CDictSpeechDiagnostic, "reason"> = {};
  if (typeof response.status === "number" && Number.isInteger(response.status) && response.status >= 100 && response.status <= 599) {
    result.upstreamStatus = response.status;
  }
  const type = record(response.headers)["content-type"];
  if (typeof type === "string") {
    const mediaType = type.split(";", 1)[0].trim().toLowerCase();
    result.upstreamContentType = CONTENT_TYPES.has(mediaType) ? mediaType : "other";
  }
  const data = response.data;
  if (Buffer.isBuffer(data)) result.responseBytes = data.length;
  else if (data instanceof ArrayBuffer) result.responseBytes = data.byteLength;
  else if (typeof data === "string") result.responseBytes = Buffer.byteLength(data);
  const body = responseBody(data);
  const codes = [record(body.errorResult).errorCode, body.code, body.retcode].map(businessCode);
  const code = codes.find(value => value !== undefined && value !== 0) ?? codes.find(value => value !== undefined);
  if (code !== undefined) result.upstreamCode = code;
  return result;
}
export function cdictSpeechTransportDiagnostic(error: unknown): CDictSpeechDiagnostic {
  const failure = record(error);
  const metadata = cdictSpeechResponseMetadata(failure.response);
  const diagnostic: CDictSpeechDiagnostic = {
    reason: metadata.upstreamStatus ? "http_error" : "transport_error", ...metadata,
  };
  const code = safeCDictTransportCode(failure.code);
  const causeCode = safeCDictTransportCode(record(failure.cause).code);
  if (code) diagnostic.transportCode = code;
  if (causeCode) diagnostic.causeCode = causeCode;
  return diagnostic;
}
export function cdictSpeechFailureDiagnostic(error: unknown, conversion = false): CDictSpeechDiagnostic {
  return error instanceof CDictSpeechError ? error.diagnostic
    : { reason: conversion ? "audio_conversion_failed" : "unexpected_failure" };
}
