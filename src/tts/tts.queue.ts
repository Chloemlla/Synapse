import { wsService } from "../services/wsService";
import logger from "../utils/logger";
import { generationHistoryStore, redactTtsTextForStorage } from "./tts.history";
import type { GenerationHistoryStore, QuotaLedger } from "./tts.ports";
import {
  buildAnonymousScopeKey,
  buildUsageSummaryFromSnapshot,
  quotaLedger,
  startExpiredReservationSweeper,
} from "./tts.quota";
import { TtsService } from "./tts.service";
import { type TtsJobRecord, type TtsNextAction, ttsStorage } from "./tts.storage";

interface QueueCallbacks {
  buildUsageSummary: (userId?: string, isAdmin?: boolean) => Promise<TtsJobRecord["usage"]>;
  buildNextAction: (type: string, label: string, message: string) => TtsNextAction;
}

export const TTS_PROCESSING_LEASE_MS = 15 * 60 * 1000;
const MAX_QUEUE_CONCURRENCY = 5;
/** 过期任务周期性回收间隔：没有新任务入队时，僵死任务也能被回收。 */
export const TTS_STALE_RECOVERY_INTERVAL_MS = 5 * 60 * 1000;
/**
 * 长耗时任务续租间隔：取租约的 1/3，给「两次续租之间进程卡顿」留两次余量。
 * 低于 10s 会变成无意义的高频写。
 */
export const TTS_LEASE_HEARTBEAT_MS = Math.max(10_000, Math.floor(TTS_PROCESSING_LEASE_MS / 3));

function resolveQueueConcurrency(): number {
  const raw = Number(process.env.TTS_QUEUE_CONCURRENCY || "2");
  if (!Number.isFinite(raw)) {
    return 2;
  }
  return Math.max(1, Math.min(MAX_QUEUE_CONCURRENCY, Math.floor(raw)));
}

export class TtsQueue {
  private readonly ttsService = new TtsService();
  private readonly workerId = `tts-worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  private readonly concurrency = resolveQueueConcurrency();
  private processing = false;
  private drainRequested = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly callbacks: QueueCallbacks,
    private readonly historyStore: GenerationHistoryStore = generationHistoryStore,
    private readonly ledger: QuotaLedger = quotaLedger,
  ) {
    // 启动独立周期回收：即便没有新任务入队，僵死任务也会被回收，
    // 超限任务进入死信并释放额度预留。
    this.startStaleRecoveryTimer();
    startExpiredReservationSweeper();
  }

  public async enqueue(job: TtsJobRecord) {
    await ttsStorage.createJob(job);
    void this.drain();
    return job;
  }

  private startStaleRecoveryTimer(): void {
    const timer = setInterval(() => {
      void this.recoverStaleJobsAndReleaseQuota();
    }, TTS_STALE_RECOVERY_INTERVAL_MS);
    timer.unref?.();
  }

  private async recoverStaleJobsAndReleaseQuota(): Promise<void> {
    try {
      const { failed } = await ttsStorage.recoverStaleJobs(Date.now());
      for (const job of failed) {
        try {
          if (job.userId && !job.isAdmin) {
            await this.ledger.release(job.userId, job.taskId);
          } else if (!job.userId) {
            await this.ledger.releaseAnonymous(buildAnonymousScopeKey(job.ip, job.fingerprint), job.taskId);
          }
        } catch (error) {
          logger.error("释放过期 TTS 任务额度预留失败", {
            taskId: job.taskId,
            userId: job.userId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      // 死信=需要人工介入：一轮回收合并成一封告警（邮件 + 可选 webhook），不逐条轰炸。
      if (failed.length > 0) {
        void this.alertDeadLetterJobs(failed);
      }
      // A failed claim can leave queued jobs without creating a stale lease.
      // Always restart scheduling after a successful recovery pass.
      void this.drain();
    } catch (error) {
      logger.error("TTS 过期任务回收失败", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** 死信告警：走邮件（admin/superadmin 团队）+ 可选 `ALERT_WEBHOOK_URL`，无钉钉/企业微信。 */
  private async alertDeadLetterJobs(failed: TtsJobRecord[]): Promise<void> {
    try {
      const { sendAdminAlert } = await import("../services/adminAlertService");
      await sendAdminAlert({
        level: "critical",
        subject: `${failed.length} 个 TTS 任务重试超限进入死信`,
        text: failed
          .map((job) => `taskId=${job.taskId} attempts=${job.attempts ?? "?"} 原因=${job.error || job.message}`)
          .join("\n"),
        detail: { count: failed.length, taskIds: failed.map((job) => job.taskId) },
      });
    } catch (error) {
      logger.error("TTS 死信告警投递失败", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async drain() {
    if (this.processing) {
      this.drainRequested = true;
      return;
    }

    this.processing = true;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    const active = new Set<Promise<void>>();
    try {
      await ttsStorage.recoverStaleJobs(Date.now());

      while (true) {
        while (active.size < this.concurrency) {
          const nextJob = await ttsStorage.claimNextQueuedJob(this.workerId, TTS_PROCESSING_LEASE_MS);
          if (!nextJob) {
            break;
          }

          // Attach a rejection handler immediately: another claim may still be
          // waiting on Mongo when this job's failure persistence also rejects.
          const task = this.processJob(nextJob).catch((error) => {
            logger.error("TTS 任务终态持久化失败，等待租约回收", {
              taskId: nextJob.taskId,
              error: error instanceof Error ? error.message : String(error),
            });
          }).finally(() => {
            active.delete(task);
          });
          active.add(task);
        }

        if (active.size === 0) {
          break;
        }

        await Promise.race(active);
      }
    } catch (error) {
      logger.error('TTS 队列调度失败，将重试', { error: error instanceof Error ? error.message : String(error) });
      this.drainRequested = false;
      this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.drain(); }, 5000);
      this.retryTimer.unref?.();
    } finally {
      await Promise.allSettled(active);
      this.processing = false;
      if (this.drainRequested) {
        this.drainRequested = false;
        void this.drain();
      }
    }
  }

  private async processJob(job: TtsJobRecord) {
    if (job.userId) {
      wsService.notifyTtsProgress(job.userId, {
        taskId: job.taskId,
        status: "processing",
        message: "正在生成语音...",
      });
    }

    // 长耗时任务在后台持续续租：一旦 Worker 卡死/崩溃，心跳中断，租约自然过期被看门狗回收。
    const lease = this.startLeaseHeartbeat(job.taskId);

    try {
      const providerExecution = await this.ttsService.resolveProviderExecution(
        job.request.model,
        job.request.voice,
        job.request.providerExecution,
      );
      const effectiveRequest = {
        ...job.request,
        model: providerExecution.model,
        voice: providerExecution.voice,
        speed: this.ttsService.resolveSpeed(job.request.speed, providerExecution),
        providerExecution,
      };
      const result = await this.ttsService.generateSpeech({
        ...effectiveRequest,
        userId: job.userId,
        isAdmin: job.isAdmin,
        taskId: job.taskId,
        ip: job.ip,
        fingerprint: job.fingerprint,
        policyVersion: job.governance?.policyVersion,
      });

      await this.historyStore.addRecord({
        scope: job.userId ? "user" : "anonymous",
        userId: job.userId,
        ip: job.ip,
        fingerprint: job.fingerprint,
        text: effectiveRequest.text,
        voice: effectiveRequest.voice,
        model: effectiveRequest.model,
        outputFormat: effectiveRequest.outputFormat,
        speed: effectiveRequest.speed,
        contentHash: result.contentHash,
        fileName: result.fileName,
        audioUrl: result.audioUrl,
        audioFileId: result.audioFileId,
        audioStorage: result.audioStorage,
        audioMimeType: result.audioMimeType,
        audioSize: result.audioSize,
        provider: result.provider,
        providerModel: result.providerModel,
        providerVoice: result.providerVoice,
        createdAt: new Date().toISOString(),
      });

      let usage: TtsJobRecord["usage"];
      if (job.userId && !job.isAdmin) {
        const snapshot = await this.ledger.confirm(job.userId, job.taskId);
        usage = buildUsageSummaryFromSnapshot(snapshot.user, snapshot);
      } else if (!job.userId) {
        await this.ledger.confirmAnonymous(buildAnonymousScopeKey(job.ip, job.fingerprint), job.taskId);
        usage = await this.callbacks.buildUsageSummary(undefined, false);
      } else {
        usage = await this.callbacks.buildUsageSummary(job.userId, job.isAdmin);
      }

      const nextAction = this.callbacks.buildNextAction(
        "play_or_download",
        "播放或下载音频",
        "音频已生成完成，可直接播放或下载。",
      );

      await ttsStorage.updateJob(job.taskId, {
        request: {
          ...effectiveRequest,
          text: redactTtsTextForStorage(effectiveRequest.text),
        },
      });

      const completed = await ttsStorage.completeJob(
        job.taskId,
        {
          text: job.request.text,
          fileName: result.fileName,
          audioUrl: result.audioUrl,
          audioFileId: result.audioFileId,
          audioStorage: result.audioStorage,
          audioMimeType: result.audioMimeType,
          audioSize: result.audioSize,
          isDuplicate: result.isDuplicate,
          outputFormat: result.outputFormat,
          provider: result.provider,
          providerModel: result.providerModel,
          providerVoice: result.providerVoice,
          watermark: result.watermarkId
            ? {
                id: result.watermarkId,
                kind: "server_forensic",
                policyVersion: job.governance?.policyVersion,
              }
            : undefined,
          permissions: {
            canDownload: process.env.TTS_DOWNLOADS_ENABLED !== "false",
            canShare: process.env.TTS_ASSET_SHARE_ENABLED === "true",
          },
          message: result.isDuplicate ? "检测到重复内容，已返回已有音频。" : "语音生成成功，音频已准备就绪。",
          status: result.isDuplicate ? "reused" : "generated",
        },
        usage ?? undefined,
        nextAction,
        this.workerId,
      );

      // owner 条件写返回 null = 任务已被看门狗回收并可能转交他人：本 Worker 必须放弃终态与通知，
      // 否则同一条任务会出现两份成功（重叠消费）。
      if (!completed) {
        logger.warn("TTS 任务完成时租约已失效（已被回收/转交），放弃终态提交与通知", {
          taskId: job.taskId,
          owner: this.workerId,
        });
        return;
      }

      if (job.userId) {
        wsService.notifyTtsComplete(job.userId, {
          taskId: job.taskId,
          audioUrl: result.audioUrl,
          fileName: result.fileName,
        });
      }
    } catch (error) {
      logger.error("TTS 队列处理失败", error);
      const message = error instanceof Error ? error.message : "生成语音失败";

      // 心跳已确认租约失效：本 Worker 不再是任务所有者，额度预留留给新 Owner 处理。
      if (lease.isLost()) {
        logger.warn("TTS 任务处理中租约已失效，放弃失败态写入与额度释放", {
          taskId: job.taskId,
          owner: this.workerId,
        });
        return;
      }

      let usage = job.usage;
      if (job.userId && !job.isAdmin) {
        const snapshot = await this.ledger.release(job.userId, job.taskId);
        usage = buildUsageSummaryFromSnapshot(snapshot.user, snapshot);
      } else if (!job.userId) {
        await this.ledger.releaseAnonymous(buildAnonymousScopeKey(job.ip, job.fingerprint), job.taskId);
      }

      const nextAction = this.callbacks.buildNextAction("retry", "稍后重试", "生成失败，请稍后重试。");
      await ttsStorage.updateJob(job.taskId, {
        request: {
          ...job.request,
          text: redactTtsTextForStorage(job.request.text),
        },
      });
      const failed = await ttsStorage.failJob(job.taskId, message, usage ?? undefined, nextAction, this.workerId);

      // 同完成路径：owner 不匹配说明任务已被回收/转交，跳过错误通知，让新 Owner 报结果。
      if (!failed) {
        logger.warn("TTS 任务失败态写入被拒（租约已失效），跳过错误通知", {
          taskId: job.taskId,
          owner: this.workerId,
        });
        return;
      }

      if (job.userId) {
        wsService.notifyTtsError(job.userId, {
          taskId: job.taskId,
          error: message,
        });
      }
    } finally {
      // 无论成功、失败还是提前放弃，都停掉心跳（否则定时器会跟着 Worker 活到进程结束）。
      lease.stop();
    }
  }

  /**
   * 租约心跳：周期续租，避免「慢任务被看门狗误判为僵死」；续租失败即标记租约丢失，
   * 供 processJob 放弃终态提交（防重叠消费）。
   */
  private startLeaseHeartbeat(taskId: string): { stop: () => void; isLost: () => boolean } {
    let lost = false;
    const timer = setInterval(() => {
      void ttsStorage
        .renewJobLease(taskId, this.workerId, TTS_PROCESSING_LEASE_MS)
        .then((renewed) => {
          if (!renewed && !lost) {
            lost = true;
            logger.warn("TTS 任务租约续期失败：任务已被看门狗回收/转交，本 Worker 将放弃终态提交", {
              taskId,
              owner: this.workerId,
            });
          }
        })
        .catch((error) => {
          logger.error("TTS 任务租约续期异常", {
            taskId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }, TTS_LEASE_HEARTBEAT_MS);
    timer.unref?.();
    return { stop: () => clearInterval(timer), isLost: () => lost };
  }
}
