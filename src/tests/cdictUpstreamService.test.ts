import axios, { type AxiosError } from "axios";
import crypto from "node:crypto";
import { lookup } from "node:dns";
import { config } from "../config/config";
import { CDICT_UPSTREAM_DEFAULTS, type CdictUpstreamRuntimeConfig } from "../config/cdictUpstreamConfig";
import { RuntimeConfigService } from "../services/runtimeConfigService";
import { CDictLanguageRequestError } from "../services/cdictLanguageDiagnostics";
import { fetchDictionaryVoice, fetchLanguageList, synthesizeSpeech, translateText } from "../services/cdictUpstreamService";

jest.mock("axios");
jest.mock("node:dns", () => ({ ...jest.requireActual("node:dns"), lookup: jest.fn() }));
jest.mock("../utils/logger", () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const post = jest.mocked(axios.post);
const get = jest.mocked(axios.get);
const baseline = { ...config.cdictUpstream };
function useConfig(patch: Partial<CdictUpstreamRuntimeConfig>) {
  RuntimeConfigService.getCachedConfig().cdictUpstream = { ...CDICT_UPSTREAM_DEFAULTS, ...patch };
}

beforeEach(() => {
  jest.clearAllMocks();
  get.mockReset().mockResolvedValue({ data: ["en"] });
  post.mockReset();
  jest.mocked(axios.isAxiosError).mockImplementation((error): error is AxiosError => Boolean(error && (error as { isAxiosError?: boolean }).isAxiosError));
  useConfig({});
});
afterAll(() => { RuntimeConfigService.getCachedConfig().cdictUpstream = baseline; });

it("sends the complete documented SDK language query including online and camelCase userId", async () => {
  const payload = { code: 0, data: { langs: ["en"] }, untouched: [1, 2] };
  const onResponse = jest.fn();
  get.mockResolvedValueOnce({ data: payload });
  expect(await fetchLanguageList(onResponse)).toBe(payload);
  expect(onResponse).toHaveBeenCalledTimes(1);
  expect(onResponse).toHaveBeenCalledWith(expect.objectContaining({
    upstreamMethod: "GET", compatibilityRetried: false, previousUpstreamStatus: undefined,
  }));
  expect(post).not.toHaveBeenCalled();
  const [rawUrl, options] = get.mock.calls[0];
  const url = new URL(rawUrl);
  expect(url.origin + url.pathname).toBe("https://vivotrans.vivo.com/translation/lang/list");
  for (const [key, value] of Object.entries({ appId: "9023957766", app: "com.vivo.translator", userId: "com.vivo.translator", imei: "unknown", online: "1", model: "V2309A", em: "00000000000000", deviceType: "phone", av: "34", an: "14", appVersion: "45900", appVer: "4.5.9.0", screensize: "1080*2400" })) {
    expect(url.searchParams.get(key)).toBe(value);
  }
  expect(url.searchParams.has("user_id")).toBe(false);
  expect(options).toMatchObject({ headers: { Accept: "application/json", "User-Agent": "okhttp/4.9.1" },
    timeout: 20_000, responseType: "json", maxContentLength: 2 * 1024 * 1024, maxRedirects: 0, proxy: false });
});

it("retries only an HTTP405 once as a form POST with exactly the same SDK parameters", async () => {
  get.mockRejectedValueOnce({ isAxiosError: true, response: { status: 405 } });
  const payload = { code: 0, data: { langs: ["en", "zh-CHS"] } };
  const onResponse = jest.fn();
  post.mockResolvedValueOnce({ data: payload });
  expect(await fetchLanguageList(onResponse)).toBe(payload);
  expect(onResponse).toHaveBeenCalledTimes(1);
  expect(onResponse).toHaveBeenCalledWith(expect.objectContaining({
    upstreamMethod: "POST", compatibilityRetried: true, previousUpstreamStatus: 405,
  }));
  expect(get).toHaveBeenCalledTimes(1);
  expect(post).toHaveBeenCalledTimes(1);
  const [url, body, options] = post.mock.calls[0];
  expect(url).toBe("https://vivotrans.vivo.com/translation/lang/list");
  expect(body).toBe(new URL(get.mock.calls[0][0]).search.slice(1));
  expect(options).toMatchObject({ headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": String(Buffer.byteLength(body)) },
    timeout: 20_000, maxContentLength: 2 * 1024 * 1024, maxRedirects: 0, proxy: false });
});

it.each([
  { failure: "HTTP500", upstreamError: { isAxiosError: true, response: { status: 500 } }, diagnostic: { reason: "http_error", upstreamStatus: 500 } },
  { failure: "network error", upstreamError: { isAxiosError: true, code: "ERR_NETWORK" }, diagnostic: { reason: "transport_error", transportCode: "ERR_NETWORK" } },
])("retains POST compatibility diagnostics when the HTTP405 retry fails with $failure", async ({ upstreamError, diagnostic }) => {
  const onResponse = jest.fn();
  get.mockRejectedValueOnce({ isAxiosError: true, response: { status: 405 } });
  post.mockRejectedValueOnce(upstreamError);
  const error = await fetchLanguageList(onResponse).catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(CDictLanguageRequestError);
  expect(error).toMatchObject({ diagnostic: {
    ...diagnostic, upstreamMethod: "POST", compatibilityRetried: true, previousUpstreamStatus: 405,
  } });
  expect(get).toHaveBeenCalledTimes(1);
  expect(post).toHaveBeenCalledTimes(1);
  expect(onResponse).not.toHaveBeenCalled();
});

it.each([
  { failure: "HTTP400", upstreamError: { isAxiosError: true, response: { status: 400 } }, diagnostic: { reason: "http_error", upstreamStatus: 400 } },
  { failure: "network error", upstreamError: { isAxiosError: true, code: "ERR_NETWORK" }, diagnostic: { reason: "transport_error", transportCode: "ERR_NETWORK" } },
])("retains GET diagnostics without retrying a direct $failure", async ({ upstreamError, diagnostic }) => {
  const onResponse = jest.fn();
  get.mockRejectedValueOnce(upstreamError);
  const error = await fetchLanguageList(onResponse).catch((failure: unknown) => failure);
  expect(error).toBeInstanceOf(CDictLanguageRequestError);
  expect(error).toMatchObject({ diagnostic: {
    ...diagnostic, upstreamMethod: "GET", compatibilityRetried: false, previousUpstreamStatus: undefined,
  } });
  expect(get).toHaveBeenCalledTimes(1);
  expect(post).not.toHaveBeenCalled();
  expect(onResponse).not.toHaveBeenCalled();
});

it("does not retry a business rejection as another request method", async () => {
  const payload = { code: 20000, data: null, msg: "参数非法" };
  get.mockResolvedValueOnce({ data: payload });
  expect(await fetchLanguageList()).toBe(payload); // controller and live check must reject this result
  expect(post).not.toHaveBeenCalled();
});

it("uses changed translation and language app identities without reimport", async () => {
  post.mockResolvedValue({ data: { code: 0, data: { translation: "hello" } } });
  for (const id of ["one", "two"]) {
    useConfig({ translateBaseUrl: `https://${id}.example.com/base`, translateAppId: `app ${id}&*` });
    await translateText({ text: "汉字 &*", from: "en", to: "zh-CHS" });
    await fetchLanguageList();
  }
  expect(post.mock.calls.map(([url]) => url)).toEqual(["https://one.example.com/base/translation/query", "https://two.example.com/base/translation/query"]);
  expect(post.mock.calls[0][1]).toContain("appId=app+one%26*");
  expect(post.mock.calls[1][1]).toContain("appId=app+two%26*");
  expect(post.mock.calls[0][1]).toContain("text=%E6%B1%89%E5%AD%97+%26*");
  for (const [index, id] of ["one", "two"].entries()) {
    const url = new URL(get.mock.calls[index][0]);
    expect(url.origin + url.pathname).toBe(`https://${id}.example.com/base/translation/lang/list`);
    expect(url.searchParams.get("appId")).toBe(`app ${id}&*`);
    expect(url.searchParams.get("online")).toBe("1");
  }
});

it("uses a per-call TTS URL/appId/key snapshot and never transmits the raw key", async () => {
  post.mockResolvedValue({ data: Buffer.from("RIFFaudio"), headers: {} });
  for (const id of ["first", "second"]) {
    const key = `test-vivo-key-${id}`; // synthetic test credential; no vendor default
    useConfig({ ttsUrl: `https://${id}.example.com/speech`, ttsAppId: id, ttsAppKey: key });
    await synthesizeSpeech("hello", "en");
    const [url, raw, options] = post.mock.calls.at(-1)!;
    const body = JSON.parse(raw);
    const params = `appId=${id}&deviceid=0&nonce_str=${body.nonce_str}&taskid=${body.taskid}&text=${body.text}`;
    const hmac = crypto.createHmac("sha256", key).update(params).digest("hex");
    expect(url).toBe(`https://${id}.example.com/speech`);
    expect(body.appId).toBe(id);
    expect(body.sign).toBe(crypto.createHash("md5").update(`${hmac}&key=${key}`).digest("hex"));
    expect(raw).not.toContain(key);
    expect(options).toMatchObject({ maxRedirects: 0, proxy: false, timeout: 20_000, maxContentLength: 8 * 1024 * 1024, responseType: "arraybuffer" });
  }
});

it("does not sign or send TTS when the current key is empty, regardless of env", async () => {
  const original = process.env.VIVO_TTS_APP_KEY;
  process.env.VIVO_TTS_APP_KEY = "test-env-key-not-a-fallback";
  try {
    useConfig({ ttsAppKey: "" });
    await expect(synthesizeSpeech("hello", "en")).rejects.toThrow("VIVO_TTS_APP_KEY 未配置");
    expect(post).not.toHaveBeenCalled();
    expect(CDICT_UPSTREAM_DEFAULTS.ttsAppKey).toBe("");
  } finally {
    if (original === undefined) delete process.env.VIVO_TTS_APP_KEY;
    else process.env.VIVO_TTS_APP_KEY = original;
  }
});

it.each([405, 400, 500])("propagates upstream HTTP %i without echoing secrets or Axios config", async (status) => {
  const secret = "test-secret-must-not-escape";
  const error = { isAxiosError: true, message: secret, config: { data: secret }, response: { status, data: { message: secret } } };
  const calls = [fetchLanguageList, () => translateText({ text: "hello", from: "en", to: "zh" }), () => synthesizeSpeech("hello", "en")];
  for (const [index, call] of calls.entries()) {
    useConfig({ ttsAppKey: secret });
    const reject = () => {
      if (index === 0) {
        get.mockRejectedValueOnce(error);
        if (status === 405) post.mockRejectedValueOnce(error);
      } else post.mockRejectedValueOnce(error);
    };
    reject();
    await expect(call()).rejects.toThrow(`上游 HTTP ${status}`);
    reject();
    await expect(call()).rejects.not.toThrow(secret);
  }
});

it("does not echo an upstream TTS errorResult that contains a credential", async () => {
  useConfig({ ttsAppKey: "test-key" });
  post.mockResolvedValueOnce({ data: Buffer.from('{"errorResult":{"errorCode":"test-key","errorMsg":"test-key"}}') });
  await expect(synthesizeSpeech("hello", "en")).rejects.toThrow(/^上游语音合成拒绝请求$/);
});

it.each(["https://127.0.0.1", "https://[::1]", "http://example.com", "https://user:pass@example.com"])("rejects unsafe request URL %s before Axios", async (translateBaseUrl) => {
  useConfig({ translateBaseUrl });
  await expect(fetchLanguageList()).rejects.toThrow();
  expect(post).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled();
});

it("checks all socket DNS answers and refuses rebinding to private/reserved destinations", async () => {
  get.mockResolvedValueOnce({ data: ["en"] });
  await fetchLanguageList();
  const agent = get.mock.calls[0][1]!.httpsAgent;
  const resolver = agent.options.lookup;
  const callback = jest.fn();
  const dnsMock = lookup as unknown as jest.Mock;
  for (const blocked of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "198.19.0.1", "225.0.0.1", "241.0.0.1", "::1", "::ffff:127.0.0.1"]) {
    dnsMock.mockImplementationOnce((_host: unknown, _options: unknown, done: unknown) => {
      (done as (error: null, answers: object[]) => void)(null, [{ address: "8.8.8.8", family: 4 }, { address: blocked, family: blocked.includes(":") ? 6 : 4 }]);
    });
    resolver("rebind.example.com", { family: 4 }, callback);
    expect(callback.mock.calls.at(-1)![0]).toBeInstanceOf(Error);
  }
  dnsMock.mockImplementationOnce((_host: unknown, _options: unknown, done: unknown) => {
    (done as (error: null, answers: object[]) => void)(null, [{ address: "8.8.8.8", family: 4 }]);
  });
  resolver("public.example.com", { family: 4 }, callback);
  expect(callback).toHaveBeenLastCalledWith(null, "8.8.8.8", 4);
});


it("retains missing-key and invalid-URL reasons without submitting speech", async () => {
  useConfig({ ttsAppKey: "" });
  await expect(synthesizeSpeech("SECRET", "en-USA")).rejects.toMatchObject({ diagnostic: { reason: "configuration_missing", setting: "VIVO_TTS_APP_KEY" } });
  useConfig({ ttsUrl: "https://name:SECRET@invalid.example", ttsAppKey: "SECRET" });
  await expect(synthesizeSpeech("SECRET", "en-USA")).rejects.toMatchObject({ diagnostic: { reason: "configuration_invalid", setting: "VIVO_TTS_URL" } });
  expect(post).not.toHaveBeenCalled();
});

it("retains numeric engine business errors while hiding their error messages", async () => {
  useConfig({ ttsAppKey: "SECRET" });
  const data = Buffer.from(JSON.stringify({ errorResult: { errorCode: 20004, errorMsg: "SECRET" } }));
  post.mockResolvedValueOnce({ status: 200, data, headers: { "content-type": "application/json" } });
  await expect(synthesizeSpeech("SECRET", "en-USA")).rejects.toMatchObject({ diagnostic: { reason: "upstream_rejected", upstreamStatus: 200, upstreamCode: 20004, responseBytes: data.length } });
});

it("retains dictionary HTTP and nonaudio response diagnostics", async () => {
  get.mockRejectedValueOnce({ isAxiosError: true, code: "ERR_BAD_REQUEST", response: { status: 403, data: { msg: "SECRET" } } });
  await expect(fetchDictionaryVoice("SECRET", 1)).rejects.toMatchObject({ diagnostic: { reason: "http_error", upstreamStatus: 403, transportCode: "ERR_BAD_REQUEST" } });
  get.mockResolvedValueOnce({ status: 200, data: Buffer.from("SECRET"), headers: { "content-type": "text/html; token=SECRET" } });
  await expect(fetchDictionaryVoice("SECRET", 2)).rejects.toMatchObject({ diagnostic: { reason: "unexpected_content_type", upstreamStatus: 200, upstreamContentType: "text/html", responseBytes: 6 } });
});
