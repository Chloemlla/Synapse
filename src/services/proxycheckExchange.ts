import {
  PROXYCHECK_SIGNATURE_HEADER,
  computePayloadSignature,
  fingerprintSecret,
  isValidHmacKeyShape,
  verifyPayloadSignature,
  type PayloadSignatureVerdict,
} from "./proxycheckSignature";

/**
 * proxycheck.io 一次上游交互的**排障快照**（纯函数，不碰 Mongo、不发请求）。
 *
 * 为什么需要它：线上只留下过 `error: "proxycheck_signature_mismatch"` 这一行，
 * 于是「上游到底回了什么 / 回没回 http_x_signature / 用的哪把密钥」全靠猜，
 * 排障只能反复猜「是不是另一把密钥」。
 *
 * 三条硬边界（改动前先读，违反任何一条都别合进来）：
 *   1. **绝不含密钥明文**：请求 URL / 请求体里的 `key` 参数一律换成「长度 + 指纹」，
 *      配置里的四把密钥只以长度 + sha256 前 12 位指纹出现。仓库硬约束见 AGENTS.md §8。
 *      指纹足够回答「两处是不是同一串」「换 key 之后变没变」，反推不出密钥本身。
 *   2. **响应原文照留但截断**：上游响应体是诊断主体（status / message 全在里面），
 *      只截到 MAX_DIAGNOSTIC_BODY_BYTES，避免把本集合变成原始响应存档。
 *   3. **验签用的是完整字节**：截断只作用于「展示副本」。
 */

/** 诊断里最多保留多少响应体字节；验签与 JSON 解析仍用完整响应体。 */
export const MAX_DIAGNOSTIC_BODY_BYTES = 8 * 1024;
/** 响应头最多留多少条 / 单值最长多少字符。 */
const MAX_HEADER_ENTRIES = 40;
const MAX_HEADER_VALUE_LENGTH = 512;
const MAX_DIAGNOSTIC_REQUEST_BODY_LENGTH = 2 * 1024;
/** 批量请求的 IP 列表在诊断里最多回显多少个（其余只留计数）。 */
const MAX_DIAGNOSTIC_IPS = 5;

/** 一把密钥的形状：有没有配、多长、是哪一把（指纹）。**没有明文，永远不要加。** */
export interface ProxycheckKeyShape {
  present: boolean;
  length: number;
  fingerprint: string;
}

/** `verified` / `header_*` / `mismatch` 来自验签本身；另外三类是「根本没验成」。 */
export type ProxycheckSignatureVerdict =
  | PayloadSignatureVerdict
  | "not_configured"
  | "key_malformed"
  | "no_response";

export interface ProxycheckSignatureSnapshot {
  verdict: ProxycheckSignatureVerdict;
  headerName: string;
  /** 上游回签的原样值（不是本服务的密钥，可以展示）；没回就是空串。 */
  headerValue: string;
  /** 用「当前配置的那把密钥」对这份响应体重算出的签名；密钥不可用时为 null。 */
  expectedSignature: string | null;
  key: ProxycheckKeyShape;
}

/** 配置里四把密钥的形状快照，用于「填错成另一把」这类比对。 */
export interface ProxycheckKeySnapshot {
  apiKey: ProxycheckKeyShape;
  publicApiKey: ProxycheckKeyShape;
  payloadVerificationKey: ProxycheckKeyShape;
  hmacSecret: ProxycheckKeyShape;
  /**
   * payloadVerificationKey 与 hmacSecret 是不是同一串 —— 2026-10-02 线上事故的形态。
   * 用指纹比对即可判定，不需要（也不允许）拿出明文。
   */
  payloadVerificationKeyMatchesHmacSecret: boolean;
}

export interface ProxycheckExchangeSnapshot {
  method: string;
  /** 已脱敏：`key` 参数只剩长度与指纹。 */
  url: string;
  requestHeaders: Record<string, string>;
  /** 批量端点的表单体（`key` 已脱敏、`ips` 已折叠）；单地址查询为 null。 */
  requestBody: string | null;
  status: number | null;
  responseHeaders: Record<string, string>;
  /** 响应体（截断后的展示副本，见 MAX_DIAGNOSTIC_BODY_BYTES）。 */
  body: string;
  /** 响应体的**完整**字节数；与 body.length 不一致即说明被截断。 */
  bodyBytes: number;
  bodyTruncated: boolean;
  signature: ProxycheckSignatureSnapshot;
  keys: ProxycheckKeySnapshot;
  durationMs: number;
  /** 本次交互的错误码（成功时为空串）。 */
  errorCode: string;
  /** 验签未通过但按 PROXYCHECK.trustUnverifiedUpstream 采信了上游结论。 */
  trustedWithoutSignature: boolean;
}

/** 带上诊断的失败：`message` 与既有错误码逐字一致，调用方按前缀判定配置类错误不受影响。 */
export class ProxycheckUpstreamError extends Error {
  readonly diagnostics: ProxycheckExchangeSnapshot;

  constructor(code: string, diagnostics: ProxycheckExchangeSnapshot) {
    super(code);
    this.name = "ProxycheckUpstreamError";
    this.diagnostics = diagnostics;
  }
}

export function describeKeyShape(secret: unknown): ProxycheckKeyShape {
  const value = typeof secret === "string" ? secret.trim() : "";
  return {
    present: value.length > 0,
    length: value.length,
    fingerprint: fingerprintSecret(value),
  };
}

export function buildKeySnapshot(keys: {
  apiKey: unknown;
  publicApiKey: unknown;
  payloadVerificationKey: unknown;
  hmacSecret: unknown;
}): ProxycheckKeySnapshot {
  const payloadVerificationKey = describeKeyShape(keys.payloadVerificationKey);
  const hmacSecret = describeKeyShape(keys.hmacSecret);

  return {
    apiKey: describeKeyShape(keys.apiKey),
    publicApiKey: describeKeyShape(keys.publicApiKey),
    payloadVerificationKey,
    hmacSecret,
    payloadVerificationKeyMatchesHmacSecret:
      payloadVerificationKey.present &&
      hmacSecret.present &&
      payloadVerificationKey.fingerprint === hmacSecret.fingerprint,
  };
}

/** 密钥在诊断里的展示形态：长度 + 指纹，绝不含任何明文字符。 */
export function describeSecretForDiagnostics(secret: unknown): string {
  const shape = describeKeyShape(secret);
  if (!shape.present) return "<empty>";
  return `<redacted length=${shape.length} fp=${shape.fingerprint}>`;
}

/**
 * 把 `key` 查询参数换成脱敏占位。手搓 query 串而不用 URLSearchParams 的序列化：
 * 前者会把我方占位符里的 `<` `=` 二次编码成 `%3C` `%3D`，排障时读不动。
 */
export function buildRedactedUrl(rawUrl: string, apiKey: unknown): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return "<invalid-url>";
  }

  const pairs: string[] = [];
  parsed.searchParams.forEach((value, name) => {
    pairs.push(`${name}=${name === "key" ? describeSecretForDiagnostics(apiKey) : value}`);
  });

  const query = pairs.length > 0 ? `?${pairs.join("&")}` : "";
  return `${parsed.origin}${parsed.pathname}${query}`;
}

/** 批量端点的表单体：`key` 脱敏、`ips` 折叠成「前几个 + 计数」。 */
export function buildRedactedRequestBody(body: string, apiKey: unknown): string {
  const pairs: string[] = [];
  new URLSearchParams(body).forEach((value, name) => {
    if (name === "key") {
      pairs.push(`${name}=${describeSecretForDiagnostics(apiKey)}`);
      return;
    }
    if (name === "ips") {
      const ips = value.split(",").map((entry) => entry.trim()).filter(Boolean);
      const shown = ips.slice(0, MAX_DIAGNOSTIC_IPS).join(",");
      const rest = ips.length - Math.min(ips.length, MAX_DIAGNOSTIC_IPS);
      pairs.push(`${name}=${rest > 0 ? `${shown},…(+${rest})` : shown}`);
      return;
    }
    pairs.push(`${name}=${value}`);
  });

  const redacted = pairs.join("&");
  return redacted.length > MAX_DIAGNOSTIC_REQUEST_BODY_LENGTH
    ? `${redacted.slice(0, MAX_DIAGNOSTIC_REQUEST_BODY_LENGTH)}…[truncated]`
    : redacted;
}

/** 请求头逐条留档，但剔除任何可能带凭据的头（现在没有，将来也不许有）。 */
export function buildRequestHeaderSnapshot(headers: Record<string, string>): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (/authorization|cookie|token|secret|key/i.test(name)) continue;
    snapshot[name] = typeof value === "string" ? value : String(value);
  }
  return snapshot;
}

/** 响应头逐条留档：`set-cookie` 与超长值不外带，条数也有上限。 */
export function buildResponseHeaderSnapshot(response: Response): Record<string, string> {
  const snapshot: Record<string, string> = {};
  let count = 0;
  for (const [name, value] of response.headers.entries()) {
    if (count >= MAX_HEADER_ENTRIES) break;
    if (/^(set-cookie|authorization)$/i.test(name)) continue;
    snapshot[name] = value.length > MAX_HEADER_VALUE_LENGTH ? `${value.slice(0, MAX_HEADER_VALUE_LENGTH)}…` : value;
    count += 1;
  }
  return snapshot;
}

/** 展示副本按字节截断：只切 Buffer，不重新序列化（那样字节会变，验签必然对不上）。 */
export function truncateBodyForDiagnostics(rawBody: Buffer | null): {
  body: string;
  bodyBytes: number;
  bodyTruncated: boolean;
} {
  if (!rawBody) return { body: "", bodyBytes: 0, bodyTruncated: false };
  const truncated = rawBody.length > MAX_DIAGNOSTIC_BODY_BYTES;
  const slice = truncated ? rawBody.subarray(0, MAX_DIAGNOSTIC_BODY_BYTES) : rawBody;
  return {
    // 截断点可能落在多字节字符中间，末尾会出现替换字符：这是有意的取舍，
    // 展示副本宁可多一个 U+FFFD，也不能为了对齐字符边界去改动验签用的原始字节。
    body: slice.toString("utf8"),
    bodyBytes: rawBody.length,
    bodyTruncated: truncated,
  };
}

/** 无响应（网络层直接失败）时的验签快照：既没验签，也没有可验的内容。 */
export function buildNoResponseSignatureSnapshot(verificationKey: unknown): ProxycheckSignatureSnapshot {
  const key = describeKeyShape(verificationKey);
  return {
    verdict: key.present ? (isValidHmacKeyShape(String(verificationKey).trim()) ? "no_response" : "key_malformed") : "not_configured",
    headerName: PROXYCHECK_SIGNATURE_HEADER,
    headerValue: "",
    expectedSignature: null,
    key,
  };
}

/**
 * 验签快照。**始终尝试验签**（哪怕已决定不采信），否则诊断里就没有「差在哪」。
 * 密钥不可用时不算期望签名：拿一把永远验不过的密钥算什么结果都是噪音。
 */
export function buildSignatureSnapshot(
  rawBody: Buffer,
  verificationKey: unknown,
  providedHeader: string | null,
): ProxycheckSignatureSnapshot {
  const key = describeKeyShape(verificationKey);
  const headerValue = typeof providedHeader === "string" ? providedHeader.trim() : "";

  if (!key.present) {
    return {
      verdict: "not_configured",
      headerName: PROXYCHECK_SIGNATURE_HEADER,
      headerValue,
      expectedSignature: null,
      key,
    };
  }

  const secret = String(verificationKey).trim();
  if (!isValidHmacKeyShape(secret)) {
    return {
      verdict: "key_malformed",
      headerName: PROXYCHECK_SIGNATURE_HEADER,
      headerValue,
      expectedSignature: null,
      key,
    };
  }

  return {
    verdict: verifyPayloadSignature(rawBody, secret, headerValue),
    headerName: PROXYCHECK_SIGNATURE_HEADER,
    headerValue,
    expectedSignature: computePayloadSignature(rawBody, secret),
    key,
  };
}

export interface ExchangeSnapshotInput {
  method: string;
  /** 真实请求 URL；函数内部会把 `key` 脱敏。 */
  url: string;
  apiKey: unknown;
  requestHeaders: Record<string, string>;
  requestBody?: string | null;
  /** 没拿到响应（网络层失败）时为 null。 */
  response?: Response | null;
  /** 完整响应体；没拿到响应时为 null。 */
  rawBody?: Buffer | null;
  verificationKey: unknown;
  keys: ProxycheckKeySnapshot;
  errorCode?: string;
  durationMs: number;
  trustedWithoutSignature?: boolean;
}

export function buildExchangeSnapshot(input: ExchangeSnapshotInput): ProxycheckExchangeSnapshot {
  const body = truncateBodyForDiagnostics(input.rawBody ?? null);

  return {
    method: input.method,
    url: buildRedactedUrl(input.url, input.apiKey),
    requestHeaders: buildRequestHeaderSnapshot(input.requestHeaders),
    requestBody: input.requestBody ? buildRedactedRequestBody(input.requestBody, input.apiKey) : null,
    status: input.response ? input.response.status : null,
    responseHeaders: input.response ? buildResponseHeaderSnapshot(input.response) : {},
    body: body.body,
    bodyBytes: body.bodyBytes,
    bodyTruncated: body.bodyTruncated,
    signature:
      input.response && input.rawBody
        ? buildSignatureSnapshot(input.rawBody, input.verificationKey, input.response.headers.get(PROXYCHECK_SIGNATURE_HEADER))
        : buildNoResponseSignatureSnapshot(input.verificationKey),
    keys: input.keys,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    errorCode: input.errorCode ?? "",
    trustedWithoutSignature: input.trustedWithoutSignature === true,
  };
}

/**
 * 验签结论是否「不该被采信」。`not_configured` 是显式不验签（只依赖 TLS），不算失败；
 * `verified` 当然算通过。其余一律视为「这次响应没有可信签名」。
 */
export function isSignatureUntrusted(verdict: ProxycheckSignatureVerdict): boolean {
  return verdict !== "verified" && verdict !== "not_configured";
}
