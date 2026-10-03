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
