import { type ILegalHold, LegalHoldModel, type LegalHoldScope } from "../models/legalHoldModel";
import { mongoose } from "./mongoService";
import logger from "../utils/logger";

/**
 * 法律保留服务（RC-22 / 裁决三）。
 *
 * 只做两件事，但两件都必须**fail-closed**：
 * 1. 查询「某对象是否被 hold」——**库不可用时按“疑似被 hold”上报**（`unknown: true`），
 *    由调用方决定拒绝删除。物理删除是不可逆的，宁可因为抖动拒绝一次删除、让人工重试，
 *    也不能在库读不到的时候把证据删掉；
 * 2. 创建/解除 hold —— 都要留痕（调用方负责写审计，服务只负责数据）；
 *
 * 结果带短期进程缓存（默认 30 秒）：删除路径通常是批量的，逐条查库会把清理任务拖慢；
 * 30 秒的窗口对“人工发起的法律保留”完全可以接受（它不是秒级生效的强约束）。
 */

const HOLD_CACHE_TTL_MS = 30_000;
const HOLD_CACHE_MAX_ENTRIES = 5_000;

interface HoldCacheEntry {
  held: boolean;
  expiresAt: number;
}

const holdCache = new Map<string, HoldCacheEntry>();

export interface LegalHoldCheck {
  held: boolean;
  /** 命中的 hold（用于告警里说明“被哪个案件挡住”）。 */
  hold?: ILegalHold;
  /** 无法判定（库不可用）：调用方应视为“疑似被 hold”，拒绝物理删除。 */
  unknown: boolean;
}

function cacheKey(scope: LegalHoldScope, value: string): string {
  return `${scope}:${value}`;
}

function mongoReady(): boolean {
  return mongoose.connection.readyState === 1;
}

/** 检查单个对象；`unknown: true` 表示没读到结论（fail-closed 由调用方落实）。 */
export async function checkLegalHold(scope: LegalHoldScope, value: string): Promise<LegalHoldCheck> {
  const normalized = String(value || "").trim();
  if (!normalized) return { held: false, unknown: false };

  const key = cacheKey(scope, normalized);
  const cached = holdCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.held ? { held: true, unknown: false } : { held: false, unknown: false };
  }

  if (!mongoReady()) {
    // 不写缓存：库不可用是瞬时状态，缓存“未 hold”会让后续 30 秒继续放行删除。
    return { held: true, unknown: true };
  }

  try {
    const hold = (await LegalHoldModel.findOne({
      scope,
      value: normalized,
      releasedAt: null,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
    })
      .lean()
      .exec()) as ILegalHold | null;

    if (holdCache.size >= HOLD_CACHE_MAX_ENTRIES) holdCache.clear();
    holdCache.set(key, { held: Boolean(hold), expiresAt: Date.now() + HOLD_CACHE_TTL_MS });
    return hold ? { held: true, hold, unknown: false } : { held: false, unknown: false };
  } catch (error) {
    logger.error("[LegalHold] 查询失败，按“疑似被保留”处理（拒绝物理删除）", {
      scope,
      value: normalized,
      error: error instanceof Error ? error.message : String(error),
    });
    return { held: true, unknown: true };
  }
}

/**
 * 批量检查：任一所给维度命中即返回命中项。删除路径通常同时持有
 * `userId` / `ipAddress` / `fingerprint` 三份标识，逐个查即可（有缓存，成本可控）。
 */
export async function checkAnyLegalHold(identifiers: {
  userId?: string;
  ipAddress?: string;
  fingerprint?: string;
}): Promise<LegalHoldCheck> {
  const checks: Array<Promise<LegalHoldCheck>> = [];
  if (identifiers.userId) checks.push(checkLegalHold("user", identifiers.userId));
  if (identifiers.ipAddress) checks.push(checkLegalHold("ip", identifiers.ipAddress));
  if (identifiers.fingerprint) checks.push(checkLegalHold("fingerprint", identifiers.fingerprint));

  const results = await Promise.all(checks);
  const hit = results.find((result) => result.held);
  return hit ?? { held: false, unknown: false };
}

export async function createLegalHold(input: {
  scope: LegalHoldScope;
  value: string;
  caseRef: string;
  reason?: string;
  issuedBy: string;
  expiresAt?: Date | null;
}): Promise<ILegalHold | null> {
  if (!mongoReady()) throw new Error("数据库不可用，无法登记法律保留");
  const doc = await LegalHoldModel.create({
    scope: input.scope,
    value: String(input.value).trim(),
    caseRef: input.caseRef,
    reason: input.reason || "",
    issuedBy: input.issuedBy,
    issuedAt: new Date(),
    expiresAt: input.expiresAt ?? null,
    releasedBy: null,
    releasedAt: null,
    releaseReason: "",
  });
  holdCache.delete(cacheKey(input.scope, String(input.value).trim()));
  logger.warn("[LegalHold] 已登记法律保留（禁止物理删除）", {
    scope: input.scope,
    caseRef: input.caseRef,
    issuedBy: input.issuedBy,
  });
  return (typeof (doc as unknown as { toObject?: () => ILegalHold }).toObject === "function"
    ? (doc as unknown as { toObject: () => ILegalHold }).toObject()
    : (doc as unknown as ILegalHold)) as ILegalHold;
}

export async function releaseLegalHold(input: {
  scope: LegalHoldScope;
  value: string;
  releasedBy: string;
  releaseReason?: string;
}): Promise<number> {
  if (!mongoReady()) throw new Error("数据库不可用，无法解除法律保留");
  const result = await LegalHoldModel.updateMany(
    { scope: input.scope, value: String(input.value).trim(), releasedAt: null },
    { $set: { releasedBy: input.releasedBy, releasedAt: new Date(), releaseReason: input.releaseReason || "" } },
  );
  holdCache.delete(cacheKey(input.scope, String(input.value).trim()));
  logger.warn("[LegalHold] 已解除法律保留", {
    scope: input.scope,
    releasedBy: input.releasedBy,
    modified: result.modifiedCount,
  });
  return result.modifiedCount;
}

export async function listLegalHolds(options: { includeReleased?: boolean } = {}): Promise<ILegalHold[]> {
  if (!mongoReady()) return [];
  const filter = options.includeReleased ? {} : { releasedAt: null };
  return (await LegalHoldModel.find(filter).sort({ issuedAt: -1 }).limit(500).lean().exec()) as ILegalHold[];
}

/** 仅供测试：清空进程内缓存。 */
export function resetLegalHoldCacheForTests(): void {
  holdCache.clear();
}
