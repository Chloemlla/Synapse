import { randomUUID } from "node:crypto";
import logger from "../../utils/logger";
import { mongoose } from "../mongoService";

const LOCK_ID = "enqueue";
const LEASE_MS = 30_000;
const WAIT_MS = 2_000;
export const QUEUE_DB_TIMEOUT_MS = 3_000;

const lockSchema = new mongoose.Schema(
  { _id: String, owner: String, expiresAt: Date },
  { collection: "command_queue_locks", bufferCommands: false },
);
lockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const QueueLockModel = mongoose.models.CommandQueueLock || mongoose.model("CommandQueueLock", lockSchema);

/** Standalone-compatible shared lock. No Redis/memory fallback can split ownership. */
export async function withCommandQueueLock<T>(action: (assertLease: () => Promise<void>) => Promise<T>): Promise<T> {
  const owner = randomUUID();
  const deadline = Date.now() + WAIT_MS;
  let acquired = false;
  while (!acquired) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("命令队列正忙，请稍后重试");
    try {
      const result = await QueueLockModel.updateOne(
        { _id: LOCK_ID, expiresAt: { $lte: new Date() } },
        { $set: { owner, expiresAt: new Date(Date.now() + LEASE_MS) } },
        { upsert: true, timeoutMS: remaining },
      ).exec();
      acquired = Boolean(result.matchedCount || result.upsertedCount);
    } catch (error) {
      // The primary-key conflict means another unexpired owner already holds it.
      if ((error as { code?: number })?.code !== 11000) throw error;
    }
    if (!acquired) {
      const delay = Math.min(50, deadline - Date.now());
      if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }

  try {
    return await action(async () => {
      // Recheck ownership after counting, before dispatching the bounded insert.
      // A paused/stale owner must not write after another process takes its lease.
      const result = await QueueLockModel.updateOne(
        { _id: LOCK_ID, owner, expiresAt: { $gt: new Date() } },
        { $set: { expiresAt: new Date(Date.now() + LEASE_MS) } },
        { timeoutMS: QUEUE_DB_TIMEOUT_MS },
      ).exec();
      if (!result.matchedCount) throw new Error("命令队列锁已失效，请重试");
    });
  } finally {
    try {
      await QueueLockModel.deleteOne(
        { _id: LOCK_ID, owner },
        { timeoutMS: QUEUE_DB_TIMEOUT_MS },
      ).exec();
    } catch {
      // A failed release cannot replace a successful insert with a retryable error.
      // Owner matching protects a successor, and expiry recovers crashed writers.
      logger.warn("[CommandQueue] Lock release failed; lease expiry will recover it");
    }
  }
}
