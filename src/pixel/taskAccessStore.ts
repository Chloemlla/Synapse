import PixelTaskAccessModel, { type IPixelTaskAccess } from "../models/pixelTaskAccessModel";
import { newPixelId } from "./runtime";
import type { PixelSubmitState } from "./types";

/**
 * Pixel 任务授权记录的数据访问层。
 *
 * 与 geogebra 系列一致：所有查询都带 `userId`（或软删除过滤），这一层不提供「按 task id
 * 裸查」的入口——权限判据只能在带 userId 的查询里成立，避免将来有人在 service 里顺手绕过。
 */
export interface PixelTaskAccessRecord {
  accessId: string;
  userId: string;
  mappingId: string;
  distributionCdkHash: string;
  upstreamTaskId: string;
  serviceType: string;
  accountCount: number;
  submitState: PixelSubmitState;
  submitOutcomeCode: string;
  status: string;
  idempotencyKey: string;
  createdAt: Date;
  updatedAt: Date;
  lastPolledAt: Date | null;
  subjectDeletedAt: number;
}

export interface PixelTaskAccessInput {
  userId: string;
  mappingId: string;
  distributionCdkHash: string;
  serviceType: string;
  accountCount: number;
  idempotencyKey: string;
}

export type PixelTaskAccessPatch = Partial<
  Pick<
    PixelTaskAccessRecord,
    "upstreamTaskId" | "submitState" | "submitOutcomeCode" | "status" | "lastPolledAt" | "accountCount"
  >
>;

function toRecord(doc: unknown): PixelTaskAccessRecord {
  const value = doc as IPixelTaskAccess;
  return {
    accessId: String(value.accessId),
    userId: String(value.userId),
    mappingId: String(value.mappingId ?? ""),
    distributionCdkHash: String(value.distributionCdkHash ?? ""),
    upstreamTaskId: String(value.upstreamTaskId ?? ""),
    serviceType: String(value.serviceType ?? ""),
    accountCount: Number(value.accountCount ?? 0),
    submitState: value.submitState,
    submitOutcomeCode: String(value.submitOutcomeCode ?? ""),
    status: String(value.status ?? ""),
    idempotencyKey: String(value.idempotencyKey),
    createdAt: new Date(value.createdAt),
    updatedAt: new Date(value.updatedAt),
    lastPolledAt: value.lastPolledAt ? new Date(value.lastPolledAt) : null,
    subjectDeletedAt: Number(value.subjectDeletedAt ?? 0),
  };
}

const MAX_LIST = 200;

export const pixelTaskAccessStore = {
  /**
   * 幂等占位：靠 {userId, idempotencyKey} 唯一索引保证同一个键只有一行。
   * 并发双击会有一方拿到 duplicate key，此时返回既有记录并让调用方按既有状态回答，
   * 从而**不会**向上游发第二次提交（不会重复扣额）。
   */
  async createIdempotent(input: PixelTaskAccessInput): Promise<{ created: boolean; record: PixelTaskAccessRecord }> {
    try {
      const created = await PixelTaskAccessModel.create({
        accessId: newPixelId("pxa"),
        userId: input.userId,
        mappingId: input.mappingId,
        distributionCdkHash: input.distributionCdkHash,
        upstreamTaskId: "",
        serviceType: input.serviceType,
        accountCount: input.accountCount,
        // 先落 in_flight：进程在这之后崩掉也不会让重放变成「再提交一次」。
        submitState: "in_flight",
        submitOutcomeCode: "",
        status: "pending",
        idempotencyKey: input.idempotencyKey,
        lastPolledAt: null,
        subjectDeletedAt: 0,
      });
      return { created: true, record: toRecord(created) };
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        const existing = await this.findByUserAndKey(input.userId, input.idempotencyKey);
        if (existing) return { created: false, record: existing };
      }
      throw error;
    }
  },

  async findByUserAndKey(userId: string, idempotencyKey: string): Promise<PixelTaskAccessRecord | null> {
    const doc = await PixelTaskAccessModel.findOne({
      userId,
      idempotencyKey,
      subjectDeletedAt: 0,
    }).lean();
    return doc ? toRecord(doc) : null;
  },

  async findByTaskId(userId: string, upstreamTaskId: string): Promise<PixelTaskAccessRecord | null> {
    if (!upstreamTaskId) return null;
    const doc = await PixelTaskAccessModel.findOne({
      userId,
      upstreamTaskId,
      subjectDeletedAt: 0,
    }).lean();
    return doc ? toRecord(doc) : null;
  },

  /** 某个用户在某个卡密下的全部任务记录（用于把上游返回的整卡任务列表收敛到本人）。 */
  async listByCard(userId: string, distributionCdkHash: string): Promise<PixelTaskAccessRecord[]> {
    if (!distributionCdkHash) return [];
    const docs = await PixelTaskAccessModel.find({
      userId,
      distributionCdkHash,
      subjectDeletedAt: 0,
    })
      .sort({ createdAt: -1 })
      .limit(MAX_LIST)
      .lean();
    return docs.map(toRecord);
  },

  async listByUser(userId: string, limit = MAX_LIST): Promise<PixelTaskAccessRecord[]> {
    const docs = await PixelTaskAccessModel.find({ userId, subjectDeletedAt: 0 })
      .sort({ createdAt: -1 })
      .limit(Math.min(Math.max(1, Math.floor(limit) || MAX_LIST), MAX_LIST))
      .lean();
    return docs.map(toRecord);
  },

  async patch(accessId: string, patch: PixelTaskAccessPatch): Promise<void> {
    if (Object.keys(patch).length === 0) return;
    await PixelTaskAccessModel.updateOne({ accessId }, { $set: patch }).exec();
  },

  /**
   * 删除占位记录。只在「保证上游没收到请求」的失败路径上调用（配置缺失/目标被拒）：
   * 否则幂等键会被一次配置故障永久烧掉，用户拿着同一个键再也提交不了。
   */
  async remove(accessId: string): Promise<void> {
    if (!accessId) return;
    await PixelTaskAccessModel.deleteOne({ accessId }).exec();
  },

  /** 账号注销：软删除（与 geogebra 系列同一约定），保留计数以便运维确认清理完成。 */
  async markUserDeleted(userId: string, deletedAt: number): Promise<number> {
    const result = await PixelTaskAccessModel.updateMany(
      { userId, subjectDeletedAt: 0 },
      { $set: { subjectDeletedAt: deletedAt } },
    ).exec();
    return Number(result.modifiedCount ?? 0);
  },

  /** 管理总览用：按本地提交状态计数（值域是 PIXEL_SUBMIT_STATES，不是上游状态）。 */
  async countBySubmitState(): Promise<{ total: number; bySubmitState: Record<string, number> }> {
    const rows = await PixelTaskAccessModel.aggregate<{ _id: string; count: number }>([
      { $match: { subjectDeletedAt: 0 } },
      { $group: { _id: "$submitState", count: { $sum: 1 } } },
    ]).exec();
    const bySubmitState: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      const key = String(row._id ?? "unknown");
      const count = Number(row.count ?? 0);
      bySubmitState[key] = count;
      total += count;
    }
    return { total, bySubmitState };
  },
};
