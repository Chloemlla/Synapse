import mongoose from "mongoose";
import { PIXEL_SUBMIT_STATES, type PixelSubmitState } from "../pixel/types";

/**
 * pixel_task_access：Synapse 用户 ↔ 上游 task 的授权记录（PIX-05…PIX-08，PRD 5.3「Pixel task access」）。
 *
 * 这张表是**权限的唯一依据**：用户能看哪个上游 task，取决于这里有没有属于他的行；上游
 * `/api/tasks-by-card` 返回的是整张卡密下的全部任务，可能横跨多个 Synapse 用户，所以
 * service 层必须按本表过滤（见 src/pixel/taskService.ts）。
 *
 * 刻意不存的字段：账号原始行、密码、辅助邮箱、2FA/TOTP 秘钥、完整 result link、完整卡密。
 * 只保留「有几个账号、现在什么状态」这类最小必要信息；卡密以 `distributionCdkHash`
 * （sha256）参与查询，明文不在库里，也不在日志/审计里。
 */
export interface IPixelTaskAccess {
  /** 对外稳定标识。 */
  accessId: string;
  /** Synapse 用户：权限归属，只能来自服务端会话。 */
  userId: string;
  /** 使用的 CDK 映射（映射被删除后该值可能指向不存在的记录，历史仍可读）。 */
  mappingId: string;
  /** sha256(分发卡密)：按卡密查历史时用它，避免存明文。 */
  distributionCdkHash: string;
  /** 上游 task id；提交尚未被受理时为空串。 */
  upstreamTaskId: string;
  serviceType: string;
  accountCount: number;
  /** 本地提交状态（见 types.PIXEL_SUBMIT_STATES）：决定同一幂等键重复请求时怎么回答。 */
  submitState: PixelSubmitState;
  /** 被拒绝时的稳定错误码（我们自己的 code，不含上游原文），用于幂等重放时回同样的错误。 */
  submitOutcomeCode: string;
  /** 已知的上游任务状态（终态后不再轮询）。 */
  status: string;
  /** 客户端提交时的幂等键；{userId, idempotencyKey} 唯一。 */
  idempotencyKey: string;
  createdAt: Date;
  updatedAt: Date;
  lastPolledAt: Date | null;
  /** 账号注销后的软删除时间戳（0 = 有效），与 geogebra 系列集合同一约定。 */
  subjectDeletedAt: number;
}

const PixelTaskAccessSchema = new mongoose.Schema<IPixelTaskAccess>(
  {
    accessId: { type: String, required: true, unique: true, maxlength: 80 },
    userId: { type: String, required: true },
    mappingId: { type: String, default: "" },
    distributionCdkHash: { type: String, default: "", maxlength: 64 },
    upstreamTaskId: { type: String, default: "", maxlength: 200 },
    serviceType: { type: String, default: "link_only", maxlength: 40 },
    accountCount: { type: Number, default: 0 },
    submitState: { type: String, enum: PIXEL_SUBMIT_STATES, required: true, default: "in_flight" },
    submitOutcomeCode: { type: String, default: "", maxlength: 80 },
    status: { type: String, default: "pending", maxlength: 40 },
    idempotencyKey: { type: String, required: true, maxlength: 200 },
    lastPolledAt: { type: Date, default: null },
    subjectDeletedAt: { type: Number, default: 0 },
  },
  { collection: "pixel_task_access", timestamps: true },
);

// 幂等键唯一：同一个用户拿同一个键重复提交时，第二次插入直接失败，service 层据此复用第一次的结果
// （不会向上游发第二次请求，也就不会重复扣额）。
PixelTaskAccessSchema.index({ userId: 1, idempotencyKey: 1 }, { unique: true });
// 用户的任务列表（详情/导出按 id 查、按时间倒序列出）
PixelTaskAccessSchema.index({ userId: 1, createdAt: -1 });
PixelTaskAccessSchema.index({ userId: 1, upstreamTaskId: 1 });
// 按卡密查历史：先按 {userId, hash} 取出该用户在该卡密下的全部 task id，再过滤上游返回的列表
PixelTaskAccessSchema.index({ userId: 1, distributionCdkHash: 1, createdAt: -1 });

export const PixelTaskAccessModel =
  (mongoose.models.PixelTaskAccess as mongoose.Model<IPixelTaskAccess>) ||
  mongoose.model<IPixelTaskAccess>("PixelTaskAccess", PixelTaskAccessSchema);

export default PixelTaskAccessModel;
