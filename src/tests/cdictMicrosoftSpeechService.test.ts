import { EventEmitter } from "node:events";
import { EDGE_DEFAULT_BASE_URL, type TtsProviderRuntimeConfig } from "../config/ttsProviderConfig";
import { RuntimeConfigService } from "../services/runtimeConfigService";
import {
  CDictMicrosoftSpeechError, normalizeMicrosoftSpeechLocale, synthesizeMicrosoftSpeech,
} from "../services/cdictMicrosoftSpeechService";
import { EdgeTtsClient, type EdgeSynthesisInput } from "../tts/edge/edge.client";

const mp3 = Buffer.from("ID3test-audio");
const realSynthesize = EdgeTtsClient.prototype.synthesize;
let loadConfig: jest.SpiedFunction<typeof RuntimeConfigService.getRawTtsProviderConfig>;
let synthesize: jest.SpiedFunction<EdgeTtsClient["synthesize"]>;

function runtime(edge: Partial<TtsProviderRuntimeConfig["edge"]> = {}): TtsProviderRuntimeConfig {
  return {
    provider: "fish", enabledProviders: ["fish", "edge"], defaultModel: "s2.1-pro-free",
    fish: { apiKey: "", baseUrl: "https://api.fish.audio", referenceId: "" },
    edge: { baseUrl: EDGE_DEFAULT_BASE_URL, defaultVoice: "zh-CN-XiaoxiaoNeural", voices: [], ...edge },
  };
}
function voices(...ids: string[]) {
  return ids.map((id) => ({ id, name: id }));
}

beforeEach(() => {
  loadConfig = jest.spyOn(RuntimeConfigService, "getRawTtsProviderConfig").mockResolvedValue(runtime());
  synthesize = jest.spyOn(EdgeTtsClient.prototype, "synthesize")
    .mockResolvedValue({ contentType: "audio/mpeg", audio: mp3 });
});
afterEach(() => jest.restoreAllMocks());

describe("CDict Microsoft short speech", () => {
  it.each([
    ["en-USA", "en-us"], ["en-GBR", "en-gb"], ["zh-CHS", "zh-cn"], ["zh-CHT", "zh-tw"],
    ["zh-HK", "zh-hk"], [" EN-usa ", "en-us"], ["fr", "fr"], ["fr-CA", "fr-ca"],
  ])("normalizes %s without confusing accents", (language, locale) => {
    expect(normalizeMicrosoftSpeechLocale(language)).toBe(locale);
  });

  it.each(["", "auto", "AUTO", "../en", "bad_code", "zh-CHS?token=secret"])
    ("rejects invalid or undetected language %s before config IO", async (language) => {
      expect(normalizeMicrosoftSpeechLocale(language)).toBeNull();
      await expect(synthesizeMicrosoftSpeech("hello", language)).rejects.toMatchObject({ category: "invalid_input" });
      expect(loadConfig).not.toHaveBeenCalled();
      expect(synthesize).not.toHaveBeenCalled();
    });

  it.each(["", " \n ", "x".repeat(301)])("validates text before IO", async (text) => {
    await expect(synthesizeMicrosoftSpeech(text, "en-USA")).rejects.toMatchObject({ category: "invalid_input" });
    expect(loadConfig).not.toHaveBeenCalled();
    expect(synthesize).not.toHaveBeenCalled();
  });

  it.each([
    ["en-USA", "en-US-AriaNeural"], ["en-GBR", "en-GB-SoniaNeural"],
    ["zh-CHS", "zh-CN-XiaoxiaoNeural"], ["zh-CHT", "zh-TW-HsiaoChenNeural"],
    ["zh-HK", "zh-HK-HiuGaaiNeural"],
  ])("uses the catalog's correct voice for %s even with fish primary", async (language, voice) => {
    const signal = new AbortController().signal;
    expect(await synthesizeMicrosoftSpeech("hello", language, signal))
      .toEqual({ contentType: "audio/mpeg", data: mp3 });
    expect(loadConfig).toHaveBeenCalledTimes(1);
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(synthesize).toHaveBeenCalledWith({
      text: "hello", voice, speed: 1, baseUrl: EDGE_DEFAULT_BASE_URL, signal,
    });
  });

  it.each([
    ["en-USA", "en-US-AriaNeural"], ["en-GBR", "en-GB-SoniaNeural"],
    ["zh-CHS", "zh-CN-XiaoxiaoNeural"], ["zh-CHT", "zh-TW-HsiaoChenNeural"],
  ])("prefers common %s voice over an alternate default", async (language, preferred) => {
    const alternative = preferred.slice(0, preferred.lastIndexOf("-") + 1) + "AlternateNeural";
    loadConfig.mockResolvedValue(runtime({ defaultVoice: alternative, voices: voices(alternative, preferred) }));
    await synthesizeMicrosoftSpeech("hello", language);
    expect(synthesize).toHaveBeenCalledWith(expect.objectContaining({ voice: preferred }));
  });

  it("accepts the exact text limit and makes a single synthesis call", async () => {
    await synthesizeMicrosoftSpeech("x".repeat(300), "en-USA");
    expect(synthesize).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ...runtime(), enabledProviders: ["fish"] as TtsProviderRuntimeConfig["enabledProviders"] },
    { ...runtime(), enabledProviders: undefined },
  ])("never connects or fetches a catalog when edge is disabled", async (config) => {
    loadConfig.mockResolvedValue(config);
    const fetchCatalog = jest.spyOn(EdgeTtsClient.prototype, "fetchVoiceCatalog");
    await expect(synthesizeMicrosoftSpeech("hello", "en-USA")).rejects.toMatchObject({ category: "provider_disabled" });
    expect(synthesize).not.toHaveBeenCalled();
    expect(fetchCatalog).not.toHaveBeenCalled();
  });

  it("allows legacy edge-primary configuration through the enabled-provider resolver", async () => {
    loadConfig.mockResolvedValue({ ...runtime(), provider: "edge", enabledProviders: undefined });
    await synthesizeMicrosoftSpeech("hello", "en-USA");
    expect(synthesize).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["fr-CA", "fr-CA-SylvieNeural"], ["fr-BE", "fr-FR-DeniseNeural"], ["fr", "fr-FR-DeniseNeural"],
  ])("selects exact locale then same-language catalog candidates for %s", async (language, voice) => {
    loadConfig.mockResolvedValue(runtime({
      voices: voices("zh-CN-XiaoxiaoNeural", "fr-FR-DeniseNeural", "fr-CA-SylvieNeural"),
    }));
    await synthesizeMicrosoftSpeech("bonjour", language);
    expect(synthesize).toHaveBeenCalledWith(expect.objectContaining({ voice }));
  });

  it("uses a configured default only when it matches the requested locale", async () => {
    loadConfig.mockResolvedValue(runtime({
      defaultVoice: "en-US-JennyNeural", voices: voices("zh-CN-XiaoxiaoNeural", "en-US-GuyNeural", "en-US-JennyNeural"),
    }));
    await synthesizeMicrosoftSpeech("hello", "en-USA");
    expect(synthesize).toHaveBeenCalledWith(expect.objectContaining({ voice: "en-US-JennyNeural" }));
  });

  it.each([
    ["xx", voices("zh-CN-XiaoxiaoNeural")], ["zz-XX", voices("zh-CN-XiaoxiaoNeural")],
    ["en-GBR", voices("en-US-AriaNeural")], ["zh-CHT", voices("zh-CN-XiaoxiaoNeural")],
    ["zh-HK", voices("zh-CN-XiaoxiaoNeural", "zh-TW-HsiaoChenNeural")],
  ] as const)("does not use Chinese or another explicit dialect for unavailable %s", async (language, catalog) => {
    loadConfig.mockResolvedValue(runtime({ voices: catalog }));
    await expect(synthesizeMicrosoftSpeech("hello", language)).rejects.toMatchObject({ category: "language_unavailable" });
    expect(synthesize).not.toHaveBeenCalled();
  });

  it("reads changed address, catalog and enablement on the next request without reimport", async () => {
    loadConfig.mockResolvedValueOnce(runtime({ baseUrl: "wss://first.example/speech", voices: voices("en-US-JennyNeural") }))
      .mockResolvedValueOnce(runtime({ baseUrl: "wss://second.example/speech", voices: voices("en-US-GuyNeural") }))
      .mockResolvedValueOnce({ ...runtime(), enabledProviders: ["fish"] });
    await synthesizeMicrosoftSpeech("first", "en-USA");
    await synthesizeMicrosoftSpeech("second", "en-USA");
    await expect(synthesizeMicrosoftSpeech("third", "en-USA")).rejects.toMatchObject({ category: "provider_disabled" });
    expect(loadConfig).toHaveBeenCalledTimes(3);
    expect(synthesize).toHaveBeenNthCalledWith(1, expect.objectContaining({ voice: "en-US-JennyNeural", baseUrl: "wss://first.example/speech" }));
    expect(synthesize).toHaveBeenNthCalledWith(2, expect.objectContaining({ voice: "en-US-GuyNeural", baseUrl: "wss://second.example/speech" }));
    expect(synthesize).toHaveBeenCalledTimes(2);
  });

  it.each([
    { contentType: "text/html", audio: mp3 }, { contentType: "application/json", audio: mp3 },
    { contentType: "audio/mpeg", audio: Buffer.from("<html>error</html>") },
    { contentType: "audio/mpeg", audio: Buffer.from("RIFFwrong-format") },
    { contentType: "audio/mpeg", audio: Buffer.alloc(0) },
  ])("rejects invalid audio with the existing validator", async (result) => {
    synthesize.mockResolvedValue(result);
    await expect(synthesizeMicrosoftSpeech("hello", "en-USA")).rejects.toMatchObject({ category: "invalid_audio" });
    expect(synthesize).toHaveBeenCalledTimes(1);
  });

  it("accepts exactly 8MiB and rejects larger audio", async () => {
    const exact = Buffer.alloc(8 * 1024 * 1024);
    exact.write("ID3");
    synthesize.mockResolvedValueOnce({ contentType: "audio/mpeg", audio: exact })
      .mockResolvedValueOnce({ contentType: "audio/mpeg", audio: Buffer.concat([exact, Buffer.from([0])]) });
    expect((await synthesizeMicrosoftSpeech("hello", "en-USA")).data).toBe(exact);
    await expect(synthesizeMicrosoftSpeech("hello", "en-USA")).rejects.toMatchObject({ category: "audio_too_large" });
  });

  it("sanitizes config and upstream errors and never adds retries", async () => {
    const unsafe = new Error("wss://private.example/speech?token=secret private-text");
    loadConfig.mockRejectedValueOnce(unsafe);
    await expect(synthesizeMicrosoftSpeech("private-text", "en-USA")).rejects.toEqual(new CDictMicrosoftSpeechError("upstream_failed"));
    expect(synthesize).not.toHaveBeenCalled();
    synthesize.mockRejectedValue(unsafe);
    await expect(synthesizeMicrosoftSpeech("private-text", "en-USA")).rejects.toMatchObject({
      message: "CDict Microsoft speech failed", category: "upstream_failed",
    });
    expect(synthesize).toHaveBeenCalledTimes(1);
  });

  it("does no IO for an already cancelled request", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(synthesizeMicrosoftSpeech("hello", "en-USA", controller.signal))
      .rejects.toMatchObject({ category: "cancelled" });
    expect(loadConfig).not.toHaveBeenCalled();
    expect(synthesize).not.toHaveBeenCalled();
  });

  it("does not connect if cancelled while loading runtime configuration", async () => {
    const controller = new AbortController();
    loadConfig.mockImplementationOnce(async () => { controller.abort(); return runtime(); });
    await expect(synthesizeMicrosoftSpeech("hello", "en-USA", controller.signal))
      .rejects.toMatchObject({ category: "cancelled" });
    expect(synthesize).not.toHaveBeenCalled();
  });

  it("passes cancellation to the real Edge client and closes its socket", async () => {
    const socket = Object.assign(new EventEmitter(), { send: jest.fn(), close: jest.fn(), terminate: jest.fn() });
    const createSocket = jest.fn(() => socket);
    const client = new EdgeTtsClient(createSocket);
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    synthesize.mockImplementation((input: EdgeSynthesisInput) => {
      const pending = realSynthesize.call(client, input);
      markStarted();
      return pending;
    });
    const controller = new AbortController();
    const pending = synthesizeMicrosoftSpeech("hello", "en-USA", controller.signal);
    const rejected = expect(pending).rejects.toMatchObject({ category: "cancelled" });
    await started;
    controller.abort();
    await rejected;
    expect(createSocket).toHaveBeenCalledTimes(1);
    expect(socket.close).toHaveBeenCalledTimes(1);
    expect(synthesize).toHaveBeenCalledTimes(1);
  });

  it("does not return audio if cancellation races with synthesis completion", async () => {
    const controller = new AbortController();
    synthesize.mockImplementationOnce(async () => {
      controller.abort();
      return { contentType: "audio/mpeg", audio: mp3 };
    });
    await expect(synthesizeMicrosoftSpeech("hello", "en-USA", controller.signal))
      .rejects.toMatchObject({ category: "cancelled" });
  });
});
