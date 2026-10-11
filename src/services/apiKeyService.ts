import crypto from "node:crypto";
import { type ApiKeyDoc, ApiKeyModel } from "../models/apiKeyModel";
import logger from "../utils/logger";

/** 所有可分配的权限 */
export const ALL_PERMISSIONS = [
  "tts", // TTS 生成
  "status", // 系统状态查询
  "shorturl", // 短链服务
  "media", // 媒体接口
  "network", // 网络工具
  "life", // 生活服务
  "social", // 社交接口
  "ipfs", // IPFS 上传
  "data-process", // 数据处理
  "outemail", // 对外邮件发送
] as const;

export const ADMIN_PERMISSION = "*" as const;

export type Permission = (typeof ALL_PERMISSIONS)[number] | typeof ADMIN_PERMISSION;

export interface ApiKeyPermissionDefinition {
  key: Permission;
  label: string;
  description: string;
  category: "core" | "utility" | "content" | "system";
  costCredits: number;
  endpoints: string[];
  adminOnly?: boolean;
}

export type ApiKeyView = Omit<ApiKeyDoc, "keyHash">;

const permissionSet = new Set<string>(ALL_PERMISSIONS);

export const API_KEY_PERMISSION_DEFINITIONS: ApiKeyPermissionDefinition[] = [
  {
    key: ADMIN_PERMISSION,
    label: "全部能力",
    description: "允许访问所有已接入 API Key 认证的能力，不包含后台管理接口。",
    category: "system",
    costCredits: 0,
    endpoints: ["所有已接入 X-API-Key 的接口"],
    adminOnly: true,
  },
  {
    key: "tts",
    label: "TTS 生成",
    description: "提交语音生成任务，查询任务状态、结果和历史记录。",
    category: "core",
    costCredits: 1,
    endpoints: ["/api/tts/generate", "/api/tts/jobs/*", "/api/tts/history"],
  },
  {
    key: "status",
    label: "认证状态",
    description: "访问需要认证的系统状态检查接口。",
    category: "system",
    costCredits: 0,
    endpoints: ["/api/status/status"],
  },
  {
    key: "shorturl",
    label: "短链管理",
    description: "查看和删除所属用户的短链记录。",
    category: "utility",
    costCredits: 0.05,
    endpoints: ["/api/shorturls", "/api/shorturls/*"],
  },
  {
    key: "media",
    label: "媒体解析",
    description: "调用音乐与视频解析接口。",
    category: "content",
    costCredits: 0.2,
    endpoints: ["/api/media/music163", "/api/media/pipixia"],
  },
  {
    key: "network",
    label: "网络工具",
    description: "调用 Ping、TCPing、测速、端口扫描、IP 查询等网络工具。",
    category: "utility",
    costCredits: 0.2,
    endpoints: ["/api/network/*"],
  },
  {
    key: "life",
    label: "生活服务",
    description: "调用手机号归属地、油价等生活信息接口。",
    category: "utility",
    costCredits: 0.1,
    endpoints: ["/api/life/*"],
  },
  {
    key: "social",
    label: "社交热榜",
    description: "调用微博、百度等热榜接口。",
    category: "content",
    costCredits: 0.1,
    endpoints: ["/api/social/*"],
  },
  {
    key: "ipfs",
    label: "IPFS 上传",
    description: "上传文件到 IPFS，并使用 API Key 认证跳过人机验证。",
    category: "core",
    costCredits: 0.5,
    endpoints: ["/api/ipfs/upload"],
  },
  {
    key: "data-process",
    label: "数据处理",
    description: "调用 Base64、MD5 等数据处理工具。",
    category: "utility",
    costCredits: 0.05,
    endpoints: ["/api/data/*"],
  },
  {
    key: "outemail",
    label: "对外邮件",
    description: "调用对外邮件发送接口（/api/outemail/send、/batch-send），与 EnvManager 外部 Key 鉴权方式兼容。",
    category: "core",
    costCredits: 0.2,
    endpoints: ["/api/outemail/send", "/api/outemail/batch-send"],
  },
];

export function getApiKeyPermissionDefinitions(isAdmin = false): ApiKeyPermissionDefinition[] {
  return API_KEY_PERMISSION_DEFINITIONS.filter((permission) => isAdmin || !permission.adminOnly);
}

export function normalizeApiKeyPermissions(
  permissions: unknown,
  opts: { isAdmin?: boolean; fallback?: string[] } = {},
): string[] {
  const fallback = opts.fallback?.length ? opts.fallback : ["status"];
  const source = Array.isArray(permissions) ? permissions : fallback;
  const normalized: string[] = [];

  for (const value of source) {
    if (typeof value !== "string") continue;
    const permission = value.trim();
    if (!permission) continue;
    if (permission === ADMIN_PERMISSION) {
      if (opts.isAdmin) return [ADMIN_PERMISSION];
      continue;
    }
    if (permissionSet.has(permission) && !normalized.includes(permission)) {
      normalized.push(permission);
    }
  }

  return normalized.length > 0 ? normalized : normalizeApiKeyPermissions(fallback, opts);
}

export function toApiKeyView(doc: ApiKeyDoc): ApiKeyView {
  const { keyHash: _keyHash, ...view } = doc;
  return view;
}

function toPlainDoc(doc: ApiKeyDoc): ApiKeyDoc {
  return typeof (doc as any).toObject === "function" ? ((doc as any).toObject() as ApiKeyDoc) : doc;
}

/** 生成 API Key：返回明文（仅此一次）和 keyId */
export async function createApiKey(opts: {
  name: string;
  userId: string;
  permissions?: string[];
  rateLimit?: number;
  expiresInDays?: number | null;
  isAdmin?: boolean;
  billingEnabled?: boolean;
  billingMode?: "metered" | "prepaid";
  balanceCredits?: number;
}): Promise<{ keyId: string; plainKey: string }> {
  const randomPart = crypto.randomBytes(24).toString("base64url"); // 32 字符
  const keyId = `ak_${crypto.randomBytes(4).toString("hex")}`; // ak_xxxxxxxx
  const plainKey = `${keyId}.${randomPart}`;
  const keyHash = await hashKey(plainKey);

  await ApiKeyModel.create({
    keyId,
    keyHash,
    name: opts.name,
    userId: opts.userId,
    permissions: normalizeApiKeyPermissions(opts.permissions, { isAdmin: opts.isAdmin }),
    rateLimit: opts.rateLimit ?? 60,
    expiresAt: opts.expiresInDays ? new Date(Date.now() + opts.expiresInDays * 86400000) : null,
    billingEnabled: opts.billingEnabled ?? true,
    billingMode: opts.billingMode === "prepaid" ? "prepaid" : "metered",
    balanceCredits: Math.max(Number(opts.balanceCredits) || 0, 0),
  });

  logger.info("[ApiKey] 创建 API Key", { keyId, userId: opts.userId, name: opts.name });
  return { keyId, plainKey };
}

// 明文形如 `ak_xxxxxxxx.<random>`。先按 keyId 前缀定位候选文档，
// 再对整串做一次定长哈希比较，避免"整串哈希当查询键"以及用随机 X-API-Key
// 强制服务器为不存在的 key 付出慢哈希代价。
const VALID_KEY_PREFIX_PATTERN = /^ak_[a-f0-9]{8}\./;
const VALIDATE_CACHE_TTL_MS = 30_000;
const VALIDATE_CACHE_MAX = 500;
// Cache only the expensive proof of possession. Authorization always comes from
// a fresh database read, so revocation/permission changes apply across instances.
const validateCache = new Map<string, { keyHash: string; expiresAt: number }>();

function setValidateCache(key: string, keyHash: string, now: number): void {
  if (validateCache.size >= VALIDATE_CACHE_MAX) {
    const oldest = validateCache.keys().next().value;
    if (oldest !== undefined) validateCache.delete(oldest);
  }
  validateCache.set(key, { keyHash, expiresAt: now + VALIDATE_CACHE_TTL_MS });
}

function timingSafeHashEqual(computed: string, stored: string): boolean {
  const a = Buffer.from(computed, "utf8");
  const b = Buffer.from(stored, "utf8");
  if (a.length !== b.length) {
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/** 验证 API Key，返回文档或 null */
export async function validateApiKey(plainKey: string): Promise<ApiKeyDoc | null> {
  const key = String(plainKey || "").trim();
  if (!key || !VALID_KEY_PREFIX_PATTERN.test(key)) {
    return null;
  }

  const now = Date.now();
  const keyId = key.split(".")[0];
  const doc = (await ApiKeyModel.findOne({ keyId }).lean()) as ApiKeyDoc | null;
  if (!doc || !doc.enabled) {
    return null;
  }
  if (doc.expiresAt && new Date(doc.expiresAt).getTime() <= Date.now()) {
    return null;
  }

  // 这是**缓存查找键**：sha256 仅用于在进程内 Map 里定位条目，不是凭据存储/比对。
  // 真正的密钥比对在下方 hashKey()（scrypt N=16384）+ timingSafeHashEqual，输入是服务端生成的高熵密钥。
  // codeql[js/insufficient-password-hash] 缓存查找键，非口令哈希；凭据比对用 scrypt + timingSafeHashEqual
  const cacheKey = crypto.createHash("sha256").update(key).digest("hex");
  const cached = validateCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return timingSafeHashEqual(cached.keyHash, doc.keyHash) ? doc : null;
  }
  const hash = await hashKey(key);
  setValidateCache(cacheKey, hash, now);
  return timingSafeHashEqual(hash, doc.keyHash) ? doc : null;
}

/** 记录使用 */
export async function recordUsage(keyId: string, ip: string): Promise<void> {
  await ApiKeyModel.updateOne(
    { keyId },
    {
      $set: { lastUsedAt: new Date(), lastUsedIp: ip, updatedAt: new Date() },
      $inc: { usageCount: 1 },
    },
  );
}

/** 列出某用户的所有 Key */
export async function listUserKeys(userId: string): Promise<ApiKeyView[]> {
  const docs = (await ApiKeyModel.find({ userId }).sort({ createdAt: -1 }).lean()) as ApiKeyDoc[];
  return docs.map(toApiKeyView);
}

/** 列出所有 Key（管理员） */
export async function listAllKeys(): Promise<ApiKeyView[]> {
  const docs = (await ApiKeyModel.find().sort({ createdAt: -1 }).lean()) as ApiKeyDoc[];
  return docs.map(toApiKeyView);
}

/** 吊销（软删除：禁用） */
export async function revokeKey(keyId: string): Promise<boolean> {
  const result = await ApiKeyModel.updateOne({ keyId }, { $set: { enabled: false, updatedAt: new Date() } });
  logger.info("[ApiKey] 吊销 API Key", { keyId });
  return result.modifiedCount > 0;
}

/** 启用 */
export async function enableKey(keyId: string): Promise<boolean> {
  const result = await ApiKeyModel.updateOne({ keyId }, { $set: { enabled: true, updatedAt: new Date() } });
  return result.modifiedCount > 0;
}

/** 硬删除 */
export async function deleteKey(keyId: string): Promise<boolean> {
  const result = await ApiKeyModel.deleteOne({ keyId });
  logger.info("[ApiKey] 删除 API Key", { keyId });
  return result.deletedCount > 0;
}

/** 更新权限/限流/名称 */
export async function updateKey(
  keyId: string,
  updates: {
    name?: string;
    permissions?: string[];
    rateLimit?: number;
    enabled?: boolean;
    expiresAt?: Date | null;
    billingEnabled?: boolean;
    billingMode?: "metered" | "prepaid";
  },
): Promise<ApiKeyView | null> {
  const doc = await ApiKeyModel.findOneAndUpdate(
    { keyId },
    { $set: { ...updates, updatedAt: new Date() } },
    { returnDocument: "after" },
  ).lean();
  return doc ? toApiKeyView(toPlainDoc(doc as ApiKeyDoc)) : null;
}

async function hashKey(plain: string): Promise<string> {
  // 使用异步 scrypt，避免 scryptSync 阻塞事件循环（默认 N=16384 单次数十毫秒）。
  return new Promise((resolve, reject) => {
    crypto.scrypt(plain, "api-key-static-salt", 64, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey.toString("hex"));
    });
  });
}

/**
 * RC-19：API Key 的三态处罚（降速 / 暂停 / 恢复）。
 *
 * 为什么必须收成一个入口：处罚要么是**自动**（突发频率、爬虫节奏、账户风险档升级），
 * 要么是**人工**（管理员动作），两者都要写归因（`penaltySource` / `penaltyReason`）——
 * 否则用户申诉时没人能回答“为什么我的 Key 变慢了”。归因写法沿用仓库约定：
 * `auto:<判据>` / `manual:<operatorId>` / `account-risk:<tier>`。
 *
 * `suspended` 且不传 `durationHours` 时是**永久**（`penaltyUntil: null`）；
 * 其余状态到期自动失效（读取侧判定，不做定时任务）。
 */
export interface ApiKeyPenaltyInput {
  /** 指定单个 Key；与 userId 二选一，同时给出时以 keyId 为准。 */
  keyId?: string;
  /** 作用于该用户的**全部** Key（账户级处罚用）。 */
  userId?: string;
  status: "active" | "throttled" | "suspended";
  reason: string;
  source: string;
  /** 处罚时长；省略且 status=suspended 时表示永久。 */
  durationHours?: number;
  /** 降速后的每分钟额度；省略时读取侧按 rateLimit 的 10% 计算。 */
  effectiveRateLimit?: number;
}

export async function setApiKeyPenalty(
  input: ApiKeyPenaltyInput,
): Promise<{ modified: number; matched: number }> {
  const filter = input.keyId ? { keyId: input.keyId } : { userId: input.userId || "" };
  if (!input.keyId && !input.userId) {
    return { modified: 0, matched: 0 };
  }

  const penaltyUntil =
    input.status === "active"
      ? null
      : typeof input.durationHours === "number" && Number.isFinite(input.durationHours) && input.durationHours > 0
        ? new Date(Date.now() + input.durationHours * 60 * 60 * 1000)
        : null;

  const result = await ApiKeyModel.updateMany(filter, {
    $set: {
      status: input.status,
      penaltyUntil,
      penaltyReason: input.reason.slice(0, 512),
      penaltySource: input.source.slice(0, 128),
      effectiveRateLimit:
        input.status === "throttled" && typeof input.effectiveRateLimit === "number"
          ? Math.max(1, Math.floor(input.effectiveRateLimit))
          : null,
      updatedAt: new Date(),
    },
  });

  logger.warn("[ApiKey] 已应用 Key 处罚", {
    scope: input.keyId ? `key:${input.keyId}` : `user:${input.userId}`,
    status: input.status,
    source: input.source,
    matched: result.matchedCount,
    modified: result.modifiedCount,
  });

  return { modified: result.modifiedCount, matched: result.matchedCount };
}
