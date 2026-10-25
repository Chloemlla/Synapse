import { describeCDictLanguageResponse, sanitizeCDictLanguageMessage } from "../services/cdictLanguageDiagnostics";

it("shows an empty upstream error message honestly and retains the known response shape", () => {
  expect(describeCDictLanguageResponse({ code: 10000, data: null, msg: "", requestId: null, serviceRegion: "cn" }))
    .toEqual({ upstreamCode: 10000, upstreamMessage: "", messageState: "empty", upstreamRequestId: null,
      serviceRegion: "cn", responseShape: "object", dataShape: "null", listSizes: {},
      knownFields: ["code", "msg", "requestId", "serviceRegion", "data"] });
});
it("retains supplied business error text while redacting known credentials and URL echoes", () => {
  const key = "private-key-123";
  const result = describeCDictLanguageResponse({ code: 20000, msg: `参数非法 appKey=${key} https://gateway.example/?key=${key}\n`,
    data: { langs: [] }, hiddenSecret: key }, [key]);
  expect(result.upstreamCode).toBe(20000);
  expect(result.upstreamMessage).toContain("参数非法");
  expect(result.upstreamMessage).toContain("[redacted]");
  expect(result.upstreamMessage).not.toContain(key);
  expect(result.upstreamMessage).not.toContain("gateway.example");
  expect(result.upstreamMessage).not.toContain("\n");
  expect(result.listSizes).toEqual({ "data.langs": 0 });
  expect(result.knownFields).not.toContain("hiddenSecret");
});
it("distinguishes missing messages, invalid codes and unknown service region values", () => {
  const result = describeCDictLanguageResponse({ code: "SECRET", retcode: null, serviceRegion: "SECRET", requestId: "SECRET" });
  expect(result).toMatchObject({ upstreamCode: "invalid", upstreamRetcode: null, messageState: "missing",
    upstreamMessage: "", serviceRegion: "other", upstreamRequestId: "[redacted]" });
  expect(JSON.stringify(result)).not.toContain("SECRET");
});
it("uses a nonempty alternate message and shows only fixed list paths", () => {
  const result = describeCDictLanguageResponse({ msg: "", message: "参数非法", code: 0, retcode: 10000,
    data: { langs: ["en", "zh-CHS"], secret: "PRIVATE" } });
  expect(result).toMatchObject({ upstreamMessage: "参数非法", messageState: "provided", upstreamCode: 0,
    upstreamRetcode: 10000, listSizes: { "data.langs": 2 }, dataShape: "object" });
  expect(JSON.stringify(result)).not.toContain("PRIVATE");
});
it("scrubs encoded credentials before truncating messages, and never fails on malformed Unicode", () => {
  const secret = "private&credential";
  for (const value of [secret, encodeURIComponent(secret), Buffer.from(secret).toString("base64")]) {
    expect(sanitizeCDictLanguageMessage(value, [secret])).toBe("[redacted]");
  }
  expect(sanitizeCDictLanguageMessage("x".repeat(250) + secret, [secret])).not.toContain("private");
  expect(sanitizeCDictLanguageMessage("safe", ["\ud800"])).toBe("safe");
  expect(sanitizeCDictLanguageMessage("x".repeat(500))).toHaveLength(256);
});
