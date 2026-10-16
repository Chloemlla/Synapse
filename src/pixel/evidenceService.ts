import PixelEvidenceApprovalModel from "../models/pixelEvidenceApprovalModel";
import PixelEvidenceModel from "../models/pixelEvidenceModel";
import logger from "../utils/logger";
import { decryptPixelEvidence, encryptPixelEvidence } from "./evidenceCrypto";
import { newPixelId } from "./runtime";
import { PixelDomainError } from "./types";

// 内容级取证（「公开、限定、可追责」版）。
//
// 与「偷偷留一份明文凭据」的四点差别，全部是硬编码在这里的约束：
//   公开：提交页与隐私政策都写明「在 X 情形下会留存账号内容 Y 天」（本服务只实现「X = 命中审批」）；
//   限定：没有有效审批单就不写任何内容（findActiveApproval 返回 null 时直接不捕获）；
//   可追责：每次读取都要带 actor，由调用方（管理路由）写审计；本服务只累加 accessCount；
//   时间盒：expiresAt 上的 TTL 自动清除，且不超过审批单自身的有效期。
const MAX_EVIDENCE_BYTES = 256 * 1024;
const MAX_EVIDENCE_KEEP_DAYS = 30;

export type PixelEvidenceApprovalView = {
  approvalId: string;
  userId: string;
  caseRef: string;
  legalBasis: string;
  reason: string;
  approvedByUsername: string;
  approvedAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedByUsername: string;
  revokeReason: string;
};

export type PixelEvidenceView = {
  evidenceId: string;
  userId: string;
  caseRef: string;
  legalBasis: string;
  approvedByUsername: string;
  capturedAt: string;
  expiresAt: string;
  accountCount: number;
  byteSize: number;
  accessCount: number;
  lastAccessedAt: string | null;
  truncatedFromBytes: number | null;
};

function approvalView(doc: {
  approvalId: string; userId: string; caseRef: string; legalBasis: string; reason: string;
  approvedByUsername: string; approvedAt: Date; expiresAt: Date;
  revokedAt: Date | null; revokedByUsername: string; revokeReason: string;
}): PixelEvidenceApprovalView {
  return {
    approvalId: doc.approvalId,
    userId: doc.userId,
    caseRef: doc.caseRef,
    legalBasis: doc.legalBasis,
    reason: doc.reason,
    approvedByUsername: doc.approvedByUsername,
    approvedAt: new Date(doc.approvedAt).toISOString(),
    expiresAt: new Date(doc.expiresAt).toISOString(),
    revokedAt: doc.revokedAt ? new Date(doc.revokedAt).toISOString() : null,
    revokedByUsername: doc.revokedByUsername,
    revokeReason: doc.revokeReason,
  };
}

function evidenceView(doc: {
  evidenceId: string; userId: string; caseRef: string; legalBasis: string;
  approvedByUsername: string; capturedAt: Date; expiresAt: Date;
  accountCount: number; byteSize: number; accessCount: number;
  lastAccessedAt: Date | null; truncatedFromBytes: number | null;
}): PixelEvidenceView {
  return {
    evidenceId: doc.evidenceId,
    userId: doc.userId,
    caseRef: doc.caseRef,
    legalBasis: doc.legalBasis,
    approvedByUsername: doc.approvedByUsername,
    capturedAt: new Date(doc.capturedAt).toISOString(),
    expiresAt: new Date(doc.expiresAt).toISOString(),
    accountCount: doc.accountCount,
    byteSize: doc.byteSize,
    accessCount: doc.accessCount,
    lastAccessedAt: doc.lastAccessedAt ? new Date(doc.lastAccessedAt).toISOString() : null,
    truncatedFromBytes: doc.truncatedFromBytes ?? null,
  };
}

/**
 * 只有「未撤销、未过期、且 userId 命中」的审批单才有效。
 * 多条命中时取最晚到期的一条（同一账号可能有新案子的审批）。
 */
export async function findActiveEvidenceApproval(userId: string): Promise<PixelEvidenceApprovalView | null> {
  const doc = await PixelEvidenceApprovalModel.findOne({
    userId,
    revokedAt: null,
    expiresAt: { $gt: new Date() },
  }).sort({ expiresAt: -1 }).lean();
  return doc ? approvalView(doc as unknown as Parameters<typeof approvalView>[0]) : null;
}

export async function createEvidenceApproval(input: {
  userId: string;
  caseRef: string;
  legalBasis: string;
  reason?: string;
  validDays?: number;
  actor: { userId: string; username: string };
}): Promise<PixelEvidenceApprovalView> {
  const userId = String(input.userId || "").trim();
  const caseRef = String(input.caseRef || "").trim();
  const legalBasis = String(input.legalBasis || "").trim();
  if (!userId) throw new PixelDomainError("请指定审批针对的账号。", 400, "PIXEL_EVIDENCE_USER_REQUIRED");
  if (!caseRef) throw new PixelDomainError("请填写案件编号。", 400, "PIXEL_EVIDENCE_CASE_REQUIRED");
  if (!legalBasis) throw new PixelDomainError("请填明法律依据或用户授权，否则不能留存账号内容。", 400, "PIXEL_EVIDENCE_BASIS_REQUIRED");

  const days = Number.isFinite(input.validDays) && (input.validDays ?? 0) > 0
    ? Math.min(MAX_EVIDENCE_KEEP_DAYS, Math.floor(input.validDays as number))
    : MAX_EVIDENCE_KEEP_DAYS;

  const created = await PixelEvidenceApprovalModel.create({
    approvalId: newPixelId("pxa"),
    userId,
    caseRef,
    legalBasis,
    reason: input.reason || "",
    approvedByUserId: input.actor.userId,
    approvedByUsername: input.actor.username,
    approvedAt: new Date(),
    expiresAt: new Date(Date.now() + days * 24 * 60 * 60_000),
    revokedAt: null,
    revokedByUserId: "",
    revokedByUsername: "",
    revokeReason: "",
  });

  logger.warn("[Pixel] 已开启内容级取证审批（仅该账号、限期内）", {
    caseRef,
    validDays: days,
    approvedBy: input.actor.username || input.actor.userId,
  });

  return approvalView(created as unknown as Parameters<typeof approvalView>[0]);
}

export async function revokeEvidenceApproval(input: {
  approvalId: string;
  reason?: string;
  actor: { userId: string; username: string };
}): Promise<PixelEvidenceApprovalView> {
  const doc = await PixelEvidenceApprovalModel.findOne({ approvalId: String(input.approvalId || "").trim() });
  if (!doc) throw new PixelDomainError("审批单不存在。", 404, "PIXEL_EVIDENCE_APPROVAL_NOT_FOUND");
  if (doc.revokedAt) return approvalView(doc as unknown as Parameters<typeof approvalView>[0]);
  doc.revokedAt = new Date();
  doc.revokedByUserId = input.actor.userId;
  doc.revokedByUsername = input.actor.username;
  doc.revokeReason = input.reason || "";
  await doc.save();
  logger.warn("[Pixel] 已撤销内容级取证审批", { revokedBy: input.actor.username || input.actor.userId });
  return approvalView(doc as unknown as Parameters<typeof approvalView>[0]);
}

export async function listEvidenceApprovals(options: { includeRevoked?: boolean; limit?: number } = {}): Promise<PixelEvidenceApprovalView[]> {
  const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 50) || 50), 200);
  const filter = options.includeRevoked ? {} : { revokedAt: null };
  const rows = await PixelEvidenceApprovalModel.find(filter).sort({ approvedAt: -1 }).limit(limit).lean();
  return rows.map((row) => approvalView(row as unknown as Parameters<typeof approvalView>[0]));
}

/**
 * 捕获账号内容：**只有命中有效审批才写**，否则静默不写（不是错误，是默认状态）。
 * 超上限时**不截断**——截断的凭据等于伪造证据，宁可整条不存并让管理员看到原因。
 */
export async function capturePixelEvidence(input: {
  userId: string;
  accountsText: string;
  accountCount: number;
}): Promise<{ captured: boolean; reason?: string; evidenceId?: string }> {
  const approval = await findActiveEvidenceApproval(input.userId);
  if (!approval) return { captured: false, reason: "no-active-approval" };

  const bytes = Buffer.byteLength(input.accountsText, "utf8");
  if (bytes > MAX_EVIDENCE_BYTES) {
    logger.warn("[Pixel] 取证内容超过单条上限，未留存（不截断）", { caseRef: approval.caseRef, bytes });
    return { captured: false, reason: "too-large" };
  }

  const encrypted = encryptPixelEvidence(input.accountsText);
  // 到期时间取「审批有效期」与「最长保留期」的较小者：审批先到期就跟着到期。
  const approvalExpiry = new Date(approval.expiresAt).getTime();
  const hardCap = Date.now() + MAX_EVIDENCE_KEEP_DAYS * 24 * 60 * 60_000;
  const doc = await PixelEvidenceModel.create({
    evidenceId: newPixelId("pxe"),
    userId: input.userId,
    caseRef: approval.caseRef,
    legalBasis: approval.legalBasis,
    approvedByUserId: "",
    approvedByUsername: approval.approvedByUsername,
    approvedAt: new Date(approval.approvedAt),
    capturedAt: new Date(),
    expiresAt: new Date(Math.min(approvalExpiry, hardCap)),
    ciphertext: encrypted.ciphertext,
    iv: encrypted.iv,
    tag: encrypted.tag,
    cryptoVersion: encrypted.cryptoVersion,
    accountCount: input.accountCount,
    byteSize: bytes,
    accessCount: 0,
    lastAccessedAt: null,
    truncatedFromBytes: null,
  });

  logger.warn("[Pixel] 已按审批留存一次账号内容（加密，限期）", { caseRef: approval.caseRef, bytes });
  return { captured: true, evidenceId: String(doc.evidenceId) };
}

export async function listPixelEvidence(options: { caseRef?: string; userId?: string; limit?: number } = {}): Promise<PixelEvidenceView[]> {
  const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 50) || 50), 200);
  const filter: Record<string, unknown> = {};
  if (options.caseRef) filter.caseRef = options.caseRef;
  if (options.userId) filter.userId = options.userId;
  const rows = await PixelEvidenceModel.find(filter).sort({ capturedAt: -1 }).limit(limit).lean();
  return rows.map((row) => evidenceView(row as unknown as Parameters<typeof evidenceView>[0]));
}

/**
 * 读取并解密一条证据。**每次读取都累加访问计数**并由调用方写审计：
 * 「谁、凭哪个案件依据、读了哪条」三件事必须同时留下。
 */
export async function readPixelEvidence(evidenceId: string): Promise<{ meta: PixelEvidenceView; accountsText: string }> {
  const doc = await PixelEvidenceModel.findOne({ evidenceId: String(evidenceId || "").trim() }).lean();
  if (!doc) throw new PixelDomainError("取证记录不存在。", 404, "PIXEL_EVIDENCE_NOT_FOUND");
  if (new Date(doc.expiresAt).getTime() <= Date.now()) {
    // TTL 回收有分钟级延迟，这里再兜一层：过期即视为不可读。
    throw new PixelDomainError("取证记录已过期。", 410, "PIXEL_EVIDENCE_EXPIRED");
  }
  let accountsText: string;
  try {
    accountsText = decryptPixelEvidence(doc as unknown as Parameters<typeof decryptPixelEvidence>[0]);
  } catch {
    logger.error("[Pixel] 取证内容解密失败（密钥轮换或密文损坏）", { caseRef: doc.caseRef });
    throw new PixelDomainError("内容暂时无法解密，请联系运维核对密钥。", 500, "PIXEL_EVIDENCE_DECRYPT_FAILED");
  }
  await PixelEvidenceModel.updateOne(
    { evidenceId: doc.evidenceId },
    { $inc: { accessCount: 1 }, $set: { lastAccessedAt: new Date() } },
  );
  return { meta: evidenceView(doc as unknown as Parameters<typeof evidenceView>[0]), accountsText };
}
