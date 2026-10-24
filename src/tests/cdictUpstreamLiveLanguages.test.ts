import { config } from "../config/config";
import { fetchLanguageList } from "../services/cdictUpstreamService";

// Opt-in CI probe only. No axios/service mock, Mongo connection, TTS invocation or credentials.
const live = process.env.CDICT_LIVE_LANGUAGE_CHECK === "1" ? describe : describe.skip;

live("CDict upstream live language protocol", () => {
  it("returns a successful, nonempty language list through the real POST transport", async () => {
    const payload = await fetchLanguageList(); // one bounded real request, no retry loop
    expect(payload).not.toBeNull();
    expect(typeof payload).toBe("object");
    const root = !Array.isArray(payload) ? payload as Record<string, unknown> : {};
    for (const key of ["code", "retcode"] as const) {
      if (root[key] !== undefined && Number(root[key]) !== 0) {
        let message = typeof root.msg === "string" ? root.msg : typeof root.message === "string" ? root.message : "";
        const credential = config.cdictUpstream.ttsAppKey;
        if (credential) message = message.replaceAll(credential, "[REDACTED]");
        message = message.replace(/https?:\/\/\S+/gi, "[URL]")
          .replace(/(?:key|token|secret|signature)\s*[=:]\s*\S+/gi, "[REDACTED]").slice(0, 200);
        throw new Error(`语言列表上游业务失败 ${key}=${Number.isFinite(Number(root[key])) ? Number(root[key]) : "invalid"} ${message}`);
      }
      if (root[key] !== undefined) expect(Number(root[key])).toBe(0);
    }
    expect(root.success).not.toBe(false);
    expect(root.error).toBeFalsy();
    const data = root.data && typeof root.data === "object" && !Array.isArray(root.data)
      ? root.data as Record<string, unknown> : {};
    // Same response shapes understood by the official downstream Android client.
    const candidates = [payload, root.data, data.list, data.languages, root.list, root.languages, root.langs];
    const languages = new Set<string>();
    for (const list of candidates) {
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        const code = typeof item === "string" ? item : item && typeof item === "object"
          ? ["code", "lang", "langCode", "name"].map((key) => item[key]).find((value) => typeof value === "string" && value.trim()) : undefined;
        if (typeof code === "string" && code.trim()) languages.add(code.trim());
      }
    }
    // A 200 error envelope, HTML string or empty/unknown structure is NOT success.
    if (languages.size === 0) {
      throw new Error(`语言列表为空或结构未知，rootKeys=${Object.keys(root).join(",")} dataKeys=${Object.keys(data).join(",")}`);
    }
    expect(languages.size).toBeGreaterThan(0);
  }, 30_000);
});
