/**
 * G1-24: 审计脱敏字段判定。以前 auditLog 中间件与 auditLogService 各维护一份
 * 硬编码模糊列表，两份会漂移，且 `key` / `code` / `sig` 做包含匹配会把
 * keyword、statusCode、countryCode、design、assigned 之类无害字段一并打码，
 * 审计记录因此失真。这里是唯一来源：EXACT 只匹配完整字段名，
 * SUBSTRING 才做包含匹配。
 */
export const normalizeAuditFieldName = (key: string): string => key.toLowerCase().replace(/[\s\-_]/g, "");

const SENSITIVE_AUDIT_FIELDS_EXACT = new Set(
  [
    "password",
    "newpassword",
    "oldpassword",
    "confirmpassword",
    "token",
    "secret",
    "clientsecret",
    "authorization",
    "apikey",
    "ttsAppKey",
    "VIVO_TTS_APP_KEY",
    "jwt",
    "refreshtoken",
    "accesstoken",
    "idtoken",
    "code",
    "otp",
    "sig",
    "signature",
    "key",
    "privatekey",
    "totpsecret",
    "backupcodes",
    "cookie",
    "session",
    // R3-03（2026-10-03）：本仓实际使用的验证码 / 其它一次性令牌字段名。
    // 为什么必须逐名列出：审计中间件对 `req.body` 的捕获是**默认开启**的
    // （`captureBody === false ? undefined : sanitizePayload(req.body)`），所以只要
    // 将来某条被审计的路由体里带验证码，它就会被写进 60 天保留、可 CSV 导出的日志。
    // 不能改成新增 `token` 子串匹配 —— 那会连 tokenCount / tokenExpiresAt 这类
    // 无害字段一起打码，把审计记录弄失真（正是本文件开头记录的那个历史缺陷）。
    "cftoken",
    "captchatoken",
    "turnstiletoken",
    "hcaptchatoken",
    "captoken",
    "integritytoken",
    "encryptedvalue",
    "svixsignature",
    // 安全会话令牌（`x-verification-token` 请求体/头里的同名字段）：它等价于一次
    // 已完成的二次验证，落进 60 天可导出的审计库就等于把“当时的身份凭证”存档。
    "verificationtoken",
    "xverificationtoken",
  ].map(normalizeAuditFieldName),
);

const SENSITIVE_AUDIT_FIELD_SUBSTRINGS = [
  "password",
  "secret",
  "apikey",
  "privatekey",
  "accesstoken",
  "refreshtoken",
].map(normalizeAuditFieldName);

export const isSensitiveAuditField = (key: string): boolean => {
  const normalized = normalizeAuditFieldName(key);
  return (
    SENSITIVE_AUDIT_FIELDS_EXACT.has(normalized) ||
    SENSITIVE_AUDIT_FIELD_SUBSTRINGS.some((pattern) => normalized.includes(pattern))
  );
};

/** 载荷里被判定敏感的字段替换成的占位串（与 logger 的 `***` 同义，便于 grep）。 */
export const REDACTED_LOG_VALUE = "[REDACTED]";

/** 递归深度上限：日志载荷是扁平诊断信息（根 + 两层），再深基本等于有人把整棵树塞进来了。 */
const LOG_PAYLOAD_MAX_DEPTH = 3;

const redactValue = (value: unknown, depth: number): unknown => {
  if (value instanceof Date || value instanceof Error) return value;
  if (Array.isArray(value)) {
    if (depth >= LOG_PAYLOAD_MAX_DEPTH) return REDACTED_LOG_VALUE;
    return value.map((item) => redactValue(item, depth + 1));
  }
  if (value && typeof value === "object") {
    if (depth >= LOG_PAYLOAD_MAX_DEPTH) return REDACTED_LOG_VALUE;
    const redacted: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      redacted[key] = isSensitiveAuditField(key) ? REDACTED_LOG_VALUE : redactValue(item, depth + 1);
    }
    return redacted;
  }
  return value;
};

/**
 * 日志载荷脱敏：所有 `logger.*` 的 meta 载荷都从这里过一道。
 *
 * 为什么需要它，而不是「调用点自己保证只记 id」：`js/clear-text-logging` 按字段名
 * 判定敏感度 —— `req.apiKey` 上的 Key 文档一旦成为源，从它派生出的 `keyId` / `userId`
 * 全被算作凭据流，调用点写不写注释都拦不住（本仓不发抑制查询，`// codeql[...]` 无效）。
 * 过一道按名单过滤的函数，把「这里只记 id」变成**可执行、可测试**的边界：
 * 以后有人往同一个 `logger` 调用里加 `apiKey` / `secret` 字段，会被就地打码而不是写进日志。
 *
 * 与 `isSensitiveAuditField` 共用同一份名单，避免审计脱敏与日志脱敏两套口径漂移。
 */
export function redactLogPayload(payload: Record<string, unknown>): Record<string, unknown> {
  return redactValue(payload, 0) as Record<string, unknown>;
}
