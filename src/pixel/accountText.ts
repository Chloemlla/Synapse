import { PixelDomainError } from "./types";
import type { PixelRuntimeLimits } from "./runtime";

/**
 * 账号文本的解析与校验（PIX-04）。
 *
 * 输入格式：`邮箱----密码----辅助邮箱----2FA密钥`，每行一个账号。
 *
 * 三条硬规则：
 *   1. **不保存、不回显**：函数只返回「账号数 + 归一化后的文本」，归一化文本随请求体一起交给上游后
 *      立刻失去引用；任何错误信息里都只有行号与计数，没有账号内容。
 *   2. **整批拒绝**：一行不合法就整批 400，并给出出错行号——半批入库/半批不发会让「将来算不出一共提交了几个」
 *      这类问题无法追责，也会让用户以为没提交的账号其实已经发出去了。
 *   3. **结构轻校验**：只校验「首字段像邮箱、字段数合理、字段长度有界、行内无控制字符」。
 *      不校验密码强度、不探测邮箱是否存在、不筛选账号——那会把工具变成撞库/探测工具。
 */

/** 分隔符与上游契约一致。 */
const FIELD_SEPARATOR = "----";
const MIN_FIELDS = 2;
const MAX_FIELDS = 6;
const MAX_FIELD_CHARS = 512;

export interface PixelParsedAccounts {
  accountCount: number;
  /** 已去掉空行、统一 `\n` 的文本；只在内存中传递。 */
  normalizedText: string;
}

export function parsePixelAccountsText(
  raw: unknown,
  limits: PixelRuntimeLimits,
): PixelParsedAccounts {
  if (typeof raw !== "string") {
    throw new PixelDomainError("请输入账号信息。", 400, "PIXEL_ACCOUNTS_REQUIRED");
  }
  if (Buffer.byteLength(raw, "utf8") > limits.maxAccountsTextBytes) {
    throw new PixelDomainError("账号信息太长，请分批提交。", 413, "PIXEL_ACCOUNTS_TOO_LARGE", {
      maxBytes: limits.maxAccountsTextBytes,
    });
  }

  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length === 0) {
    throw new PixelDomainError("请输入账号信息。", 400, "PIXEL_ACCOUNTS_REQUIRED");
  }
  if (lines.length > limits.maxAccountsPerSubmission) {
    throw new PixelDomainError(
      `一次最多提交 ${limits.maxAccountsPerSubmission} 个账号，请分批提交。`,
      400,
      "PIXEL_ACCOUNTS_TOO_MANY",
      { max: limits.maxAccountsPerSubmission, count: lines.length },
    );
  }

  const seen = new Map<string, number>();
  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(line) || line.length > limits.maxAccountLineChars) {
      throw new PixelDomainError(`第 ${lineNumber} 行格式不正确。`, 400, "PIXEL_ACCOUNT_LINE_INVALID", {
        lineNumber,
        maxChars: limits.maxAccountLineChars,
      });
    }
    const fields = line.split(FIELD_SEPARATOR);
    if (fields.length < MIN_FIELDS || fields.length > MAX_FIELDS) {
      throw new PixelDomainError(`第 ${lineNumber} 行格式不正确。`, 400, "PIXEL_ACCOUNT_LINE_INVALID", {
        lineNumber,
        expected: "邮箱----密码----辅助邮箱----2FA密钥",
      });
    }
    if (fields.some((field) => field.length === 0 || field.length > MAX_FIELD_CHARS)) {
      throw new PixelDomainError(`第 ${lineNumber} 行格式不正确。`, 400, "PIXEL_ACCOUNT_LINE_INVALID", {
        lineNumber,
      });
    }
    const email = fields[0];
    if (!email.includes("@") || /\s/.test(email)) {
      throw new PixelDomainError(`第 ${lineNumber} 行的邮箱格式不正确。`, 400, "PIXEL_ACCOUNT_LINE_INVALID", {
        lineNumber,
      });
    }
    const firstSeenAt = seen.get(line);
    if (firstSeenAt !== undefined) {
      throw new PixelDomainError("账号信息里有重复行，请检查后再提交。", 400, "PIXEL_ACCOUNT_DUPLICATE", {
        lineNumber,
        firstLineNumber: firstSeenAt,
      });
    }
    seen.set(line, lineNumber);
  });

  return { accountCount: lines.length, normalizedText: lines.join("\n") };
}

/** 客户端提交的幂等键：非空、长度有界、只允许可见 ASCII（避免变成注入面或超长 payload）。 */
export function normalizeIdempotencyKey(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value || value.length < 8 || value.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new PixelDomainError(
      "提交标识无效，请刷新页面后重试。",
      400,
      "PIXEL_IDEMPOTENCY_KEY_REQUIRED",
    );
  }
  return value;
}
