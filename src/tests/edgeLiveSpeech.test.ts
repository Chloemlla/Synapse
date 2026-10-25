import { EdgeTtsClient } from "../tts/edge/edge.client";
import { EDGE_DEFAULT_BASE_URL } from "../config/ttsProviderConfig";

// Opt-in CI only: a mock handshake cannot prove the current upstream accepts our protocol.
const live = process.env.EDGE_LIVE_SPEECH_CHECK === "1" ? describe : describe.skip;
live("Microsoft live speech protocol", () => {
  it.each(["en-US-AriaNeural", "zh-CN-XiaoxiaoNeural"])("returns real MP3 for %s", async voice => {
    const result = await new EdgeTtsClient().synthesize({
      text: voice.startsWith("en") ? "Hello." : "你好。", voice, speed: 1, baseUrl: EDGE_DEFAULT_BASE_URL,
    });
    expect(result.contentType).toMatch(/^audio\//);
    expect(result.audio.length).toBeGreaterThan(500);
    expect(result.audio.length).toBeLessThan(8 * 1024 * 1024);
    const frame = result.audio[0] === 0xff && (result.audio[1] & 0xe0) === 0xe0;
    expect(result.audio.toString("ascii", 0, 3) === "ID3" || frame).toBe(true);
  }, 90_000);
});
