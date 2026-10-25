import { resolveEnabledTtsProviders, type TtsProviderOption } from "../config/ttsProviderConfig";
import { RuntimeConfigService } from "./runtimeConfigService";
import type { CDictAudio } from "./cdictUpstreamService";
import { EdgeHandshakeError, EdgeTtsClient } from "../tts/edge/edge.client";
import { TtsGenerationError } from "../tts/tts.errors";
import { EDGE_SEC_MS_GEC_VERSION } from "../tts/edge/edge.protocol";
import { resolveEdgeVoiceOptions } from "../tts/edge/edge.voices";
import { assertAudioResponse } from "../tts/tts.provider";

const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const LANGUAGE_CODE = /^[A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?$/;
const LOCALE_ALIASES: Readonly<Record<string, string>> = {
  "en-usa": "en-us", "en-gbr": "en-gb", "zh-chs": "zh-cn", "zh-cht": "zh-tw",
};
const PREFERRED_VOICES: Readonly<Record<string, string>> = {
  "en-us": "en-US-AriaNeural",
  "en-gb": "en-GB-SoniaNeural",
  "zh-cn": "zh-CN-XiaoxiaoNeural",
  "zh-tw": "zh-TW-HsiaoChenNeural",
};
// Explicit English accents and Chinese locales must not silently change dialect.
const STRICT_LOCALES = new Set([...Object.keys(PREFERRED_VOICES), "zh-hk"]);

type SpeechFailureCategory = "invalid_input" | "provider_disabled" | "language_unavailable" |
  "invalid_audio" | "audio_too_large" | "upstream_failed" | "cancelled";

const DIAGNOSTIC_CODES = new Set(["TTS_UPSTREAM_AUTH_FAILED", "TTS_UPSTREAM_UNAVAILABLE",
  "TTS_UPSTREAM_TIMEOUT", "TTS_ABORTED", "TTS_EMPTY_PROVIDER_RESPONSE", "TTS_INVALID_PROVIDER_RESPONSE"]);
interface SpeechDiagnostic { code?: string; statusCode?: number; upstreamStatusCode?: number; protocolVersion?: string }

/** Only bounded diagnostic fields cross this boundary; never forward upstream URLs or text. */
export class CDictMicrosoftSpeechError extends Error {
  constructor(public readonly category: SpeechFailureCategory, public readonly diagnostic: SpeechDiagnostic = {}) {
    super("CDict Microsoft speech failed");
    this.name = "CDictMicrosoftSpeechError";
  }
}

/** Pure validation is also used by the controller before any config/network IO. */
export function normalizeMicrosoftSpeechLocale(langType: string): string | null {
  const code = langType.trim().toLowerCase();
  if (code === "auto" || !LANGUAGE_CODE.test(code)) return null;
  return Object.prototype.hasOwnProperty.call(LOCALE_ALIASES, code) ? LOCALE_ALIASES[code] : code;
}

function chooseVoice(locale: string, catalog: TtsProviderOption[], defaultVoice: string): string {
  const exact = catalog.filter((voice) => voice.id.toLowerCase().startsWith(`${locale}-`));
  const candidates = exact.length > 0 || STRICT_LOCALES.has(locale)
    ? exact
    : catalog.filter((voice) => voice.id.toLowerCase().startsWith(`${locale.split("-")[0]}-`));
  // A default is usable only inside the requested language's current catalog subset.
  const preferred = PREFERRED_VOICES[locale];
  const voice = candidates.find((entry) => entry.id === preferred) ||
    candidates.find((entry) => entry.id === defaultVoice) || candidates[0];
  if (!voice) throw new CDictMicrosoftSpeechError("language_unavailable");
  return voice.id;
}

function assertNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new CDictMicrosoftSpeechError("cancelled");
}

/** CDict short reading only: no jobs, history, shared files, quota writes or provider fallback. */
export async function synthesizeMicrosoftSpeech(
  text: string, langType: string, signal?: AbortSignal,
): Promise<CDictAudio> {
  const locale = normalizeMicrosoftSpeechLocale(langType);
  const input = text.trim();
  if (!input || input.length > 300 || !locale) throw new CDictMicrosoftSpeechError("invalid_input");
  assertNotCancelled(signal);
  try {
    const runtime = await RuntimeConfigService.getRawTtsProviderConfig();
    assertNotCancelled(signal);
    if (!resolveEnabledTtsProviders(runtime).includes("edge")) {
      throw new CDictMicrosoftSpeechError("provider_disabled");
    }
    const voice = chooseVoice(locale, resolveEdgeVoiceOptions(runtime.edge.voices), runtime.edge.defaultVoice);
    const result = await new EdgeTtsClient().synthesize({
      text: input, voice, speed: 1, baseUrl: runtime.edge.baseUrl, signal,
    });
    assertNotCancelled(signal);
    if (result.audio.length > MAX_AUDIO_BYTES) throw new CDictMicrosoftSpeechError("audio_too_large");
    try {
      assertAudioResponse(result.contentType, result.audio, "mp3");
    } catch {
      throw new CDictMicrosoftSpeechError("invalid_audio");
    }
    return { contentType: "audio/mpeg", data: result.audio };
  } catch (error) {
    assertNotCancelled(signal);
    if (error instanceof CDictMicrosoftSpeechError) throw error;
    const diagnostic: SpeechDiagnostic = {};
    if (error instanceof TtsGenerationError) {
      if (DIAGNOSTIC_CODES.has(error.code)) diagnostic.code = error.code;
      if (Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode <= 599) diagnostic.statusCode = error.statusCode;
    }
    if (error instanceof EdgeHandshakeError && Number.isInteger(error.upstreamStatusCode)
      && error.upstreamStatusCode >= 100 && error.upstreamStatusCode <= 599) {
      diagnostic.upstreamStatusCode = error.upstreamStatusCode;
      diagnostic.protocolVersion = EDGE_SEC_MS_GEC_VERSION;
    }
    throw new CDictMicrosoftSpeechError("upstream_failed", diagnostic);
  }
}
