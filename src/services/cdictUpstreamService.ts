import axios, { type AxiosResponse } from "axios";
import crypto from "node:crypto";
import { lookup } from "node:dns";
import https from "node:https";
import { config } from "../config/config";
import { isPublicCdictUpstreamAddress, normalizeCdictUpstreamUrl } from "../config/cdictUpstreamConfig";
import logger from "../utils/logger";

/**
 * CDict 上游代理服务。
 *
 * CDict Android 客户端不再直连第三方翻译网关 / 语音合成 / 词典音频，统一请求本服务；
 * 上游地址、appId、appKey 与签名算法只存在于服务端。默认值与客户端历史版本一致，
 * 可通过环境变量覆盖（VIVO_TRANSLATE_* / VIVO_TTS_*）。
 */

const TRANSLATE_PATH = "/translation/query";
const LANGUAGE_LIST_PATH = "/translation/lang/list";

const YOUDAO_VOICE_URL = "https://dict.youdao.com/dictvoice";
const UPSTREAM_TIMEOUT_MS = 20000;
const UPSTREAM_USER_AGENT = "okhttp/4.9.1";
const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";

/** 上游 TTS 把 deviceid 当数值解析，带前导零会被拒（HTTP 400 "Leading zeroes not allowed"）。 */
const TTS_DEVICE_ID = "0";

export interface CDictTranslateInput {
  text: string;
  from: string;
  to: string;
}

export interface CDictAudio {
  contentType: string;
  data: Buffer;
}

/**
 * 复刻 java.net.URLEncoder.encode(s, "UTF-8")：空格 -> '+'，A-Za-z0-9 与 .-*_ 原样，
 * 其余按 UTF-8 字节大写百分号编码。不能用 URLSearchParams —— 它会把 '*' 编成 %2A，
 * 与客户端历史请求的字节序列不一致。
 */
function javaFormEncode(value: string): string {
  let out = "";
  for (const char of value) {
    if (/^[A-Za-z0-9.\-*_]$/.test(char)) {
      out += char;
      continue;
    }
    if (char === " ") {
      out += "+";
      continue;
    }
    for (const byte of Buffer.from(char, "utf8")) {
      out += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

/** 按插入顺序拼接表单/查询串，编码语义与客户端 encodeForm 一致。 */
function encodeForm(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${javaFormEncode(key)}=${javaFormEncode(value)}`)
    .join("&");
}

/** 16 位字母数字 nonce，字符集与客户端 randomAlphanumeric 一致。 */
function randomAlphanumeric(length: number): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += alphabet[crypto.randomInt(alphabet.length)];
  }
  return out;
}

/** 设备/SDK 参数：上游只强校验 appId，设备值不要求真实匹配。 */
function deviceParams(): Record<string, string> {
  return {
    em: "00000000000000",
    model: "V2309A",
    product: "PD2243",
    deviceType: "mobile",
    elapsedtime: "0",
    av: "1",
    an: "1.0.0",
    cs: "0",
    sysVer: "14",
    appVersion: "1",
    appVer: "1.0.0",
    appPkgName: "com.vivo.translator",
    netType: "2",
    screensize: "1080x2400",
    oaid: "",
    vaid: "00000000000000",
  };
}

function extractUpstreamError(error: unknown, fallback: string): string {
  // Axios error.message/config and upstream payloads may echo credentials. Keep
  // only the HTTP status for diagnosis; never forward arbitrary upstream details.
  const status = axios.isAxiosError(error) ? error.response?.status : undefined;
  return Number.isInteger(status) ? `${fallback}（上游 HTTP ${status}）` : fallback;
}

/** Check DNS at the connection itself and use that checked address (no rebinding gap). */
const publicHttpsAgent = new https.Agent({
  keepAlive: false,
  autoSelectFamily: false,
  lookup(hostname, options, callback) {
    lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error || addresses.length === 0 || addresses.some(({ address }) => !isPublicCdictUpstreamAddress(address))) {
        callback(new Error("CDict upstream public address lookup failed"), "", 4);
        return;
      }
      const family: unknown = typeof options === "number" ? options : options.family;
      const requestedFamily = family === "IPv4" ? 4 : family === "IPv6" ? 6 : Number(family || 0);
      const candidates = addresses.filter((entry) => !requestedFamily || requestedFamily === entry.family);
      const selected = candidates.find((entry) => entry.family === 4) || candidates[0];
      if (!selected) {
        callback(new Error("CDict upstream public address lookup failed"), "", 4);
        return;
      }
      callback(null, selected.address, selected.family);
    });
  },
});

const SAFE_UPSTREAM_OPTIONS = {
  httpsAgent: publicHttpsAgent,
  // Environment proxies and redirects must not bypass the checked target or send
  // signed bodies to a second host. No browser credentials are ever forwarded.
  proxy: false as const,
  maxRedirects: 0,
  maxBodyLength: 512 * 1024,
};

/** 文本翻译：请求体字段与顺序完全复刻客户端历史请求；响应体原样透传。 */
export async function translateText(input: CDictTranslateInput): Promise<Record<string, unknown>> {
  const upstream = { ...config.cdictUpstream };
  const baseUrl = normalizeCdictUpstreamUrl(upstream.translateBaseUrl, "translateBaseUrl");
  const body = encodeForm({
    text: input.text,
    from: input.from,
    to: input.to,
    requestId: crypto.randomUUID(),
    appId: upstream.translateAppId,
    app: "com.vivo.translator",
    user_id: "com.vivo.translator",
    ...deviceParams(),
  });
  try {
    const response: AxiosResponse<Record<string, unknown>> = await axios.post(
      `${baseUrl}${TRANSLATE_PATH}`,
      body,
      {
        ...SAFE_UPSTREAM_OPTIONS,
        timeout: UPSTREAM_TIMEOUT_MS,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": UPSTREAM_USER_AGENT,
          "Content-Length": Buffer.byteLength(body, "utf8").toString(),
        },
        responseType: "json",
        // G7-17: bound the response body.
        maxContentLength: 2 * 1024 * 1024,
      },
    );
    return response.data ?? {};
  } catch (error) {
    logger.warn("[CDict] 上游翻译失败", { from: input.from, to: input.to });
    throw new Error(extractUpstreamError(error, "上游翻译请求失败"));
  }
}

/** The gateway rejects GET (405). Device fields belong in a POST form, not in the URL. */
export async function fetchLanguageList(): Promise<unknown> {
  const upstream = { ...config.cdictUpstream };
  const baseUrl = normalizeCdictUpstreamUrl(upstream.translateBaseUrl, "translateBaseUrl");
  const body = encodeForm(deviceParams());
  try {
    const response = await axios.post(`${baseUrl}${LANGUAGE_LIST_PATH}`, body, {
      ...SAFE_UPSTREAM_OPTIONS,
      timeout: UPSTREAM_TIMEOUT_MS,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body, "utf8").toString(),
        "User-Agent": UPSTREAM_USER_AGENT,
      },
      responseType: "json",
      maxContentLength: 2 * 1024 * 1024,
    });
    return response.data ?? {};
  } catch (error) {
    throw new Error(extractUpstreamError(error, "上游语言列表请求失败"));
  }
}

/**
 * 上游签名（libspeech_sec.so 逆向）：
 *   1. 参数按 key 升序拼接 appId & deviceid & nonce_str & taskid & text(base64)
 *   2. hmacHex = hex(HMAC-SHA256(appKey, 拼接串))
 *   3. sign = hex(MD5(hmacHex + "&key=" + appKey))
 */
function ttsSignature(params: string, appKey: string): string {
  if (!appKey) {
    throw new Error("VIVO_TTS_APP_KEY 未配置，语音合成功能不可用");
  }
  const hmacHex = crypto.createHmac("sha256", appKey).update(params, "utf8").digest("hex");
  return crypto.createHash("md5").update(`${hmacHex}&key=${appKey}`, "utf8").digest("hex");
}

function detectAudioContentType(data: Buffer): string {
  if (data.length >= 4 && data.toString("ascii", 0, 4) === "RIFF") return "audio/wav";
  if (data.length >= 3 && data.toString("ascii", 0, 3) === "ID3") return "audio/mpeg";
  if (data.length >= 2 && data[0] === 0xff && (data[1] & 0xe0) === 0xe0) return "audio/mpeg";
  // aue=3 / auf=audio/L16 时上游可能返回无容器 PCM，客户端会自行补 WAV 头。
  return "audio/L16; rate=16000";
}

/** 在线合成引擎：成功返回音频字节；上游以 {"errorResult":{…}} 拒绝时抛错。 */
export async function synthesizeSpeech(text: string, langType: string): Promise<CDictAudio> {
  const upstream = { ...config.cdictUpstream };
  const ttsUrl = normalizeCdictUpstreamUrl(upstream.ttsUrl, "ttsUrl");
  const taskId = crypto.randomUUID().replace(/-/g, "");
  const nonce = randomAlphanumeric(16);
  const textB64 = Buffer.from(text, "utf8").toString("base64");
  const signedParams = `appId=${upstream.ttsAppId}&deviceid=${TTS_DEVICE_ID}&nonce_str=${nonce}&taskid=${taskId}&text=${textB64}`;
  const body = JSON.stringify({
    appId: upstream.ttsAppId,
    deviceid: TTS_DEVICE_ID,
    taskid: taskId,
    nonce_str: nonce,
    aue: 3,
    auf: "audio/L16;rate=16000",
    vcn: "women",
    speed: 70,
    volume: 50,
    pitch: 50,
    langType,
    text: textB64,
    encoding: "utf-8",
    sign: ttsSignature(signedParams, upstream.ttsAppKey),
    sysVer: "14",
    product: "PD2243",
    model: "V2309A",
    appVer: "4.5.9.0",
    app: "com.vivo.translator",
  });
  let response: AxiosResponse<ArrayBuffer>;
  try {
    response = await axios.post(ttsUrl, body, {
      ...SAFE_UPSTREAM_OPTIONS,
      timeout: UPSTREAM_TIMEOUT_MS,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body, "utf8").toString(),
      },
      responseType: "arraybuffer",
      // G7-17: TTS audio is bounded (typically <1MB) — cap at 8MB.
      maxContentLength: 8 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(extractUpstreamError(error, "上游语音合成请求失败"));
  }
  const data = Buffer.from(response.data);
  if (data.length === 0) throw new Error("上游语音合成返回空音频");
  const head = data.subarray(0, 1024).toString("utf8");
  if (head.includes("errorResult")) {
    // Do not echo errorMsg or arbitrary errorCode values: upstream may include keys.
    throw new Error("上游语音合成拒绝请求");
  }
  return { contentType: detectAudioContentType(data), data };
}

/** 词典静态音频：查询串与 UA 复刻客户端历史请求；只接受音频响应，错误页/空体一律抛错以便客户端回退。 */
export async function fetchDictionaryVoice(text: string, type: number): Promise<CDictAudio> {
  const url = `${YOUDAO_VOICE_URL}?audio=${javaFormEncode(text)}&type=${type}`;
  let response: AxiosResponse<ArrayBuffer>;
  try {
    response = await axios.get(url, {
      timeout: UPSTREAM_TIMEOUT_MS,
      headers: { "User-Agent": BROWSER_USER_AGENT },
      responseType: "arraybuffer",
      // G7-17: dictionary audio is bounded — cap at 8MB.
      maxContentLength: 8 * 1024 * 1024,
    });
  } catch (error) {
    throw new Error(extractUpstreamError(error, "上游词典音频请求失败"));
  }
  const data = Buffer.from(response.data);
  if (data.length === 0) throw new Error("上游词典音频返回空响应体");
  const upstreamType = String(response.headers["content-type"] || "");
  if (upstreamType && !upstreamType.toLowerCase().startsWith("audio/")) {
    throw new Error(`上游词典音频返回非音频响应 content-type=${upstreamType}`);
  }
  const contentType = upstreamType.toLowerCase().startsWith("audio/")
    ? upstreamType
    : detectAudioContentType(data);
  if (!contentType.toLowerCase().startsWith("audio/")) {
    throw new Error("上游词典音频返回非音频格式");
  }
  return { contentType, data };
}
