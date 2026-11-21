import { BilibiliCookieReportModel, type BilibiliCookieReportDoc } from "../models/bilibiliCookieReportModel";
import type { BilibiliAccountClientIdentity } from "../models/bilibiliAccountBindingModel";
import {
  BilibiliSyncError,
  decryptStoredCredential,
  encryptCredential,
  normalizeUid,
  verifyBilibiliCookie,
} from "./bilibiliSyncService";
import { normalizeClient, normalizeDevice, normalizePermissions } from "./bilibiliAccountService";
import { escapeRegexLiteral } from "../utils/regexEscape";

/**
 * Login-time cookie reports (PiliPlus and any other registered client).
 *
 * The reporter is NOT a logged-in Synapse user: identity is the device id the
 * client generated on first launch and echoes on every request. That is enough
 * to keep a device's vault stable across logins, and it is deliberately weak
 * credentials — which is acceptable because this endpoint only *accepts* data.
 * Everything that reads it back (the admin listing) is behind the normal
 * admin authentication chain, and the cookie never leaves the database as
 * anything but AES-GCM ciphertext.
 */

/** Device ids are 24 random bytes, base64url without padding, in current clients. */
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/** Clients allowed to file a login report without a Synapse session. */
export const REPORT_CLIENT_ALLOW_LIST = new Set(["piliplus"]);

/** A single device may not archive an unbounded number of Bilibili accounts. */
export const MAX_REPORTS_PER_DEVICE = 32;

export const MAX_REPORT_COOKIE_BYTES = 8192;

export interface BilibiliCookieReportInput {
  clientId?: unknown;
  deviceId?: unknown;
  uid?: unknown;
  cookie?: unknown;
  isPrimary?: unknown;
  device?: unknown;
  permissions?: unknown;
  client?: unknown;
}

export interface BilibiliCookieReportResult {
  accepted: true;
  uid: string;
  status: "active";
  reportedAt: string;
  reportCount: number;
}

export interface BilibiliCookieReportView {
  clientId: string;
  deviceId: string;
  uid: string;
  isPrimary: boolean;
  status: "active" | "invalid";
  reportCount: number;
  firstReportedAt: string;
  lastReportedAt: string;
  deviceSummary: Record<string, unknown>;
  permissionsCount: number;
  client: BilibiliAccountClientIdentity;
}

function normalizeClientId(value: unknown): string {
  const clientId = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!clientId) {
    throw new BilibiliSyncError("缺少客户端标识", "BILIBILI_REPORT_CLIENT_REQUIRED", 400);
  }
  if (!REPORT_CLIENT_ALLOW_LIST.has(clientId)) {
    throw new BilibiliSyncError("该客户端未登记为可上报设备", "BILIBILI_REPORT_CLIENT_UNKNOWN", 403);
  }
  return clientId;
}

export function normalizeReportDeviceId(value: unknown): string {
  const deviceId = typeof value === "string" ? value.trim() : "";
  if (!deviceId) {
    throw new BilibiliSyncError("缺少设备标识", "BILIBILI_REPORT_DEVICE_REQUIRED", 400);
  }
  if (!DEVICE_ID_PATTERN.test(deviceId)) {
    throw new BilibiliSyncError("设备标识格式无效", "BILIBILI_REPORT_DEVICE_INVALID", 400);
  }
  return deviceId;
}

/**
 * Header and body must agree. A report that disagrees is either a buggy client
 * or somebody probing with a borrowed device id; both are rejected outright.
 * A client may omit either side, but never both.
 */
export function resolveReportDeviceId(bodyDeviceId: unknown, headerDeviceId: unknown): string {
  const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
  const fromBody = text(bodyDeviceId);
  const fromHeader = text(headerDeviceId);
  if (fromBody && fromHeader && fromBody !== fromHeader) {
    throw new BilibiliSyncError("设备标识与请求头不一致", "BILIBILI_REPORT_DEVICE_MISMATCH", 403);
  }
  return normalizeReportDeviceId(fromBody || fromHeader);
}

function normalizeCookie(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new BilibiliSyncError("需要 Bilibili 登录 Cookie", "BILIBILI_COOKIE_REQUIRED", 400);
  }
  const cookie = value.trim();
  if (cookie.length > MAX_REPORT_COOKIE_BYTES) {
    throw new BilibiliSyncError("Bilibili 登录 Cookie 过长", "BILIBILI_COOKIE_TOO_LARGE", 413);
  }
  return cookie;
}

async function markInvalid(clientId: string, deviceId: string, uid: string): Promise<void> {
  try {
    await BilibiliCookieReportModel.updateOne(
      { clientId, deviceId, bilibiliUid: uid },
      { $set: { credentialStatus: "invalid", credentialLastCheckedAt: new Date() } },
    );
  } catch {
    // Metadata cleanup only; the report itself already failed for a real reason.
  }
}

export async function reportBilibiliCookie(input: BilibiliCookieReportInput): Promise<BilibiliCookieReportResult> {
  const clientId = normalizeClientId(input.clientId);
  const deviceId = normalizeReportDeviceId(input.deviceId);
  const uid = normalizeUid(input.uid);
  const cookie = normalizeCookie(input.cookie);

  const existingCount = await BilibiliCookieReportModel.countDocuments({ clientId, deviceId });
  const known = await BilibiliCookieReportModel.findOne({ clientId, deviceId, bilibiliUid: uid })
    .select("reportCount")
    .lean<{ reportCount?: number } | null>();
  if (!known && existingCount >= MAX_REPORTS_PER_DEVICE) {
    throw new BilibiliSyncError("该设备的 Bilibili 账号上报数量已达上限", "BILIBILI_REPORT_DEVICE_LIMIT", 409);
  }

  try {
    await verifyBilibiliCookie(cookie, uid);
  } catch (error) {
    await markInvalid(clientId, deviceId, uid);
    throw error;
  }

  const now = new Date();
  const credential = encryptCredential(cookie);
  const doc = await BilibiliCookieReportModel.findOneAndUpdate(
    { clientId, deviceId, bilibiliUid: uid },
    {
      $set: {
        clientId,
        deviceId,
        bilibiliUid: uid,
        isPrimary: input.isPrimary === true,
        ...credential,
        credentialStatus: "active" as const,
        credentialValidatedAt: now,
        credentialLastCheckedAt: now,
        lastReportedAt: now,
        device: normalizeDevice(input.device),
        permissions: normalizePermissions(input.permissions),
        client: normalizeClient(input.client),
      },
      $setOnInsert: { firstReportedAt: now },
      $inc: { reportCount: 1 },
    },
    { upsert: true, returnDocument: "after" },
  )
    .select("reportCount lastReportedAt")
    .lean<{ reportCount?: number; lastReportedAt?: Date } | null>();

  return {
    accepted: true,
    uid,
    status: "active",
    reportedAt: (doc?.lastReportedAt ?? now).toISOString(),
    reportCount: doc?.reportCount ?? 1,
  };
}

function toView(doc: BilibiliCookieReportDoc): BilibiliCookieReportView {
  return {
    clientId: doc.clientId,
    deviceId: doc.deviceId,
    uid: doc.bilibiliUid,
    isPrimary: doc.isPrimary,
    status: doc.credentialStatus,
    reportCount: doc.reportCount,
    firstReportedAt: new Date(doc.firstReportedAt).toISOString(),
    lastReportedAt: new Date(doc.lastReportedAt).toISOString(),
    deviceSummary: {
      platform: doc.device?.platform ?? doc.device?.os,
      model: doc.device?.model,
      brand: doc.device?.brand ?? doc.device?.manufacturer,
      appVersion: doc.device?.appVersion ?? doc.device?.versionName,
      sdkInt: doc.device?.sdkInt,
    },
    permissionsCount: Object.keys(doc.permissions || {}).length,
    client: doc.client || {},
  };
}
export async function listBilibiliCookieReports(query: {
  search?: unknown;
  page?: unknown;
  limit?: unknown;
}): Promise<{ reports: BilibiliCookieReportView[]; total: number; page: number; limit: number }> {
  const page = Math.max(1, parseInt(String(query.page ?? 1), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(String(query.limit ?? 20), 10) || 20));
  const search = typeof query.search === "string" ? query.search.trim() : "";

  const filter: Record<string, unknown> = {};
  if (search) {
    // 设备 id / UID / 客户端 id 都是外部可写入的字段：关键词不转义会把 `.`/`*` 变通配符，
    // 也能被构造成病态正则。
    const keyword = escapeRegexLiteral(search);
    filter.$or = [
      { deviceId: { $regex: keyword, $options: "i" } },
      { bilibiliUid: { $regex: keyword, $options: "i" } },
      { clientId: { $regex: keyword, $options: "i" } },
    ];
  }

  const [docs, total] = await Promise.all([
    BilibiliCookieReportModel.find(filter)
      .sort({ lastReportedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean<BilibiliCookieReportDoc[]>(),
    BilibiliCookieReportModel.countDocuments(filter),
  ]);

  return { reports: docs.map(toView), total, page, limit };
}

export async function removeBilibiliCookieReport(rawClientId: unknown, rawDeviceId: unknown, rawUid: unknown): Promise<{ removed: boolean }> {
  const clientId = normalizeClientId(rawClientId);
  const deviceId = normalizeReportDeviceId(rawDeviceId);
  const uid = normalizeUid(rawUid);
  // 登录凭据存档删除是隐私删除权/凭据失效清理，软删除会留下可解密的密文。
  const result = await BilibiliCookieReportModel.deleteOne({ clientId, deviceId, bilibiliUid: uid }); // soft-delete-exempt: 隐私删除权/凭据失效清理，软删除相当于留下可解密凭据
  return { removed: result.deletedCount > 0 };
}

/** 一次「解密查看」最多解多少条：挡的是一条请求把整张表拉成明文。 */
export const MAX_REVEAL_ROWS = 50;

export interface BilibiliRevealedReportCredential {
  clientId: string;
  deviceId: string;
  uid: string;
  status: "active" | "invalid" | "unknown";
  lastReportedAt: string | null;
  /** 解密后的 Cookie 明文；失败/记录不存在时为 null，原因见 `error`。 */
  cookie: string | null;
  error?: "not-found" | "undecryptable";
}

/**
 * 把一批登录上报记录的凭据解密成明文（**仅** `/api/admin/bilibili-reports/credentials` 用）。
 *
 * 安全约束（缺一不可）：
 *   1. 调用方必须是超管 + 有效安全会话（二次验证），见 routes/admin/bilibiliCredentials.ts；
 *   2. 逐次写审计（只有标识与结果，不含明文 Cookie）；
 *   3. 对超长/非法键直接报错，不会“部分解密”后返回半张表；
 *   4. 单次最多 `MAX_REVEAL_ROWS` 条，超过直接拒绝。
 *
 * 解密失败不抛错而是逐条标记 `undecryptable`：密钥轮换期间旧代密文必然存在，
 * 面板需要能说清“哪几条打不开”，而不是整批 500。
 */
export async function revealBilibiliCookieReports(rawItems: unknown): Promise<BilibiliRevealedReportCredential[]> {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    throw new BilibiliSyncError("需要指定要解密的记录", "BILIBILI_REVEAL_ITEMS_REQUIRED", 400);
  }
  if (rawItems.length > MAX_REVEAL_ROWS) {
    throw new BilibiliSyncError(
      `单次最多解密 ${MAX_REVEAL_ROWS} 条记录`,
      "BILIBILI_REVEAL_ITEMS_TOO_MANY",
      413,
    );
  }

  const keys = rawItems.map((item) => {
    const record = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    // 读取侧不过白名单：客户端一旦被从白名单里摘掉，旧存档仍然要能被读到（否则数据就“锁定”了）。
    const clientId = typeof record.clientId === "string" ? record.clientId.trim().toLowerCase() : "";
    if (!clientId) throw new BilibiliSyncError("缺少客户端标识", "BILIBILI_REPORT_CLIENT_REQUIRED", 400);
    return {
      clientId,
      deviceId: normalizeReportDeviceId(record.deviceId),
      uid: normalizeUid(record.uid),
    };
  });

  const docs = await BilibiliCookieReportModel.find({
    $or: keys.map((key) => ({ clientId: key.clientId, deviceId: key.deviceId, bilibiliUid: key.uid })),
  })
    .select(
      "+credentialCiphertext +credentialIv +credentialTag +credentialKeyVersion clientId deviceId bilibiliUid credentialStatus lastReportedAt",
    )
    .lean<BilibiliCookieReportDoc[]>();

  const byKey = new Map(
    docs.map((doc) => [`${doc.clientId}|${doc.deviceId}|${doc.bilibiliUid}`, doc] as const),
  );

  return keys.map((key) => {
    const doc = byKey.get(`${key.clientId}|${key.deviceId}|${key.uid}`);
    if (!doc) {
      return { ...key, status: "unknown" as const, lastReportedAt: null, cookie: null, error: "not-found" as const };
    }
    let cookie: string | null = null;
    let error: "undecryptable" | undefined;
    try {
      cookie = decryptStoredCredential(doc);
    } catch {
      error = "undecryptable";
    }
    return {
      ...key,
      status: doc.credentialStatus,
      lastReportedAt: doc.lastReportedAt ? new Date(doc.lastReportedAt).toISOString() : null,
      cookie,
      ...(error ? { error } : {}),
    };
  });
}
