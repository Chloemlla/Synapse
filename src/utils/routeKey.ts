/**
 * 请求路由键（`routeKey`）的归一化 —— RC-45。
 *
 * 用途：step-up 单次令牌 / grant 必须绑定到「哪一类路由」，
 * 否则攻击者拿到一张低危路由的令牌就能用在 `/api/command` 上。
 *
 * 三条硬规则（来自 RC-45 审计）：
 * 1. **不得用 `req.route.path`**：`req.route` 只在具体路由 handler 阶段才被 Express 挂上，
 *    在早期中间件里恒为 `undefined` —— 令牌会签不出来，或所有人撞同一个 `undefined` 键。
 *    这里一律用 `req.baseUrl + req.path`（在路由级中间件里两者都已确定）。
 * 2. **必须归一化动态段**：`/api/resources/a1b2` 与 `/api/resources/c3d4` 是同一类路由；
 *    不归一化的话 `payloadHash`/`routeKey` 绑定形同虚设（换个 id 就绕过）。
 *    只折叠**确定 id 形状**的段（纯数字 / ObjectId / 带连字 UUID / CUID），
 *    其余保持原样 —— 宁可窄（要求重新验证），也不得过度通配把窄路由令牌升级成一类路由的通行证。
 * 3. **校验时重算**，不信任客户端上报的 routeKey（客户端可自称低危路由）。
 */

/** 纯数字（含很长的自增 id）。 */
const NUMERIC_SEGMENT = /^\d+$/;
/** Mongo ObjectId：24 位十六进制。 */
const OBJECT_ID_SEGMENT = /^[0-9a-f]{24}$/i;
/** 标准 UUID（含连字）。 */
const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** CUID v1（`c` + 24 位 base36）与 CUID2（`c` 开头的长小写串）。 */
const CUID_SEGMENT = /^c[0-9a-z]{16,40}$/;

export const DYNAMIC_SEGMENT_PLACEHOLDER = ":id";

export function isIdLikeSegment(segment: string): boolean {
  if (!segment) return false;
  return (
    NUMERIC_SEGMENT.test(segment) ||
    OBJECT_ID_SEGMENT.test(segment) ||
    UUID_SEGMENT.test(segment) ||
    CUID_SEGMENT.test(segment)
  );
}

function normalizeSegment(segment: string): string {
  return isIdLikeSegment(segment) ? DYNAMIC_SEGMENT_PLACEHOLDER : segment;
}

/**
 * 把 `baseUrl`（可能带 query / 尾斜杠 / 多余斜杠）折成稳定的路由键。
 *
 * 处理顺序有意为之：先剥 query 与 hash、再按 `/` 切段。**不做百分号解码** ——
 * 解码会把 `%2F` 变成路径分隔符，把两个不同的路由折成同一个键（过度通配，
 * 正是 RC-45 要防的失败模式）；编码形态的 id 只是不再折叠成 `:id`，方向上属于“宁窄不宽”。
 */
export function normalizeRouteKey(baseUrl: string, path: string): string {
  const raw = `${typeof baseUrl === "string" ? baseUrl : ""}${typeof path === "string" ? path : ""}`;
  const withoutQuery = raw.split("#")[0].split("?")[0];
  const segments = withoutQuery
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .map((segment) => normalizeSegment(segment));

  return `/${segments.join("/")}`;
}

/**
 * 从 Express 请求上取路由键。刻意只接受最小结构（便于单测直接喂普通对象）。
 *
 * 注意 `req.baseUrl` 在应用级中间件里为空，此时 `req.path` 已是完整路径（如 `/api/user/me`）；
 * 在路由级中间件里 baseUrl 是挂载前缀、path 是剩余部分 —— 两种拼接结果一致。
 */
export function routeKeyFromRequest(req: { baseUrl?: string; path?: string; url?: string }): string {
  const baseUrl = typeof req.baseUrl === "string" ? req.baseUrl : "";
  const path = typeof req.path === "string" && req.path ? req.path : typeof req.url === "string" ? req.url : "";
  return normalizeRouteKey(baseUrl, path);
}

/**
 * 请求体摘要，用于防止「验一次、改内容重放」（RC-03 的 `payloadHash`）。
 *
 * 只对**幂等摘要**负责：键排序后 JSON.stringify 再哈希，保证同一语义的 body
 * （键顺序不同）得到同一摘要；其余形态（数组顺序、数值精度）保持原样，不做“聪明”的归一化，
 * 否则会把内容不同的请求判成同一摘要，反而放过重放。
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}
