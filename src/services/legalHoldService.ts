import { randomUUID } from "node:crypto";
import { type ILegalHold, LegalHoldModel, type LegalHoldScope } from "../models/legalHoldModel";
import { ForensicAuditLogModel } from "../models/forensicAuditModel";
import { AuditLogService } from "./auditLogService";
import { mongoose } from "./mongoService";
import logger from "../utils/logger";

/**
 * 法律保留服务（RC-22 / 裁决三）。
 *
 * 只做两件事，但两件都必须**fail-closed**：
 * 1. 查询「某对象是否被 hold」——**库不可用时按“疑似被 hold”上报**（`unknown: true`），
 *    由调用方决定拒绝删除。物理删除是不可逆的，宁可因为抖动拒绝一次删除、让人工重试，
 *    也不能在库读不到的时候把证据删掉；
 * 2. 创建/解除 hold —— 都要留痕：服务层负责写普通审计与不设 TTL 的取证审计
 *    （RC-35；管理端可传入请求上下文，内部调用以操作者用户名留痕）；
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

/**
 * 审计上下文：管理端会把请求 IP/UA/路径传进来；脚本或 Pixel 保全这类内部调用
 * 可以省略，此时仍会以 `issuedBy` / `releasedBy` 作为操作者留痕（ip 记 unknown）。
 */
export interface LegalHoldAuditContext {
  actorId?: string;
  actorUsername?: string;
  actorRole?: string;
  ip?: string;
  userAgent?: string;
  path?: string;
  method?: string;
}

export interface LegalHoldCheck {
  held: boolean;
  /** 命中的 hold（用于告警里说明“被哪个案件挡住”）。 */
  hold?: ILegalHold;
  /** 无法判定（库不可用）：调用方应视为“疑似被 hold”，拒绝物理删除。 */
  unknown: boolean;
}

/**
 * 校验类错误：带稳定 code 与 HTTP 状态，管理端直接映射成响应。
 *
 * 为什么服务层也管 code：登记/解除 hold 是**法律动作**，失败原因必须能被前端
 * 与调用方分辨（缺案件编号 vs 缺理由 vs 案件对不上），而不是一句 “请求失败”。
 */
export class LegalHoldValidationError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "LegalHoldValidationError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function normalizeScope(scope: unknown): LegalHoldScope {
  if (scope === "user" || scope === "ip" || scope === "fingerprint") return scope;
  throw new LegalHoldValidationError("LEGAL_HOLD_SCOPE_INVALID", "保留范围只支持 user / ip / fingerprint");
}

function requireNonEmpty(value: unknown, code: string, message: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new LegalHoldValidationError(code, message);
  return normalized;
}

function cacheKey(scope: LegalHoldScope, value: string): string {
  return `${scope}:${value}`;
}

function mongoReady(): boolean {
  return mongoose.connection.readyState === 1;
}

/** 检查单个对象；`unknown: true` 表示没读到结论（fail-closed 由调用方落实）。 */
export async function checkLegalHold(scope: LegalHoldScope, value: string): Promise<LegalHoldCheck> {
  // 运行期收窄：scope 在类型上是枚举，但调用链上可能来自请求参数。不收窄时
  // `{$ne: null}` 这类对象会被 Mongo 当成查询操作符（NoSQL 注入）。
  if (scope !== "user" && scope !== "ip" && scope !== "fingerprint") {
    return { held: true, unknown: true };
  }
  // `String()` 同样是为了把「对象形态的注入载荷」压成字符串后再进查询。
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
    // 显式 `$eq`：等值过滤写成 Mongo 操作符而不是裸值，形状固定为「字符串等值」，
    // 无论调用方传入什么都不会被解析成查询操作符（NoSQL 注入面）。
    const hold = (await LegalHoldModel.findOne({
      scope: { $eq: scope },
      value: { $eq: normalized },
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

/**
 * RC-35：legal_holds 的**每一次增删**都必须同时落普通审计与不设 TTL 的取证集合。
 *
 * 为什么写在服务层而不是控制器：Pixel 保全（`pixel/evidenceHoldService`）也会创建/解除
 * 法律保留，只在管理端控制器写会漏掉那条路径。服务层写入没有 Express 上下文，
 * 因此管理端通过 `audit` 参数补充 IP/UA/路径；内部调用仍以操作者用户名留痕。
 */
async function recordLegalHoldAudit(
  action: string,
  hold: ILegalHold,
  context?: LegalHoldAuditContext,
  detail?: Record<string, unknown>,
): Promise<void> {
  const actorId = context?.actorId || hold.issuedBy || "unknown";
  const actorUsername = context?.actorUsername || hold.issuedBy || "unknown";
  const actorRole = context?.actorRole || "unknown";
  const ip = context?.ip || "unknown";
  const path = context?.path;
  const method = context?.method;

  try {
    await AuditLogService.log({
      userId: actorId,
      username: actorUsername,
      role: actorRole,
      action,
      module: "security",
      targetId: hold.value,
      targetName: hold.caseRef,
      result: "success",
      detail: { scope: hold.scope, caseRef: hold.caseRef, reason: hold.reason, ...detail },
      ip,
      userAgent: context?.userAgent,
      path,
      method,
    });
  } catch (error) {
    logger.error("[LegalHold] 普通审计写入失败", {
      action,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    await ForensicAuditLogModel.create({
      eventId: `fev_${randomUUID()}`,
      action,
      actorId,
      actorUsername,
      actorRole,
      caseRef: hold.caseRef,
      scope: hold.scope,
      subjectValue: hold.value,
      reason: hold.reason,
      targetIds: [String(hold._id ?? "")],
      detail,
      ip,
      userAgent: context?.userAgent,
      path,
      method,
      createdAt: new Date(),
    });
  } catch (error) {
    logger.error("[LegalHold] 取证审计写入失败（不可静默）", {
      action,
      caseRef: hold.caseRef,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function createLegalHold(input: {
  scope: LegalHoldScope;
  value: string;
  caseRef: string;
  reason?: string;
  issuedBy: string;
  expiresAt?: Date | null;
  audit?: LegalHoldAuditContext;
}): Promise<ILegalHold | null> {
  if (!mongoReady()) throw new Error("数据库不可用，无法登记法律保留");
  const scope = normalizeScope(input.scope);
  const value = requireNonEmpty(input.value, "LEGAL_HOLD_VALUE_REQUIRED", "请填写要保留的对象（用户 ID / IP / 指纹）");
  const caseRef = requireNonEmpty(
    input.caseRef,
    "LEGAL_HOLD_CASE_REQUIRED",
    "请填写案件编号，否则之后无法说明为什么保留了这些数据",
  );
  // RC-22：登记也必须写理由 —— 调查期结束后，他人要能仅凭记录判断这次保留是否仍然成立。
  const reason = requireNonEmpty(
    input.reason,
    "LEGAL_HOLD_REASON_REQUIRED",
    "请填写保留理由（法律依据 / 文书编号 / 用户授权）",
  );

  if (input.expiresAt && Number.isNaN(new Date(input.expiresAt).getTime())) {
    throw new LegalHoldValidationError("LEGAL_HOLD_EXPIRES_INVALID", "保留到期时间格式不正确");
  }

  // 同一对象、同一案件重复登记是运维常见操作（重试/多人操作），按幂等处理：
  // 返回既有 hold，而不是堆出两条“都在生效”的记录让解除时只解除一半。
  // 同样用显式 `$eq`：三处校验（normalizeScope / requireNonEmpty）负责语义，
  // `$eq` 负责让「这是字符串等值过滤」在查询结构上成立。
  const existing = (await LegalHoldModel.findOne({
    scope: { $eq: scope },
    value: { $eq: value },
    caseRef: { $eq: caseRef },
    releasedAt: null,
  })
    .lean()
    .exec()) as ILegalHold | null;
  if (existing) return existing;

  const doc = await LegalHoldModel.create({
    scope,
    value,
    caseRef,
    reason,
    issuedBy: input.issuedBy,
    issuedAt: new Date(),
    expiresAt: input.expiresAt ?? null,
    releasedBy: null,
    releasedAt: null,
    releaseReason: "",
  });
  holdCache.delete(cacheKey(scope, value));
  logger.warn("[LegalHold] 已登记法律保留（禁止物理删除）", {
    scope,
    caseRef,
    issuedBy: input.issuedBy,
  });
  const created = (typeof (doc as unknown as { toObject?: () => ILegalHold }).toObject === "function"
    ? (doc as unknown as { toObject: () => ILegalHold }).toObject()
    : (doc as unknown as ILegalHold)) as ILegalHold;
  await recordLegalHoldAudit("legal_hold.create", created, input.audit, {
    expiresAt: created.expiresAt ? new Date(created.expiresAt).toISOString() : null,
  });
  return created;
}

export async function releaseLegalHold(input: {
  scope: LegalHoldScope;
  value: string;
  releasedBy: string;
  releaseReason?: string;
  audit?: LegalHoldAuditContext;
}): Promise<number> {
  if (!mongoReady()) throw new Error("数据库不可用，无法解除法律保留");
  // 先取出生效中的记录：解除后 `releasedAt` 已写入，事后无法再按“当时生效”的
  // 案件编号留痕；法律动作必须在写路径上完成审计，而不是事后补偿。
  // 值先压成字符串再进查询：即便调用方误传了对象形态的载荷，也只会被当作普通字符串比较。
  const releaseScope = String(input.scope ?? "");
  const releaseValue = String(input.value ?? "").trim();
  const activeHolds = (await LegalHoldModel.find({
    scope: { $eq: releaseScope },
    value: { $eq: releaseValue },
    releasedAt: null,
  })
    .lean()
    .exec()) as ILegalHold[];
  const result = await LegalHoldModel.updateMany(
    { scope: { $eq: releaseScope }, value: { $eq: releaseValue }, releasedAt: null },
    { $set: { releasedBy: input.releasedBy, releasedAt: new Date(), releaseReason: input.releaseReason || "" } },
  );
  holdCache.delete(cacheKey(releaseScope, releaseValue));
  logger.warn("[LegalHold] 已解除法律保留", {
    scope: input.scope,
    releasedBy: input.releasedBy,
    modified: result.modifiedCount,
  });
  for (const hold of activeHolds) {
    await recordLegalHoldAudit(
      "legal_hold.release",
      {
        ...hold,
        releasedBy: input.releasedBy,
        releasedAt: new Date(),
        releaseReason: input.releaseReason || "",
      },
      input.audit ?? { actorUsername: input.releasedBy },
      { modified: result.modifiedCount },
    );
  }
  return result.modifiedCount;
}

/**
 * 管理端解除：按 hold id + 案件编号双重定位。
 *
 * 为什么不能只按 scope/value：同一对象可能同时被多个案件 hold，按 scope/value 解除会把
 * 其它案件的 hold 一起放掉。案件编号必须与记录一致，防止「点错行解除错案件」。
 */
export async function releaseLegalHoldById(input: {
  holdId: string;
  caseRef: string;
  releasedBy: string;
  releaseReason: string;
  audit?: LegalHoldAuditContext;
}): Promise<ILegalHold | null> {
  if (!mongoReady()) throw new Error("数据库不可用，无法解除法律保留");
  const holdId = requireNonEmpty(input.holdId, "LEGAL_HOLD_ID_REQUIRED", "缺少要解除的保留记录");
  const caseRef = requireNonEmpty(input.caseRef, "LEGAL_HOLD_CASE_REQUIRED", "请填写案件编号");
  const releaseReason = requireNonEmpty(
    input.releaseReason,
    "LEGAL_HOLD_RELEASE_REASON_REQUIRED",
    "请填写解除理由，否则之后无法说明为什么不再保留",
  );

  const existing = (await LegalHoldModel.findById(holdId).lean().exec()) as ILegalHold | null;
  if (!existing) throw new LegalHoldValidationError("LEGAL_HOLD_NOT_FOUND", "保留记录不存在", 404);
  if (existing.releasedAt) return existing;
  if (existing.caseRef !== caseRef) {
    throw new LegalHoldValidationError(
      "LEGAL_HOLD_CASE_MISMATCH",
      "案件编号与保留记录不一致，已拒绝解除",
      409,
    );
  }

  const updated = (await LegalHoldModel.findOneAndUpdate(
    { _id: holdId, releasedAt: null, caseRef },
    {
      $set: {
        releasedBy: input.releasedBy,
        releasedAt: new Date(),
        releaseReason,
      },
    },
    { new: true },
  )
    .lean()
    .exec()) as ILegalHold | null;

  holdCache.delete(cacheKey(existing.scope, existing.value));
  logger.warn("[LegalHold] 已由管理端解除法律保留", {
    holdId,
    caseRef,
    releasedBy: input.releasedBy,
  });
  const released = updated ?? {
    ...existing,
    releasedBy: input.releasedBy,
    releasedAt: new Date(),
    releaseReason,
  };
  await recordLegalHoldAudit(
    "legal_hold.release",
    released,
    input.audit ?? { actorUsername: input.releasedBy },
    { holdId },
  );
  return updated;
}

export async function listLegalHolds(options: { includeReleased?: boolean } = {}): Promise<ILegalHold[]> {
  if (!mongoReady()) return [];
  const filter = options.includeReleased ? {} : { releasedAt: null };
  // codeql[js/sql-injection] filter 的输入是已解除的 hold 对象（来自库），不是请求参数。
  return (await LegalHoldModel.find(filter).sort({ issuedAt: -1 }).limit(500).lean().exec()) as ILegalHold[];
}

export interface LegalHoldListCursor {
  issuedAt: number;
  id: string;
}

export function encodeLegalHoldCursor(hold: ILegalHold): string {
  const issuedAt = hold.issuedAt instanceof Date ? hold.issuedAt.getTime() : new Date(hold.issuedAt).getTime();
  return Buffer.from(JSON.stringify({ issuedAt, id: String(hold._id ?? "") }), "utf8").toString("base64url");
}

export function parseLegalHoldCursor(raw: unknown): LegalHoldListCursor | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Record<string, unknown>;
    const issuedAt = Number(parsed.issuedAt);
    const id = typeof parsed.id === "string" ? parsed.id : "";
    if (!Number.isFinite(issuedAt) || !id) return null;
    return { issuedAt, id };
  } catch {
    return null;
  }
}

/**
 * 游标分页（RC-58）：管理端列表不允许“整表一把拉”。
 * 排序键是 (issuedAt, _id) —— 只按 issuedAt 会在同一秒批量登记时丢行/重复。
 */
export async function listLegalHoldsPage(options: {
  includeReleased?: boolean;
  scope?: LegalHoldScope;
  caseRef?: string;
  limit?: number;
  cursor?: string;
} = {}): Promise<{ holds: ILegalHold[]; nextCursor: string | null; limit: number }> {
  const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 50) || 50), 200);
  if (!mongoReady()) return { holds: [], nextCursor: null, limit };

  const filter: Record<string, unknown> = options.includeReleased ? {} : { releasedAt: null };
  // 两个过滤值都可能直接来自查询串：先收窄成「白名单枚举」与「定长字符串」再进查询，
  // 否则 `?scope[$ne]=x` 解析出的对象会被 Mongo 当作操作符执行（NoSQL 注入）。
  // 白名单收窄写成内联比较（而不是自定义函数）：静态分析能直接看见「只有三个字面量
  // 能进入过滤条件」，`$eq` 再把值固定成字符串等值语义。
  if (options.scope === "user" || options.scope === "ip" || options.scope === "fingerprint") {
    filter.scope = { $eq: options.scope };
  }
  const caseRef = typeof options.caseRef === "string" ? options.caseRef.trim().slice(0, 200) : "";
  if (caseRef) filter.caseRef = { $eq: caseRef };

  const cursor = parseLegalHoldCursor(options.cursor);
  if (cursor) {
    filter.$or = [
      { issuedAt: { $lt: new Date(cursor.issuedAt) } },
      { issuedAt: new Date(cursor.issuedAt), _id: { $lt: cursor.id } },
    ];
  }

  const rows = (await LegalHoldModel.find(filter)
    .sort({ issuedAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean()
    .exec()) as ILegalHold[];
  const hasMore = rows.length > limit;
  const holds = hasMore ? rows.slice(0, limit) : rows;
  const last = holds[holds.length - 1];
  return {
    holds,
    nextCursor: hasMore && last ? encodeLegalHoldCursor(last) : null,
    limit,
  };
}

/** 仅供测试：清空进程内缓存。 */
export function resetLegalHoldCacheForTests(): void {
  holdCache.clear();
}
