/**
 * 凭据材料脱敏（账户数据导出与 MongoDB 在库浏览共用）。
 *
 * 为什么单独一层：同一个「哪些字段算凭据」的判据如果写两份，迟早会有一边漏字段 ——
 * 漏的那一边就是把密码哈希/令牌写进导出文件或管理页面的那一侧。
 *
 * 规则：
 * - 键名归一（转小写、去掉非字母数字）后包含 password / secret / token / credential /
 *   ciphertext / privatekey / apikey / keyhash / cdkhash 的字段替换为 `[redacted]`；
 * - 精确命中 iv / tag / storageKey / rawResponse / backupCodes / pendingChallenge /
 *   currentChallenge / passkeyVerified 的字段同样替换；
 * - 二进制正文不写内容，只留 `{ redacted: true, type: "binary" }`；
 * - 日期转 ISO，ObjectId 转十六进制，循环/超深结构截断。
 *
 * 想保留的完整性元数据（sha256 / checksum / documentHash）不在规则内，会原样输出。
 */

export const REDACTED = "[redacted]";

/** 键名归一后包含这些片段的字段一律脱敏（凭据材料）。 */
const SENSITIVE_KEY_FRAGMENTS = [
  "password",
  "secret",
  "token",
  "credential",
  "ciphertext",
  "privatekey",
  "apikey",
  "keyhash",
  "cdkhash",
];

/** 精确匹配的敏感键（片段规则覆盖不到、又确实属于内部材料）。 */
const SENSITIVE_EXACT_KEYS = new Set([
  "iv",
  "tag",
  "storagekey",
  "rawresponse",
  "backupcodes",
  "pendingchallenge",
  "currentchallenge",
  "passkeyverified",
]);

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function shouldRedactKey(key: string): boolean {
  const normalized = normalizedKey(key);
  if (!normalized) return false;
  if (SENSITIVE_EXACT_KEYS.has(normalized)) return true;
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

function isBinary(value: unknown): boolean {
  return Buffer.isBuffer(value)
    || value instanceof Uint8Array
    || (typeof value === "object" && value !== null
      && typeof (value as { _bsontype?: unknown })._bsontype === "string"
      && (value as { _bsontype: string })._bsontype === "Binary");
}

/**
 * 递归脱敏。
 *
 * 不导出密码哈希、令牌、密钥、密文与内部存储键；二进制正文替换成大小标记。
 * Buffer 之外的对象保持结构，管理员仍能看到「有哪些字段、更新时间」。
 */
export function sanitizeForExport(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (depth > 12) return "[max-depth]";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (isBinary(value)) return { redacted: true, type: "binary" };
  if (Array.isArray(value)) return value.map((item) => sanitizeForExport(item, depth + 1));

  const candidate = value as { toHexString?: () => string } & Record<string, unknown>;
  if (typeof candidate.toHexString === "function") {
    try {
      return candidate.toHexString();
    } catch {
      return String(value);
    }
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(candidate)) {
    if (shouldRedactKey(key)) {
      result[key] = entry === undefined || entry === null ? null : REDACTED;
      continue;
    }
    result[key] = sanitizeForExport(entry, depth + 1);
  }
  return result;
}

