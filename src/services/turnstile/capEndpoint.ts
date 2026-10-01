import { CAP_DEFAULT_API_ENDPOINT } from "./constants";

/**
 * Cap 实例地址的校验与归一。
 *
 * 这个值由管理端写入、被服务端用来发起出站请求（challenge / siteverify），
 * 因此属于典型的 SSRF 面：一旦被写坏（或管理员账号被接管），服务端就会按指令去访问内网。
 * 这里做三件事：
 *   1. 只接受 http/https，拒绝带凭据的 URL；
 *   2. 拒绝回环 / 私网 / 链路本地 / 云元数据等内网目标；
 *   3. 用解析后的部件**重建** origin（丢弃 query/hash 与子路径），sink 拿到的是重建值。
 * 子路径部署（如 https://host/cap）当前不支持，直接判为非法而不是静默截断，
 * 避免"配置看起来生效、实际请求打到别的路径"。
 */

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/** 内网/元数据目标黑名单：命中即拒绝。 */
const BLOCKED_HOST_PATTERNS: RegExp[] = [
  /^localhost$/,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^\[?::1\]?$/,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, // 链路本地，含云元数据 169.254.169.254
  /^\[?fe80:/,
  /^\[?f[cd][0-9a-f]{2}:/, // 唯一本地地址 fc00::/7
  /\.internal$/,
  /\.local$/,
  /^metadata\./,
  /^metadata$/,
];

/**
 * Cap Standalone 的 siteKey 是 `randomBytes(5).toString("hex")`，即 10 位十六进制。
 * 它会被拼进出站 URL 的路径段，因此写入侧与读取侧都按格式卡住（非该格式一律拒）。
 */
const CAP_SITE_KEY_PATTERN = /^[a-f0-9]{10}$/i;

export function isValidCapSiteKey(value: unknown): value is string {
  return typeof value === "string" && CAP_SITE_KEY_PATTERN.test(value.trim());
}

export interface CapEndpointValidation {
  /** 校验是否通过。 */
  ok: boolean;
  /** 校验通过的 origin（重建值）；不通过时回落为默认实例地址。 */
  origin: string;
  /** 不通过的原因，供管理端提示。 */
  reason?: string;
}

export function validateCapEndpoint(raw: string | null | undefined): CapEndpointValidation {
  const candidate = (raw ?? "").trim() || CAP_DEFAULT_API_ENDPOINT;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, origin: CAP_DEFAULT_API_ENDPOINT, reason: "地址无法解析，请填写完整 URL（含 https://）" };
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return { ok: false, origin: CAP_DEFAULT_API_ENDPOINT, reason: "只支持 http/https 协议" };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, origin: CAP_DEFAULT_API_ENDPOINT, reason: "地址中不允许携带用户名或密码" };
  }

  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) {
    return { ok: false, origin: CAP_DEFAULT_API_ENDPOINT, reason: "地址缺少主机名" };
  }

  if (BLOCKED_HOST_PATTERNS.some((pattern) => pattern.test(hostname))) {
    return {
      ok: false,
      origin: CAP_DEFAULT_API_ENDPOINT,
      reason: "不允许指向本机、内网或云元数据地址",
    };
  }

  const path = parsed.pathname.replace(/\/+$/, "");
  if (path) {
    return { ok: false, origin: CAP_DEFAULT_API_ENDPOINT, reason: "请使用实例根地址，暂不支持子路径部署" };
  }

  const port = parsed.port ? `:${parsed.port}` : "";
  return { ok: true, origin: `${parsed.protocol}//${hostname}${port}` };
}

/** 取校验通过的地址，不通过则回落到默认实例（调用方如需提示，直接用 validateCapEndpoint）。 */
export function sanitizeCapEndpoint(raw: string | null | undefined): string {
  return validateCapEndpoint(raw).origin;
}
