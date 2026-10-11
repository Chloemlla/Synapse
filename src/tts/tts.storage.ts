import { mongoose } from "../services/mongoService";
import type { TtsProviderExecutionSnapshot } from "../config/ttsProviderConfig";
import type { TtsJobStore } from "./tts.ports";

export type TtsJobStatus = "queued" | "processing" | "completed" | "failed";

export interface TtsUsageSummary {
  authenticated: boolean;
  isAdmin: boolean;
  dailyLimit: number | null;
  usedToday: number | null;
  remainingToday: number | null;
  reservedToday?: number | null;
}

export interface TtsNextAction {
  type: string;
  label: string;
  message: string;
}

export interface TtsAssetWatermarkSummary {
  id: string;
  kind: "server_forensic";
  policyVersion?: string;
}

export interface TtsGovernanceSummary {
  policyVersion?: string;
  contentSafety?: {
    decision: "allow" | "review" | "block";
    confidence: number;
    categories: string[];
    source: string;
    remoteChecked: boolean;
    remoteUnavailable?: boolean;
  };
}

export interface TtsJobResult {
  text?: string;
  fileName: string;
  audioUrl: string;
  audioFileId?: string;
  audioStorage?: "file" | "mongo";
  audioMimeType?: string;
  audioSize?: number;
  isDuplicate?: boolean;
  outputFormat?: string;
  provider?: string;
  providerModel?: string;
  providerVoice?: string;
  message: string;
  status: "generated" | "reused";
  watermark?: TtsAssetWatermarkSummary;
  permissions?: {
    canDownload: boolean;
    canShare: boolean;
  };
}

export interface TtsJobRequestPayload {
  text: string;
  model: string;
  voice: string;
  outputFormat: string;
  speed: number;
  providerExecution?: TtsProviderExecutionSnapshot;
}

export interface TtsJobRecord {
  taskId: string;
  status: TtsJobStatus;
  createdAt: string;
  updatedAt: string;
  request: TtsJobRequestPayload;
  userId?: string;
  isAdmin?: boolean;
  ip: string;
  fingerprint: string;
  message: string;
  error?: string;
  usage?: TtsUsageSummary;
  nextAction?: TtsNextAction;
  governance?: TtsGovernanceSummary;
  result?: TtsJobResult;
  attempts?: number;
  processingOwner?: string;
  leaseExpiresAt?: string;
}

const TtsJobSchema = new mongoose.Schema<TtsJobRecord>(
  {
    taskId: { type: String, required: true, unique: true, index: true },
    status: { type: String, required: true, index: true },
    createdAt: { type: String, required: true, index: true },
    updatedAt: { type: String, required: true },
    request: {
      text: { type: String, required: true },
      model: { type: String, required: true },
      voice: { type: String, required: true },
      outputFormat: { type: String, required: true },
      speed: { type: Number, required: true },
      providerExecution: {
        providerId: { type: String, enum: ["openai", "fish", "edge"] },
        model: { type: String },
        voice: { type: String },
        referenceId: { type: String },
        baseUrl: { type: String },
        cacheIdentity: { type: String },
      },
    },
    userId: { type: String, index: true },
    isAdmin: { type: Boolean },
    ip: { type: String, required: true, index: true },
    fingerprint: { type: String, required: true, index: true },
    message: { type: String, required: true },
    error: { type: String },
    usage: {
      authenticated: { type: Boolean },
      isAdmin: { type: Boolean },
      dailyLimit: { type: Number, default: null },
      usedToday: { type: Number, default: null },
      remainingToday: { type: Number, default: null },
      reservedToday: { type: Number, default: null },
    },
    nextAction: {
      type: { type: String },
      label: { type: String },
      message: { type: String },
    },
    governance: {
      policyVersion: { type: String },
      contentSafety: {
        decision: { type: String },
        confidence: { type: Number },
        categories: [{ type: String }],
        source: { type: String },
        remoteChecked: { type: Boolean },
        remoteUnavailable: { type: Boolean },
      },
    },
    result: {
      text: { type: String },
      fileName: { type: String },
      audioUrl: { type: String },
      audioFileId: { type: String },
      audioStorage: { type: String, enum: ["file", "mongo"] },
      audioMimeType: { type: String },
      audioSize: { type: Number },
      isDuplicate: { type: Boolean },
      outputFormat: { type: String },
      provider: { type: String },
      providerModel: { type: String },
      providerVoice: { type: String },
      message: { type: String },
      status: { type: String },
      watermark: {
        id: { type: String },
        kind: { type: String },
        policyVersion: { type: String },
      },
      permissions: {
        canDownload: { type: Boolean },
        canShare: { type: Boolean },
      },
    },
    attempts: { type: Number, default: 0 },
    processingOwner: { type: String, index: true },
    leaseExpiresAt: { type: String, index: true },
  },
  { collection: "tts_jobs" },
);

TtsJobSchema.index({ status: 1, createdAt: 1 });
TtsJobSchema.index({ status: 1, leaseExpiresAt: 1 });

const TtsJobModel = mongoose.models.TtsJob || mongoose.model<TtsJobRecord>("TtsJob", TtsJobSchema);

/** 单个任务最大处理尝试次数，超过后进入 failed（死信），不再无限重排队。 */
export const TTS_MAX_ATTEMPTS = 3;

class MongoTtsJobStore implements TtsJobStore {
  public createTaskId() {
    return `tts_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }

  public async createJob(job: TtsJobRecord) {
    await TtsJobModel.create(job);
    return job;
  }

  public async getJob(taskId: string) {
    return (await TtsJobModel.findOne({ taskId }).lean().exec()) as TtsJobRecord | null;
  }

  public async updateJob(taskId: string, patch: Partial<TtsJobRecord>) {
    return (await TtsJobModel.findOneAndUpdate(
      { taskId },
      { $set: { ...patch, updatedAt: new Date().toISOString() } },
      { returnDocument: "after" },
    )
      .lean()
      .exec()) as TtsJobRecord | null;
  }

  public async completeJob(
    taskId: string,
    result: TtsJobResult,
    usage?: TtsUsageSummary,
    nextAction?: TtsNextAction,
    expectedOwner?: string,
  ) {
    return this.updateJobOwned(taskId, expectedOwner, {
      status: "completed",
      message: result.message,
      result,
      usage,
      nextAction,
      error: undefined,
      processingOwner: undefined,
      leaseExpiresAt: undefined,
    });
  }

  public async failJob(
    taskId: string,
    error: string,
    usage?: TtsUsageSummary,
    nextAction?: TtsNextAction,
    expectedOwner?: string,
  ) {
    return this.updateJobOwned(taskId, expectedOwner, {
      status: "failed",
      message: error,
      error,
      usage,
      nextAction,
      processingOwner: undefined,
      leaseExpiresAt: undefined,
    });
  }

  /** 带 owner 条件的终态写入：owner 不匹配（任务已被其他 worker 重新认领）则返回 null。 */
  private async updateJobOwned(
    taskId: string,
    expectedOwner: string | undefined,
    patch: Partial<TtsJobRecord>,
  ): Promise<TtsJobRecord | null> {
    const filter: Record<string, unknown> = { taskId };
    if (expectedOwner) {
      filter.processingOwner = expectedOwner;
    }
    return (await TtsJobModel.findOneAndUpdate(
      filter,
      { $set: { ...patch, updatedAt: new Date().toISOString() } },
      { returnDocument: "after" },
    )
      .lean()
      .exec()) as TtsJobRecord | null;
  }

  public async getQueuePosition(taskId: string) {
    const job = await this.getJob(taskId);
    if (!job || job.status !== "queued") {
      return 0;
    }

    return await TtsJobModel.countDocuments({
      status: "queued",
      createdAt: { $lt: job.createdAt },
    })
      .exec()
      .then((count) => count + 1);
  }

  public async claimNextQueuedJob(workerId: string, leaseMs: number) {
    return (await TtsJobModel.findOneAndUpdate(
      { status: "queued" },
      {
        $set: {
          status: "processing",
          message: "正在生成语音...",
          processingOwner: workerId,
          leaseExpiresAt: new Date(Date.now() + leaseMs).toISOString(),
          updatedAt: new Date().toISOString(),
        },
        $inc: { attempts: 1 },
      },
      { sort: { createdAt: 1 }, returnDocument: "after" },
    )
      .lean()
      .exec()) as TtsJobRecord | null;
  }

  /**
   * 续租（心跳）：只有仍由 `expectedOwner` 持有、且尚未进入终态的 processing 任务才延长租约。
   * 返回 null 说明任务已被看门狗回收 / 转交（或已完成），原 Worker 必须放弃后续提交。
   */
  public async renewJobLease(taskId: string, expectedOwner: string, leaseMs: number) {
    return (await TtsJobModel.findOneAndUpdate(
      { taskId, status: "processing", processingOwner: expectedOwner },
      {
        $set: {
          leaseExpiresAt: new Date(Date.now() + leaseMs).toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
      { returnDocument: "after" },
    )
      .lean()
      .exec()) as TtsJobRecord | null;
  }

  /**
   * 看门狗回收：把「超时未续租」的 processing 任务退回 queued，超过重试上限的进 failed（死信）。
   *
   * 并发安全：多实例可能同时跑看门狗，因此**不再 find 后 updateMany（条件与更新之间会被续租/完成
   * 抢先）**，而是逐条 `findOneAndUpdate`，把「仍处于超时状态」写进更新条件本身；只对真正改到的
   * 那条返回现场，调用方据此释放额度预留。
   */
  public async recoverStaleJobs(staleBefore: number) {
    const staleIso = new Date(staleBefore).toISOString();
    const staleFilter = { status: "processing", leaseExpiresAt: { $lte: staleIso } };

    // 超限候选（先只取 taskId）：真正死信化时逐条做原子条件更新。
    const overLimitCandidates = (await TtsJobModel.find({ ...staleFilter, attempts: { $gte: TTS_MAX_ATTEMPTS } })
      .select("taskId")
      .lean()
      .exec()) as Array<{ taskId: string }>;

    const failed: TtsJobRecord[] = [];
    for (const candidate of overLimitCandidates) {
      const doc = (await TtsJobModel.findOneAndUpdate(
        { taskId: candidate.taskId, ...staleFilter, attempts: { $gte: TTS_MAX_ATTEMPTS } },
        {
          $set: {
            status: "failed",
            message: "任务重试次数已达上限，已终止",
            error: "任务重试次数已达上限，已终止",
            processingOwner: null,
            leaseExpiresAt: null,
            updatedAt: new Date().toISOString(),
          },
        },
        { returnDocument: "after" },
      )
        .lean()
        .exec()) as TtsJobRecord | null;
      if (doc) failed.push(doc);
    }

    // 未超限的原子回队：条件同样写进更新，避免把刚续租 / 刚完成的任务误捉回。
    const result = await TtsJobModel.updateMany(
      { ...staleFilter, attempts: { $lt: TTS_MAX_ATTEMPTS } },
      {
        $set: {
          status: "queued",
          message: "检测到任务处理中断，已重新入队",
          processingOwner: null,
          leaseExpiresAt: null,
          updatedAt: new Date().toISOString(),
        },
      },
    ).exec();

    return { recovered: result.modifiedCount, failed };
  }
}

export const ttsStorage = new MongoTtsJobStore();
