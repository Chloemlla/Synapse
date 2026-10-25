import { EventEmitter } from "node:events";
import { EdgeHandshakeError, EdgeTtsClient, type EdgeWebSocketLike } from "../tts/edge/edge.client";
import { EDGE_DEFAULT_BASE_URL } from "../config/ttsProviderConfig";
import { EDGE_SEC_MS_GEC_VERSION } from "../tts/edge/edge.protocol";
import { generateEdgeSecMsGec } from "../tts/edge/edge.drm";

const NOW = Date.parse("2026-10-25T00:00:00Z");
const input = { text: "Hello.", voice: "en-US-AriaNeural", speed: 1, baseUrl: EDGE_DEFAULT_BASE_URL };
function socket() {
  return Object.assign(new EventEmitter(), { send: jest.fn(), close: jest.fn(), terminate: jest.fn() });
}
function audio(target: ReturnType<typeof socket>) {
  const headers = Buffer.from("Path:audio\r\nContent-Type:audio/mpeg\r\n");
  const size = Buffer.alloc(2); size.writeUInt16BE(headers.length);
  target.emit("message", Buffer.concat([size, headers, Buffer.from("ID3sample")]), true);
  target.emit("message", Buffer.from("Path:turn.end\r\n\r\n"), false);
}
beforeEach(() => { jest.spyOn(Date, "now").mockReturnValue(NOW); });
afterEach(() => { jest.restoreAllMocks(); });

describe("Microsoft handshake v2 and clock correction", () => {
  it("sends a matched v2 version/token and completes real frame parsing", async () => {
    const target = socket(); const fetch = jest.fn();
    const factory = jest.fn((_url: string) => { queueMicrotask(() => audio(target)); return target as unknown as EdgeWebSocketLike; });
    const client = new EdgeTtsClient(factory, fetch);
    const result = await client.synthesize(input);
    const url = new URL(factory.mock.calls[0][0]);
    expect(EDGE_SEC_MS_GEC_VERSION).toBe("2-143.0.3650.75");
    expect(url.searchParams.get("Sec-MS-GEC-Version")).toBe(EDGE_SEC_MS_GEC_VERSION);
    expect(url.searchParams.get("Sec-MS-GEC")).toBe(generateEdgeSecMsGec(NOW));
    expect(url.searchParams.get("Sec-MS-GEC")).toMatch(/^[0-9A-F]{16}-[0-9A-F]{64}$/);
    expect(result.audio).toEqual(Buffer.from("ID3sample"));
    expect(fetch).not.toHaveBeenCalled();
    expect(target.close).toHaveBeenCalledTimes(1);
  });

  it("does not call a 403 clock skew or retry when Date matches", async () => {
    const target = socket(); const fetch = jest.fn();
    const factory = jest.fn((_url: string) => {
      queueMicrotask(() => target.emit("unexpected-response", {}, { statusCode: 403, headers: { date: new Date(NOW).toUTCString() } }));
      return target as unknown as EdgeWebSocketLike;
    });
    const client = new EdgeTtsClient(factory, fetch);
    await expect(client.synthesize(input)).rejects.toMatchObject({ upstreamStatusCode: 403, code: "TTS_UPSTREAM_AUTH_FAILED", retryable: false });
    expect(new EdgeHandshakeError(403).message).not.toContain("时钟偏差");
    expect(factory).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the handshake Date and never accumulates the same absolute offset", async () => {
    const targets: Array<ReturnType<typeof socket>> = [];
    const fetch = jest.fn();
    const factory = jest.fn((_url: string) => {
      const target = socket(); targets.push(target);
      queueMicrotask(() => target.emit("unexpected-response", {}, { statusCode: 403, headers: { date: new Date(NOW + 120_000).toUTCString() } }));
      return target as unknown as EdgeWebSocketLike;
    });
    const client = new EdgeTtsClient(factory, fetch);
    await expect(client.synthesize(input)).rejects.toBeInstanceOf(EdgeHandshakeError);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(client.getClockSkewSeconds()).toBe(120);
    expect(new URL(factory.mock.calls[1][0]).searchParams.get("Sec-MS-GEC")).toBe(generateEdgeSecMsGec(NOW, 120));
    expect(targets.every(target => target.close.mock.calls.length === 1)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retries successfully after an actual skew change", async () => {
    let attempt = 0;
    const factory = jest.fn((_url: string) => {
      const target = socket(); const first = attempt++ === 0;
      queueMicrotask(() => first ? target.emit("unexpected-response", {}, { statusCode: 403, headers: { date: new Date(NOW + 300_000).toUTCString() } }) : audio(target));
      return target as unknown as EdgeWebSocketLike;
    });
    const client = new EdgeTtsClient(factory, jest.fn());
    expect((await client.synthesize(input)).audio).toEqual(Buffer.from("ID3sample"));
    expect(factory).toHaveBeenCalledTimes(2);
    expect(client.getClockSkewSeconds()).toBe(300);
  });

  it("aborts a missing-Date fallback lookup instead of waiting for its timeout", async () => {
    const target = socket(); const controller = new AbortController();
    let started!: () => void; const arrived = new Promise<void>(resolve => { started = resolve; });
    let signal!: AbortSignal;
    const fetch = jest.fn((_url: string | URL | Request, options?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      signal = options!.signal as AbortSignal; signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); started();
    }));
    const factory = jest.fn((_url: string) => {
      queueMicrotask(() => target.emit("unexpected-response", {}, { statusCode: 403, headers: {} }));
      return target as unknown as EdgeWebSocketLike;
    });
    const client = new EdgeTtsClient(factory, fetch);
    const pending = client.synthesize({ ...input, signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ code: "TTS_ABORTED", retryable: false });
    await arrived; controller.abort(); await rejected;
    expect(signal.aborted).toBe(true);
    expect(factory).toHaveBeenCalledTimes(1);
  });
});
