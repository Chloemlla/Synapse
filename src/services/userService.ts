import validator from "validator";
import type { User as UserType } from "../utils/userStorageTypes";
import { mongoose } from "./mongoService";
import logger from "../utils/logger";
import { USER_DELETED_FIELD, activeUserFilter, isSoftDeleted } from "../utils/softDeleteState";
import { retireIdentity } from "./blockedIdentityService";
import { hasPasswordMaterial, PASSWORD_MATERIAL_FIELDS } from "../utils/passwordMaterial";
import {
  canDecryptPassword,
  protectPassword,
  verifyPasswordHash,
} from "../utils/passwordSecurity";
import {
  buildAdminUserMatchStage,
  buildAdminUserStatsGroup,
  getAdminUserSortField,
  normalizeAdminUserStats,
  type AdminUserListQueryParams,
  type AdminUserListPageResult,
} from "./adminUserListAggregation";

const userSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    // RC-47：username/email 的「唯一」不再用字段级 unique:true，而是下方显式的**部分唯一索引**
    // （只约束活跃账号）。原因：软删除后要把邮箱释放给用户重新注册，
    // 但是否真允许重注由 `blocked_identities` 墓碑裁决（可解释、可人工释放）。
    username: { type: String, required: true },
    email: { type: String, required: true },
    password: { type: String },
    passwordHash: { type: String },
    passwordCiphertext: { type: String },
    passwordIv: { type: String },
    passwordTag: { type: String },
    passwordKeyVersion: { type: String, default: "v1" },
    passwordWrappedDek: { type: String },
    passwordDekId: { type: String },
    role: { type: String, enum: ["user", "admin", "superadmin", "trusted"], default: "user" },
    dailyUsage: { type: Number, default: 0 },
    lastUsageDate: { type: String },
    createdAt: { type: String },
    token: String,
    tokenExpiresAt: Number,
    totpSecret: String,
    totpEnabled: Boolean,
    backupCodes: [String],
    // G2-13: TOTP 已使用的最新 counter，用于重放防护
    lastTotpCounter: Number,
    passkeyEnabled: Boolean,
    passkeyCredentials: [
      {
        id: String,
        name: String,
        credentialID: String,
        credentialPublicKey: String,
        counter: Number,
        createdAt: String,
      },
    ],
    pendingChallenge: String,
    // G2-11: passkey challenge 过期时间戳（TTL ≤ 5 分钟）
    pendingChallengeExpiresAt: Number,
    currentChallenge: String,
    passkeyVerified: Boolean,
    avatarUrl: { type: String }, // 新增头像URL字段
    authProvider: { type: String, enum: ["local", "linuxdo", "google"], default: "local" },
    linuxdoId: { type: String, unique: true, sparse: true },
    linuxdoUsername: { type: String },
    linuxdoAvatarUrl: { type: String },
    // 指纹预约需求持久化
    requireFingerprint: { type: Boolean, default: false },
    requireFingerprintAt: { type: Number, default: 0 },
    // 用户是否已经关闭过一次指纹请求（一生只能关闭一次）
    fingerprintRequestDismissedOnce: { type: Boolean, default: false },
    fingerprintRequestDismissedAt: { type: Number, default: 0 }, // 关闭时间戳
    // 新增：指纹记录（历史）
    fingerprints: [
      {
        id: { type: String },
        ts: { type: Number },
        ua: { type: String },
        ip: { type: String },
        deviceInfo: { type: mongoose.Schema.Types.Mixed },
      },
    ],
    // 上次登录IP和时间（用于异地登录检测）
    lastLoginIp: { type: String },
    lastLoginAt: { type: String },
    // 工单违规处罚相关
    ticketViolationCount: { type: Number, default: 0 },
    ticketBannedUntil: { type: String }, // ISO 日期字符串
    // LibreChat 每日额度与超额自动封禁（见 services/libreChatQuotaService）：与 TTS 的 dailyUsage
    // 分账，避免两个功能互吃额度；这些字段必须登记进 schema，否则 strict 模式会静默丢弃写入。
    libreChatDailyUsage: { type: Number, default: 0 },
    libreChatUsageDay: { type: String }, // 上海自然日的天键（YYYY-MM-DD）
    libreChatViolationCount: { type: Number, default: 0 },
    libreChatBannedUntil: { type: String }, // ISO 日期字符串
    // 翻译权限与账户状态
    isTranslationEnabled: { type: Boolean, default: true },
    translationAccessUntil: { type: String },
    accountStatus: { type: String, enum: ["active", "suspended"], default: "active" },
    disabled: { type: Boolean, default: false },

    // ── 软删除账号（RC-01 / RC-11 / RC-21）──────────────────────────────────
    // 0 / 缺省 = 未删除；> 0 = 被软删除的时间戳。删号不再物理删除文档：
    // 设备、行为、IP、邀请码使用链路等风控证据因此得以保留（RC-22 取证保留）。
    deletedAt: { type: Number, default: 0, index: true },
    deletedBy: { type: String },
    deleteReason: { type: String },
    // 软删除时把 username/email 换成占位值以释放唯一索引；原值另存，供调查比对。
    deletedOriginalUsername: { type: String },
    deletedOriginalEmail: { type: String },

    // ── 账户风险（RC-04）────────────────────────────────────────────────
    // riskTier 单调升级、可人工降级；缺省 normal，存量文档无需回填。
    riskTier: {
      type: String,
      enum: ["normal", "watch", "restricted", "danger"],
      default: "normal",
      index: true,
    },
    // 0-100，越高越危险。注意与 accountSecuritySummary 的「越高越安全」方向相反，勿混用。
    riskScore: { type: Number, default: 0 },
    riskFlags: { type: [String], default: [] },
    riskUpdatedAt: { type: Number, default: 0 },
    flaggedBy: { type: String },
    flagReason: { type: String },
    // 逐步验证（RC-02/RC-03）：0 = 不强制；> now 表示该时刻前每次操作都要验。
    stepUpUntil: { type: Number, default: 0 },
    stepUpMode: { type: String, enum: ["sensitive", "all-writes", "all"], default: "sensitive" },
  },
  { collection: "user_datas" },
);

userSchema.index({ role: 1, createdAt: 1 });

/**
 * 「活跃账号」的部分索引过滤条件（RC-47）。
 *
 * 语义上等价于 `utils/softDeleteState.ts` 的 `activeUserFilter()`（`$in: [0, null]`），
 * 但这里刻意改用 `$or` + 等值/`$exists` 这组**部分索引最保守的子集**：
 * partialFilterExpression 只允许有限运算符，用最保守的写法能避开“表达式被拒 → 索引建不出来”
 * 这类只在线上才会发作的故障。
 *
 * ⚠ 不能用 `{ deletedAt: { $eq: null } }`：本模型的 deletedAt 是**数字 0** 表示未删除，
 * `$eq: null` 只匹配「缺失或 null」，**不会匹配 0** —— 那样索引会把全部存量活跃账号排除在外，
 * 等于把邮箱唯一性直接取消（比它要解决的洗白问题更严重）。
 */
const ACTIVE_USER_PARTIAL_FILTER = {
  $or: [{ deletedAt: 0 }, { deletedAt: { $exists: false } }],
};

// 唯一性只在活跃账号之间成立；已软删除的账号不再占着邮箱/用户名（否则无法重注）。
// 是否允许重注由 blocked_identities 墓碑在应用层裁决。
userSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: ACTIVE_USER_PARTIAL_FILTER },
);
userSchema.index(
  { username: 1 },
  { unique: true, partialFilterExpression: ACTIVE_USER_PARTIAL_FILTER },
);

const UserModel = mongoose.models.User || mongoose.model("User", userSchema);

/**
 * 「未软删除」判据（RC-01）。字段名与 `$in: [0, null]` 的理由见 `utils/softDeleteState.ts`；
 * 用户/管理端的列举与查重都要带上它；
 * **只有鉴权路径例外** —— 鉴权要「看得到已删除用户」才能回准确的 403。
 */
const ACTIVE_USER_FILTER = activeUserFilter();

/** 该用户是否已被软删除。兼容 mongoose 文档与 lean 普通对象。 */
export const isUserSoftDeleted = (user: unknown): boolean => isSoftDeleted(user, USER_DELETED_FIELD);

// G2-22: 默认公开投影不再带出 totpSecret / backupCodes 等离线 2FA 秘密。
const PUBLIC_USER_SELECT =
  "id username email role avatarUrl authProvider linuxdoId linuxdoUsername linuxdoAvatarUrl totpEnabled passkeyEnabled passkeyCredentials pendingChallenge pendingChallengeExpiresAt currentChallenge passkeyVerified requireFingerprint requireFingerprintAt fingerprintRequestDismissedOnce fingerprintRequestDismissedAt fingerprints lastLoginIp lastLoginAt ticketViolationCount ticketBannedUntil libreChatDailyUsage libreChatUsageDay libreChatViolationCount libreChatBannedUntil isTranslationEnabled translationAccessUntil accountStatus dailyUsage lastUsageDate createdAt token tokenExpiresAt lastTotpCounter deletedAt";

// 安全的公开用户字段选择（排除敏感认证凭据），用于 /api/user/me 等普通用户 API
const PUBLIC_USER_SAFE_SELECT =
  "id username email role avatarUrl authProvider linuxdoId linuxdoUsername linuxdoAvatarUrl totpEnabled passkeyEnabled requireFingerprint requireFingerprintAt fingerprintRequestDismissedOnce fingerprintRequestDismissedAt lastLoginIp lastLoginAt ticketViolationCount ticketBannedUntil libreChatDailyUsage libreChatUsageDay libreChatViolationCount libreChatBannedUntil isTranslationEnabled translationAccessUntil accountStatus dailyUsage lastUsageDate createdAt lastTotpCounter";

// G2-22: 只有明确需要 2FA 秘密的调用方（totpController、passkeyService verify 等）才使用该投影。
const USER_SECRETS_SELECT = `${PUBLIC_USER_SELECT} totpSecret backupCodes`;
const AUTH_USER_SELECT =
  `${PUBLIC_USER_SELECT} password passwordHash passwordCiphertext passwordIv passwordTag passwordKeyVersion passwordWrappedDek passwordDekId totpSecret backupCodes`;
const ADMIN_USER_LIST_PROJECT = {
  _id: 0,
  id: 1,
  username: 1,
  email: 1,
  role: 1,
  avatarUrl: 1,
  authProvider: 1,
  linuxdoId: 1,
  linuxdoUsername: 1,
  linuxdoAvatarUrl: 1,
  totpEnabled: 1,
  passkeyEnabled: 1,
  passkeyVerified: 1,
  requireFingerprint: 1,
  requireFingerprintAt: 1,
  fingerprintRequestDismissedOnce: 1,
  fingerprintRequestDismissedAt: 1,
  lastLoginIp: 1,
  lastLoginAt: 1,
  ticketViolationCount: 1,
  ticketBannedUntil: 1,
  // LibreChat 额度/封禁状态：管理端用户详情要能看到「为什么被限」，故随列表一起下推。
  libreChatDailyUsage: 1,
  libreChatUsageDay: 1,
  libreChatViolationCount: 1,
  libreChatBannedUntil: 1,
  isTranslationEnabled: 1,
  translationAccessUntil: 1,
  accountStatus: 1,
  dailyUsage: 1,
  lastUsageDate: 1,
  createdAt: 1,
  // RC-01 / RC-04：管理端是唯一能看到「已删除账号 + 风险档」的地方。
  // 默认列表会按 deletedAt 过滤，这些字段是给管理员专页（默认隐藏后手动切换）用的。
  deletedAt: 1,
  deletedBy: 1,
  deleteReason: 1,
  riskTier: 1,
  riskScore: 1,
  riskFlags: 1,
  riskUpdatedAt: 1,
  flaggedBy: 1,
  flagReason: 1,
  stepUpUntil: 1,
  stepUpMode: 1,
  fingerprintCount: { $size: { $ifNull: ["$fingerprints", []] } },
  latestFingerprint: {
    $let: {
      vars: { fingerprints: { $ifNull: ["$fingerprints", []] } },
      in: { $arrayElemAt: ["$$fingerprints", -1] },
    },
  },
};

// 工具函数：彻底删除对象中的avatarBase64字段
function removeAvatarBase64(obj: any) {
  if (obj && typeof obj === "object" && "avatarBase64" in obj) {
    delete obj.avatarBase64;
  }
  return obj;
}

const parsedUserCacheTtlMs = Number(process.env.USER_BY_ID_CACHE_TTL_MS || 10_000);
const USER_BY_ID_CACHE_TTL_MS = Number.isFinite(parsedUserCacheTtlMs)
  ? Math.max(0, Math.min(60_000, parsedUserCacheTtlMs))
  : 10_000;
const parsedUserCacheMax = Number(process.env.USER_BY_ID_CACHE_MAX || 1000);
const USER_BY_ID_CACHE_MAX = Number.isFinite(parsedUserCacheMax)
  ? Math.max(100, Math.min(10_000, Math.floor(parsedUserCacheMax)))
  : 1000;

const userByIdCache = new Map<string, { user: UserType; expiresAt: number }>();

function cloneUser(user: UserType): UserType {
  return { ...user };
}

function getCachedUserById(id: string): UserType | null {
  if (USER_BY_ID_CACHE_TTL_MS <= 0) return null;
  const cached = userByIdCache.get(id);
  if (!cached) return null;

  if (cached.expiresAt <= Date.now()) {
    userByIdCache.delete(id);
    return null;
  }

  userByIdCache.delete(id);
  userByIdCache.set(id, cached);
  return cloneUser(cached.user);
}

function setCachedUserById(user: UserType): UserType {
  if (!user?.id || USER_BY_ID_CACHE_TTL_MS <= 0) {
    return user;
  }

  if (userByIdCache.size >= USER_BY_ID_CACHE_MAX) {
    const oldestKey = userByIdCache.keys().next().value as string | undefined;
    if (oldestKey) {
      userByIdCache.delete(oldestKey);
    }
  }

  userByIdCache.set(user.id, {
    user: cloneUser(user),
    expiresAt: Date.now() + USER_BY_ID_CACHE_TTL_MS,
  });
  return cloneUser(user);
}

function invalidateCachedUserById(id: string): void {
  userByIdCache.delete(id);
}

export const getAllUsers = async (): Promise<UserType[]> => {
  // G2-22: 默认取安全投影，不携带 totpSecret/backupCodes。
  // RC-01: 已软删除账号不进用户列表（含 lastSuperadmin 判定）。
  const docs = await UserModel.find(ACTIVE_USER_FILTER).select(PUBLIC_USER_SELECT).lean();
  return docs.map(removeAvatarBase64) as unknown as UserType[];
};

export const getAdminUserList = async (opts: { includeFingerprints?: boolean } = {}): Promise<UserType[]> => {
  if (opts.includeFingerprints) {
    return getAllUsers();
  }

  const docs = await UserModel.aggregate([{ $match: ACTIVE_USER_FILTER }, { $project: ADMIN_USER_LIST_PROJECT }]);
  return docs.map(removeAvatarBase64) as unknown as UserType[];
};

// ========== G4-19: 管理端用户列表下推 aggregation ==========
// 筛选/排序/分页/统计 pipeline 构建逻辑在 ./adminUserListAggregation（避免本文件超 800 行）。

export type { AdminUserListQueryParams, AdminUserListPageResult, AdminUserListStats } from "./adminUserListAggregation";

export const getAdminUserListPage = async (
  query: AdminUserListQueryParams,
  includeFingerprints: boolean,
): Promise<AdminUserListPageResult> => {
  const nowIso = new Date().toISOString();
  // RC-01：已软删除账号默认不进管理端列表，也不进全量统计（否则列表页总数会对不上）。
  const match = { $and: [buildAdminUserMatchStage(query), ACTIVE_USER_FILTER] };
  const sortField = getAdminUserSortField(query);
  const sortDir = query.sortOrder === "asc" ? 1 : -1;
  const project = includeFingerprints ? { ...ADMIN_USER_LIST_PROJECT, fingerprints: 1 } : ADMIN_USER_LIST_PROJECT;

  const facetResults = await UserModel.aggregate([
    { $match: match },
    {
      $facet: {
        metadata: [{ $count: "total" }],
        filteredStats: [{ $group: buildAdminUserStatsGroup(nowIso) }],
        data: [
          { $sort: { [sortField]: sortDir } },
          { $skip: (query.page - 1) * query.pageSize },
          { $limit: query.pageSize },
          { $project: project },
        ],
      },
    },
  ]);

  const facet = facetResults[0] || {};
  const total = Number((facet as any).metadata?.[0]?.total || 0);
  const filteredStats = normalizeAdminUserStats((facet as any).filteredStats?.[0]);
  const users = ((facet as any).data || []).map(removeAvatarBase64) as unknown as UserType[];

  const allStatsResults = await UserModel.aggregate([
    { $match: ACTIVE_USER_FILTER },
    { $group: buildAdminUserStatsGroup(nowIso) },
  ]);
  const stats = normalizeAdminUserStats(allStatsResults[0]);

  return { users, total, stats, filteredStats };
};

export const getAllUsersAuth = async (): Promise<UserType[]> => {
  const docs = await UserModel.find(ACTIVE_USER_FILTER).select(AUTH_USER_SELECT).lean();
  return docs.map(removeAvatarBase64) as unknown as UserType[];
};

export const getUserById = async (id: string): Promise<UserType | null> => {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error("非法的用户ID");
  }
  const cached = getCachedUserById(id);
  if (cached) {
    return cached;
  }

  const doc = await UserModel.findOne({ id })
    .select(PUBLIC_USER_SELECT)
    .lean();

  if (!doc) return null;
  return setCachedUserById(removeAvatarBase64(doc) as unknown as UserType);
};

export const getUserByUsername = async (username: string): Promise<UserType | null> => {
  if (typeof username !== "string" || !/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    throw new Error("非法的用户名");
  }
  const doc = await UserModel.findOne({ username, ...ACTIVE_USER_FILTER })
    .select(PUBLIC_USER_SELECT)
    .lean();

  if (!doc) return null;
  return removeAvatarBase64(doc) as unknown as UserType;
};

export const getUserByLinuxDoId = async (linuxdoId: string): Promise<UserType | null> => {
  if (typeof linuxdoId !== "string" || !linuxdoId.trim()) {
    return null;
  }

  const doc = await UserModel.findOne({ linuxdoId: linuxdoId.trim() })
    .select(PUBLIC_USER_SELECT)
    .lean();

  if (!doc) return null;
  return removeAvatarBase64(doc) as unknown as UserType;
};

export const getUserByEmail = async (email: string): Promise<UserType | null> => {
  // 防注入：只允许字符串类型且为合法邮箱
  if (typeof email !== "string") return null;
  const safeEmail = email.trim();
  if (!validator.isEmail(safeEmail)) return null;
  const doc = await UserModel.findOne({ email: safeEmail, ...ACTIVE_USER_FILTER })
    .select(PUBLIC_USER_SELECT)
    .lean();

  if (!doc) return null;
  return removeAvatarBase64(doc) as unknown as UserType;
};

export const getUserByEmailCaseInsensitive = async (email: string): Promise<UserType | null> => {
  // 防注入：只允许字符串类型且为合法邮箱
  if (typeof email !== "string") return null;
  const safeEmail = email.trim();
  if (!safeEmail || !validator.isEmail(safeEmail)) return null;

  // 精确匹配走 email 唯一索引；只有大小写不一致的历史数据才落到不可走索引的正则查询
  const exact = await UserModel.findOne({ email: safeEmail, ...ACTIVE_USER_FILTER })
    .select(PUBLIC_USER_SELECT)
    .lean();
  if (exact) return removeAvatarBase64(exact) as unknown as UserType;

  const escaped = safeEmail.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, (ch) => `\\${ch}`);
  const doc = await UserModel.findOne({ email: new RegExp(`^${escaped}$`, "i"), ...ACTIVE_USER_FILTER })
    .select(PUBLIC_USER_SELECT)
    .lean();

  if (!doc) return null;
  return removeAvatarBase64(doc) as unknown as UserType;
};

export const getUserByToken = async (token: string): Promise<UserType | null> => {
  if (typeof token !== "string" || !token) {
    return null;
  }
  const doc = await UserModel.findOne({ token })
    .select(PUBLIC_USER_SELECT)
    .lean();

  if (!doc) return null;
  return removeAvatarBase64(doc) as unknown as UserType;
};

export const getUsersByIds = async (ids: string[]): Promise<UserType[]> => {
  if (!ids || ids.length === 0) return [];
  const docs = await UserModel.find({ id: { $in: ids } })
    .select(PUBLIC_USER_SELECT)
    .lean();
  return docs.map((d) => removeAvatarBase64(d)) as unknown as UserType[];
};

export const bulkUpdateUsers = async (ops: Array<{ updateOne: { filter: Record<string, unknown>; update: Record<string, unknown> } }>): Promise<void> => {
  if (!ops || ops.length === 0) return;
  await UserModel.bulkWrite(ops as any);
  // G2-31: 批量写会绕过 updateUser 的失效逻辑，直接清空整个缓存，
  // 避免被封停/降权的账号在最长 10 秒内仍从缓存读到旧状态。
  userByIdCache.clear();
};

export const createUser = async (user: UserType): Promise<UserType> => {
  const { password, ...rest } = user;
  const protectedPassword = await protectPassword(user.id, password || "");
  const doc = await UserModel.create({
    ...rest,
    ...protectedPassword,
    password: undefined,
  });
  return setCachedUserById(removeAvatarBase64(doc.toObject()) as unknown as UserType);
};

export const updateUser = async (id: string, updates: Partial<UserType>): Promise<UserType | null> => {
  // 只允许字符串id，且不能包含特殊字符
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error("非法的用户ID");
  }
  const sanitizedUpdates = { ...updates } as Partial<UserType>;
  if (typeof sanitizedUpdates.password === "string" && sanitizedUpdates.password.trim()) {
    Object.assign(sanitizedUpdates, await protectPassword(id, sanitizedUpdates.password.trim()));
  }
  delete sanitizedUpdates.password;

  const updateOps: any = { $set: {}, $unset: { password: "" } };
  for (const key in sanitizedUpdates) {
    if ((sanitizedUpdates as any)[key] === undefined) {
      if (!updateOps.$unset) updateOps.$unset = {};
      updateOps.$unset[key] = "";
    } else if (key !== "avatarBase64") {
      updateOps.$set[key] = (sanitizedUpdates as any)[key];
    }
  }
  // 如果$set为空对象，删除它
  if (Object.keys(updateOps.$set).length === 0) delete updateOps.$set;
  if (process.env.USER_SERVICE_DEBUG_LOGS === "true") {
    console.log("[updateUser] 更新条件:", { id }, "更新内容:", updateOps);
  }
  invalidateCachedUserById(id);
  const doc = await UserModel.findOneAndUpdate({ id }, updateOps, { returnDocument: "after" })
    .select(PUBLIC_USER_SELECT)
    .lean();

  if (process.env.USER_SERVICE_DEBUG_LOGS === "true") {
    console.log("[updateUser] 更新后文档:", removeAvatarBase64(doc));
  }
  return doc ? setCachedUserById(removeAvatarBase64(doc) as unknown as UserType) : null;
};

/**
 * 原子自增用户工单违规次数并返回自增后的新计数。
 * updateUser 的 read-modify-write 在并发违规时会互相覆盖计数，这里用 $inc 一次性完成。
 */
export const incrementUserTicketViolationCount = async (id: string): Promise<number> => {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error("非法的用户ID");
  }
  invalidateCachedUserById(id);
  const doc = await UserModel.findOneAndUpdate(
    { id },
    { $inc: { ticketViolationCount: 1 } },
    { returnDocument: "after", projection: { ticketViolationCount: 1 } },
  ).lean();
  return Number((doc as { ticketViolationCount?: number } | null)?.ticketViolationCount ?? 1);
};

// RC-01 / RC-21：账号被软删除时要一起打标记的从属集合。
// G2-30: 级联集合及其归属字段名（逐集合修正，避免统一用 userId 导致静默失效）。
// audit_logs 不在其中 —— 删号本就不该动审计日志。
//
// 已知遗留：`access_tokens` 的真实文档里**没有 userId**（只有 token/fingerprint/ipAddress，
// 见 models/accessTokenModel.ts），所以这一条是死条件。保留在此不删，以免误以为已经覆盖；
// 该集合带 5 分钟 TTL，随指纹失效即可。真正需要失效的会话在 auth_sessions。
const USER_CASCADE_COLLECTIONS: ReadonlyArray<{ collection: string; field: string }> = [
  { collection: "access_tokens", field: "userId" },
  { collection: "auth_sessions", field: "userId" },
  { collection: "verification_tokens", field: "userId" },
  { collection: "api_keys", field: "userId" },
  { collection: "api_key_billing_events", field: "userId" },
  { collection: "bilibili_account_bindings", field: "userId" },
  { collection: "bilibili_sync", field: "userId" },
  { collection: "nexai_sync", field: "userId" },
  { collection: "nexai_sync_v2_records", field: "userId" },
  { collection: "collaboration_sessions", field: "userId" },
  { collection: "invitations", field: "userId" },
  { collection: "workspaces", field: "creatorId" },
  { collection: "voice_projects", field: "ownerId" },
  { collection: "linuxdo_credit_orders", field: "userId" },
  { collection: "device_trackings", field: "userId" },
  { collection: "tickets", field: "userId" },
  { collection: "translation_logs", field: "userId" },
  { collection: "user_preferences", field: "userId" },
  { collection: "recommendation_history", field: "userId" },
  { collection: "security_events", field: "userId" },
  { collection: "oauth_clients", field: "ownerUserId" },
  { collection: "oauth_grants", field: "userId" },
  { collection: "oauth_tokens", field: "userId" },
  { collection: "oauth_authorization_codes", field: "userId" },
  { collection: "account_identities", field: "userId" },
  { collection: "artifacts", field: "userId" },
  { collection: "cdks", field: "userId" },
  { collection: "registration_invites", field: "userId" },
  { collection: "short_urls", field: "userId" },
];

/**
 * 软删除账号（RC-01 / RC-11 / RC-21）。
 *
 * 与旧的 deleteUser 的差别：不再物理删除用户文档与从属集合，只打标记，
 * 并让凭据**功能性失效**（会话撤销、API Key 禁用、主档密码材料清空）。
 * 依据：owner 决策 —— 前端/法务文案保持「不可恢复」，但底层数据要留给调查取证（RC-22）。
 *
 * 幂等：已软删除的账号重复调用直接返回 true。
 */
export const softDeleteUser = async (
  id: string,
  options: { by?: string; reason?: string } = {},
): Promise<boolean> => {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error("非法的用户ID");
  }
  invalidateCachedUserById(id);

  const existing = await UserModel.findOne({ id }).select("id username email deletedAt").lean();
  if (!existing) return false;
  if (isUserSoftDeleted(existing)) return true;

  const db = mongoose.connection.db;
  if (!db) {
    throw new Error("数据库连接不可用");
  }

  const now = Date.now();
  const by = options.by ?? "auto";
  const reason = options.reason ?? "account_deleted";
  const record = existing as { username?: string; email?: string };
  // 从属集合用统一字段名（见 softDeleteService 的字段约定）；用户主档用自己的 deletedAt。
  const cascadeMark = {
    $set: { subjectDeletedAt: now, deletedBy: by, deleteReason: reason },
  };
  const cascadeFilter = (field: string) => ({
    $and: [{ [field]: id }, { subjectDeletedAt: { $in: [0, null] } }],
  });

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      // 1) 从属集合一律只标记，不物理删除：设备/行为/IP/邀请码使用链路是风控证据。
      const results = await Promise.all(
        USER_CASCADE_COLLECTIONS.map(({ collection, field }) =>
          db.collection(collection).updateMany(cascadeFilter(field), cascadeMark, { session }),
        ),
      );
      const unacknowledged = results.filter((result) => result.acknowledged === false);
      if (unacknowledged.length > 0) {
        throw new Error(`级联标记失败: ${unacknowledged.length} 个集合未被确认`);
      }

      // 2) 凭据功能性失效：只打标记不够，未过期的会话与 Key 必须真的用不了。
      await db.collection("auth_sessions").updateMany(
        { userId: id, revokedAt: null },
        { $set: { revokedAt: new Date(), updatedAt: new Date() } },
        { session },
      );
      await db.collection("api_keys").updateMany({ userId: id }, { $set: { enabled: false } }, { session });
      await db.collection("oauth_tokens").updateMany({ userId: id }, { $set: { revokedAt: new Date() } }, { session });

      // 2.5) RC-47：先写身份墓碑，再打软删除标记，**两者同一事务**。
      // 不能出现“账号已软删除但没有墓碑”的窗口 —— 那个窗口就是“注销再注册洗白”的入口。
      await retireIdentity(
        { userId: id, username: record.username ?? "", email: record.email ?? "", reason },
        session,
      );

      // 3) 用户主档：清凭据 + 打软删除标记。
      // **刻意不改 username/email**：唯一索引本身就是“禁止直接重注”的硬兜底；
      // 旧实现把它们改成 deleted_<id> 以“释放唯一索引”，等于给攻击者一条零成本洗白路径（RC-47）。
      // 原值另存是为了调查比对与历史可读。
      await UserModel.updateOne(
        { id },
        {
          $set: {
            deletedAt: now,
            deletedBy: by,
            deleteReason: reason,
            deletedOriginalUsername: record.username ?? "",
            deletedOriginalEmail: record.email ?? "",
            accountStatus: "suspended",
          },
          // 凭据必须清：不清就会变成「删了还能登」。
          // linuxdoId 是 unique+sparse，不 unset 会让同一 Linux.do 账号无法重新注册。
          // 字面量内联而不是抽常量：让 TS 直接校验键名与 schema 对齐。
          $unset: {
            password: "",
            passwordHash: "",
            passwordCiphertext: "",
            passwordIv: "",
            passwordTag: "",
            passwordWrappedDek: "",
            passwordDekId: "",
            totpSecret: "",
            totpEnabled: "",
            backupCodes: "",
            passkeyEnabled: "",
            passkeyCredentials: "",
            pendingChallenge: "",
            pendingChallengeExpiresAt: "",
            currentChallenge: "",
            passkeyVerified: "",
            token: "",
            tokenExpiresAt: "",
            linuxdoId: "",
          },
        },
      ).session(session);
    });
  } finally {
    await session.endSession();
  }

  logger.info("[UserService] 账号已软删除", { id, by, reason });
  return true;
};

/**
 * 物理删除账号：**仅限注册流程回滚**（邀请码消费失败、邮箱验证落库失败等）。
 * 那种场景下账号从未真正存在过，软删除反而会留下占着邮箱的幽灵账号。
 * 用户/管理员的删号一律走 softDeleteUser（RC-01）。
 */
export const hardDeleteUser = async (id: string): Promise<void> => {
  invalidateCachedUserById(id);

  const db = mongoose.connection.db;
  if (!db) {
    throw new Error("数据库连接不可用");
  }

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const results = await Promise.all(
        USER_CASCADE_COLLECTIONS.map(({ collection, field }) =>
          db.collection(collection).deleteMany({ [field]: id }, { session }),
        ),
      );
      const unacknowledged = results.filter((result) => result.acknowledged === false);
      if (unacknowledged.length > 0) {
        throw new Error(`级联清理失败: ${unacknowledged.length} 个集合未被确认`);
      }
      await UserModel.deleteOne({ id }).session(session);
    });
  } finally {
    await session.endSession();
  }
};

/**
 * @deprecated 语义已改为**软删除**（RC-01）。
 * 保留同名导出是为了不一次性改动所有管理员调用点；新代码请显式用
 * `softDeleteUser`（用户/管理员删号）或 `hardDeleteUser`（仅注册回滚）。
 * 注意：可直接调用，参数与旧签名兼容；但**不再接收** `string` 之外的旧用法。
 */
export const deleteUser = async (id: string, options: { by?: string; reason?: string } = {}): Promise<void> => {
  await softDeleteUser(id, options);
};

export const getUserAuthById = async (id: string): Promise<UserType | null> => {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error("非法的用户ID");
  }
  const doc = await UserModel.findOne({ id }).select(AUTH_USER_SELECT).lean();
  return doc ? (removeAvatarBase64(doc) as unknown as UserType) : null;
};

// G2-22: 明确需要 TOTP 秘密/恢复码的调用方专用投影（totpController、passkeyService verify 等）。
export const getUserSecretsById = async (id: string): Promise<UserType | null> => {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error("非法的用户ID");
  }
  const doc = await UserModel.findOne({ id }).select(USER_SECRETS_SELECT).lean();
  return doc ? (removeAvatarBase64(doc) as unknown as UserType) : null;
};

/**
 * 账号安全总览所需的**两项事实**，用一次窄查询算出来。
 *
 * 为什么不直接读 `getUserById`：它的公开投影（PUBLIC_USER_SELECT，G2-22）不含密码字段
 * 与 backupCodes，于是安全清单会分别误报「没设密码」与「恢复码已用尽」。
 * 这里也只把布尔/计数带出去，密码材料与恢复码本体不离开存储层。
 */
export interface AccountSecurityFacts {
  hasPassword: boolean;
  backupCodesRemaining: number;
}

export const getAccountSecurityFacts = async (id: string): Promise<AccountSecurityFacts | null> => {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error("非法的用户ID");
  }
  const doc = await UserModel.findOne({ id })
    .select([...PASSWORD_MATERIAL_FIELDS, "backupCodes"].join(" "))
    .lean();
  if (!doc) return null;
  const record = doc as unknown as Record<string, unknown> & { backupCodes?: string[] };
  return {
    hasPassword: hasPasswordMaterial(record),
    backupCodesRemaining: Array.isArray(record.backupCodes) ? record.backupCodes.length : 0,
  };
};

/**
 * 账户风险聚合（RC-06）所需的最小读取面。
 *
 * 为什么不直接用 `getUserById`：它走 `PUBLIC_USER_SELECT`，而风控字段刻意**不进**公开投影
 *（D2：风控分只在管理端可见）。这里用独立投影读，既拿得到聚合所需的档位/旗标，
 * 又不会把 riskScore/riskFlags 泄进任何用户自助接口。
 */
export interface AccountRiskState {
  id: string;
  role: string;
  createdAt?: string;
  riskTier?: "normal" | "watch" | "restricted" | "danger";
  riskScore?: number;
  riskFlags?: string[];
  riskUpdatedAt?: number;
  flaggedBy?: string;
  flagReason?: string;
  stepUpUntil?: number;
  stepUpMode?: "sensitive" | "all-writes" | "all";
  totpEnabled?: boolean;
  passkeyEnabled?: boolean;
  accountStatus?: string;
  deletedAt?: number;
}

export const getAccountRiskState = async (id: string): Promise<AccountRiskState | null> => {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id)) return null;
  const doc = await UserModel.findOne({ id })
    .select(
      "id role createdAt riskTier riskScore riskFlags riskUpdatedAt flaggedBy flagReason stepUpUntil stepUpMode totpEnabled passkeyEnabled accountStatus deletedAt",
    )
    .lean();
  return doc ? (doc as unknown as AccountRiskState) : null;
};

export const getUserAuthByUsername = async (username: string): Promise<UserType | null> => {
  if (typeof username !== "string" || !/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    throw new Error("非法的用户名");
  }
  const doc = await UserModel.findOne({ username }).select(AUTH_USER_SELECT).lean();
  return doc ? (removeAvatarBase64(doc) as unknown as UserType) : null;
};

export const getUserAuthByEmail = async (email: string): Promise<UserType | null> => {
  if (typeof email !== "string") return null;
  const safeEmail = email.trim();
  if (!validator.isEmail(safeEmail)) return null;
  const doc = await UserModel.findOne({ email: safeEmail }).select(AUTH_USER_SELECT).lean();
  return doc ? (removeAvatarBase64(doc) as unknown as UserType) : null;
};

export const getPrimaryAdminAuthUser = async () => {
  // 按 createdAt 升序取最早的管理员，与旧的“getAllUsers() 里第一个 admin”保持一致，
  // 并且完全走 { role: 1, createdAt: 1 } 索引。
  const doc = await UserModel.findOne({ role: { $in: ["admin", "superadmin"] } })
    .sort({ createdAt: 1 })
    .select(AUTH_USER_SELECT)
    .lean();
  return doc ? (removeAvatarBase64(doc) as unknown as UserType) : null;
};

export const verifyAndMigrateUserPassword = async (
  user: UserType,
  password: string,
): Promise<{ valid: boolean; migrated: boolean; user: UserType | null }> => {
  if (await verifyPasswordHash(user.passwordHash, password)) {
    if (canDecryptPassword(user)) {
      return { valid: true, migrated: false, user };
    }

    const protectedPassword = await protectPassword(user.id, password);
    // G2-31: 直接 findOneAndUpdate 绕过 updateUser 的失效逻辑，手动失效缓存。
    invalidateCachedUserById(user.id);
    const updated = await UserModel.findOneAndUpdate(
      { id: user.id },
      {
        $set: protectedPassword,
        $unset: { password: "" },
      },
      { returnDocument: "after" },
    )
      .select(AUTH_USER_SELECT)
      .lean();

    return {
      valid: true,
      migrated: true,
      user: updated ? (removeAvatarBase64(updated) as unknown as UserType) : user,
    };
  }

  if (user.password && user.password === password) {
    const protectedPassword = await protectPassword(user.id, password);
    // G2-31: 同上，手动失效缓存。
    invalidateCachedUserById(user.id);
    const updated = await UserModel.findOneAndUpdate(
      { id: user.id },
      {
        $set: protectedPassword,
        $unset: { password: "" },
      },
      { returnDocument: "after" },
    )
      .select(AUTH_USER_SELECT)
      .lean();

    return {
      valid: true,
      migrated: true,
      user: updated ? (removeAvatarBase64(updated) as unknown as UserType) : user,
    };
  }

  return { valid: false, migrated: false, user: null };
};

export function getUserUsageDay(date: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

export const incrementUserDailyUsageAtomic = async (
  id: string,
  dailyLimit: number,
): Promise<{ success: boolean; user: UserType | null }> => {
  const today = getUserUsageDay();
  const now = new Date().toISOString();

  // G2-29: 单条 findOneAndUpdate + 聚合管道，一次完成「跨日判断 + 增量/重置 + 管理员豁免」。
  // 管理员通过 role 条件排除在本次更新外；并发请求在同一时刻只有一个能匹配并更新。
  // lastUsageDate 保留真实 UTC 时间戳；读写都按上海自然日归桶。
  const sameDay = { $eq: [
    { $dateToString: {
      date: { $convert: { input: "$lastUsageDate", to: "date", onError: null, onNull: null } },
      format: "%Y-%m-%d", timezone: "Asia/Shanghai", onNull: "",
    } },
    today,
  ] };
  const updated = await UserModel.findOneAndUpdate(
    {
      id,
      role: { $nin: ["admin", "superadmin"] },
      $or: [{ $expr: { $not: [sameDay] } }, { dailyUsage: { $lt: dailyLimit } }],
    },
    [
      {
        $set: {
          dailyUsage: {
            $cond: [
              sameDay,
              { $add: [{ $ifNull: ["$dailyUsage", 0] }, 1] },
              1,
            ],
          },
          lastUsageDate: now,
        },
      },
    ],
    { returnDocument: "after" },
  )
    .select(PUBLIC_USER_SELECT)
    .lean();

  if (!updated) {
    // 未命中更新：可能是管理员（豁免），也可能是非管理员已达当日上限。
    const adminDoc = await UserModel.findOne({ id, role: { $in: ["admin", "superadmin"] } })
      .select(PUBLIC_USER_SELECT)
      .lean();
    if (adminDoc) {
      return { success: true, user: removeAvatarBase64(adminDoc) as unknown as UserType };
    }
    return { success: false, user: null };
  }

  const user = setCachedUserById(removeAvatarBase64(updated) as unknown as UserType);
  return {
    success: Boolean(updated),
    user,
  };
};

// G2-11: 原子消费 passkey challenge——只有文档里的 pendingChallenge 与预期一致时才清除并返回，
// 否则说明 challenge 已被使用（重放），返回 null。先清后验，杜绝同一断言被并发重放两次。
export const consumePendingChallenge = async (id: string, expectedChallenge: string): Promise<UserType | null> => {
  const doc = await UserModel.findOneAndUpdate(
    { id, pendingChallenge: expectedChallenge },
    { $unset: { pendingChallenge: "", pendingChallengeExpiresAt: "" } },
    { returnDocument: "after" },
  )
    .select(PUBLIC_USER_SELECT)
    .lean();
  return doc ? (removeAvatarBase64(doc) as unknown as UserType) : null;
};

export { UserModel };

// G2-13: 原子消费 TOTP counter——只有传入的 counter 严格大于已记录值时更新成功，
// 否则说明该 counter 已被使用（重放），返回 false。
// 非有限值（NaN/Infinity）直接拒绝：拿它去 $set 会让 Mongoose 抛 CastError，
// 把整条 TOTP 验证链打成 500（曾发生：verifyDelta 不返回 counter → NaN）。
export const consumeTotpCounter = async (id: string, counter: number): Promise<boolean> => {
  if (!Number.isFinite(counter)) {
    return false;
  }

  const result = await UserModel.updateOne(
    { id, $or: [{ lastTotpCounter: { $exists: false } }, { lastTotpCounter: { $lt: counter } }] },
    { $set: { lastTotpCounter: counter } },
  );
  return Number(result.modifiedCount || 0) > 0;
};
