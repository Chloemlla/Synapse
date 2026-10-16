// Pixel 自助折扣链接的浏览器侧类型。
// 与后端 src/pixel/types.ts 的「视图」一一对应：这里刻意不出现上游字段名、内部状态机
// （in_flight/uncertain 等只体现在错误语义里），避免前端无意间依赖上游契约。
export type PixelServiceType = "link_only" | "link_and_bind" | "link_and_bind_1usd";

export type PixelServiceOption = {
  type: PixelServiceType;
  quotaCost: number;
  enabled: boolean;
};

export type PixelSettings = {
  autoBindEnabled: boolean;
  autoBindOneDollarEnabled: boolean;
  services: PixelServiceOption[];
};

export type PixelCardQuota = {
  valid: boolean;
  remainingQuota: string | null;
  totalQuota: string | null;
  remainingUnits: number | null;
  totalUnits: number | null;
  historyAvailable: boolean;
  message: string;
};

export type PixelTaskAccount = {
  id: number;
  lineNumber: number;
  email: string;
  status: string;
  message: string;
  resultLink: string;
  queuePosition: number | null;
};

export type PixelTaskDetail = {
  taskId: string;
  status: string;
  totalAccounts: number;
  cancelledCount: number;
  accounts: PixelTaskAccount[];
};

export type PixelTaskSummary = {
  taskId: string;
  totalAccounts: number;
  status: string;
  success: number;
  failed: number;
  cancelled: number;
  done: number;
  createdAt: string;
};

export type PixelSubmitResult = {
  taskId: string;
  totalAccounts: number;
  status: string;
  message: string;
};

export const PIXEL_SERVICE_LABELS: Record<PixelServiceType, string> = {
  link_only: "仅提取链接",
  link_and_bind: "提取链接 + 绑卡",
  link_and_bind_1usd: "提取链接 + 绑卡（1 美元方案）",
};

export const PIXEL_ACCOUNT_STATUS_LABELS: Record<string, string> = {
  pending: "排队中",
  running: "处理中",
  success: "已成功",
  failed: "未成功",
  bind_pending: "待绑卡",
  binding: "绑卡中",
  bind_success: "绑卡成功",
  bind_failed: "绑卡未成功",
  cancelled: "已取消",
  unknown: "状态未知",
};

export const PIXEL_TASK_STATUS_LABELS: Record<string, string> = {
  pending: "排队中",
  running: "处理中",
  completed: "已完成",
  failed: "未完成",
  cancelled: "已取消",
  unknown: "状态未知",
};

export const PIXEL_TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "cancelled"]);
