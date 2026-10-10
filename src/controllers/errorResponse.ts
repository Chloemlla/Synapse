import type { Response } from "express";
import logger from "../utils/logger";

/** Only explicit HTTP error statuses are accepted; driver codes are not HTTP statuses. */
export function errorStatus(error: unknown): number {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500;
}

/** Diagnostics remain useful without returning URLs, credentials or provider response bodies. */
export function safeFailureDetails(error: unknown) {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const code = (error as { code?: unknown } | null)?.code;
  const reportedStatus = message.match(/(?:失败:|状态码:)\s*([45]\d{2})\b|\(([45]\d{2})\)/);
  const rawStatus = (error as { response?: { status?: unknown } } | null)?.response?.status
    ?? (reportedStatus ? Number(reportedStatus[1] || reportedStatus[2]) : undefined);
  const upstreamStatus = typeof rawStatus === "number" && Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599
    ? rawStatus : undefined;
  const reason = code === "ETIMEDOUT" || code === "ECONNABORTED" || /ETIMEDOUT|ECONNABORTED|timeout|超时/i.test(message) ? "timeout"
    : code === "ENOTFOUND" || code === "EAI_AGAIN" || /ENOTFOUND|EAI_AGAIN/.test(message) ? "dns"
    : /ECONNREFUSED|ECONNRESET|ENETUNREACH|无响应|不可达/.test(message) ? "connection"
    : upstreamStatus === 401 || upstreamStatus === 403 ? "upstream_authentication"
    : upstreamStatus === 429 ? "upstream_rate_limited"
    : upstreamStatus ? "upstream_rejected" : "service_unavailable";
  return { reason, retryable: upstreamStatus === undefined || upstreamStatus === 429 || upstreamStatus >= 500, ...(upstreamStatus ? { upstreamStatus } : {}) };
}

const TOOL_INPUT_ERRORS = new Map<string, number>([
  ["Base64解码失败：输入不是有效的Base64字符串", 400],
  ["身高和体重必须为正数", 400],
  ["身高和体重参数不能为空", 400],
  ["加密文本不能为空", 400],
  ["操作文本不能为空", 400],
  ["操作类型必须是 encode(编码) 或 decode(解码)", 400],
  ["URL参数不能为空", 400],
  ["URL格式不正确", 400],
  ["手机号码格式无效，请输入11位数字", 400],
  ["城市名称格式无效", 400],
  ["查询过于频繁，请稍后重试", 429],
]);

export function sendToolFailure(res: Response, error: unknown, fallback: string): void {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const status = TOOL_INPUT_ERRORS.get(message);
  if (status) {
    res.status(status).json({ success: false, error: message });
    return;
  }
  logger.error("工具服务调用失败", { operation: fallback, error: message });
  res.status(500).json({ success: false, error: fallback, details: safeFailureDetails(error) });
}
