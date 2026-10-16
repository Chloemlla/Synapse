import PixelEvidenceHoldModel from "../models/pixelEvidenceHoldModel";
import PixelTaskAccessModel from "../models/pixelTaskAccessModel";
import PixelUsageLogModel from "../models/pixelUsageLogModel";
import { createLegalHold, releaseLegalHold, checkAnyLegalHold } from "../services/legalHoldService";
import logger from "../utils/logger";
import { newPixelId } from "./runtime";
import { pixelUsageLogService } from "./usageLogService";
import { PixelDomainError } from "./types";

// 法律保全（PRD 6.1 框架 / 运维手册第 8 节）：
//   收到法律程序 → 登记 legal hold（全局表）→ 就地快照「任务归属 + 脱敏溯源」→
//   此后该账号的物理清理一律跳过；解除保全后再按期限回收快照。
//
// 两条边界必须说清：
//   1) 保全的是**已按披露目的收集的数据**。账号内容本来就不落库，保全不会、也不应该
//      凭空产生它；要内容级证据走 evidenceService 的审批通道。
//   2) 快照没有 TTL（purgeAfter 为 null），否则「保全」会被 TTL 静默清掉 —— 那正是
//      pixel_usage_logs 加标记拦不住的原因。
const MAX_SNAPSHOT_ROWS = 5_000;
const RELEASE_PURGE_DELAY_DAYS = 30;

const TASK_ACCESS_FIELDS = [
  "accessId", "userId", "mappingId", "distributionCdkHash", "upstreamTaskId",
  "serviceType", "accountCount", "submitState", "submitOutcomeCode", "status",
  "idempotencyKey", "createdAt", "updatedAt", "lastPolledAt", "subjectDeletedAt",
] as const;

const USAGE_LOG_FIELDS = [
  "logId", "requestId", "userId", "mappingId", "requestedCdkMasked", "matchedMapping",
  "method", "path", "serviceType", "accountCount", "requestBytes", "responseBytes",
  "upstreamStatus", "outcome", "durationMs", "createdAt",
] as const;

export type PixelEvidenceHoldView = {
  holdId: string;
  userId: string;
  caseRef: string;
  legalBasis: string;
  reason: string;
  issuedByUsername: string;
  issuedAt: string;
  taskAccessCount: number;
  usageLogCount: number;
  truncated: boolean;
  releasedAt: string | null;
  releasedByUsername: string;
  releaseReason: string;
  purgeAfter: string | null;
};

function holdView(doc: {
  holdId: string; userId: string; caseRef: string; legalBasis: string; reason: string;
  issuedByUsername: string; issuedAt: Date;
  taskAccess?: Array<Record<string, unknown>>; usageLogs?: Array<Record<string, unknown>>;
  taskAccessCount?: number; usageLogCount?: number; truncated: boolean;
  releasedAt: Date | null; releasedByUsername: string; releaseReason: string; purgeAfter: Date | null;
}): PixelEvidenceHoldView {
  return {
    holdId: doc.holdId,
    userId: doc.userId,
    caseRef: doc.caseRef,
    legalBasis: doc.legalBasis,
    reason: doc.reason,
    issuedByUsername: doc.issuedByUsername,
    issuedAt: new Date(doc.issuedAt).toISOString(),
    // 列表视图用存好的计数（明细字段不下发）；创建时用实际行数。
    taskAccessCount: doc.taskAccessCount ?? (Array.isArray(doc.taskAccess) ? doc.taskAccess.length : 0),
    usageLogCount: doc.usageLogCount ?? (Array.isArray(doc.usageLogs) ? doc.usageLogs.length : 0),
    truncated: Boolean(doc.truncated),
    releasedAt: doc.releasedAt ? new Date(doc.releasedAt).toISOString() : null,
    releasedByUsername: doc.releasedByUsername,
    releaseReason: doc.releaseReason,
    purgeAfter: doc.purgeAfter ? new Date(doc.purgeAfter).toISOString() : null,
  };
}

function pickFields(row: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const field of fields) {
    if (field in row) picked[field] = row[field];
  }
  return picked;
}

/**
 * 登记保全 + 快照。顺序刻意是「先 hold 再快照」：
 * 若 hold 写失败（库不可用会抛错），就不留下「只有快照、没有 hold」的半状态——
 * 那种状态会让人误以为删除已被冻结，实际上删除路径只看 legal hold。
 */
export async function createPixelEvidenceHold(input: {
  userId: string;
  caseRef: string;
  legalBasis: string;
  reason?: string;
  actor: { userId: string; username: string };
}): Promise<PixelEvidenceHoldView> {
  const userId = String(input.userId || "").trim();
  const caseRef = String(input.caseRef || "").trim();
  const legalBasis = String(input.legalBasis || "").trim();
  if (!userId) throw new PixelDomainError("请指定要保全的账号。", 400, "PIXEL_HOLD_USER_REQUIRED");
  if (!caseRef) throw new PixelDomainError("请填写案件编号，否则之后无法说明为什么保留了这些数据。", 400, "PIXEL_HOLD_CASE_REQUIRED");
  if (!legalBasis) throw new PixelDomainError("请填明法律依据（例如文书编号或用户授权）。", 400, "PIXEL_HOLD_BASIS_REQUIRED");

  const hold = await createLegalHold({
    scope: "user",
    value: userId,
    caseRef,
    reason: input.reason || legalBasis,
    issuedBy: input.actor.username || input.actor.userId,
  });
  if (!hold) throw new PixelDomainError("法律保留登记失败，请稍后重试。", 503, "PIXEL_HOLD_CREATE_FAILED");

  const [taskAccessRows, usageRows] = await Promise.all([
    PixelTaskAccessModel.find({ userId }).limit(MAX_SNAPSHOT_ROWS).lean(),
    PixelUsageLogModel.find({ userId }).sort({ createdAt: -1 }).limit(MAX_SNAPSHOT_ROWS).lean(),
  ]);
  const taskAccess = taskAccessRows.map((row) => pickFields(row as Record<string, unknown>, TASK_ACCESS_FIELDS));
  const usageLogs = usageRows.map((row) => pickFields(row as Record<string, unknown>, USAGE_LOG_FIELDS));
  const truncated = taskAccessRows.length >= MAX_SNAPSHOT_ROWS || usageRows.length >= MAX_SNAPSHOT_ROWS;

  const created = await PixelEvidenceHoldModel.create({
    holdId: newPixelId("pxh"),
    userId,
    caseRef,
    legalBasis,
    reason: input.reason || "",
    issuedByUserId: input.actor.userId,
    issuedByUsername: input.actor.username,
    issuedAt: new Date(),
    taskAccess,
    usageLogs,
    truncated,
    taskAccessCount: taskAccess.length,
    usageLogCount: usageLogs.length,
    releasedAt: null,
    releasedByUserId: "",
    releasedByUsername: "",
    releaseReason: "",
    purgeAfter: null,
  });

  logger.warn("[Pixel] 已登记法律保全并快照证据", {
    caseRef,
    taskAccess: taskAccess.length,
    usageLogs: usageLogs.length,
    truncated,
  });

  return holdView(created as unknown as Parameters<typeof holdView>[0]);
}

export async function releasePixelEvidenceHold(input: {
  holdId: string;
  releaseReason?: string;
  actor: { userId: string; username: string };
  purgeDelayDays?: number;
}): Promise<PixelEvidenceHoldView> {
  const holdId = String(input.holdId || "").trim();
  const existing = await PixelEvidenceHoldModel.findOne({ holdId });
  if (!existing) throw new PixelDomainError("保全记录不存在。", 404, "PIXEL_HOLD_NOT_FOUND");
  if (existing.releasedAt) return holdView(existing as unknown as Parameters<typeof holdView>[0]);

  await releaseLegalHold({
    scope: "user",
    value: existing.userId,
    releasedBy: input.actor.username || input.actor.userId,
    releaseReason: input.releaseReason || "",
  });

  const delayDays = Number.isFinite(input.purgeDelayDays) && (input.purgeDelayDays ?? 0) > 0
    ? Math.min(365, Math.floor(input.purgeDelayDays as number))
    : RELEASE_PURGE_DELAY_DAYS;
  const releasedAt = new Date();
  existing.releasedAt = releasedAt;
  existing.releasedByUserId = input.actor.userId;
  existing.releasedByUsername = input.actor.username;
  existing.releaseReason = input.releaseReason || "";
  // 解除后仍留一段时间（默认 30 天）再自动回收：法律程序刚结束就秒删，同样会造成证据缺口。
  existing.purgeAfter = new Date(releasedAt.getTime() + delayDays * 24 * 60 * 60_000);
  await existing.save();

  return holdView(existing as unknown as Parameters<typeof holdView>[0]);
}

/**
 * 账号注销时清理 Pixel 脱敏溯源（纯遥测，就地硬删）。
 *
 * **法律保留优先**：命中 hold、或库不可用只能给出「疑似被 hold」时，一律跳过删除。
 * 物理删除不可逆 —— 宁可多留一次让人工按程序处理，也不能把证据删掉。
 *
 * 放在 Pixel 域里（而不是塞进 userService）是为了让这条策略可被单测直接钉住。
 */
export async function purgePixelTelemetryUnlessHeld(userId: string): Promise<{ skipped: boolean; removed: number }> {
  const hold = await checkAnyLegalHold({ userId });
  if (hold.held) {
    logger.warn("[Pixel] 溯源保留：命中法律保留，跳过物理删除", {
      caseRef: hold.hold?.caseRef ?? "unknown",
      undetermined: hold.unknown,
    });
    return { skipped: true, removed: 0 };
  }
  try {
    const removed = await pixelUsageLogService.deleteForUser(userId);
    logger.info("[Pixel] 脱敏溯源已随账号注销清除", { removed });
    return { skipped: false, removed };
  } catch {
    // 删不掉不能阻断账号注销：记录会由 TTL 到期自动回收。
    logger.warn("[Pixel] 溯源清理延后");
    return { skipped: false, removed: 0 };
  }
}

export async function listPixelEvidenceHolds(options: { includeReleased?: boolean; limit?: number } = {}): Promise<PixelEvidenceHoldView[]> {
  const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 50) || 50), 200);
  const filter = options.includeReleased ? {} : { releasedAt: null };
  const rows = await PixelEvidenceHoldModel.find(filter)
    .sort({ issuedAt: -1 })
    .limit(limit)
    .select("-taskAccess -usageLogs")
    .lean();
  return rows.map((row) => holdView(row as unknown as Parameters<typeof holdView>[0]));
}
