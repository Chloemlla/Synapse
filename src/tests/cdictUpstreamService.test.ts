import axios, { type AxiosError } from "axios";
import crypto from "node:crypto";
import { lookup } from "node:dns";
import { config } from "../config/config";
import { CDICT_UPSTREAM_DEFAULTS, type CdictUpstreamRuntimeConfig } from "../config/cdictUpstreamConfig";
import { RuntimeConfigService } from "../services/runtimeConfigService";
import { fetchLanguageList, synthesizeSpeech, translateText } from "../services/cdictUpstreamService";

jest.mock("axios");
jest.mock("node:dns", () => ({ ...jest.requireActual("node:dns"), lookup: jest.fn() }));
jest.mock("../utils/logger", () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const post = jest.mocked(axios.post);
const baseline = { ...config.cdictUpstream };
function useConfig(patch: Partial<CdictUpstreamRuntimeConfig>) {
  RuntimeConfigService.getCachedConfig().cdictUpstream = { ...CDICT_UPSTREAM_DEFAULTS, ...patch };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(axios.isAxiosError).mockImplementation((error): error is AxiosError => Boolean(error && (error as { isAxiosError?: boolean }).isAxiosError));
  useConfig({});
});
afterAll(() => { RuntimeConfigService.getCachedConfig().cdictUpstream = baseline; });

it("POSTs the exact form-encoded language device body, never GET or a query string", async () => {
  const payload = { code: 0, data: { list: [{ langCode: "en", extra: "preserved" }] }, untouched: [1, 2] };
  post.mockResolvedValueOnce({ data: payload });
  expect(await fetchLanguageList()).toBe(payload);
  expect(axios.get).not.toHaveBeenCalled();
  expect(post).toHaveBeenCalledTimes(1);
  const [url, body, options] = post.mock.calls[0];
  expect(url).toBe("https://vivotrans.vivo.com/translation/lang/list");
  expect(body).toBe("em=00000000000000&model=V2309A&product=PD2243&deviceType=mobile&elapsedtime=0&av=1&an=1.0.0&cs=0&sysVer=14&appVersion=1&appVer=1.0.0&appPkgName=com.vivo.translator&netType=2&screensize=1080x2400&oaid=&vaid=00000000000000");
  expect(options).toMatchObject({
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "okhttp/4.9.1", "Content-Length": String(Buffer.byteLength(body)) },
    timeout: 20_000, responseType: "json", maxContentLength: 2 * 1024 * 1024,
    maxBodyLength: 512 * 1024, maxRedirects: 0, proxy: false,
  });
});

it("uses changed translation URL/appId and language URL on the next call without reimport", async () => {
  post.mockResolvedValue({ data: { code: 0, data: { translation: "hello" } } });
  for (const id of ["one", "two"]) {
    useConfig({ translateBaseUrl: `https://${id}.example.com/base`, translateAppId: `app ${id}&*` });
    await translateText({ text: "汉字 &*", from: "en", to: "zh-CHS" });
    await fetchLanguageList();
  }
  expect(post.mock.calls.map(([url]) => url)).toEqual([
    "https://one.example.com/base/translation/query", "https://one.example.com/base/translation/lang/list",
    "https://two.example.com/base/translation/query", "https://two.example.com/base/translation/lang/list",
  ]);
  expect(post.mock.calls[0][1]).toContain("appId=app+one%26*");
  expect(post.mock.calls[2][1]).toContain("appId=app+two%26*");
  expect(post.mock.calls[0][1]).toContain("text=%E6%B1%89%E5%AD%97+%26*");
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
  for (const call of [() => fetchLanguageList(), () => translateText({ text: "hello", from: "en", to: "zh" }),
    () => synthesizeSpeech("hello", "en")]) {
    useConfig({ ttsAppKey: secret });
    post.mockRejectedValueOnce(error);
    await expect(call()).rejects.toThrow(`上游 HTTP ${status}`);
    post.mockRejectedValueOnce(error);
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
});

it("checks all socket DNS answers and refuses rebinding to private/reserved destinations", async () => {
  post.mockResolvedValueOnce({ data: ["en"] });
  await fetchLanguageList();
  const agent = post.mock.calls[0][2]!.httpsAgent;
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
