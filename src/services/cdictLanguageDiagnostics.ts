import { redactSecret } from "./proxycheckParsing";
import type { CDictSpeechDiagnostic } from "./cdictSpeechDiagnostics";

export interface CDictLanguageDiagnostic extends Omit<Partial<CDictSpeechDiagnostic>, "upstreamCode"> {
  upstreamCode?: number | "invalid" | null;
  upstreamRetcode?: number | "invalid" | null;
  upstreamMethod?: "GET" | "POST";
  compatibilityRetried?: boolean;
  previousUpstreamStatus?: number;
  upstreamMessage: string;
  messageState: "provided" | "empty" | "missing";
  serviceRegion?: string;
  upstreamRequestId?: string | null;
  responseShape: string;
  dataShape: string;
  knownFields: string[];
  listSizes: Record<string, number>;
}
export class CDictLanguageRequestError extends Error {
  constructor(message: string, public readonly diagnostic: CDictLanguageDiagnostic) {
    super(message);
    this.name = "CDictLanguageRequestError";
  }
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function shape(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}
function code(value: unknown): number | "invalid" | null {
  if (value === null) return null;
  const numeric = typeof value === "string" && /^-?\d{1,9}$/.test(value) ? Number(value) : value;
  return typeof numeric === "number" && Number.isInteger(numeric) && Math.abs(numeric) <= 999999999 ? numeric : "invalid";
}
export function sanitizeCDictLanguageMessage(value: string, secrets: readonly string[] = []): string {
  let text = value;
  for (const secret of secrets) {
    if (!secret) continue;
    const variants = [secret, Buffer.from(secret).toString("base64")];
    try { variants.push(encodeURIComponent(secret)); } catch { /* A malformed Unicode secret must not break diagnostics. */ }
    for (const encoded of variants) {
      text = redactSecret(text, encoded);
    }
  }
  return text.replace(/https?:\/\/[^\s<>"']+/gi, "[URL]")
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, "[credentials]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/(["']?(?:app[_-]?key|api[_-]?key|key|token|secret|password|signature|authorization|cookie|sign)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, "$1[redacted]")
    .replace(/\b[a-f0-9]{32,}\b/gi, "[redacted]")
    .replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 256);
}
export function describeCDictLanguageResponse(value: unknown, secrets: readonly string[] = []): CDictLanguageDiagnostic {
  const root = record(value), data = record(root.data);
  const messages = [root.msg, root.message, root.error].filter((item): item is string => typeof item === "string");
  const message = messages.find(item => item.trim()) ?? messages[0];
  const result: CDictLanguageDiagnostic = {
    upstreamMessage: sanitizeCDictLanguageMessage(message ?? "", secrets),
    messageState: message === undefined ? "missing" : message.trim() ? "provided" : "empty",
    responseShape: shape(value), dataShape: shape(root.data),
    knownFields: ["code", "retcode", "success", "error", "msg", "message", "requestId", "serviceRegion", "data", "langs", "languages", "list"]
      .filter(key => Object.prototype.hasOwnProperty.call(root, key)),
    listSizes: {},
  };
  if (Object.prototype.hasOwnProperty.call(root, "code")) result.upstreamCode = code(root.code);
  if (Object.prototype.hasOwnProperty.call(root, "retcode")) result.upstreamRetcode = code(root.retcode);
  if (typeof root.serviceRegion === "string") {
    result.serviceRegion = new Set(["cn", "asia", "us", "eu", "global", "uk", "jp", "kr", "in", "hk", "tw"])
      .has(root.serviceRegion.toLowerCase()) ? root.serviceRegion.toLowerCase() : "other";
  }
  if (root.requestId === null) result.upstreamRequestId = null;
  else if (typeof root.requestId === "string") {
    const id = root.requestId;
    result.upstreamRequestId = /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i.test(id)
      && !secrets.some(secret => secret && id.toLowerCase().includes(secret.toLowerCase())) ? id : "[redacted]";
  }
  for (const [name, list] of Object.entries({ response: value, data: root.data, "data.langs": data.langs,
    "data.list": data.list, "data.languages": data.languages, list: root.list, languages: root.languages, langs: root.langs })) {
    if (Array.isArray(list)) result.listSizes[name] = list.length;
  }
  return result;
}
