import { createHash, randomUUID } from "node:crypto";
import type { Response } from "express";
import type { NextFunction, Request } from "express";
import {
  ForensicAuditLogModel,
  ForensicExportRequestModel,
  type ForensicExportStatus,
  type ForensicSubjectScope,
  type IForensicAuditLog,
  type IForensicExportRequest,
} from "../models/forensicAuditModel";
import { AccountIpSignal } from "../models/accountIpSignalModel";
import { AuditLogModel } from "../models/auditLogModel";
import { DeviceFingerprint } from "../models/deviceFingerprintModel";
import { DeviceTracking } from "../models/deviceTrackingModel";
import { SecurityEvent } from "../models/securityEventModel";
import { AuditLogService, type AuditEntry } from "./auditLogService";
import { mongoose } from "./mongoService";
import logger from "../utils/logger";
import { checkLegalHold, LegalHoldValidationError, type LegalHoldScope } from "./legalHoldService";

/**
 * 取证审计与导出（RC-22 / RC-35 / RC-58 / D10 / D16）。
 *
 * 三条不可退让的边界：
 * 1. **审计不设 TTL**：`forensic_audit_logs` 与 `forensic_export_requests` 都没有 TTL 索引，
 *    调查周期超过 60 天时仍能回答「谁在什么时候导出过什么」；
 * 2. **导出是流式的、有硬顶的**：按 `_id` 游标逐页读（500 行/页），NDJSON 逐片写响应，
 *    超过 `FORENSIC_EXPORT_MAX_ROWS` 时返回 `EXPORT_LIMIT_EXCEEDED` 而**不截断**；
 * 3. **双人确认 + 不能由 API Key 触发**：发起与批准必须是两个不同的 superadmin，
 *    路由层拒绝 `req.apiKey` / `req.oauthToken`，并要求有效安全会话。
 */

export const FORENSIC_EXPORT_MAX_ROWS = 20_000;
export const FORENSIC_EXPORT_PAGE_SIZE = 500;
export const FORENSIC_EXPORT_REQUEST_TTL_MS = 15 * 60 * 1000;
export const EXPORT_LIMIT_EXCEEDED = "EXPORT_LIMIT_EXCEEDED";

export class ForensicExportLimitError extends Error {
  readonly code = EXPORT_LIMIT_EXCEEDED;
  readonly statusCode = 413;
  readonly totalRows: number;
  readonly maxRows: number;
  constructor(totalRows: number, maxRows = FORENSIC_EXPORT_MAX_ROWS) {
    super(
      `单次导出最多 ${maxRows} 行，本次命中 ${totalRows} 行；为避免截断，未导出任何数据。请缩小时间窗或按维度拆分后再试。`,
    );
    this.name = "ForensicExportLimitError";
    this.totalRows = totalRows;
    this.maxRows = maxRows;
  }
}

export class ForensicExportRequestError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "ForensicExportRequestError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface ForensicActor {
  id: string;
  username: string;
  role: string;
}

export interface ForensicRequestMeta {
  ip: string;
  userAgent?: string;
  path?: string;
  method?: string;
}

export interface ForensicEventInput {
  action: string;
  actor: ForensicActor;
  caseRef?: string;
  scope?: ForensicSubjectScope | "";
  subjectValue?: string;
  reason?: string;
  exportRequestId?: string;
  targetIds?: string[];
  detail?: Record<string, unknown>;
  request: ForensicRequestMeta;
}

export interface ForensicExportFilters {
  scope: ForensicSubjectScope;
  value: string;
  from: Date | null;
  to: Date | null;
}

function mongoReady(): boolean {
  return mongoose.connection.readyState === 1;
}

function normalizeScope(scope: unknown): ForensicSubjectScope {
  if (scope === "user" || scope === "ip" || scope === "fingerprint") return scope;
  throw new ForensicExportRequestError("FORENSIC_EXPORT_SCOPE_INVALID", "导出范围只支持 user / ip / fingerprint");
}

function requireText(value: unknown, code: string, message: string): string {
  const text = String(value ?? "").trim();
  if (!text) throw new ForensicExportRequestError(code, message);
  return text;
}

function parseDate(value: unknown): Date | null {
  if (value === undefined || value === null || value === "") return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new ForensicExportRequestError("FORENSIC_EXPORT_DATE_INVALID", "时间窗格式不正确");
  }
  return date;
}

/**
 * 单次导出硬顶。抽成纯函数是为了让 CI 能在不连 Mongo 的情况下钉住「超限不截断」。
 */
export function assertWithinExportCap(totalRows: number, maxRows = FORENSIC_EXPORT_MAX_ROWS): number {
  if (!Number.isFinite(totalRows) || totalRows < 0) {
    throw new ForensicExportRequestError("FORENSIC_EXPORT_COUNT_FAILED", "无法统计导出行数，已拒绝导出", 503);
  }
  if (totalRows > maxRows) throw new ForensicExportLimitError(totalRows, maxRows);
  return totalRows;
}

/**
 * 写一条不设 TTL 的取证事件。**刻意不经过批量缓冲**：法律保留的登记/解除、
 * 导出交付都是低频且必须立刻可查的事件，不能因为进程崩溃丢掉最后一次缓冲。
 */
export async function writeForensicAudit(input: ForensicEventInput): Promise<IForensicAuditLog> {
  if (!mongoReady()) throw new Error("数据库不可用，无法写取证审计");
  const doc = await ForensicAuditLogModel.create({
    eventId: `fev_${randomUUID()}`,
    action: input.action,
    actorId: input.actor.id || "unknown",
    actorUsername: input.actor.username || "unknown",
    actorRole: input.actor.role || "unknown",
    caseRef: input.caseRef || "",
    scope: input.scope || "",
    subjectValue: input.subjectValue || "",
    reason: input.reason || "",
    exportRequestId: input.exportRequestId,
    targetIds: input.targetIds || [],
    detail: input.detail,
    ip: input.request.ip || "unknown",
    userAgent: input.request.userAgent,
    path: input.request.path,
    method: input.request.method,
    createdAt: new Date(),
  });
  return doc as unknown as IForensicAuditLog;
}

/**
 * 双写：普通 `audit_logs`（60 天，供日常面板检索）+ `forensic_audit_logs`（永久，供调查）。
 *
 * 返回是否两条都写成功。调用方（管理端控制器）把失败作为 `auditWarning` 回给操作者，
 * 而不是让「审计写失败」把已经发生的法律动作回滚成假象。
 */
export async function recordForensicEvent(
  input: ForensicEventInput,
): Promise<{ auditLogged: boolean; forensicLogged: boolean }> {
  const entry: AuditEntry = {
    userId: input.actor.id || "unknown",
    username: input.actor.username || "unknown",
    role: input.actor.role || "unknown",
    action: input.action,
    module: input.action.startsWith("forensic_export") ? "privacy" : "security",
    targetId: input.subjectValue,
    targetName: input.caseRef,
    result: "success",
    detail: {
      caseRef: input.caseRef,
      scope: input.scope,
      subjectValue: input.subjectValue,
      reason: input.reason,
      exportRequestId: input.exportRequestId,
      ...input.detail,
    },
    ip: input.request.ip || "unknown",
    userAgent: input.request.userAgent,
    path: input.request.path,
    method: input.request.method,
  };

  let auditLogged = false;
  try {
    await AuditLogService.log(entry);
    auditLogged = true;
  } catch (error) {
    logger.error("[ForensicAudit] 普通审计写入失败", {
      action: input.action,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  let forensicLogged = false;
  try {
    await writeForensicAudit(input);
    forensicLogged = true;
  } catch (error) {
    logger.error("[ForensicAudit] 取证审计写入失败（不可静默）", {
      action: input.action,
      caseRef: input.caseRef,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return { auditLogged, forensicLogged };
}

export interface ForensicExportSource {
  collection: string;
  label: string;
  filter: Record<string, unknown>;
  dateField: string;
  /** 固定字段顺序：调查交付件必须在不同批次间保持同一列序。 */
  fields: readonly string[];
}

const COMMON_LOOKUP_FIELDS = [
  "requestId",
  "userId",
  "username",
  "role",
  "action",
  "module",
  "targetId",
  "targetName",
  "result",
  "detail",
  "ip",
  "path",
  "method",
  "createdAt",
] as const;

const SECURITY_EVENT_FIELDS = [
  "deviceFingerprint",
  "userId",
  "eventType",
  "riskScore",
  "ipAddress",
  "createdAt",
] as const;

const DEVICE_TRACKING_FIELDS = [
  "userId",
  "deviceFingerprint",
  "riskScore",
  "riskLevel",
  "isCompromised",
  "isRoot",
  "isDebugger",
  "isEmulator",
  "isVpn",
  "ipAddress",
  "firstSeen",
  "lastSeen",
] as const;

const IP_SIGNAL_FIELDS = [
  "userId",
  "ipAddress",
  "ipLocation",
  "loginCount",
  "riskScore",
  "riskLevel",
  "flags",
  "isDatacenter",
  "source",
  "firstSeenAt",
  "lastSeenAt",
] as const;

const USER_FIELDS = [
  "id",
  "username",
  "email",
  "role",
  "createdAt",
  "updatedAt",
  "accountStatus",
  "riskTier",
  "riskScore",
  "riskFlags",
  "deletedAt",
  "subjectDeletedAt",
] as const;

const FINGERPRINT_FIELDS = [
  "userId",
  "fingerprintId",
  "componentHashes",
  "previousComponentHashes",
  "firstSeenAt",
  "lastSeenAt",
  "seenCount",
  "driftCount",
  "lastDriftAt",
  "ips",
  "sources",
] as const;

const RISK_CACHE_FIELDS = [
  "ip",
  "risk",
  "proxy",
  "vpn",
  "tor",
  "hosting",
  "scraper",
  "compromised",
  "confidence",
  "country",
  "region",
  "city",
  "provider",
  "asn",
  "queriedAt",
  "expiresAt",
] as const;

const FORENSIC_AUDIT_FIELDS = [
  "eventId",
  "action",
  "actorId",
  "actorUsername",
  "actorRole",
  "caseRef",
  "scope",
  "subjectValue",
  "reason",
  "exportRequestId",
  "detail",
  "ip",
  "path",
  "method",
  "createdAt",
] as const;

function dateRange(filters: ForensicExportFilters, field: string): Record<string, unknown> {
  if (!filters.from && !filters.to) return {};
  const range: Record<string, unknown> = {};
  if (filters.from) range.$gte = filters.from;
  if (filters.to) range.$lte = filters.to;
  return { [field]: range };
}

/**
 * 导出源注册表：**只放与案件对象直接相关的集合**，且每个集合都有明确字段白名单。
 * 不把 `user_datas` 的密码材料、令牌、恢复码等凭据纳入交付件 —— 取证要的是事实，
 * 不是可登录凭据（内部文档第 2 节）。
 */
export function buildForensicExportSources(filters: ForensicExportFilters): ForensicExportSource[] {
  const { scope, value } = filters;
  if (scope === "user") {
    return [
      {
        collection: "user_datas",
        label: "账户文档（最小字段）",
        filter: { id: value, ...dateRange(filters, "createdAt") },
        dateField: "createdAt",
        fields: USER_FIELDS,
      },
      {
        collection: SecurityEvent.collection.name,
        label: "安全事件",
        filter: { userId: value, ...dateRange(filters, "createdAt") },
        dateField: "createdAt",
        fields: SECURITY_EVENT_FIELDS,
      },
      {
        collection: DeviceTracking.collection.name,
        label: "设备风险跟踪",
        filter: { userId: value, ...dateRange(filters, "lastSeen") },
        dateField: "lastSeen",
        fields: DEVICE_TRACKING_FIELDS,
      },
      {
        collection: DeviceFingerprint.collection.name,
        label: "设备指纹分量事实",
        filter: { userId: value, ...dateRange(filters, "lastSeenAt") },
        dateField: "lastSeenAt",
        fields: FINGERPRINT_FIELDS,
      },
      {
        collection: AccountIpSignal.collection.name,
        label: "登录 IP 事实",
        filter: { userId: value, ...dateRange(filters, "lastSeenAt") },
        dateField: "lastSeenAt",
        fields: IP_SIGNAL_FIELDS,
      },
      {
        collection: AuditLogModel.collection.name,
        label: "普通审计（60 天内）",
        filter: { userId: value, ...dateRange(filters, "createdAt") },
        dateField: "createdAt",
        fields: COMMON_LOOKUP_FIELDS,
      },
      {
        collection: ForensicAuditLogModel.collection.name,
        label: "取证审计（不设 TTL）",
        filter: { scope: "user", subjectValue: value, ...dateRange(filters, "createdAt") },
        dateField: "createdAt",
        fields: FORENSIC_AUDIT_FIELDS,
      },
    ];
  }

  if (scope === "ip") {
    return [
      {
        collection: SecurityEvent.collection.name,
        label: "安全事件",
        filter: { ipAddress: value, ...dateRange(filters, "createdAt") },
        dateField: "createdAt",
        fields: SECURITY_EVENT_FIELDS,
      },
      {
        collection: DeviceTracking.collection.name,
        label: "设备风险跟踪",
        filter: { ipAddress: value, ...dateRange(filters, "lastSeen") },
        dateField: "lastSeen",
        fields: DEVICE_TRACKING_FIELDS,
      },
      {
        collection: AccountIpSignal.collection.name,
        label: "登录 IP 事实",
        filter: { ipAddress: value, ...dateRange(filters, "lastSeenAt") },
        dateField: "lastSeenAt",
        fields: IP_SIGNAL_FIELDS,
      },
      {
        collection: "proxycheck_risk_cache",
        label: "IP 风险结论缓存",
        filter: { ip: value, ...dateRange(filters, "queriedAt") },
        dateField: "queriedAt",
        fields: RISK_CACHE_FIELDS,
      },
      {
        collection: AuditLogModel.collection.name,
        label: "普通审计（60 天内）",
        filter: { ip: value, ...dateRange(filters, "createdAt") },
        dateField: "createdAt",
        fields: COMMON_LOOKUP_FIELDS,
      },
      {
        collection: ForensicAuditLogModel.collection.name,
        label: "取证审计（不设 TTL）",
        filter: { scope: "ip", subjectValue: value, ...dateRange(filters, "createdAt") },
        dateField: "createdAt",
        fields: FORENSIC_AUDIT_FIELDS,
      },
    ];
  }

  return [
    {
      collection: SecurityEvent.collection.name,
      label: "安全事件",
      filter: { deviceFingerprint: value, ...dateRange(filters, "createdAt") },
      dateField: "createdAt",
      fields: SECURITY_EVENT_FIELDS,
    },
    {
      collection: DeviceTracking.collection.name,
      label: "设备风险跟踪",
      filter: { deviceFingerprint: value, ...dateRange(filters, "lastSeen") },
      dateField: "lastSeen",
      fields: DEVICE_TRACKING_FIELDS,
    },
    {
      collection: DeviceFingerprint.collection.name,
      label: "设备指纹分量事实",
      filter: { fingerprintId: value, ...dateRange(filters, "lastSeenAt") },
      dateField: "lastSeenAt",
      fields: FINGERPRINT_FIELDS,
    },
    {
      collection: ForensicAuditLogModel.collection.name,
      label: "取证审计（不设 TTL）",
      filter: { scope: "fingerprint", subjectValue: value, ...dateRange(filters, "createdAt") },
      dateField: "createdAt",
      fields: FORENSIC_AUDIT_FIELDS,
    },
  ];
}

function rawDb() {
  const db = mongoose.connection.db;
  if (!db) throw new ForensicExportRequestError("FORENSIC_EXPORT_DB_UNAVAILABLE", "数据库未连接，无法导出", 503);
  return db;
}

/** 导出前的行数闸门：超过硬顶直接 413，**一条都不导出**。 */
export async function countForensicExportRows(filters: ForensicExportFilters): Promise<number> {
  const db = rawDb();
  const sources = buildForensicExportSources(filters);
  let total = 0;
  for (const source of sources) {
    total += await db.collection(source.collection).countDocuments(source.filter as any);
    if (total > FORENSIC_EXPORT_MAX_ROWS) return total;
  }
  return total;
}

function orderedRecord(row: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  const ordered: Record<string, unknown> = { _id: row._id };
  for (const field of fields) {
    if (field in row) ordered[field] = row[field];
  }
  return ordered;
}

function projectionFor(fields: readonly string[]): Record<string, 1> {
  const projection: Record<string, 1> = { _id: 1 };
  for (const field of fields) projection[field] = 1;
  return projection;
}

async function writeChunk(res: Response, chunk: string): Promise<void> {
  if (res.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    const onDrain = () => {
      res.off("close", onClose);
      resolve();
    };
    const onClose = () => {
      res.off("drain", onDrain);
      reject(new Error("client aborted export"));
    };
    res.once("drain", onDrain);
    res.once("close", onClose);
  });
}

export interface ForensicExportStreamResult {
  rowCount: number;
  checksum: string;
  collectionCounts: Record<string, number>;
}

/**
 * 流式导出：内部按 `_id` 游标逐页读，NDJSON 逐片写。
 *
 * 校验和覆盖**所有数据行**（不含 manifest 行），manifest 作为最后一行随档交付。
 * 这样即便响应被中间层分块/压缩，接收方也能自己对已收到的数据行重算 SHA-256 对账。
 */
export async function streamForensicExport(
  res: Response,
  request: IForensicExportRequest,
): Promise<ForensicExportStreamResult> {
  const db = rawDb();
  const filters: ForensicExportFilters = {
    scope: request.scope,
    value: request.subjectValue,
    from: request.from ?? null,
    to: request.to ?? null,
  };
  const sources = buildForensicExportSources(filters);
  const hash = createHash("sha256");
  const collectionCounts: Record<string, number> = {};
  let rowCount = 0;

  for (const source of sources) {
    const collection = db.collection(source.collection);
    let lastId: unknown = null;
    let sourceCount = 0;
    for (;;) {
      const query: Record<string, unknown> = { ...source.filter };
      if (lastId !== null) {
        query._id = { $gt: lastId };
      }
      const rows = (await collection
        .find(query as any, { projection: projectionFor(source.fields) } as any)
        .sort({ _id: 1 })
        .limit(FORENSIC_EXPORT_PAGE_SIZE)
        .toArray()) as Array<Record<string, unknown>>;
      if (rows.length === 0) break;

      for (const row of rows) {
        if (rowCount >= FORENSIC_EXPORT_MAX_ROWS) {
          // 正常路径在 count 闸门就会 413；这里兜住“计数后又有新写入”的竞态。
          // 已写出的分片无法收回，必须中断连接，绝不能悄悄少写几行当作完整归档。
          throw new ForensicExportLimitError(rowCount + 1);
        }
        const line = `${JSON.stringify({
          collection: source.collection,
          label: source.label,
          record: orderedRecord(row, source.fields),
        })}\n`;
        hash.update(line, "utf8");
        await writeChunk(res, line);
        rowCount += 1;
        sourceCount += 1;
      }
      lastId = rows[rows.length - 1]._id;
      if (rows.length < FORENSIC_EXPORT_PAGE_SIZE) break;
    }
    collectionCounts[source.collection] = sourceCount;
  }

  const checksum = hash.digest("hex");
  const manifest = {
    type: "manifest",
    requestId: request.requestId,
    caseRef: request.caseRef,
    scope: request.scope,
    subjectValue: request.subjectValue,
    from: request.from ? new Date(request.from).toISOString() : null,
    to: request.to ? new Date(request.to).toISOString() : null,
    rowCount,
    collectionCounts,
    sha256: checksum,
    generatedAt: new Date().toISOString(),
    note: "sha256 覆盖本行之前的全部数据行（NDJSON），不含本 manifest 行。",
  };
  await writeChunk(res, `${JSON.stringify(manifest)}\n`);
  res.end();
  return { rowCount, checksum, collectionCounts };
}

export interface ForensicExportRequestView {
  requestId: string;
  caseRef: string;
  reason: string;
  scope: ForensicSubjectScope;
  subjectValue: string;
  from: string | null;
  to: string | null;
  status: ForensicExportStatus;
  requestedByUserId: string;
  requestedByUsername: string;
  approvedByUserId: string;
  approvedByUsername: string;
  expiresAt: string;
  approvedAt: string | null;
  downloadedAt: string | null;
  rowCount: number;
  checksum: string;
  createdAt: string;
}

function toIso(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function toForensicExportView(doc: IForensicExportRequest): ForensicExportRequestView {
  return {
    requestId: doc.requestId,
    caseRef: doc.caseRef,
    reason: doc.reason,
    scope: doc.scope,
    subjectValue: doc.subjectValue,
    from: toIso(doc.from),
    to: toIso(doc.to),
    status: doc.status,
    requestedByUserId: doc.requestedByUserId,
    requestedByUsername: doc.requestedByUsername,
    approvedByUserId: doc.approvedByUserId,
    approvedByUsername: doc.approvedByUsername,
    expiresAt: toIso(doc.expiresAt) || "",
    approvedAt: toIso(doc.approvedAt),
    downloadedAt: toIso(doc.downloadedAt),
    rowCount: doc.rowCount,
    checksum: doc.checksum,
    createdAt: toIso(doc.createdAt) || "",
  };
}

export async function createForensicExportRequest(input: {
  actor: ForensicActor;
  caseRef: unknown;
  reason: unknown;
  scope: unknown;
  value: unknown;
  from?: unknown;
  to?: unknown;
  request: ForensicRequestMeta;
}): Promise<{ request: ForensicExportRequestView; rowCount: number; audit: { auditLogged: boolean; forensicLogged: boolean } }> {
  if (!mongoReady()) throw new ForensicExportRequestError("FORENSIC_EXPORT_DB_UNAVAILABLE", "数据库未连接，无法发起导出", 503);
  const scope = normalizeScope(input.scope);
  const value = requireText(input.value, "FORENSIC_EXPORT_VALUE_REQUIRED", "请填写要导出的用户 ID / IP / 指纹");
  const caseRef = requireText(input.caseRef, "FORENSIC_EXPORT_CASE_REQUIRED", "请填写案件编号");
  const reason = requireText(input.reason, "FORENSIC_EXPORT_REASON_REQUIRED", "请填写导出理由（法律依据 / 文书编号）");
  const from = parseDate(input.from);
  const to = parseDate(input.to);
  if (from && to && from > to) {
    throw new ForensicExportRequestError("FORENSIC_EXPORT_RANGE_INVALID", "时间窗起始晚于结束");
  }

  // 只允许导出被法律保留命中的对象：导出不是“管理员随便看看”的批量下载口。
  // `unknown`（库不可用）按 fail-closed 处理，不放行。
  const hold = await checkLegalHold(scope as LegalHoldScope, value);
  if (hold.unknown) {
    throw new ForensicExportRequestError("FORENSIC_EXPORT_HOLD_UNKNOWN", "无法确认法律保留状态，已拒绝导出", 503);
  }
  if (!hold.held) {
    throw new ForensicExportRequestError(
      "FORENSIC_EXPORT_HOLD_REQUIRED",
      "该对象没有生效中的法律保留，取证导出只对已登记 hold 的对象开放",
      403,
    );
  }

  const totalRows = await countForensicExportRows({ scope, value, from, to });
  assertWithinExportCap(totalRows);

  const requestId = `fxr_${randomUUID()}`;
  const expiresAt = new Date(Date.now() + FORENSIC_EXPORT_REQUEST_TTL_MS);
  const doc = await ForensicExportRequestModel.create({
    requestId,
    requestedByUserId: input.actor.id,
    requestedByUsername: input.actor.username,
    approvedByUserId: "",
    approvedByUsername: "",
    caseRef,
    reason,
    scope,
    subjectValue: value,
    from,
    to,
    status: "pending",
    expiresAt,
    approvedAt: null,
    downloadedAt: null,
    rowCount: 0,
    checksum: "",
  });

  const audit = await recordForensicEvent({
    action: "forensic_export.request",
    actor: input.actor,
    caseRef,
    scope,
    subjectValue: value,
    reason,
    exportRequestId: requestId,
    detail: { from: from?.toISOString() ?? null, to: to?.toISOString() ?? null, potentialRows: totalRows },
    request: input.request,
  });

  return {
    request: toForensicExportView(doc as unknown as IForensicExportRequest),
    rowCount: totalRows,
    audit,
  };
}

export async function getForensicExportRequest(requestId: string): Promise<IForensicExportRequest | null> {
  if (!mongoReady()) throw new ForensicExportRequestError("FORENSIC_EXPORT_DB_UNAVAILABLE", "数据库未连接", 503);
  return (await ForensicExportRequestModel.findOne({ requestId }).lean().exec()) as IForensicExportRequest | null;
}

export async function approveForensicExportRequest(input: {
  actor: ForensicActor;
  requestId: unknown;
  request: ForensicRequestMeta;
}): Promise<{ request: ForensicExportRequestView; audit: { auditLogged: boolean; forensicLogged: boolean } }> {
  const requestId = requireText(input.requestId, "FORENSIC_EXPORT_REQUEST_ID_REQUIRED", "缺少导出申请编号");
  const existing = await getForensicExportRequest(requestId);
  if (!existing) throw new ForensicExportRequestError("FORENSIC_EXPORT_REQUEST_NOT_FOUND", "导出申请不存在", 404);

  if (existing.requestedByUserId === input.actor.id) {
    throw new ForensicExportRequestError(
      "FORENSIC_EXPORT_DUAL_CONTROL_REQUIRED",
      "双人确认：发起人不能批准自己的导出申请",
      403,
    );
  }
  if (existing.status === "expired" || (existing.expiresAt && new Date(existing.expiresAt).getTime() <= Date.now())) {
    await ForensicExportRequestModel.updateOne({ requestId }, { $set: { status: "expired" } });
    throw new ForensicExportRequestError("FORENSIC_EXPORT_REQUEST_EXPIRED", "导出申请已过期，请重新发起", 410);
  }
  if (existing.status !== "pending") {
    return { request: toForensicExportView(existing), audit: { auditLogged: true, forensicLogged: true } };
  }

  const updated = (await ForensicExportRequestModel.findOneAndUpdate(
    { requestId, status: "pending" },
    {
      $set: {
        status: "approved",
        approvedByUserId: input.actor.id,
        approvedByUsername: input.actor.username,
        approvedAt: new Date(),
      },
    },
    { new: true },
  )
    .lean()
    .exec()) as IForensicExportRequest | null;
  if (!updated) {
    const current = await getForensicExportRequest(requestId);
    return {
      request: toForensicExportView((current ?? existing) as IForensicExportRequest),
      audit: { auditLogged: true, forensicLogged: true },
    };
  }

  const audit = await recordForensicEvent({
    action: "forensic_export.approve",
    actor: input.actor,
    caseRef: existing.caseRef,
    scope: existing.scope,
    subjectValue: existing.subjectValue,
    reason: existing.reason,
    exportRequestId: requestId,
    detail: { requestedBy: existing.requestedByUserId },
    request: input.request,
  });

  return { request: toForensicExportView(updated), audit };
}

export function assertDownloadable(
  request: IForensicExportRequest,
  actor: ForensicActor,
): void {
  if (request.status !== "approved" && request.status !== "downloaded") {
    throw new ForensicExportRequestError(
      "FORENSIC_EXPORT_NOT_APPROVED",
      "导出申请尚未完成双人确认，已拒绝下载",
      403,
    );
  }
  if (request.expiresAt && new Date(request.expiresAt).getTime() <= Date.now()) {
    throw new ForensicExportRequestError("FORENSIC_EXPORT_REQUEST_EXPIRED", "导出申请已过期，请重新发起", 410);
  }
  if (actor.id !== request.requestedByUserId && actor.id !== request.approvedByUserId) {
    throw new ForensicExportRequestError(
      "FORENSIC_EXPORT_NOT_A_PARTY",
      "只有发起人或批准人可以下载该导出件",
      403,
    );
  }
}

/** 下载完成后回写校验和与行数；同时把这次交付本身写进取证审计。 */
export async function finalizeForensicExport(input: {
  actor: ForensicActor;
  request: IForensicExportRequest;
  result: ForensicExportStreamResult;
  requestMeta: ForensicRequestMeta;
}): Promise<{ auditLogged: boolean; forensicLogged: boolean }> {
  await ForensicExportRequestModel.updateOne(
    { requestId: input.request.requestId },
    {
      $set: {
        status: "downloaded",
        downloadedAt: new Date(),
        rowCount: input.result.rowCount,
        checksum: input.result.checksum,
      },
    },
  );

  return recordForensicEvent({
    action: "forensic_export.download",
    actor: input.actor,
    caseRef: input.request.caseRef,
    scope: input.request.scope,
    subjectValue: input.request.subjectValue,
    reason: input.request.reason,
    exportRequestId: input.request.requestId,
    detail: {
      rowCount: input.result.rowCount,
      checksum: input.result.checksum,
      collectionCounts: input.result.collectionCounts,
      approvedBy: input.request.approvedByUserId,
    },
    request: input.requestMeta,
  });
}

export interface ForensicAuditCursor {
  createdAt: number;
  id: string;
}

export function encodeForensicAuditCursor(doc: IForensicAuditLog): string {
  const createdAt = doc.createdAt instanceof Date ? doc.createdAt.getTime() : new Date(doc.createdAt).getTime();
  return Buffer.from(JSON.stringify({ createdAt, id: String((doc as unknown as { _id?: unknown })._id ?? "") }), "utf8").toString("base64url");
}

export function parseForensicAuditCursor(raw: unknown): ForensicAuditCursor | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Record<string, unknown>;
    const createdAt = Number(parsed.createdAt);
    const id = typeof parsed.id === "string" ? parsed.id : "";
    if (!Number.isFinite(createdAt) || !id) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

export async function listForensicAuditPage(options: {
  action?: string;
  caseRef?: string;
  subjectValue?: string;
  limit?: number;
  cursor?: string;
} = {}): Promise<{ events: IForensicAuditLog[]; nextCursor: string | null; limit: number }> {
  const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 50) || 50), 200);
  if (!mongoReady()) return { events: [], nextCursor: null, limit };

  const filter: Record<string, unknown> = {};
  if (options.action) filter.action = options.action;
  if (options.caseRef) filter.caseRef = options.caseRef;
  if (options.subjectValue) filter.subjectValue = options.subjectValue;

  const cursor = parseForensicAuditCursor(options.cursor);
  if (cursor) {
    filter.$or = [
      { createdAt: { $lt: new Date(cursor.createdAt) } },
      { createdAt: new Date(cursor.createdAt), _id: { $lt: cursor.id } },
    ];
  }

  const rows = (await ForensicAuditLogModel.find(filter)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean()
    .exec()) as IForensicAuditLog[];
  const hasMore = rows.length > limit;
  const events = hasMore ? rows.slice(0, limit) : rows;
  const last = events[events.length - 1];
  return {
    events,
    nextCursor: hasMore && last ? encodeForensicAuditCursor(last) : null,
    limit,
  };
}

/** 供控制器统一把 Request 折成审计元数据。 */
export function requestMeta(req: Request): ForensicRequestMeta {
  return {
    ip: req.ip || req.socket?.remoteAddress || "unknown",
    userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : undefined,
    path: (req.originalUrl || req.path || "").split("?")[0],
    method: req.method,
  };
}

/** 供服务调用方（非 Express 上下文）使用。 */
export function actorFromUser(user: { id?: string; username?: string; role?: string } | undefined): ForensicActor {
  return {
    id: user?.id || "unknown",
    username: user?.username || "unknown",
    role: user?.role || "unknown",
  };
}

export type ForensicAuditMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => void | Promise<void>;

export { LegalHoldValidationError };
