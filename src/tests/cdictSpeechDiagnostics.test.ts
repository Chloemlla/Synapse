import { CDictSpeechError, cdictSpeechFailureDiagnostic, cdictSpeechResponseMetadata,
  cdictSpeechTransportDiagnostic } from "../services/cdictSpeechDiagnostics";

describe("CDict speech diagnostic projections", () => {
  it("retains numeric business failures without arbitrary upstream messages", () => {
    const data = Buffer.from('{"errorResult":{"errorCode":"20004","errorMsg":"SECRET"},"token":"SECRET"}');
    const diagnostic = cdictSpeechResponseMetadata({ status: 200, data,
      headers: { "content-type": "application/json; token=SECRET", authorization: "SECRET" } });
    expect(diagnostic).toEqual({ upstreamStatus: 200, upstreamCode: 20004,
      upstreamContentType: "application/json", responseBytes: data.length });
    expect(JSON.stringify(diagnostic)).not.toContain("SECRET");
    expect(cdictSpeechResponseMetadata({ data: { code: 0, retcode: "10000" } })).toEqual({ upstreamCode: 10000 });
  });
  it("reports HTTP and known network/TLS codes, never Axios config, bodies or messages", () => {
    const diagnostic = cdictSpeechTransportDiagnostic({ code: "ERR_BAD_RESPONSE", message: "SECRET",
      cause: { code: "CERT_HAS_EXPIRED", message: "SECRET" }, config: { data: "SECRET", headers: { cookie: "SECRET" } },
      response: { status: 503, data: { code: 20004, msg: "SECRET" }, headers: { "content-type": "text/html" } } });
    expect(diagnostic).toEqual({ reason: "http_error", upstreamStatus: 503, upstreamCode: 20004,
      upstreamContentType: "text/html", transportCode: "ERR_BAD_RESPONSE", causeCode: "CERT_HAS_EXPIRED" });
    expect(JSON.stringify(diagnostic)).not.toContain("SECRET");
    expect(cdictSpeechTransportDiagnostic({ code: "ENOTFOUND" })).toEqual({ reason: "transport_error", transportCode: "ENOTFOUND" });
  });
  it("drops unknown codes and MIME types rather than treating them as safe strings", () => {
    expect(cdictSpeechTransportDiagnostic({ code: "SECRET", cause: { code: "SECRET" },
      response: { status: "503", data: { errorResult: { errorCode: "SECRET" }, code: 1e10 },
        headers: { "content-type": "SECRET" } } })).toEqual({ reason: "transport_error", upstreamContentType: "other" });
  });
  it("bounds JSON parsing and retains only response size for large or binary data", () => {
    const huge = Buffer.from(JSON.stringify({ code: 20004, text: "SECRET".repeat(2000) }));
    expect(cdictSpeechResponseMetadata({ data: huge })).toEqual({ responseBytes: huge.length });
    const invalid = Buffer.from([0xff, 0x00, 0x80]);
    expect(cdictSpeechResponseMetadata({ data: invalid })).toEqual({ responseBytes: 3 });
    const bytes = new Uint8Array([0xff, 0x00]).buffer;
    expect(cdictSpeechResponseMetadata({ data: bytes })).toEqual({ responseBytes: 2 });
  });
  it("uses fixed fallback reasons for unexpected errors and conversion failures", () => {
    const error = new Error("SECRET");
    expect(cdictSpeechFailureDiagnostic(error)).toEqual({ reason: "unexpected_failure" });
    expect(cdictSpeechFailureDiagnostic(error, true)).toEqual({ reason: "audio_conversion_failed" });
    expect(cdictSpeechFailureDiagnostic(new CDictSpeechError("fixed", { reason: "empty_audio", responseBytes: 0 })))
      .toEqual({ reason: "empty_audio", responseBytes: 0 });
  });
});
