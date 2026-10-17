import { api } from "./api";

/**
 * 管理端账户数据（用户管理页「数据」弹窗）。
 *
 * 权限：摘要 = 超管；导出 = 超管 + 安全会话。共享 axios 实例会自动带上
 * `x-verification-token`，所以建立安全会话后无需在这里手工传头。
 */

export interface AccountDataSubject {
  id: string;
  username: string;
  email: string;
  role: string;
  deletedAt: number | null;
  deletedBy: string | null;
  deleteReason: string | null;
  accountStatus: string | null;
}

export interface AccountDataDatasetSummary {
  id: string;
  label: string;
  collection: string;
  support: "full" | "partial";
  count: number;
  returned: number;
  truncated: boolean;
  note?: string;
}

export interface AccountDataOmitted {
  id: string;
  label: string;
  reason: string;
}

export interface AccountDataSummary {
  subject: AccountDataSubject;
  datasets: AccountDataDatasetSummary[];
  omitted: AccountDataOmitted[];
}

export interface AccountDataExportResult {
  blob: Blob;
  filename: string | null;
}

const DOWNLOAD_TIMEOUT_MS = 120_000;

function readFilename(disposition: unknown, fallback: string): string {
  const raw = String(disposition ?? "");
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(raw);
  if (utf8) {
    try {
      return decodeURIComponent(utf8[1]);
    } catch {
      // 落到 ASCII 回退
    }
  }
  const ascii = /filename="?([^";]+)"?/i.exec(raw);
  return ascii ? ascii[1] : fallback;
}

function saveBlob(data: Blob, filename: string): void {
  const url = window.URL.createObjectURL(data);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.setTimeout(() => window.URL.revokeObjectURL(url), 2000);
}

/**
 * 读取账户数据摘要（只统计条数）。打开弹窗时调用，不触发任何导出。
 */
export async function fetchAccountDataSummary(userId: string): Promise<AccountDataSummary> {
  const response = await api.get<AccountDataSummary>(
    `/api/admin/users/${encodeURIComponent(userId)}/data-summary`,
  );
  return response.data;
}

/** 导出单个账户数据并直接落盘。返回文件名与体积，供成功提示展示。 */
export async function downloadAccountData(userId: string): Promise<AccountDataExportResult> {
  const response = await api.get<Blob>(
    `/api/admin/users/${encodeURIComponent(userId)}/export`,
    { responseType: "blob", timeout: DOWNLOAD_TIMEOUT_MS },
  );
  const fallback = `account-export-${userId}-${new Date().toISOString().slice(0, 10)}.json`;
  const disposition = response.headers?.["content-disposition"];
  const filename = readFilename(disposition, fallback);
  saveBlob(response.data, filename);
  return { blob: response.data, filename };
}

/** 批量导出（最多 10 个账号）并直接落盘。 */
export async function downloadAccountsData(userIds: string[]): Promise<AccountDataExportResult> {
  const response = await api.post<Blob>(
    "/api/admin/users/export",
    { userIds },
    { responseType: "blob", timeout: DOWNLOAD_TIMEOUT_MS },
  );
  const fallback = `accounts-export-${userIds.length}-${new Date().toISOString().slice(0, 10)}.json`;
  const disposition = response.headers?.["content-disposition"];
  const filename = readFilename(disposition, fallback);
  saveBlob(response.data, filename);
  return { blob: response.data, filename };
}

/**
 * `responseType: "blob"` 时错误响应体也是 Blob，通用错误提取读不出后端文案；
 * 这里先把 Blob 读成文本再解析，保证「需要安全会话」「超过体积上限」这类关键
 * code / 文案不会被吞成一句泛化错误。
 */
export async function extractAccountDataErrorMessage(error: unknown, fallback: string): Promise<string> {
  const data = (error as { response?: { data?: unknown } } | undefined)?.response?.data;
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    try {
      const parsed = JSON.parse(await data.text()) as { error?: unknown; code?: unknown };
      if (typeof parsed?.error === "string" && parsed.error) return parsed.error;
    } catch {
      // 落到通用错误提取
    }
  }
  const responseData = (error as { response?: { data?: { error?: unknown } } } | undefined)?.response?.data;
  if (responseData && typeof responseData === "object" && typeof responseData.error === "string") {
    return responseData.error;
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

/** 从错误响应里读稳定 code（例如 SECURITY_SESSION_REQUIRED）。 */
export async function extractAccountDataErrorCode(error: unknown): Promise<string | null> {
  const data = (error as { response?: { data?: unknown } } | undefined)?.response?.data;
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    try {
      const parsed = JSON.parse(await data.text()) as { code?: unknown };
      return typeof parsed?.code === "string" ? parsed.code : null;
    } catch {
      return null;
    }
  }
  if (data && typeof data === "object" && typeof (data as { code?: unknown }).code === "string") {
    return (data as { code: string }).code;
  }
  return null;
}
