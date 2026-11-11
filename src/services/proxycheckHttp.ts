import { isIP } from "node:net";
import { isRecord, toStringField } from "./proxycheckParsing";
import {
  ProxycheckUpstreamError,
  buildExchangeSnapshot,
  buildKeySnapshot,
  isSignatureUntrusted,
  type ProxycheckExchangeSnapshot,
  type ProxycheckKeySnapshot,
} from "./proxycheckExchange";
import { isValidHmacKeyShape } from "./proxycheckSignature";

/**
 * proxycheck.io 的 HTTP 层：只负责构造请求、发请求、验签、判定顶层 status。
 *
 * 鉴权是 `key` 参数；另外 Dashboard 可为账号生成 API Payload Verification Key，
 * 上游在 HTTPS 响应的 `http_x_signature` 头里回签响应体，本层逐字节验签后才解析
 * （见 proxycheckSignature.ts）。未配置该 key 时不做验签，只依赖 TLS。
 *
 * 每一次交互都会带出一份 `ProxycheckExchangeSnapshot`（见 proxycheckExchange.ts）：
 * 失败由 `ProxycheckUpstreamError.diagnostics` 带出，成功由返回值带出。
 * 那份快照里**没有密钥明文**，只有长度与指纹。
 */

// 上游地址硬编码：绝不从配置接受任意 URL（防 SSRF）。
const PROXYCHECK_BASE_URL = "https://proxycheck.io";
// 批量端点单次 <= 1000 个 IP（官方限制）。
export const BATCH_MAX_IPS = 1000;

/**
 * 响应顶层：status + 每个被查询地址一个键（键名就是 IP 字符串），
 * 另外可能混有 message / node 等非地址键。
 */
export interface ProxycheckPayload {
  status?: unknown;
  message?: unknown;
  [key: string]: unknown;
}

/** 一次上游查询的全部可调参数；`verificationKey` 为空串表示不验签。 */
export interface ProxycheckRequestOptions {
  apiKey: string;
  verificationKey: string;
  timeoutMs: number;
  days: number;
  /**
   * 验签未通过（头缺失 / 形态不对 / 不匹配）时是否仍采信上游响应体。
   * 对应运行时配置 `PROXYCHECK.trustUnverifiedUpstream`，默认 false = 绝不采信。
   */
  trustUnverifiedUpstream?: boolean;
  /** 调用方（ipRiskService）按运行时配置算好的四把密钥形状，仅用于诊断展示。 */
  keySnapshot?: ProxycheckKeySnapshot;
}

/** 单地址查询的结果 + 这次交互的快照。 */
export interface SingleLookupOutcome {
  record: Record<string, unknown> | null;
  exchange: ProxycheckExchangeSnapshot;
}

/** 批量查询的结果 + 这次交互的快照。 */
export interface BatchLookupOutcome {
  payload: ProxycheckPayload;
  exchange: ProxycheckExchangeSnapshot;
}

interface ExchangeRequest {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/**
 * undici 把所有网络失败都抛成 TypeError("fetch failed")，真正原因（拒重定向 / DNS / TLS / 超时）
 * 只在 cause 里。这里拼成一段可读文本当错误码用（与 ipRiskService 的 describeError 同口径）。
 */
function describeNetworkFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
  const causeMessage =
    cause instanceof Error
      ? cause.message
      : typeof (cause as { message?: unknown } | null | undefined)?.message === "string"
        ? String((cause as { message: unknown }).message)
        : "";
  return causeMessage ? `${message} (cause: ${causeMessage})` : message;
}

/** status 非 ok/warning 一律当失败；只回状态名，不回上游 message（可能回显含 key 的 URL）。 */
function assertUpstreamStatus(payload: ProxycheckPayload, exchange: ProxycheckExchangeSnapshot): void {
  const status = toStringField(payload.status);
  if (status === "ok" || status === "warning") return;
  const code = `proxycheck_status_${status || "unknown"}`;
  throw new ProxycheckUpstreamError(code, { ...exchange, errorCode: code });
}

/**
 * 发一次请求并把它完整记进诊断快照。
 *
 * 判定顺序与改版前一致：HTTP 状态 → 验签 → JSON → 上游 status。
 * 唯一的行为变更来自 `trustUnverifiedUpstream`：验签未通过时不再直接抛错，而是把
 * 结论记进快照（`trustedWithoutSignature=true`）后继续用上游响应体。
 * 上游自己说「凭据无效」（status=auth/denied）时**即便开了该开关也照样失败** ——
 * 那说明 payload 里根本没有风险数据，采信它等于凭空放行。
 */
async function executeExchange(
  request: ExchangeRequest,
  options: ProxycheckRequestOptions,
): Promise<{ payload: ProxycheckPayload; exchange: ProxycheckExchangeSnapshot }> {
  const startedAt = Date.now();
  const trustUnverified = options.trustUnverifiedUpstream === true;
  const verificationKey = options.verificationKey;
  const keySnapshot =
    options.keySnapshot ??
    buildKeySnapshot({
      apiKey: options.apiKey,
      publicApiKey: "",
      payloadVerificationKey: options.verificationKey,
      hmacSecret: "",
    });

  const snapshot = (input: {
    response?: Response | null;
    rawBody?: Buffer | null;
    errorCode: string;
    trustedWithoutSignature?: boolean;
  }): ProxycheckExchangeSnapshot =>
    buildExchangeSnapshot({
      method: request.method,
      url: request.url,
      apiKey: options.apiKey,
      requestHeaders: request.headers,
      requestBody: request.body ?? null,
      response: input.response ?? null,
      rawBody: input.rawBody ?? null,
      verificationKey,
      keys: keySnapshot,
      errorCode: input.errorCode,
      durationMs: Date.now() - startedAt,
      trustedWithoutSignature: input.trustedWithoutSignature,
    });

  // 形态不对的验签密钥会让每一次验收都失败，默认在发请求前拦下（否则只会白烧上游额度）。
  // 「验签失败也采信上游」打开时，验签本来就不作为采信门槛 —— 照发，把 key_malformed 记进诊断。
  if (verificationKey && !isValidHmacKeyShape(verificationKey) && !trustUnverified) {
    throw new ProxycheckUpstreamError("proxycheck_hmac_key_malformed", snapshot({ errorCode: "proxycheck_hmac_key_malformed" }));
  }

  let response: Response;
  try {
    response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      // 拒绝跟随重定向：批量 POST 在不带 JSON 体时会 302 到含 key 的地址。
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    const code = describeNetworkFailure(error);
    throw new ProxycheckUpstreamError(code, snapshot({ errorCode: code }));
  }

  let rawBody: Buffer;
  try {
    // 只读一次响应体：HMAC 要对原始字节算，JSON.parse 要用同一份字节解码，二次读取拿不到。
    rawBody = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    const code = describeNetworkFailure(error);
    throw new ProxycheckUpstreamError(code, snapshot({ response, errorCode: code }));
  }

  if (!response.ok) {
    const code = `proxycheck_http_${response.status}`;
    throw new ProxycheckUpstreamError(code, snapshot({ response, rawBody, errorCode: code }));
  }

  const exchange = snapshot({ response, rawBody, errorCode: "" });
  if (isSignatureUntrusted(exchange.signature.verdict)) {
    if (!trustUnverified) {
      const code = `proxycheck_signature_${exchange.signature.verdict}`;
      throw new ProxycheckUpstreamError(code, { ...exchange, errorCode: code });
    }
    exchange.trustedWithoutSignature = true;
  }

  let payload: ProxycheckPayload;
  try {
    payload = JSON.parse(rawBody.toString("utf8")) as ProxycheckPayload;
  } catch {
    // 不把 JSON.parse 的原始报错透出去：V8 会在消息里回显响应片段，可能是含 key 的 URL。
    const code = "proxycheck_response_not_json";
    throw new ProxycheckUpstreamError(code, { ...exchange, errorCode: code });
  }

  assertUpstreamStatus(payload, exchange);
  return { payload, exchange };
}

export function extractIpResult(payload: ProxycheckPayload, ip: string): Record<string, unknown> | null {
  const direct = payload[ip];
  if (isRecord(direct)) return direct;

  // 上游有时回显压缩后的 IPv6 形式，键名与请求不完全一致，退化为扫描 IP 形态的键。
  // 批量响应里同时存在多个 IP 形态的键，此时无从判断哪个才是本 IP：宁可判这次查询失败，
  // 也绝不把邻居 IP 的结论安到本 IP 头上（它会被写进 24h 缓存，污染闸门判据）。
  const candidates: Record<string, unknown>[] = [];
  for (const [key, value] of Object.entries(payload)) {
    if (key === "status" || key === "message" || key === "node") continue;
    if (isIP(key) && isRecord(value)) candidates.push(value);
  }
  return candidates.length === 1 ? candidates[0] : null;
}

/**
 * 单地址查询走 `GET /v3/{ip}`，不走批量那条 `POST /v3/`。
 *
 * POST 批量端点在不带 JSON 体时会 302 到 `/v3/<调用方出口IP>`，而本层用 redirect:"error"
 * 拒绝跟随重定向（防止被带到含 key 的地址），于是每次单地址查询都变成
 * `unexpected redirect` 失败。首访闸门的风险判定因此永远拿不到结论，
 * failOpen 时直接放行，验证流程不会被唤醒。
 * GET 单地址端点返回 200 且同样携带 `http_x_signature`，验签逻辑不受影响。
 */
export async function requestSingleLookup(
  ip: string,
  options: ProxycheckRequestOptions,
): Promise<SingleLookupOutcome> {
  const params = new URLSearchParams();
  params.set("key", options.apiKey);
  params.set("vpn", "1");
  params.set("asn", "1");
  params.set("risk", "1");
  params.set("node", "1");
  params.set("p", "1");
  params.set("days", String(options.days));

  const { payload, exchange } = await executeExchange(
    {
      method: "GET",
      url: `${PROXYCHECK_BASE_URL}/v3/${encodeURIComponent(ip)}?${params.toString()}`,
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "identity",
      },
    },
    options,
  );

  return { record: extractIpResult(payload, ip), exchange };
}

export async function requestBatchLookup(
  ips: string[],
  options: ProxycheckRequestOptions,
): Promise<BatchLookupOutcome> {
  const body = new URLSearchParams();
  body.set("key", options.apiKey);
  body.set("ips", ips.join(","));
  body.set("vpn", "1");
  body.set("asn", "1");
  body.set("risk", "1");
  body.set("node", "1");
  body.set("p", "1");
  body.set("days", String(options.days));

  const { payload, exchange } = await executeExchange(
    {
      method: "POST",
      url: `${PROXYCHECK_BASE_URL}/v3/`,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        // 不协商压缩：验签哈希的是收到的字节，官方库用 libcurl 也没请求压缩。
        "Accept-Encoding": "identity",
      },
      body: body.toString(),
    },
    options,
  );

  return { payload, exchange };
}
