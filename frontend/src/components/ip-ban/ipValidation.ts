/**
 * IP / CIDR 的前端预校验。
 *
 * 与后端 `src/controllers/turnstile/_helpers.ts` 的 `isValidIpOrCidr` 同口径（同样只收
 * IPv4/IPv6 单地址与 CIDR）。前端做这件事**不是**为了取代后端校验，而是为了在批量粘贴
 * 时先告诉管理员「这 30 行里 3 行不合法、5 行重复」，而不是原样发出去让后端逐条报错。
 */

const IPV4 = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
const IPV4_CIDR =
  /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\/([0-9]|[12][0-9]|3[0-2])$/;
const IPV6 =
  /^(?:(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,7}:|(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|::|(?:[0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){1,2}|(?:[0-9a-fA-F]{1,4}:){1,4}(?::[0-9a-fA-F]{1,4}){1,3}|(?:[0-9a-fA-F]{1,4}:){1,3}(?::[0-9a-fA-F]{1,4}){1,4}|(?:[0-9a-fA-F]{1,4}:){1,2}(?::[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:(?::[0-9a-fA-F]{1,4}){1,6}|:(?:(?::[0-9a-fA-F]{1,4}){1,7}|:))$/;
const IPV6_CIDR =
  /^(?:(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,7}:|(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|::|(?:[0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){1,2}|(?:[0-9a-fA-F]{1,4}:){1,4}(?::[0-9a-fA-F]{1,4}){1,3}|(?:[0-9a-fA-F]{1,4}:){1,3}(?::[0-9a-fA-F]{1,4}){1,4}|(?:[0-9a-fA-F]{1,4}:){1,2}(?::[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:(?::[0-9a-fA-F]{1,4}){1,6}|:(?:(?::[0-9a-fA-F]{1,4}){1,7}|:))\/([0-9]|[1-9][0-9]|1[01][0-9]|12[0-8])$/;

export function isValidIpOrCidr(value: string): boolean {
  const text = value.trim();
  if (!text) return false;
  return IPV4.test(text) || IPV4_CIDR.test(text) || IPV6.test(text) || IPV6_CIDR.test(text);
}

export interface BatchParseResult {
  /** 去重后的可提交条目。 */
  valid: string[];
  /** 重复出现的行（已在上面的 valid 里去重，这里只做提示）。 */
  duplicates: string[];
  /** 形态非法的行，原样保留以便高亮定位。 */
  invalid: string[];
}

/** 按行切分批量输入：去空行、去重、区分「非法」与「重复」。 */
export function parseBatchInput(raw: string): BatchParseResult {
  const seen = new Set<string>();
  const valid: string[] = [];
  const duplicates: string[] = [];
  const invalid: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    if (!isValidIpOrCidr(text)) {
      invalid.push(text);
      continue;
    }
    if (seen.has(text)) {
      duplicates.push(text);
      continue;
    }
    seen.add(text);
    valid.push(text);
  }

  return { valid, duplicates, invalid };
}
