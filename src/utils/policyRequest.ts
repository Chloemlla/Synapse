import type { Request } from "express";

/**
 * 政策相关端点共用的请求参数解析。
 *
 * 这些函数原先内联在 policyController 里；随着 /status 与 /history 也走同一套规则
 * （指纹优先取请求头、版本可省略、长度收敛），抽出来让三个端点共享同一份判据，
 * 避免各自实现后再慢慢分叉。
 */

export const FINGERPRINT_MAX_LENGTH = 100;
export const VERSION_MAX_LENGTH = 50;

/**
 * 请求里的设备指纹来源顺序：请求头 → 请求体 → 查询串。
 * 请求头优先是隐私考虑：指纹在本系统里就是设备凭据本体，放进 query 会同时落到访问日志、
 * 代理日志与 Referer（见 docs/audit-2026-09-30-policy-system.md P-04）。前端已统一走 X-Fingerprint。
 */
export function readFingerprintFromRequest(req: Request): unknown {
  const header = req.headers["x-fingerprint"];
  if (typeof header === "string" && header.trim()) return header;
  const body = (req.body as { fingerprint?: unknown } | undefined)?.fingerprint;
  if (typeof body === "string" && body.trim()) return body;
  return (req.query as { fingerprint?: unknown } | undefined)?.fingerprint;
}

/** 归一化指纹；`unknown` / 空白 / 超长一律视为无效。 */
export function parseFingerprint(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed === "unknown" || trimmed.length > FINGERPRINT_MAX_LENGTH) return null;
  return trimmed;
}

/** 版本参数：可省略（默认当前版本）；显式给出时必须是长度合理的非空字符串。 */
export function parseVersionInput(value: unknown): { valid: boolean; version?: string } {
  if (value === undefined || value === null || value === "") return { valid: true };
  if (typeof value !== "string") return { valid: false };
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > VERSION_MAX_LENGTH) return { valid: false };
  return { valid: true, version: trimmed };
}
