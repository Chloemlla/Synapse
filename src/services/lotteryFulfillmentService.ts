import crypto from "node:crypto";
import logger from "../utils/logger";
import { sendAdminAlert } from "./adminAlertService";
import { sharedStateStore } from "./sharedStateStore";
import { getUserRecord, updateUserRecord } from "./lotteryStorage";
import {
  LotteryFulfillmentModel,
  type LotteryFulfillmentAddress,
  type LotteryFulfillmentRecord,
} from "../models/lotteryFulfillmentModel";
import type { LotteryPrize } from "./lotteryService";

/**
 * 奖品履约中心（PRD §3.5）：虚拟直充 / 卡密池 / 实物邮寄，全部走**租约队列 + 看门狗**。
 *
 * 形态与 TTS 队列同构（§4.4）：认领写 `leaseExpiresAt` + `attempts`；看门狗按「仍超时」条件
 * 原子回收；超过重试上限进死信并发邮件/webhook 告警；所有者条件写（`processingOwner`）防重叠消费。
 *
 * 通道（env，未配置时**不置失败**，落 `ready` 待人工，避免把「没接通道」误判成「履约失败」）：
 * - 虚拟直充：`LOTTERY_FULFILLMENT_VIRTUAL_URL`
 * - 卡密下发：`LOTTERY_FULFILLMENT_CODE_URL`（缺省复用虚拟直充地址）
 */

const LEASE_MS = Math.max(10_000, Number(process.env.LOTTERY_FULFILLMENT_LEASE_MS) || 60_000);
const POLL_MS = Math.max(1_000, Number(process.env.LOTTERY_FULFILLMENT_POLL_MS) || 5_000);
const MAX_ATTEMPTS = Math.max(1, Number(process.env.LOTTERY_FULFILLMENT_MAX_ATTEMPTS) || 3);
const CONCURRENCY = Math.max(1, Math.min(5, Number(process.env.LOTTERY_FULFILLMENT_CONCURRENCY) || 2));
const REDEEM_RATIO = Math.max(0, Number(process.env.LOTTERY_FULFILLMENT_REDEEM_RATIO) || 1);
const PROVIDER_TIMEOUT_MS = 8000;
const CHANCE_LOCK_TTL_MS = 10_000;

/** 可转赠 / 可折现的状态（已实际发货或已核销的不允许）。 */
const MOVABLE_STATUSES = new Set(["pending", "awaiting_address", "ready"]);

export interface EnqueueFulfillmentInput {
  roundId: string;
  userId: string;
  username: string;
  prize: LotteryPrize;
}

class LotteryFulfillmentService {
  private readonly workerId = `lottery-fulfill-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  private draining = false;

  constructor() {
    this.startWorker();
  }

  private startWorker(): void {
    if (process.env.LOTTERY_FULFILLMENT_WORKER_ENABLED === "false") return;
    const timer = setInterval(() => {
      void this.drain();
    }, POLL_MS);
    timer.unref?.();
  }

  private virtualUrl(): string | undefined {
    return process.env.LOTTERY_FULFILLMENT_VIRTUAL_URL?.trim() || undefined;
  }

  private codeUrl(): string | undefined {
    return process.env.LOTTERY_FULFILLMENT_CODE_URL?.trim() || this.virtualUrl();
  }

  /** 中奖后落一条履约记录（失败只记日志，不影响抽奖结果）。 */
  public async enqueue(input: EnqueueFulfillmentInput): Promise<LotteryFulfillmentRecord | null> {
    const config = input.prize.fulfillment;
    if (!config) return null;
    const now = new Date().toISOString();
    const record: LotteryFulfillmentRecord = {
      id: `lf_${crypto.randomUUID()}`,
      roundId: input.roundId,
      userId: input.userId,
      originalUserId: input.userId,
      username: input.username,
      prizeId: input.prize.id,
      prizeName: input.prize.name,
      prizeValue: Number(input.prize.value) || 0,
      type: config.type,
      provider: config.provider,
      params: {
        ...(config.params ?? {}),
        ...(config.redeemValue !== undefined ? { redeemValue: config.redeemValue } : {}),
      },
      status: config.type === "physical" ? "awaiting_address" : "pending",
      attempts: 0,
      history: [{ action: "created", at: now, detail: `type=${config.type}` }],
      createdAt: now,
      updatedAt: now,
    };
    try {
      await LotteryFulfillmentModel.create(record);
    } catch (error) {
      logger.error("[LotteryFulfillment] 创建履约记录失败", {
        prizeId: input.prize.id,
        userId: input.userId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    void this.drain();
    return record;
  }

  /** 我的奖品（本人可见；卡密仅本人与超管可见）。 */
  public async listForUser(userId: string): Promise<LotteryFulfillmentRecord[]> {
    return (await LotteryFulfillmentModel.find({ userId })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean()
      .exec()) as LotteryFulfillmentRecord[];
  }

  /** 实物：填写收件地址。 */
  public async submitAddress(
    id: string,
    userId: string,
    address: Omit<LotteryFulfillmentAddress, "submittedAt">,
  ): Promise<LotteryFulfillmentRecord> {
    const record = (await LotteryFulfillmentModel.findOne({ id, userId }).lean().exec()) as LotteryFulfillmentRecord | null;
    if (!record) throw new Error("履约记录不存在");
    if (record.type !== "physical") throw new Error("该奖品无需填写地址");
    if (!MOVABLE_STATUSES.has(record.status)) throw new Error("该奖品当前状态不可修改地址");
    const now = new Date().toISOString();
    const updated = (await LotteryFulfillmentModel.findOneAndUpdate(
      { id, userId },
      {
        $set: { address: { ...address, submittedAt: now }, status: "ready", updatedAt: now },
        $push: { history: { action: "address", at: now, by: userId, detail: "已提交收件地址" } },
      },
      { returnDocument: "after" },
    )
      .lean()
      .exec()) as LotteryFulfillmentRecord | null;
    if (!updated) throw new Error("该奖品已被处理");
    return updated;
  }

  /** 转赠：把未核销的奖品凭据转给另一个用户。 */
  public async transfer(id: string, userId: string, targetUserId: string): Promise<LotteryFulfillmentRecord> {
    if (!targetUserId || targetUserId === userId) throw new Error("受赠人非法");
    const record = (await LotteryFulfillmentModel.findOne({ id, userId }).lean().exec()) as LotteryFulfillmentRecord | null;
    if (!record) throw new Error("履约记录不存在");
    if (!MOVABLE_STATUSES.has(record.status)) throw new Error("该奖品当前状态不可转赠");
    const now = new Date().toISOString();
    const updated = (await LotteryFulfillmentModel.findOneAndUpdate(
      { id, userId, status: record.status },
      {
        $set: { userId: targetUserId, updatedAt: now },
        $push: { history: { action: "transfer", at: now, by: userId, detail: `→ ${targetUserId}` } },
      },
      { returnDocument: "after" },
    )
      .lean()
      .exec()) as LotteryFulfillmentRecord | null;
    if (!updated) throw new Error("该奖品已被处理");
    return updated;
  }

  /** 折现/折积分：按 redeemValue 或 价值 × 比例 折算成抽奖积分。 */
  public async redeem(id: string, userId: string): Promise<{ value: number; balance: number }> {
    const record = (await LotteryFulfillmentModel.findOne({ id, userId }).lean().exec()) as LotteryFulfillmentRecord | null;
    if (!record) throw new Error("履约记录不存在");
    if (!MOVABLE_STATUSES.has(record.status)) throw new Error("该奖品当前状态不可折现");
    const configured = Number((record.params as Record<string, unknown> | undefined)?.redeemValue);
    const value = Math.max(0, Math.floor((Number.isFinite(configured) ? configured : record.prizeValue * REDEEM_RATIO) || 0));

    const now = new Date().toISOString();
    const updated = (await LotteryFulfillmentModel.findOneAndUpdate(
      { id, userId, status: record.status },
      {
        $set: { status: "redeemed", updatedAt: now },
        $push: { history: { action: "redeem", at: now, by: userId, detail: `折现 ${value}` } },
      },
      { returnDocument: "after" },
    )
      .lean()
      .exec()) as LotteryFulfillmentRecord | null;
    if (!updated) throw new Error("该奖品已被处理");

    const balance = await this.creditPoints(userId, value);
    return { value, balance };
  }

  /** 把折算积分记到用户账上（与机会扣减同一把用户锁）。 */
  private async creditPoints(userId: string, amount: number): Promise<number> {
    return sharedStateStore.withLock(`lottery:chances:${userId}`, CHANCE_LOCK_TTL_MS, async () => {
      const record = await getUserRecord(userId);
      const next = Math.max(0, Math.floor(record?.assetBalance ?? 0)) + Math.max(0, Math.floor(amount));
      await updateUserRecord(userId, { userId, assetBalance: next });
      return next;
    });
  }

  // ── 队列 / 看门狗 ────────────────────────────────────────────────

  /** 认领一条待处理记录（原子；带租约与尝试计数）。 */
  private async claimNextPending(): Promise<LotteryFulfillmentRecord | null> {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + LEASE_MS).toISOString();
    return (await LotteryFulfillmentModel.findOneAndUpdate(
      { status: "pending" },
      {
        $set: { status: "processing", processingOwner: this.workerId, leaseExpiresAt, updatedAt: now.toISOString() },
        $inc: { attempts: 1 },
      },
      { sort: { createdAt: 1 }, returnDocument: "after" },
    )
      .lean()
      .exec()) as LotteryFulfillmentRecord | null;
  }

  /** 所有者条件写：owner 不匹配（已被看门狗回收/转交）则返回 null。 */
  private async transition(
    id: string,
    expectedOwner: string | undefined,
    patch: Partial<LotteryFulfillmentRecord>,
    action?: string,
    detail?: string,
  ): Promise<LotteryFulfillmentRecord | null> {
    const now = new Date().toISOString();
    const filter: Record<string, unknown> = { id };
    if (expectedOwner) filter.processingOwner = expectedOwner;
    const update: Record<string, unknown> = { $set: { ...patch, updatedAt: now } };
    if (action) update.$push = { history: { action, at: now, detail } };
    return (await LotteryFulfillmentModel.findOneAndUpdate(filter, update, { returnDocument: "after" })
      .lean()
      .exec()) as LotteryFulfillmentRecord | null;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      await this.recoverStale(Date.now());
      const active = new Set<Promise<void>>();
      while (active.size < CONCURRENCY) {
        const record = await this.claimNextPending();
        if (!record) break;
        const task = this.processRecord(record)
          .catch((error) => {
            logger.error("[LotteryFulfillment] 处理异常", {
              id: record.id,
              error: error instanceof Error ? error.message : String(error),
            });
          })
          .finally(() => {
            active.delete(task);
          });
        active.add(task);
      }
      await Promise.allSettled(active);
    } catch (error) {
      logger.error("[LotteryFulfillment] 调度失败", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.draining = false;
    }
  }

  private async processRecord(record: LotteryFulfillmentRecord): Promise<void> {
    try {
      if (record.type === "physical") {
        await this.transition(record.id, record.processingOwner, { status: "awaiting_address" }, "await_address", "等待填写地址");
        return;
      }
      const url = record.type === "code" ? this.codeUrl() : this.virtualUrl();
      if (!url) {
        // 未接通道：落 ready 待人工，不置失败（避免把「没配通道」误判成履约失败）。
        await this.transition(record.id, record.processingOwner, { status: "ready", error: undefined }, "no_provider", "未配置履约通道，待人工处理");
        return;
      }
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fulfillmentId: record.id,
          roundId: record.roundId,
          userId: record.userId,
          prizeId: record.prizeId,
          prizeName: record.prizeName,
          provider: record.provider,
          params: record.params,
        }),
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`履约服务返回 ${response.status}`);
      }
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (record.type === "code") {
        const code = typeof payload?.code === "string" ? payload.code.trim() : "";
        if (!code) throw new Error("履约服务未返回卡密");
        await this.transition(record.id, record.processingOwner, { status: "completed", code, error: undefined }, "completed", "卡密已下发");
      } else {
        await this.transition(record.id, record.processingOwner, { status: "completed", error: undefined }, "completed", "虚拟直充完成");
      }
    } catch (error) {
      await this.handleFailure(record, error);
    }
  }

  private async handleFailure(record: LotteryFulfillmentRecord, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    if (record.attempts >= MAX_ATTEMPTS) {
      const failed = await this.transition(
        record.id,
        record.processingOwner,
        { status: "failed", error: message, processingOwner: undefined, leaseExpiresAt: undefined },
        "failed",
        message,
      );
      if (failed) void this.alertDeadLetter([failed]);
      return;
    }
    await this.transition(
      record.id,
      record.processingOwner,
      { status: "pending", error: message, processingOwner: undefined, leaseExpiresAt: undefined },
      "retry",
      message,
    );
  }

  /** 看门狗：超时未续租的处理中记录 → 重试或死信（原子条件更新，防误杀）。 */
  public async recoverStale(now: number): Promise<{ recovered: number; failed: LotteryFulfillmentRecord[] }> {
    const nowIso = new Date(now).toISOString();
    const staleFilter = { status: "processing", leaseExpiresAt: { $lte: nowIso } };

    const overLimit = (await LotteryFulfillmentModel.find({ ...staleFilter, attempts: { $gte: MAX_ATTEMPTS } })
      .select("id")
      .lean()
      .exec()) as Array<{ id: string }>;

    const failed: LotteryFulfillmentRecord[] = [];
    for (const candidate of overLimit) {
      const doc = (await LotteryFulfillmentModel.findOneAndUpdate(
        { id: candidate.id, ...staleFilter, attempts: { $gte: MAX_ATTEMPTS } },
        {
          $set: { status: "failed", error: "履约重试次数已达上限", processingOwner: null, leaseExpiresAt: null, updatedAt: nowIso },
          $push: { history: { action: "dead_letter", at: nowIso, detail: "超时重试超限" } },
        },
        { returnDocument: "after" },
      )
        .lean()
        .exec()) as LotteryFulfillmentRecord | null;
      if (doc) failed.push(doc);
    }

    const reset = await LotteryFulfillmentModel.updateMany(
      { ...staleFilter, attempts: { $lt: MAX_ATTEMPTS } },
      {
        $set: { status: "pending", processingOwner: null, leaseExpiresAt: null, updatedAt: nowIso },
        $push: { history: { action: "recovered", at: nowIso, detail: "租约超时回收" } },
      },
    ).exec();

    if (failed.length > 0) void this.alertDeadLetter(failed);
    return { recovered: reset.modifiedCount, failed };
  }

  private async alertDeadLetter(failed: LotteryFulfillmentRecord[]): Promise<void> {
    try {
      await sendAdminAlert({
        level: "critical",
        subject: `${failed.length} 个抽奖履约任务进入死信`,
        text: failed.map((record) => `id=${record.id} prize=${record.prizeName} user=${record.userId} attempts=${record.attempts}`).join("\n"),
        detail: { count: failed.length, ids: failed.map((record) => record.id) },
      });
    } catch (error) {
      logger.error("[LotteryFulfillment] 死信告警失败", { error: error instanceof Error ? error.message : String(error) });
    }
  }
}

export const lotteryFulfillmentService = new LotteryFulfillmentService();
