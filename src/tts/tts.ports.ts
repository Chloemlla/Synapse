import type { User } from "../utils/userStorage";
import type { TtsProviderExecutionSnapshot } from "../config/ttsProviderConfig";
import type { TtsJobRecord, TtsJobResult, TtsNextAction, TtsUsageSummary } from "./tts.storage";

export type TtsHistoryReviewStatus = "none" | "needs_review" | "in_review" | "fixed" | "dismissed";

export interface TtsQuotaReservation {
  taskId: string;
  userId: string;
  usageDay: string;
  reservedAt: string;
  consumedAt?: string;
  releasedAt?: string;
}

export interface TtsHistoryRecord {
  id?: string;
  scope: "user" | "anonymous";
  userId?: string;
  ip?: string;
  fingerprint?: string;
  text: string;
  voice: string;
  model: string;
  outputFormat: string;
  speed: number;
  contentHash: string;
  fileName: string;
  audioUrl: string;
  audioFileId?: string;
  audioStorage?: "file" | "mongo";
  audioMimeType?: string;
  audioSize?: number;
  provider: string;
  providerModel: string;
  providerVoice: string;
  createdAt: string;
  // 用户自助管理字段：软删除只打标记，记录不物理消失，管理后台仍然可见。
  userTitle?: string;
  userNote?: string;
  userTags?: string[];
  userDeletedAt?: string;
  adminNote?: string;
  adminSuggestion?: string;
  reviewStatus?: TtsHistoryReviewStatus;
  reviewedBy?: string;
  reviewedAt?: string;
  fixedAt?: string;
  updatedAt?: string;
}

/** 用户可自行编辑的字段。fileName 不在其中：它决定音频落盘路径，改不得。 */
export interface TtsHistoryUserPatch {
  userTitle?: string;
  userNote?: string;
  userTags?: string[];
}

/** 管理后台的记录状态筛选：未删除 / 已被用户软删除。 */
export type TtsHistoryDeletedFilter = "all" | "active" | "deleted";

export interface TtsDuplicateHit {
  fileName: string;
  audioUrl: string;
  audioFileId?: string;
  audioStorage?: "file" | "mongo";
  audioMimeType?: string;
  audioSize?: number;
  outputFormat: string;
  contentHash: string;
  provider?: string;
  providerModel?: string;
  providerVoice?: string;
}

export interface TtsUsageSnapshot {
  user: User | null;
  remainingToday: number | null;
  reservedToday: number | null;
  consumedToday: number | null;
}

export interface TtsProviderRequest {
  text: string;
  model: string;
  voice: string;
  outputFormat: string;
  speed: number;
  userId?: string;
  isAdmin?: boolean;
  taskId?: string;
  ip?: string;
  fingerprint?: string;
  policyVersion?: string;
  providerExecution?: TtsProviderExecutionSnapshot;
}

export interface TtsProviderResponse {
  provider: string;
  providerModel: string;
  providerVoice: string;
  outputFormat: string;
  audioBuffer: Buffer;
}

export interface TtsProvider {
  readonly providerId: string;
  synthesize(request: TtsProviderRequest): Promise<TtsProviderResponse>;
}

export interface TtsAudioPostProcessInput {
  audioBuffer: Buffer;
  outputFormat: string;
  taskId?: string;
  contentHash: string;
}

export interface TtsAudioPostProcessResult {
  audioBuffer: Buffer;
  outputFormat: string;
  metadata?: Record<string, unknown>;
  source: "node-passthrough";
}

export interface TtsAudioPostProcessor {
  process(input: TtsAudioPostProcessInput): Promise<TtsAudioPostProcessResult>;
}

export interface QuotaLedger {
  getUsageSnapshot(userId: string): Promise<TtsUsageSnapshot>;
  reserve(userId: string, taskId: string): Promise<{ success: boolean; snapshot: TtsUsageSnapshot }>;
  confirm(userId: string, taskId: string): Promise<TtsUsageSnapshot>;
  release(userId: string, taskId: string): Promise<TtsUsageSnapshot>;
  reserveAnonymous(scopeKey: string, taskId: string): Promise<{ success: boolean; remainingToday: number }>;
  confirmAnonymous(scopeKey: string, taskId: string): Promise<void>;
  releaseAnonymous(scopeKey: string, taskId: string): Promise<void>;
}

export interface TtsSettingsStore {
  getGenerationCode(): Promise<string | null>;
}

export interface TtsJobStore {
  createTaskId(): string;
  createJob(job: TtsJobRecord): Promise<TtsJobRecord>;
  getJob(taskId: string): Promise<TtsJobRecord | null>;
  updateJob(taskId: string, patch: Partial<TtsJobRecord>): Promise<TtsJobRecord | null>;
  completeJob(
    taskId: string,
    result: TtsJobResult,
    usage?: TtsUsageSummary,
    nextAction?: TtsNextAction,
    expectedOwner?: string,
  ): Promise<TtsJobRecord | null>;
  failJob(
    taskId: string,
    error: string,
    usage?: TtsUsageSummary,
    nextAction?: TtsNextAction,
    expectedOwner?: string,
  ): Promise<TtsJobRecord | null>;
  getQueuePosition(taskId: string): Promise<number>;
  claimNextQueuedJob(workerId: string, leaseMs: number): Promise<TtsJobRecord | null>;
  /**
   * 续租：只有仍由 `expectedOwner` 持有租约时才延长 `leaseExpiresAt`。
   * 返回 null 说明任务已被看门狗回收或转交（调用方应放弃终态提交）。
   */
  renewJobLease(taskId: string, expectedOwner: string, leaseMs: number): Promise<TtsJobRecord | null>;
  recoverStaleJobs(
    staleBefore: number,
  ): Promise<{ recovered: number; failed: TtsJobRecord[] }>;
}

export interface GenerationHistoryStore {
  findDuplicateForUser(params: {
    userId: string;
    text: string;
    voice: string;
    model: string;
    speed: number;
    outputFormat: string;
    contentHashes: string[];
  }): Promise<TtsDuplicateHit | null>;
  addRecord(record: TtsHistoryRecord): Promise<TtsHistoryRecord>;
  getRecentRecords(params: { userId: string; limit?: number }): Promise<TtsHistoryRecord[]>;
  countRecentByContentHash(params: {
    userId: string;
    contentHash: string;
    sinceIso: string;
  }): Promise<number>;
  getAllRecords(params: {
    page?: number;
    limit?: number;
    userId?: string;
    scope?: "user" | "anonymous";
    reviewStatus?: TtsHistoryReviewStatus | "all";
    userDeleted?: TtsHistoryDeletedFilter;
    q?: string;
  }): Promise<{
    records: TtsHistoryRecord[];
    total: number;
    page: number;
    limit: number;
  }>;
  updateAdminReview(
    recordId: string,
    patch: {
      adminNote?: string;
      adminSuggestion?: string;
      reviewStatus?: TtsHistoryReviewStatus;
      reviewedBy?: string;
    },
  ): Promise<TtsHistoryRecord | null>;
  /** owner 条件写进查询过滤里，避免先读后改的 TOCTOU 与越权改他人记录。 */
  updateUserRecord(
    params: { recordId: string; userId: string },
    patch: TtsHistoryUserPatch,
  ): Promise<TtsHistoryRecord | null>;
  /** 软删除：只打 userDeletedAt 标记，用户侧不可恢复。 */
  softDeleteRecord(params: { recordId: string; userId: string }): Promise<TtsHistoryRecord | null>;
}
