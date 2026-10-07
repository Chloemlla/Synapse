import crypto from "node:crypto";
import dayjs from "dayjs";
import { mongoose } from "./mongoService";
import { RuntimeConfigService } from "./runtimeConfigService";
import logger from "../utils/logger";

interface ReservationEntry {
  count: number;
  minuteStart: number;
}

interface QuotaLedger {
  _id: string;
  used: number;
  resetAt: Date;
  minuteStart: number;
  minuteUsed: number;
  reservations: Record<string, ReservationEntry>;
}

const quotaLedgerSchema = new mongoose.Schema<QuotaLedger>(
  {
    _id: { type: String, required: true },
    used: { type: Number, required: true },
    resetAt: { type: Date, required: true },
    minuteStart: { type: Number, required: true },
    minuteUsed: { type: Number, required: true },
    reservations: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { collection: "email_quota_ledgers", versionKey: false },
);
const QuotaLedgerModel =
  (mongoose.models.EmailQuotaLedger as mongoose.Model<QuotaLedger>) ||
  mongoose.model<QuotaLedger>("EmailQuotaLedger", quotaLedgerSchema);

interface LegacyUserQuota {
  userId: string;
  domain: string;
  used?: number;
  resetAt?: string;
}
interface LegacyOutEmailQuota {
  date: string;
  minute?: string;
  countDay?: number;
  countMinute?: number;
}
const LegacyUserQuotaModel =
  (mongoose.models.LegacyEmailQuota as mongoose.Model<LegacyUserQuota>) ||
  mongoose.model<LegacyUserQuota>("LegacyEmailQuota", new mongoose.Schema<LegacyUserQuota>(
    { userId: String, domain: String, used: Number, resetAt: String },
    { collection: "email_quotas", versionKey: false },
  ));
const LegacyOutEmailQuotaModel =
  (mongoose.models.LegacyOutEmailQuota as mongoose.Model<LegacyOutEmailQuota>) ||
  mongoose.model<LegacyOutEmailQuota>("LegacyOutEmailQuota", new mongoose.Schema<LegacyOutEmailQuota>(
    { date: String, minute: String, countDay: Number, countMinute: Number },
    { collection: "outemail_quotas", versionKey: false },
  ));

export interface EmailQuotaInfo {
  used: number;
  total: number;
  resetAt: string;
}

export interface EmailQuotaReservation {
  id: string;
  ledgerId: string;
  resetAt: string;
  count: number;
}

export type EmailQuotaResult =
  | { success: true; quotaTotal: number; reservation: EmailQuotaReservation }
  | { success: false; quotaTotal: number; reason: "exhausted" | "rate_limited" | "unavailable" | "invalid"; retryAfterSeconds?: number };

export class EmailQuotaUnavailableError extends Error {
  readonly code = "EMAIL_SERVICE_UNAVAILABLE";
  constructor() {
    super("邮件额度暂时无法查询，请稍后重试");
    this.name = "EmailQuotaUnavailableError";
  }
}

function currentLimits(isPublic: boolean) {
  const email = RuntimeConfigService.getCachedConfig().email;
  return isPublic ? email.outemailQuotaTotal : email.quotaTotal;
}

function ledgerIdForUser(userId: string): string {
  return `user:${crypto.createHash("sha256").update(userId).digest("hex")}`;
}

function safeUsage(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.ceil(value)) : 0;
}

function assertAvailable() {
  if (mongoose.connection.readyState !== 1) throw new EmailQuotaUnavailableError();
}

/**
 * First access copies all unexpired legacy domain buckets into one deterministic ledger.
 * The old collections remain untouched for audit. Concurrent initializers race on _id,
 * so exactly one snapshot wins; every new reader/writer then uses that same document.
 */
async function ensureLedger(ledgerId: string, userId?: string): Promise<QuotaLedger> {
  assertAvailable();
  const existing = await QuotaLedgerModel.findById(ledgerId).lean().exec();
  if (existing) return existing;
  const now = dayjs();
  const minuteStart = now.startOf("minute").valueOf();
  let used = 0;
  let minuteUsed = 0;
  let resetAt = now.add(1, "day").startOf("day").toDate();
  if (userId !== undefined) {
    const legacy = await LegacyUserQuotaModel.find({ userId, domain: { $ne: "verification" } }).lean().exec();
    for (const row of legacy) {
      const oldReset = row.resetAt ? new Date(row.resetAt) : null;
      // A malformed historic expiry used to never expire: preserve its usage for today.
      if (!oldReset || !Number.isFinite(oldReset.getTime()) || oldReset.getTime() > now.valueOf()) {
        used += safeUsage(row.used);
        if (oldReset && Number.isFinite(oldReset.getTime()) && oldReset > resetAt) resetAt = oldReset;
      }
    }
  } else {
    const legacy = await LegacyOutEmailQuotaModel.find({ date: now.format("YYYY-MM-DD") }).lean().exec();
    for (const row of legacy) {
      used += safeUsage(row.countDay);
      if (row.minute === now.format("YYYY-MM-DD-HH-mm")) minuteUsed += safeUsage(row.countMinute);
    }
  }
  try {
    const ledger = await QuotaLedgerModel.findOneAndUpdate(
      { _id: ledgerId },
      { $setOnInsert: { used, resetAt, minuteStart, minuteUsed, reservations: {} } },
      { upsert: true, returnDocument: "after" },
    ).lean().exec();
    if (ledger) return ledger;
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    const winner = await QuotaLedgerModel.findById(ledgerId).lean().exec();
    if (winner) return winner;
  }
  throw new EmailQuotaUnavailableError();
}

async function readQuota(ledgerId: string, isPublic: boolean, userId?: string): Promise<EmailQuotaInfo & { quotaTotal: number }> {
  try {
    const ledger = await ensureLedger(ledgerId, userId);
    const now = dayjs();
    const expired = ledger.resetAt.getTime() <= now.valueOf();
    const total = currentLimits(isPublic);
    return {
      used: expired ? 0 : ledger.used,
      total,
      quotaTotal: total,
      resetAt: expired ? now.add(1, "day").startOf("day").toISOString() : ledger.resetAt.toISOString(),
    };
  } catch (error) {
    logger.error("[EmailQuota] 查询失败", { error });
    throw new EmailQuotaUnavailableError();
  }
}

// Domain is retained for source compatibility; sender selection must not create another user allowance.
export async function getEmailQuota(userId: string, _domain?: string) {
  if (typeof userId !== "string" || !userId.trim()) throw new EmailQuotaUnavailableError();
  return readQuota(ledgerIdForUser(userId), false, userId);
}

export async function getPublicEmailQuota() {
  return readQuota("public:outemail", true);
}

async function reserve(ledgerId: string, count: number, isPublic: boolean, userId?: string): Promise<EmailQuotaResult> {
  const quotaTotal = currentLimits(isPublic);
  if (!Number.isSafeInteger(count) || count <= 0) return { success: false, quotaTotal, reason: "invalid" };
  if (count > quotaTotal) return { success: false, quotaTotal, reason: "exhausted" };
  if (isPublic && count > 20) return { success: false, quotaTotal, reason: "rate_limited", retryAfterSeconds: 60 };
  try {
    await ensureLedger(ledgerId, userId);
    const now = dayjs();
    const minuteStart = now.startOf("minute").valueOf();
    const resetAt = now.add(1, "day").startOf("day").toDate();
    const expired = { $lte: ["$resetAt", now.toDate()] };
    const minuteExpired = { $or: [expired, { $lt: ["$minuteStart", minuteStart] }] };
    const effectiveUsed = { $cond: [expired, 0, "$used"] };
    const effectiveMinuteUsed = { $cond: [minuteExpired, 0, "$minuteUsed"] };
    const effectiveMinuteStart = { $cond: [minuteExpired, minuteStart, "$minuteStart"] };
    const id = crypto.randomUUID().replace(/-/g, "");
    const conditions: object[] = [{ $lte: [effectiveUsed, quotaTotal - count] }];
    if (isPublic) conditions.push({ $lte: [effectiveMinuteUsed, 20 - count] });
    const updated = await QuotaLedgerModel.findOneAndUpdate(
      { _id: ledgerId, $expr: { $and: conditions } },
      [{ $set: {
        used: { $add: [effectiveUsed, count] },
        resetAt: { $cond: [expired, resetAt, "$resetAt"] },
        minuteStart: effectiveMinuteStart,
        minuteUsed: { $add: [effectiveMinuteUsed, isPublic ? count : 0] },
        reservations: { $mergeObjects: [
          { $cond: [expired, {}, "$reservations"] },
          { [id]: { count, minuteStart: effectiveMinuteStart } },
        ] },
      } }],
      { returnDocument: "after", updatePipeline: true },
    ).lean().exec();
    if (updated) {
      return { success: true, quotaTotal, reservation: { id, ledgerId, count, resetAt: updated.resetAt.toISOString() } };
    }
    const current = await QuotaLedgerModel.findById(ledgerId).lean().exec();
    if (!current) throw new EmailQuotaUnavailableError();
    const remaining = current.resetAt.getTime() <= now.valueOf() ? quotaTotal : quotaTotal - current.used;
    if (remaining < count) {
      return { success: false, quotaTotal, reason: "exhausted", retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt.getTime() - now.valueOf()) / 1000)) };
    }
    return { success: false, quotaTotal, reason: "rate_limited", retryAfterSeconds: Math.max(1, Math.ceil((current.minuteStart + 60_000 - now.valueOf()) / 1000)) };
  } catch (error) {
    logger.error("[EmailQuota] 预留失败", { error });
    return { success: false, quotaTotal, reason: "unavailable" };
  }
}

export async function consumeEmailQuota(userId: string, _domain?: string, count = 1): Promise<EmailQuotaResult> {
  if (typeof userId !== "string" || !userId.trim()) return { success: false, quotaTotal: currentLimits(false), reason: "invalid" };
  return reserve(ledgerIdForUser(userId), count, false, userId);
}

export async function reservePublicEmailQuota(count: number): Promise<EmailQuotaResult> {
  return reserve("public:outemail", count, true);
}

/** Final settlement is atomic and idempotent; deleting the reservation also prevents double refunds. */
export async function settleEmailQuota(reservation: EmailQuotaReservation, acceptedCount: number): Promise<void> {
  if (!reservation || !/^[a-f0-9]{32}$/.test(reservation.id) || !Number.isSafeInteger(acceptedCount) ||
      acceptedCount < 0 || acceptedCount > reservation.count) throw new Error("无效的邮件额度结算");
  try {
    assertAvailable();
    const entryPath = `reservations.${reservation.id}`;
    const refund = reservation.count - acceptedCount;
    await QuotaLedgerModel.updateOne(
      { _id: reservation.ledgerId, resetAt: new Date(reservation.resetAt), [`${entryPath}.count`]: reservation.count },
      [
        { $set: {
          used: { $max: [0, { $subtract: ["$used", refund] }] },
          minuteUsed: { $cond: [
            { $eq: ["$minuteStart", `$${entryPath}.minuteStart`] },
            { $max: [0, { $subtract: ["$minuteUsed", refund] }] },
            "$minuteUsed",
          ] },
        } },
        { $unset: entryPath },
      ],
      { updatePipeline: true },
    ).exec();
  } catch (error) {
    // A storage failure must never turn an accepted provider send into a failed-send response.
    logger.error("[EmailQuota] 结算失败，保留预留以防超额", { reservationId: reservation.id, error });
  }
}

export async function refundEmailQuota(reservation: EmailQuotaReservation): Promise<void> {
  return settleEmailQuota(reservation, 0);
}

export async function resetEmailQuota(userId: string, _domain?: string): Promise<void> {
  const ledgerId = ledgerIdForUser(userId);
  await ensureLedger(ledgerId, userId);
  await QuotaLedgerModel.updateOne({ _id: ledgerId }, { $set: {
    used: 0, resetAt: dayjs().add(1, "day").startOf("day").toDate(), reservations: {}, minuteUsed: 0,
  } }).exec();
}

/** Legacy explicit usage API remains bounded and uses the same reservation/settlement path. */
export async function addEmailUsage(userId: string, count = 1, domain?: string): Promise<void> {
  const result = await consumeEmailQuota(userId, domain, count);
  if (!result.success) throw new Error(result.reason === "exhausted" ? "邮件额度不足" : "邮件额度暂时不可用");
  await settleEmailQuota(result.reservation, count);
}
