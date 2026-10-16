/**
 * Pixel 用户侧（自助折扣链接任务）的领域类型与错误。
 *
 * 这里定义的是**本地归一化视图**，不是上游原始响应：上游响应结构只允许出现在
 * src/pixel/upstreamClient.ts 与各 service 的解析函数里，业务/HTTP 层只看这里的类型。
 * 这么分是为了让「上游改字段」这件事只有一处需要改，也为了让测试能断言
 * 「响应里没有上游原文/凭据」。
 *
 * 上游契约来源：来源仓库 GGGGGG/docs/openapi.yaml 是**从公开页面重建的草案**，
 * 因此所有字段解析都必须容错（缺字段按 null/默认值处理），不能假设它稳定。
 */

/** 三种服务类型；枚举值与上游一致。 */
export const PIXEL_SERVICE_TYPES = ["link_only", "link_and_bind", "link_and_bind_1usd"] as const;
export type PixelServiceType = (typeof PIXEL_SERVICE_TYPES)[number];

/**
 * 界面预估单价（来源页面的固定配置）。它**只用于预估**：真实扣额以服务端/上游响应为准，
 * 已有优惠链接时扣额可能不同，因此它不出现在任何账本计算里。
 */
export const PIXEL_SERVICE_QUOTA_COST: Record<PixelServiceType, number> = {
  link_only: 0.5,
  link_and_bind: 1,
  link_and_bind_1usd: 1.5,
};

export const PIXEL_TASK_STATUSES = ["pending", "running", "completed", "failed", "cancelled"] as const;
export type PixelTaskStatus = (typeof PIXEL_TASK_STATUSES)[number];

export const PIXEL_ACCOUNT_STATUSES = [
  "pending",
  "running",
  "success",
  "failed",
  "bind_pending",
  "binding",
  "bind_success",
  "bind_failed",
  "cancelled",
] as const;
export type PixelAccountStatus = (typeof PIXEL_ACCOUNT_STATUSES)[number];

/**
 * 可导出结果链接的账号状态：口径与来源页面一致（成功与绑卡相关状态）。
 * 只有这些状态**且**带 result link 的账号才会出现在导出文本里。
 */
export const PIXEL_EXPORTABLE_ACCOUNT_STATUSES: readonly string[] = [
  "success",
  "bind_pending",
  "binding",
  "bind_success",
  "bind_failed",
];

/**
 * 本地提交状态：
 *   in_flight  —— 已占位、正在向上游提交（重复请求返回 409，不再发第二次）；
 *   accepted   —— 上游已受理并返回 task id；
 *   rejected   —— 上游明确拒绝（4xx / 服务被关闭）：重放同一幂等键得到同样的错误，安全可改；
 *   uncertain  —— 超时、网络中断或上游 5xx：**不知道上游是否受理**，绝不能用同一幂等键重发，
 *                否则可能重复扣额。用户只能去历史任务里确认。
 */
export const PIXEL_SUBMIT_STATES = ["in_flight", "accepted", "rejected", "uncertain"] as const;
export type PixelSubmitState = (typeof PIXEL_SUBMIT_STATES)[number];

/** 溯源日志的结果分类。 */
export const PIXEL_USAGE_OUTCOMES = [
  "success",
  "client_error",
  "upstream_error",
  "timeout",
  "rate_limited",
  "blocked",
] as const;
export type PixelUsageOutcome = (typeof PIXEL_USAGE_OUTCOMES)[number];

export function isPixelServiceType(value: unknown): value is PixelServiceType {
  return typeof value === "string" && (PIXEL_SERVICE_TYPES as readonly string[]).includes(value);
}

export function isPixelSubmitState(value: unknown): value is PixelSubmitState {
  return typeof value === "string" && (PIXEL_SUBMIT_STATES as readonly string[]).includes(value);
}

/**
 * 领域错误：HTTP 层只按它映射响应，业务层不碰 res。
 *
 * 约定：`message` 一定是**可给用户看的中文**，不含上游地址、上游原文、密钥或栈；
 * 诊断细节放 `logger`（且只记 code 与路径这类非敏感上下文）。
 */
export class PixelDomainError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    /**
     * 可回给客户端的结构化补充信息。**只允许放定位用的非敏感值**：
     * 行号、上限、账号数这类计数/位置，绝不能放账号文本、卡密或上游原文。
     */
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PixelDomainError";
  }
}

/** 上游 `/api/settings` 的归一化视图。 */
export interface PixelSettingsView {
  autoBindEnabled: boolean;
  autoBindOneDollarEnabled: boolean;
  services: PixelServiceOptionView[];
}

export interface PixelServiceOptionView {
  type: PixelServiceType;
  quotaCost: number;
  enabled: boolean;
}

/**
 * 卡密额度视图。刻意同时给「展示值」与「单位值」：
 * 上游的新字段与新单位字段量纲不同（示例：remaining_quota="5"、remaining_quota_units=10），
 * 旧字段 remaining/total_count 与 *_units 同量纲。混用会让「剩余额度」显示成两倍/一半。
 */
export interface PixelCardQuotaView {
  valid: boolean;
  /** 展示用额度（上游 remaining_quota，缺失时回落旧字段 remaining）。 */
  remainingQuota: string | null;
  totalQuota: string | null;
  /** 计费单位额度（上游 *_units，缺失时回落旧字段），用于预估与对账。 */
  remainingUnits: number | null;
  totalUnits: number | null;
  /**
   * 卡密虽判定无效、但这张卡密仍然可以查历史任务（映射存在 → 我们仍能按卡密过滤）。
   * 界面据此提供「查看历史」而不是把用户挡死。
   */
  historyAvailable: boolean;
  message: string;
}

export interface PixelTaskAccountView {
  id: number;
  lineNumber: number;
  /** 账号邮箱：只作为响应返回给本人，绝不落库/落日志（PRD 6.1.4）。 */
  email: string;
  status: PixelAccountStatus | "unknown";
  message: string;
  /** 结果链接：只回给本人，不落库、不进审计（PRD 6.1.3）。 */
  resultLink: string;
  queuePosition: number | null;
}

export interface PixelTaskDetailView {
  taskId: string;
  status: PixelTaskStatus | "unknown";
  totalAccounts: number;
  cancelledCount: number;
  accounts: PixelTaskAccountView[];
}

export interface PixelTaskSummaryView {
  taskId: string;
  totalAccounts: number;
  status: PixelTaskStatus | "unknown";
  success: number;
  failed: number;
  cancelled: number;
  done: number;
  createdAt: string;
}

/** 提交结果（幂等重放时返回与首次一致的内容）。 */
export interface PixelSubmitResultView {
  taskId: string;
  totalAccounts: number;
  status: PixelTaskStatus | "unknown";
  message: string;
}

export interface PixelExportFileView {
  filename: string;
  text: string;
}

/** 管理端：CDK 映射视图。只含遮罩值——明文上游 CDK 与分发卡密都不出现在这里。 */
export interface PixelCdkMappingView {
  mappingId: string;
  distributionCdkMasked: string;
  upstreamCdkMasked: string;
  note: string;
  enabled: boolean;
  createdByUsername: string;
  createdAt: string;
  updatedAt: string;
}

/** 创建映射的响应：分发卡密明文只在这**一次**响应里出现（管理员当场复制给用户）。 */
export interface PixelCdkMappingCreatedView {
  mapping: PixelCdkMappingView;
  distributionCdk: string;
}

export interface PixelUsageLogView {
  logId: string;
  requestId: string;
  userId: string;
  mappingId: string | null;
  requestedCdkMasked: string;
  matchedMapping: boolean;
  method: string;
  path: string;
  serviceType: string | null;
  accountCount: number | null;
  requestBytes: number;
  responseBytes: number | null;
  upstreamStatus: number | null;
  outcome: PixelUsageOutcome;
  durationMs: number;
  createdAt: string;
}

/** 上游集成配置视图（仅管理端；用户侧接口绝不返回上游 host）。 */
export interface PixelIntegrationConfigView {
  configured: boolean;
  enabled: boolean;
  upstreamBaseUrl: string;
  allowedHosts: string[];
  requestTimeoutMs: number;
  updatedAt: string | null;
  updatedByUsername: string;
}

export interface PixelAdminDashboardView {
  config: {
    configured: boolean;
    enabled: boolean;
    host: string;
  };
  mappings: {
    total: number;
    enabled: number;
  };
  usage: {
    total: number;
    last24h: number;
    last7d: number;
    lastAt: string | null;
    /** 典量保留天数（来自 PIXEL_USAGE_LOG_RETENTION_DAYS；只要靠运维重建 TTL 索引才真正生效）。 */
    retentionDays: number;
  };
  tasks: {
    total: number;
    bySubmitState: Record<string, number>;
  };
}
