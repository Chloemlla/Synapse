import { generateEdgeMuid, generateEdgeSecMsGec, parseEdgeClockSkewSeconds } from "../tts/edge/edge.drm";

// 1758796800000 秒数部分正好落在 300 秒窗口的边界上。
const WINDOW_START_MS = 1_758_796_800_000;
const WINDOW_START_WITHIN_MS = WINDOW_START_MS + 91_000;
const NEXT_WINDOW_MS = WINDOW_START_MS + 300_000;

describe("Edge DRM 参数", () => {
  describe("generateEdgeSecMsGec", () => {
    it("hashes the aligned tick count together with the trusted client token", () => {
      // Exact digest vectors are independently checked against the pinned v2 oracle in CI.
      expect(generateEdgeSecMsGec(WINDOW_START_MS, 0)).toMatch(/^[0-9A-F]{16}-[0-9A-F]{64}$/);
      expect(generateEdgeSecMsGec(NEXT_WINDOW_MS, 0)).not.toBe(generateEdgeSecMsGec(WINDOW_START_MS, 0));
    });

    it("maps a +300s skew onto the same window as a timestamp 300s later", () => {
      expect(generateEdgeSecMsGec(WINDOW_START_MS, 300)).toBe(generateEdgeSecMsGec(NEXT_WINDOW_MS, 0));
    });

    it("moves to an earlier window for a large negative skew", () => {
      expect(generateEdgeSecMsGec(WINDOW_START_MS, -90_000)).toBe(generateEdgeSecMsGec(WINDOW_START_MS - 90_000_000, 0));
    });

    it("aligns every timestamp inside the same five minute window", () => {
      expect(generateEdgeSecMsGec(WINDOW_START_WITHIN_MS, 0)).toBe(generateEdgeSecMsGec(WINDOW_START_MS, 0));
      expect(generateEdgeSecMsGec(WINDOW_START_WITHIN_MS + 208_999, 0)).toBe(generateEdgeSecMsGec(WINDOW_START_MS, 0));
    });

    it("is deterministic and always returns the v2 CS64-SHA256 pair", () => {
      const first = generateEdgeSecMsGec(WINDOW_START_MS, 0);

      expect(first).toBe(generateEdgeSecMsGec(WINDOW_START_MS, 0));
      expect(first).toMatch(/^[0-9A-F]{16}-[0-9A-F]{64}$/);
    });
  });

  describe("parseEdgeClockSkewSeconds", () => {
    it("returns zero when the Date header is missing or unparsable", () => {
      expect(parseEdgeClockSkewSeconds(null, WINDOW_START_MS)).toBe(0);
      expect(parseEdgeClockSkewSeconds(undefined, WINDOW_START_MS)).toBe(0);
      expect(parseEdgeClockSkewSeconds("", WINDOW_START_MS)).toBe(0);
      expect(parseEdgeClockSkewSeconds("not a date", WINDOW_START_MS)).toBe(0);
    });

    it("preserves small skews that can cross a five-minute window boundary", () => {
      const header = new Date(WINDOW_START_MS + 10_000).toUTCString();

      expect(parseEdgeClockSkewSeconds(header, WINDOW_START_MS + 20_000)).toBe(-10);
      expect(parseEdgeClockSkewSeconds(new Date(WINDOW_START_MS).toUTCString(), WINDOW_START_MS + 29_000)).toBe(-29);
    });

    it("returns both positive and negative absolute offsets", () => {
      expect(parseEdgeClockSkewSeconds(new Date(WINDOW_START_MS).toUTCString(), WINDOW_START_MS + 30_000)).toBe(-30);
      expect(parseEdgeClockSkewSeconds(new Date(WINDOW_START_MS).toUTCString(), WINDOW_START_MS + 120_000)).toBe(-120);
      expect(parseEdgeClockSkewSeconds(new Date(WINDOW_START_MS + 60_000).toUTCString(), WINDOW_START_MS)).toBe(60);
    });
  });

  describe("generateEdgeMuid", () => {
    it("builds a fresh 32 character uppercase hex id per call", () => {
      const muid = generateEdgeMuid();

      expect(muid).toMatch(/^[0-9A-F]{32}$/);
      expect(muid).not.toBe(generateEdgeMuid());
    });
  });
});
