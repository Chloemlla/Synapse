import crypto from "node:crypto";
import mongoose from "mongoose";
import { RegistrationInviteModel, type RegistrationInviteDoc } from "../models/registrationInviteModel";
import { RuntimeConfigService } from "./runtimeConfigService";

const CODE_PATTERN = /^[A-Z0-9_-]{4,32}$/;

export interface RegistrationInviteSummary {
  id: string;
  code: string;
  note: string;
  active: boolean;
  maxUses: number;
  usedCount: number;
  remainingUses: number;
  createdBy?: string;
  createdByUsername?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  expired: boolean;
  usedBy: {
    userId: string;
    username: string;
    email: string;
    usedAt: string;
  }[];
}

export interface InviteActor {
  id?: string;
  username?: string;
}

export interface ConsumeInviteUser {
  id: string;
  username: string;
  email: string;
  /** RC-05：消耗来源（可选，旧调用方不传时为空白）。 */
  ipAddress?: string;
  fingerprint?: string;
}

export function normalizeInviteCode(input: unknown): string {
  return typeof input === "string" ? input.trim().toUpperCase() : "";
}

// 「仅支持在 env-manager 配置」：闸门值来自 Mongo 运行时配置（REGISTRATION_INVITE 分区），
// REGISTRATION_INVITE_REQUIRED 环境变量只作启动默认值，读内存缓存，保存后无需重启即生效。
export function isRegistrationInviteRequired(): boolean {
  return RuntimeConfigService.getCachedConfig().registrationInvite.required;
}

function generateInviteCode(): string {
  return crypto.randomBytes(9).toString("base64url").replace(/-/g, "").replace(/_/g, "").slice(0, 12).toUpperCase();
}

function parsePositiveInteger(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(10000, Math.floor(parsed)));
}

function parseExpiry(value: unknown): Date | null {
  if (value === undefined || value === null || value === "") return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new Error("过期时间格式不正确");
  }
  if (date.getTime() <= Date.now()) {
    throw new Error("过期时间必须晚于当前时间");
  }
  return date;
}

function isExpired(invite: Pick<RegistrationInviteDoc, "expiresAt">): boolean {
  return Boolean(invite.expiresAt && invite.expiresAt.getTime() <= Date.now());
}

function toSummary(invite: RegistrationInviteDoc & { _id?: any }): RegistrationInviteSummary {
  const expired = isExpired(invite);
  const remainingUses = Math.max(0, invite.maxUses - invite.usedCount);
  return {
    id: String((invite as any)._id),
    code: invite.code,
    note: invite.note || "",
    active: invite.active,
    maxUses: invite.maxUses,
    usedCount: invite.usedCount,
    remainingUses,
    createdBy: invite.createdBy,
    createdByUsername: invite.createdByUsername,
    createdAt: invite.createdAt.toISOString(),
    updatedAt: invite.updatedAt.toISOString(),
    expiresAt: invite.expiresAt ? invite.expiresAt.toISOString() : null,
    expired,
    usedBy: (invite.usedBy || []).map((item) => ({
      userId: item.userId,
      username: item.username,
      email: item.email,
      usedAt: item.usedAt.toISOString(),
    })),
  };
}

export async function listRegistrationInvites(): Promise<RegistrationInviteSummary[]> {
  const invites = await RegistrationInviteModel.find({}).sort({ createdAt: -1 }).lean(false).exec();
  return invites.map((invite) => toSummary(invite as any));
}

export interface RegistrationInviteStats {
  total: number;
  active: number;
  expired: number;
  exhausted: number;
  totalUses: number;
  remainingUses: number;
  topInviters: Array<{ username: string; created: number; uses: number }>;
  topCodes: Array<{ code: string; usedCount: number; maxUses: number; active: boolean }>;
  recentUses: Array<{ code: string; username: string; email: string; usedAt: string }>;
  trend: Array<{ date: string; uses: number }>;
}

/**
 * IN-3 / IN-5：邀请码使用概览。
 * 「已过期」与「已用尽」分开统计：前者需要续期或新建，后者只是用量到了。
 */
export async function getRegistrationInviteStats(): Promise<RegistrationInviteStats> {
  const now = new Date();
  const since30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [facet] = await RegistrationInviteModel.aggregate([
    {
      $facet: {
        totals: [
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              active: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        "$active",
                        { $or: [{ $eq: ["$expiresAt", null] }, { $gt: ["$expiresAt", now] }] },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
              expired: { $sum: { $cond: [{ $and: [{ $ne: ["$expiresAt", null] }, { $lte: ["$expiresAt", now] }] }, 1, 0] } },
              exhausted: { $sum: { $cond: [{ $gte: ["$usedCount", "$maxUses"] }, 1, 0] } },
              totalUses: { $sum: { $ifNull: ["$usedCount", 0] } },
              totalCapacity: { $sum: { $ifNull: ["$maxUses", 0] } },
            },
          },
        ],
        topInviters: [
          {
            $group: {
              _id: { $ifNull: ["$createdByUsername", "未知"] },
              created: { $sum: 1 },
              uses: { $sum: { $ifNull: ["$usedCount", 0] } },
            },
          },
          { $sort: { uses: -1, created: -1 } },
          { $limit: 10 },
        ],
        topCodes: [
          { $sort: { usedCount: -1 } },
          { $limit: 10 },
          { $project: { _id: 0, code: 1, usedCount: 1, maxUses: 1, active: 1 } },
        ],
        recentUses: [
          { $unwind: "$usedBy" },
          { $sort: { "usedBy.usedAt": -1 } },
          { $limit: 20 },
          {
            $project: {
              _id: 0,
              code: 1,
              username: "$usedBy.username",
              email: "$usedBy.email",
              usedAt: "$usedBy.usedAt",
            },
          },
        ],
        trend: [
          { $unwind: "$usedBy" },
          { $match: { "usedBy.usedAt": { $gte: since30d } } },
          { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$usedBy.usedAt" } }, uses: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ],
      },
    },
  ] as any).exec();

  const totals = facet?.totals?.[0] ?? {};
  return {
    total: totals.total ?? 0,
    active: totals.active ?? 0,
    expired: totals.expired ?? 0,
    exhausted: totals.exhausted ?? 0,
    totalUses: totals.totalUses ?? 0,
    remainingUses: Math.max(0, (totals.totalCapacity ?? 0) - (totals.totalUses ?? 0)),
    topInviters: (facet?.topInviters ?? []).map((row: any) => ({
      username: row._id ?? "未知",
      created: row.created ?? 0,
      uses: row.uses ?? 0,
    })),
    topCodes: (facet?.topCodes ?? []).map((row: any) => ({
      code: row.code,
      usedCount: row.usedCount ?? 0,
      maxUses: row.maxUses ?? 0,
      active: Boolean(row.active),
    })),
    recentUses: (facet?.recentUses ?? []).map((row: any) => ({
      code: row.code,
      username: row.username || "",
      email: row.email || "",
      usedAt: row.usedAt ? new Date(row.usedAt).toISOString() : "",
    })),
    trend: (facet?.trend ?? []).map((row: any) => ({ date: row._id, uses: row.uses ?? 0 })),
  };
}

/** IN-4：批量停用/启用，避免一次操作发 N 个请求。 */
export async function bulkSetRegistrationInvitesActive(
  ids: string[],
  active: boolean,
): Promise<{ matched: number; modified: number }> {
  const safeIds = ids
    .filter((id) => typeof id === "string" && id.trim() && mongoose.isValidObjectId(id))
    .slice(0, 500);
  if (safeIds.length === 0) throw new Error("未提供有效的邀请码 ID");
  const result = await RegistrationInviteModel.updateMany(
    { _id: { $in: safeIds } },
    { $set: { active: Boolean(active) } },
  ).exec();
  return {
    matched: result.matchedCount ?? 0,
    modified: result.modifiedCount ?? 0,
  };
}

/** IN-4：批量删除。 */
export async function bulkDeleteRegistrationInvites(ids: string[]): Promise<{ deleted: number }> {
  const safeIds = ids
    .filter((id) => typeof id === "string" && id.trim() && mongoose.isValidObjectId(id))
    .slice(0, 500);
  if (safeIds.length === 0) throw new Error("未提供有效的邀请码 ID");
  const result = await RegistrationInviteModel.deleteMany({ _id: { $in: safeIds } }).exec();
  return { deleted: result.deletedCount ?? 0 };
}

export async function createRegistrationInvite(
  input: { code?: unknown; note?: unknown; maxUses?: unknown; active?: unknown; expiresAt?: unknown },
  actor: InviteActor,
): Promise<RegistrationInviteSummary> {
  const code = normalizeInviteCode(input.code) || generateInviteCode();
  if (!CODE_PATTERN.test(code)) {
    throw new Error("邀请码只能包含 4-32 位大写字母、数字、下划线或短横线");
  }

  const existing = await RegistrationInviteModel.findOne({ code: { $eq: code } }).lean().exec();
  if (existing) {
    throw new Error("邀请码已存在");
  }

  const invite = await RegistrationInviteModel.create({
    code,
    note: typeof input.note === "string" ? input.note.trim().slice(0, 200) : "",
    active: input.active === undefined ? true : Boolean(input.active),
    maxUses: parsePositiveInteger(input.maxUses, 1),
    usedCount: 0,
    usedBy: [],
    createdBy: actor.id,
    createdByUsername: actor.username,
    expiresAt: parseExpiry(input.expiresAt),
  });

  return toSummary(invite as any);
}

export async function updateRegistrationInvite(
  id: string,
  input: { note?: unknown; maxUses?: unknown; active?: unknown; expiresAt?: unknown },
): Promise<RegistrationInviteSummary | null> {
  const invite = await RegistrationInviteModel.findById(id).exec();
  if (!invite) return null;

  if (input.note !== undefined) {
    invite.note = typeof input.note === "string" ? input.note.trim().slice(0, 200) : "";
  }
  if (input.active !== undefined) {
    invite.active = Boolean(input.active);
  }
  if (input.maxUses !== undefined) {
    const nextMaxUses = parsePositiveInteger(input.maxUses, invite.maxUses);
    if (nextMaxUses < invite.usedCount) {
      throw new Error("最大使用次数不能小于已使用次数");
    }
    invite.maxUses = nextMaxUses;
  }
  if (Object.prototype.hasOwnProperty.call(input, "expiresAt")) {
    invite.expiresAt = parseExpiry(input.expiresAt);
  }

  await invite.save();
  return toSummary(invite as any);
}

export async function deleteRegistrationInvite(id: string): Promise<boolean> {
  const result = await RegistrationInviteModel.deleteOne({ _id: id }).exec();
  return result.deletedCount === 1;
}

export async function validateRegistrationInviteForRegistration(codeInput: unknown): Promise<{
  ok: boolean;
  code?: string;
  error?: string;
}> {
  const code = normalizeInviteCode(codeInput);
  if (!code) {
    return isRegistrationInviteRequired() ? { ok: false, error: "请填写邀请码" } : { ok: true };
  }
  if (!CODE_PATTERN.test(code)) {
    return { ok: false, error: "邀请码格式不正确" };
  }

  const invite = await RegistrationInviteModel.findOne({ code: { $eq: code } }).lean().exec();
  if (!invite) return { ok: false, error: "邀请码不存在或已失效" };
  if (!invite.active) return { ok: false, error: "邀请码已停用" };
  if (isExpired(invite as any)) return { ok: false, error: "邀请码已过期" };
  if (invite.usedCount >= invite.maxUses) return { ok: false, error: "邀请码使用次数已用完" };

  return { ok: true, code };
}

export async function consumeRegistrationInvite(
  codeInput: unknown,
  user: ConsumeInviteUser,
): Promise<{ ok: boolean; error?: string }> {
  const validation = await validateRegistrationInviteForRegistration(codeInput);
  if (!validation.ok || !validation.code) {
    return { ok: validation.ok, error: validation.error };
  }

  const now = new Date();
  const result = await RegistrationInviteModel.updateOne(
    {
      code: { $eq: validation.code },
      active: true,
      $expr: { $lt: ["$usedCount", "$maxUses"] },
      $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }, { expiresAt: { $exists: false } }],
    },
    {
      $inc: { usedCount: 1 },
      $push: {
        usedBy: {
          userId: user.id,
          username: user.username,
          email: user.email,
          usedAt: now,
          ipAddress: String(user.ipAddress || "").slice(0, 128),
          fingerprint: String(user.fingerprint || "").slice(0, 512),
        },
      },
    },
  ).exec();

  if (result.modifiedCount !== 1) {
    return { ok: false, error: "邀请码已失效或使用次数已用完" };
  }

  return { ok: true };
}
