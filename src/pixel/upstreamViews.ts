import {
  PIXEL_ACCOUNT_STATUSES,
  PIXEL_EXPORTABLE_ACCOUNT_STATUSES,
  PIXEL_TASK_STATUSES,
  type PixelAccountStatus,
  type PixelTaskAccountView,
  type PixelTaskDetailView,
  type PixelTaskStatus,
  type PixelTaskSummaryView,
} from "./types";

/**
 * 上游响应 → 本地视图的归一化（PIX-05/PIX-06/PIX-07 的解析层）。
 *
 * 单独成文件的两个理由：
 *   1) 上游契约是「从公开页面重建的草案」，字段名与形状都可能变；把**所有**字段读取集中在这里，
 *      契约变动只有一处要改，业务逻辑（taskService）不必跟着动；
 *   2) 归一化必须是**白名单拷贝**：只从上游响应里取我们认识的字段，
 *      于是上游将来多回一个字段（邮箱副本、完整账号、内部备注）也不会顺手被我们转发出去。
 *
 * 未知状态不冒充已知状态：上游新增状态时归一成 "unknown"，界面上显示「未知」比错标成失败安全。
 */

/** 单条任务详情最多归一化的账号数：防上游返回超长数组把响应和内存撑爆。 */
const MAX_ACCOUNTS_IN_RESPONSE = 1_000;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toText(value: unknown, maxLength = 500): string {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

const TASK_STATUS_SET = new Set<string>(PIXEL_TASK_STATUSES);
const ACCOUNT_STATUS_SET = new Set<string>(PIXEL_ACCOUNT_STATUSES);

export function normalizeTaskStatus(value: unknown): PixelTaskStatus | "unknown" {
  return typeof value === "string" && TASK_STATUS_SET.has(value) ? (value as PixelTaskStatus) : "unknown";
}

/**
 * 未知账号状态不冒充已知状态：上游加了新状态时界面上显示成「未知」比错标成「失败」安全。
 */
function normalizeAccountStatus(value: unknown): PixelAccountStatus | "unknown" {
  return typeof value === "string" && ACCOUNT_STATUS_SET.has(value)
    ? (value as PixelAccountStatus)
    : "unknown";
}

function normalizeTaskAccount(raw: unknown): PixelTaskAccountView {
  const value = asRecord(raw);
  const id = toNumber(value.id);
  return {
    id: id ?? 0,
    lineNumber: toNumber(value.line_number) ?? 0,
    email: toText(value.email, 320),
    status: normalizeAccountStatus(value.status),
    message: toText(value.message, 500),
    // 结果链接只回给本人；不落库、不进审计。
    resultLink: toText(value.result_link, 2_048),
    queuePosition: toNumber(value.queue_position),
  };
}

export function normalizeTaskDetail(raw: unknown, fallbackTaskId: string): PixelTaskDetailView {
  const value = asRecord(raw);
  const accounts = asArray(value.accounts).slice(0, MAX_ACCOUNTS_IN_RESPONSE).map(normalizeTaskAccount);
  return {
    taskId: toText(value.task_id, 200) || fallbackTaskId,
    status: normalizeTaskStatus(value.status),
    totalAccounts: toNumber(value.total_accounts) ?? accounts.length,
    cancelledCount: accounts.filter((account) => account.status === "cancelled").length,
    accounts,
  };
}

export function normalizeTaskSummary(raw: unknown): PixelTaskSummaryView | null {
  const value = asRecord(raw);
  const taskId = toText(value.task_id, 200);
  if (!taskId) return null;
  return {
    taskId,
    totalAccounts: toNumber(value.total_accounts) ?? 0,
    status: normalizeTaskStatus(value.status),
    success: toNumber(value.success) ?? 0,
    failed: toNumber(value.failed) ?? 0,
    cancelled: toNumber(value.cancelled) ?? 0,
    done: toNumber(value.done) ?? 0,
    createdAt: toText(value.created_at, 64),
  };
}

/** 导出文本行：与来源页面一致的 `email----result_link`。 */
export function buildExportText(rows: Array<{ email: string; resultLink: string }>): string {
  const lines = rows
    .filter((row) => row.email && row.resultLink)
    .map((row) => `${row.email}----${row.resultLink}`);
  return lines.length ? `${lines.join("\n")}\n` : "";
}

export function exportableAccounts(detail: PixelTaskDetailView): Array<{ email: string; resultLink: string }> {
  return detail.accounts
    .filter(
      (account) =>
        PIXEL_EXPORTABLE_ACCOUNT_STATUSES.includes(account.status) && Boolean(account.resultLink.trim()),
    )
    .map((account) => ({ email: account.email, resultLink: account.resultLink }));
}

export function timestampSlug(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(
    date.getHours(),
  )}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/**
 * 文件名里的 task 前缀只保留字母数字：`Content-Disposition` 头里出现引号/换行会被
 * 中间件或浏览器当作注入面，而 task id 来自上游（不是我们生成的）。
 */
export function taskSlug(taskId: string): string {
  return (String(taskId).replace(/[^A-Za-z0-9]/g, "").slice(0, 8) || "task").toLowerCase();
}

/**
 * 提交响应里我们**唯一**依赖的两个字段：上游 task id 与账号数（其余字段一概不读）。
 * 拿不到 task id 时返回空串——调用方据此把这次提交判为「结果不确定」，而不是当作成功。
 */
export function readSubmittedTaskId(payload: unknown): string {
  return toText(asRecord(payload).task_id, 200).trim();
}

export function readSubmittedAccountCount(payload: unknown): number | null {
  return toNumber(asRecord(payload).total_accounts);
}

/** 历史列表：没有 task id 的条目一律丢掉（无法做归属过滤，留着就等于放水）。 */
export function normalizeTaskSummaryList(payload: unknown): PixelTaskSummaryView[] {
  return asArray(asRecord(payload).tasks)
    .map(normalizeTaskSummary)
    .filter((task): task is PixelTaskSummaryView => task !== null);
}

export interface PixelExportAccountRow {
  taskId: string;
  email: string;
  resultLink: string;
}

/** 导出口径：只读 task_id / email / result_link 三个字段，其余一概不读。 */
export function normalizeExportAccountRows(payload: unknown): PixelExportAccountRow[] {
  return asArray(asRecord(payload).accounts).map((raw) => {
    const value = asRecord(raw);
    return {
      taskId: toText(value.task_id, 200),
      email: toText(value.email, 320),
      resultLink: toText(value.result_link, 2_048),
    };
  });
}
