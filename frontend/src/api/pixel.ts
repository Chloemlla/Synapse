import { api } from "./api";
import type { PixelCardQuota, PixelServiceType, PixelSettings, PixelSubmitResult, PixelTaskDetail, PixelTaskSummary } from "../types/pixel";

// Pixel 用户侧客户端。两条纪律：
//  1) 卡密与账号文本只作为请求体出现（绝不进 URL / 查询串，避免落进访问日志）。
//  2) 账号文本不写 localStorage、不写任何持久化；离开页面即从内存消失。
type Envelope<T> = { success: boolean; data: T };

function data<T>(response: { data: Envelope<T> }): T {
  if (!response.data?.success) throw new Error("请求暂时无法完成，请稍后重试。");
  return response.data.data;
}

export async function getPixelSettings(): Promise<PixelSettings> {
  return data(await api.get<Envelope<PixelSettings>>("/api/pixel/settings"));
}

export async function verifyPixelCard(card: string): Promise<PixelCardQuota> {
  return data(await api.post<Envelope<PixelCardQuota>>("/api/pixel/verify-card", { card }));
}

export async function submitPixelTask(input: {
  card: string;
  serviceType: PixelServiceType;
  accountsText: string;
  idempotencyKey: string;
}): Promise<PixelSubmitResult> {
  return data(await api.post<Envelope<PixelSubmitResult>>("/api/pixel/submit-task", input));
}

export async function getPixelTask(taskId: string): Promise<PixelTaskDetail> {
  return data(await api.get<Envelope<PixelTaskDetail>>(`/api/pixel/tasks/${encodeURIComponent(taskId)}`));
}

export async function listPixelTasksByCard(input: { card: string; accountQuery?: string }): Promise<PixelTaskSummary[]> {
  return data(await api.post<Envelope<PixelTaskSummary[]>>("/api/pixel/tasks-by-card", input));
}

export async function cancelPixelQueuedAccount(taskId: string, accountId: number): Promise<{ cancelled: boolean }> {
  return data(await api.post<Envelope<{ cancelled: boolean }>>(
    `/api/pixel/tasks/${encodeURIComponent(taskId)}/accounts/${encodeURIComponent(String(accountId))}/cancel-queue`,
  ));
}

export async function exportPixelTask(taskId: string): Promise<Blob> {
  const response = await api.get<Blob>(`/api/pixel/tasks/${encodeURIComponent(taskId)}/export`, { responseType: "blob" });
  return response.data;
}

export async function exportPixelTasksByCard(input: { card: string; accountQuery?: string }): Promise<Blob> {
  const response = await api.post<Blob>("/api/pixel/tasks/export-by-card", input, { responseType: "blob" });
  return response.data;
}

export async function exportPixelUserData(): Promise<Blob> {
  const response = await api.get<Blob>("/api/pixel/export", { responseType: "blob" });
  return response.data;
}

/** 把 axios 错误收敛成「用户下一步该做什么」，而不是把状态码或内部文案摊给用户。 */
export type PixelFailure = {
  kind: "unauthenticated" | "forbidden" | "not-found" | "rate-limited" | "conflict" | "uncertain" | "invalid" | "unavailable" | "unknown";
  message: string;
};

export function describePixelFailure(error: unknown): PixelFailure {
  const status = (error as { response?: { status?: number } })?.response?.status;
  const serverMessage = (error as { response?: { data?: { error?: unknown } } })?.response?.data?.error;
  const message = typeof serverMessage === "string" && serverMessage.trim() ? serverMessage : "";
  switch (status) {
    case 401:
      return { kind: "unauthenticated", message: message || "登录状态已失效，请重新登录。" };
    case 403:
      return { kind: "forbidden", message: message || "需要先同意相关条款，或这张卡密已停用。" };
    case 404:
      return { kind: "not-found", message: message || "没有找到对应的卡密或任务。" };
    case 409:
      return { kind: "conflict", message: message || "这次提交还在处理中，请不要重复提交。" };
    case 413:
      return { kind: "invalid", message: message || "账号文本过长，请分批提交。" };
    case 429:
      return { kind: "rate-limited", message: message || "操作过于频繁，请稍后再试。" };
    case 502:
      // 502 在这里专指「上游是否受理不确定」：必须明确告诉用户不要重试，先去历史里确认。
      return { kind: "uncertain", message: message || "这次提交的结果不确定，请先到历史任务里确认，不要重复提交。" };
    case 503:
      return { kind: "unavailable", message: message || "该服务当前不可用，请联系管理员。" };
    default:
      return { kind: "unknown", message: message || "请求暂时无法完成，请稍后重试。" };
  }
}
