import {
  MAX_DIAGNOSTIC_BODY_BYTES,
  ProxycheckUpstreamError,
  buildExchangeSnapshot,
  buildKeySnapshot,
  buildRedactedRequestBody,
  buildRedactedUrl,
  buildRequestHeaderSnapshot,
  buildSignatureSnapshot,
  describeSecretForDiagnostics,
  isSignatureUntrusted,
  truncateBodyForDiagnostics,
} from "../services/proxycheckExchange";
import { requestSingleLookup } from "../services/proxycheckHttp";
import { computePayloadSignature } from "../services/proxycheckSignature";

/**
 * 回归：排障快照必须能定位「为什么验签不过」，又**绝不含密钥明文**
 * （AGENTS.md §8：日志与接口响应里绝不出现密钥）。
 * 这两条同时成立才有意义 —— 少了前者排障还是靠猜，少了后者就是凭据泄露。
 */
describe("proxycheckExchange 脱敏与指纹", () => {
  const apiKey = "111111-222222-333333-444444";
  const verificationKey = "a".repeat(64);

  it("指纹稳定、可区分、且不含明文", () => {
    const first = describeSecretForDiagnostics(verificationKey);
    expect(first).toBe(describeSecretForDiagnostics(verificationKey));
    expect(first).not.toContain(verificationKey);
    expect(first).not.toContain("aaaa");
    expect(first).toBe("<redacted length=64 fp=" + first.split("fp=")[1]);
    expect(describeSecretForDiagnostics("b".repeat(64))).not.toBe(first);
    expect(describeSecretForDiagnostics("")).toBe("<empty>");
  });

  it("请求 URL 只脱敏 key，其余参数原样保留", () => {
    const url = buildRedactedUrl(`https://proxycheck.io/v3/144.52.238.197?key=${apiKey}&vpn=1&days=1`, apiKey);
    expect(url).not.toContain(apiKey);
    expect(url).not.toContain("111111");
    expect(url).toContain("vpn=1");
    expect(url).toContain("days=1");
    expect(url).toContain("key=<redacted length=27 fp=");
    expect(url.startsWith("https://proxycheck.io/v3/144.52.238.197?")).toBe(true);
  });

  it("批量表单体的 key 脱敏、ips 折叠", () => {
    const body = buildRedactedRequestBody(
      `key=${apiKey}&ips=1.1.1.1,2.2.2.2,3.3.3.3,4.4.4.4,5.5.5.5,6.6.6.6&vpn=1`,
      apiKey,
    );
    expect(body).not.toContain(apiKey);
    expect(body).toContain("key=<redacted length=27 fp=");
    expect(body).toContain("ips=1.1.1.1,2.2.2.2,3.3.3.3,4.4.4.4,5.5.5.5,…(+1)");
    expect(body).toContain("vpn=1");
  });

  it("请求头里的凭据类字段一律剔除", () => {
    const headers = buildRequestHeaderSnapshot({
      Accept: "application/json",
      Authorization: "Bearer secret",
      "x-api-key": "secret",
      "Accept-Encoding": "identity",
    });
    expect(headers).toEqual({ Accept: "application/json", "Accept-Encoding": "identity" });
  });

  it("响应体展示副本按字节截断，但字节数记录完整长度", () => {
    const small = Buffer.from('{"status":"ok"}', "utf8");
    expect(truncateBodyForDiagnostics(small)).toEqual({
      body: '{"status":"ok"}',
      bodyBytes: small.length,
      bodyTruncated: false,
    });

    const large = Buffer.alloc(MAX_DIAGNOSTIC_BODY_BYTES + 100, 0x61);
    const truncated = truncateBodyForDiagnostics(large);
    expect(truncated.bodyTruncated).toBe(true);
    expect(truncated.bodyBytes).toBe(MAX_DIAGNOSTIC_BODY_BYTES + 100);
    expect(Buffer.from(truncated.body, "utf8").length).toBe(MAX_DIAGNOSTIC_BODY_BYTES);
  });
});

describe("proxycheckExchange 验签快照", () => {
  const rawBody = Buffer.from('{"status":"ok","144.52.238.197":{"proxy":"no"}}', "utf8");
  const rightKey = "c".repeat(64);
  const wrongKey = "d".repeat(64);

  it("未配置密钥 = not_configured（只依赖 TLS，不算失败）", () => {
    const snapshot = buildSignatureSnapshot(rawBody, "", null);
    expect(snapshot.verdict).toBe("not_configured");
    expect(snapshot.expectedSignature).toBeNull();
    expect(isSignatureUntrusted(snapshot.verdict)).toBe(false);
  });

  it("长度不对的密钥判 key_malformed，且不拿它去算期望签名", () => {
    const snapshot = buildSignatureSnapshot(rawBody, "short", "0".repeat(64));
    expect(snapshot.verdict).toBe("key_malformed");
    expect(snapshot.expectedSignature).toBeNull();
    expect(snapshot.key.length).toBe(5);
    expect(isSignatureUntrusted(snapshot.verdict)).toBe(true);
  });

  it("上游没回签名头 = header_missing（线上事故的第一现场）", () => {
    const snapshot = buildSignatureSnapshot(rawBody, rightKey, null);
    expect(snapshot.verdict).toBe("header_missing");
    expect(snapshot.headerValue).toBe("");
    // 即便头缺失也要算出期望签名：那正是「本服务算出来的应该是什么」。
    expect(snapshot.expectedSignature).toBe(computePayloadSignature(rawBody, rightKey));
    expect(isSignatureUntrusted(snapshot.verdict)).toBe(true);
  });

  it("密钥对得上 = verified；对不上 = mismatch", () => {
    const good = buildSignatureSnapshot(rawBody, rightKey, computePayloadSignature(rawBody, rightKey));
    expect(good.verdict).toBe("verified");
    expect(isSignatureUntrusted(good.verdict)).toBe(false);

    const bad = buildSignatureSnapshot(rawBody, wrongKey, computePayloadSignature(rawBody, rightKey));
    expect(bad.verdict).toBe("mismatch");
    expect(bad.expectedSignature).toBe(computePayloadSignature(rawBody, wrongKey));
    expect(isSignatureUntrusted(bad.verdict)).toBe(true);
  });

  it("形态不对的回签头判 header_malformed", () => {
    expect(buildSignatureSnapshot(rawBody, rightKey, "not-hex").verdict).toBe("header_malformed");
  });
});

describe("proxycheckExchange 配置密钥比对", () => {
  it("payloadVerificationKey 与 hmacSecret 同串可被指纹比对识别（线上事故形态）", () => {
    const same = buildKeySnapshot({
      apiKey: "111111-222222-333333-444444",
      publicApiKey: "public-1-2-3",
      payloadVerificationKey: "b".repeat(64),
      hmacSecret: "b".repeat(64),
    });
    expect(same.payloadVerificationKeyMatchesHmacSecret).toBe(true);
    expect(same.payloadVerificationKey.fingerprint).toBe(same.hmacSecret.fingerprint);

    const different = buildKeySnapshot({
      apiKey: "111111-222222-333333-444444",
      publicApiKey: "public-1-2-3",
      payloadVerificationKey: "b".repeat(64),
      hmacSecret: "e".repeat(64),
    });
    expect(different.payloadVerificationKeyMatchesHmacSecret).toBe(false);
  });

  it("快照里任何位置都不出现密钥明文", () => {
    const apiKey = "111111-222222-333333-444444";
    const verificationKey = "f".repeat(64);
    const exchange = buildExchangeSnapshot({
      method: "GET",
      url: `https://proxycheck.io/v3/1.1.1.1?key=${apiKey}&vpn=1`,
      apiKey,
      requestHeaders: { Accept: "application/json" },
      verificationKey,
      keys: buildKeySnapshot({
        apiKey,
        publicApiKey: "",
        payloadVerificationKey: verificationKey,
        hmacSecret: "9".repeat(64),
      }),
      errorCode: "proxycheck_signature_header_missing",
      durationMs: 12,
    });

    const serialized = JSON.stringify(exchange);
    expect(serialized).not.toContain(apiKey);
    expect(serialized).not.toContain(verificationKey);
    expect(serialized).not.toContain("9".repeat(64));
    expect(exchange.signature.verdict).toBe("no_response");
  });
});

/**
 * 采信开关的行为边界：它只放宽「验签未过」，不放宽「上游说凭据无效」。
 * 后者 payload 里根本没有风险数据，采信它等于凭空放行。
 */
describe("requestSingleLookup 的 trustUnverifiedUpstream", () => {
  const apiKey = "111111-222222-333333-444444";
  const rightKey = "c".repeat(64);
  const wrongKey = "d".repeat(64);
  const payloadBody = '{"status":"ok","1.1.1.1":{"proxy":"yes","risk":80}}';
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  const mockFetch = (headers: Record<string, string>) => {
    const mock = jest.fn(async () => new Response(payloadBody, { status: 200, headers }));
    global.fetch = mock as unknown as typeof fetch;
    return mock;
  };

  const options = {
    apiKey,
    verificationKey: wrongKey,
    timeoutMs: 1000,
    days: 1,
  };

  it("默认（不采信）验签不匹配直接抛错，且错误里带着诊断", async () => {
    mockFetch({ http_x_signature: computePayloadSignature(Buffer.from(payloadBody), rightKey) });

    await expect(requestSingleLookup("1.1.1.1", options)).rejects.toBeInstanceOf(ProxycheckUpstreamError);
    const error = await requestSingleLookup("1.1.1.1", options).catch((err: unknown) => err);
    expect((error as ProxycheckUpstreamError).message).toBe("proxycheck_signature_mismatch");
    const diagnostics = (error as ProxycheckUpstreamError).diagnostics;
    expect(diagnostics.status).toBe(200);
    expect(diagnostics.body).toBe(payloadBody);
    expect(diagnostics.signature.verdict).toBe("mismatch");
    expect(diagnostics.signature.headerValue).toBe(computePayloadSignature(Buffer.from(payloadBody), rightKey));
    expect(diagnostics.trustedWithoutSignature).toBe(false);
    expect(JSON.stringify(diagnostics)).not.toContain(apiKey);
  });

  it("打开采信开关后同一份响应被解析并标记 trustedWithoutSignature", async () => {
    mockFetch({ http_x_signature: computePayloadSignature(Buffer.from(payloadBody), rightKey) });

    const outcome = await requestSingleLookup("1.1.1.1", { ...options, trustUnverifiedUpstream: true });
    expect(outcome.record).toEqual({ proxy: "yes", risk: 80 });
    expect(outcome.exchange.signature.verdict).toBe("mismatch");
    expect(outcome.exchange.trustedWithoutSignature).toBe(true);
  });

  it("上游没回签名头 + 采信开关：仍然拿到结论（这正是「验签密钥无效仍信任结果」）", async () => {
    mockFetch({});
    const outcome = await requestSingleLookup("1.1.1.1", { ...options, trustUnverifiedUpstream: true });
    expect(outcome.exchange.signature.verdict).toBe("header_missing");
    expect(outcome.exchange.trustedWithoutSignature).toBe(true);
    expect(outcome.record).not.toBeNull();
  });

  it("形态不对的密钥默认在发请求前拦下；打开采信后照发并记 key_malformed", async () => {
    const mock = mockFetch({});
    const malformed = { ...options, verificationKey: "short-key" };

    await expect(requestSingleLookup("1.1.1.1", malformed)).rejects.toMatchObject({
      message: "proxycheck_hmac_key_malformed",
    });
    expect(mock).not.toHaveBeenCalled();

    const outcome = await requestSingleLookup("1.1.1.1", { ...malformed, trustUnverifiedUpstream: true });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(outcome.exchange.signature.verdict).toBe("key_malformed");
    expect(outcome.exchange.trustedWithoutSignature).toBe(true);
  });

  it("上游自己说凭据无效时不采信（payload 里没有风险数据）", async () => {
    const body = '{"status":"denied","message":"Invalid key"}';
    global.fetch = jest.fn(
      async () => new Response(body, { status: 200, headers: { http_x_signature: computePayloadSignature(Buffer.from(body), rightKey) } }),
    ) as unknown as typeof fetch;

    await expect(
      requestSingleLookup("1.1.1.1", { ...options, trustUnverifiedUpstream: true }),
    ).rejects.toMatchObject({ message: "proxycheck_status_denied" });
  });
});
