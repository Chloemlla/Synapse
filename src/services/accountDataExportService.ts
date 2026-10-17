import { mongoose } from "./mongoService";
import { USER_CASCADE_COLLECTIONS } from "./userService";
import { UserStorage } from "../utils/userStorage";
import { sanitizeForExport } from "../utils/credentialRedaction";
import logger from "../utils/logger";

/**
 * 账户数据导出（管理端）。
 *
 * 为什么存在：隐私数据地图里 `user-fingerprints` 的 `export.surface` 早就写着
 * 「admin user export」，但仓库里从来没有这个接口；用户与法务都只能靠人工翻库。
 * 这里补上唯一的导出实现，并且把「哪些数据不导出、为什么」写进导出文件本身，
 * 让管理员拿到的是一个**可解释**的清单，而不是一个看起来不完整的 JSON。
 *
 * 设计约束：
 * - 只读：不修改任何集合；
 * - 脱敏：密码材料、令牌、密钥、密文、内部存储键一律替换为 `[redacted]`，并记录脱敏规则；
 * - 有界：每个数据集有行数上限，超出时标注 `truncated`，不静默截断；
 * - 可解释：隐私数据地图里 `export.supported=false` 的数据集列入 `omitted` 并附原因；
 * - 覆盖面：除显式登记的集合外，`USER_CASCADE_COLLECTIONS` 里其余的账号归属集合
 *   也会被自动纳入（通用标签 + 较小上限），避免新增功能后导出悄悄漏项。
 *
 * 与数据地图保持一致由单测 `src/tests/accountDataExport.test.ts` 比对（docs 不进生产镜像，
 * 故注册表必须硬编码在代码里，测试负责防止它与契约漂移）。
 */

export const ACCOUNT_EXPORT_SCHEMA_VERSION = 1;

/** 单次导出总体积上限：超过时拒绝并提示改用单账号导出（不截断、不静默丢数据）。 */
export const ACCOUNT_EXPORT_MAX_BYTES = 20 * 1024 * 1024;
/** 单次批量导出最多账号数。 */
export const ACCOUNT_EXPORT_MAX_USERS = 10;

export class AccountExportTooLargeError extends Error {
  constructor(public readonly bytes: number) {
    super(`导出内容超过 ${Math.round(ACCOUNT_EXPORT_MAX_BYTES / 1024 / 1024)}MB 上限`);
    this.name = "AccountExportTooLargeError";
  }
}

export interface AccountExportSubject {
  id: string;
  username: string;
  email: string;
  role: string;
  deletedAt: number | null;
  deletedBy: string | null;
  deleteReason: string | null;
  accountStatus: string | null;
}

export interface AccountExportDataset {
  /** 稳定 id：与隐私数据地图的 dataset id 对齐（补充项使用集合名）。 */
  id: string;
  label: string;
  collection: string;
  /** full = 内容完整；partial = 只含元数据或按约定剔除敏感字段。 */
  support: "full" | "partial";
  count: number;
  returned: number;
  truncated: boolean;
  note?: string;
  rows?: unknown[];
}

export interface AccountExportOmitted {
  id: string;
  label: string;
  reason: string;
}

export interface AccountExportDocument {
  schemaVersion: number;
  generatedAt: string;
  requestedBy: { id: string; username: string } | null;
  subject: AccountExportSubject;
  redaction: string;
  profile: Record<string, unknown>;
  datasets: AccountExportDataset[];
  omitted: AccountExportOmitted[];
}

interface ExportSpec {
  id: string;
  label: string;
  collection: string;
  /** 归属字段；`__email__` 表示按账号邮箱匹配。 */
  ownerField: string;
  limit: number;
  support: "full" | "partial";
  note?: string;
}

/**
 * 显式登记的高价值数据集。
 *
 * 顺序即导出文件顺序：先是账号自身与凭据元数据，再是按业务域排列的用户内容。
 */
const EXPLICIT_TARGETS: ExportSpec[] = [
  { id: "auth-sessions", label: "登录会话与设备", collection: "auth_sessions", ownerField: "userId", limit: 200, support: "partial", note: "会话凭据哈希已脱敏" },
  { id: "api-keys", label: "API Key（元数据）", collection: "api_keys", ownerField: "userId", limit: 200, support: "partial", note: "密钥哈希不外发，只保留 keyId 与使用统计" },
  { id: "api-key-billing", label: "API Key 计费事件", collection: "api_key_billing_events", ownerField: "userId", limit: 500, support: "full" },
  { id: "account-identities", label: "第三方登录身份绑定", collection: "account_identities", ownerField: "userId", limit: 20, support: "partial" },
  { id: "policy-consents", label: "政策同意记录", collection: "policy_consents", ownerField: "userId", limit: 200, support: "full" },
  { id: "tickets", label: "客服工单与对话", collection: "tickets", ownerField: "userId", limit: 200, support: "full", note: "附件正文不在此文件内，见「未包含的数据」" },
  { id: "tts-jobs", label: "语音合成任务", collection: "tts_jobs", ownerField: "userId", limit: 200, support: "full" },
  { id: "geogebra-projects", label: "GeoGebra 项目", collection: "geogebra_projects", ownerField: "ownerUserId", limit: 200, support: "full" },
  { id: "geogebra-project-versions", label: "GeoGebra 项目版本", collection: "geogebra_project_versions", ownerField: "ownerUserId", limit: 300, support: "full" },
  { id: "geogebra-review-comments", label: "GeoGebra 评审评论", collection: "geogebra_review_comments", ownerField: "authorUserId", limit: 200, support: "full" },
  { id: "geogebra-public-shares", label: "GeoGebra 公开分享", collection: "geogebra_shares", ownerField: "ownerUserId", limit: 200, support: "full" },
  { id: "geogebra-assets", label: "GeoGebra 资产（元数据）", collection: "geogebra_assets", ownerField: "ownerUserId", limit: 200, support: "partial", note: "二进制正文不随导出，storageKey 已脱敏" },
  { id: "geogebra-jobs", label: "GeoGebra 异步任务", collection: "geogebra_jobs", ownerField: "ownerUserId", limit: 200, support: "full" },
  { id: "pixel-task-access", label: "Pixel 任务访问记录", collection: "pixel_task_access", ownerField: "userId", limit: 200, support: "partial", note: "卡密哈希已脱敏" },
  { id: "data-collections", label: "数据采集记录", collection: "data_collections", ownerField: "userId", limit: 500, support: "full" },
  { id: "recommendation-feedback", label: "推荐反馈", collection: "recommendation_feedback", ownerField: "userId", limit: 100, support: "full" },
  { id: "recommendation-history", label: "推荐历史", collection: "recommendation_history", ownerField: "userId", limit: 5, support: "full" },
  { id: "audit-logs", label: "操作审计日志", collection: "audit_logs", ownerField: "userId", limit: 1000, support: "full", note: "只导出与该账号 userId 直接关联的条目" },
  { id: "email-suppressions", label: "邮件抑制记录", collection: "email_suppressions", ownerField: "__email:email", limit: 20, support: "full" },
  { id: "translation-logs", label: "翻译使用记录", collection: "translation_logs", ownerField: "userId", limit: 500, support: "full" },
  { id: "short-urls", label: "短链", collection: "short_urls", ownerField: "userId", limit: 300, support: "full" },
  { id: "cdks", label: "已兑换资源", collection: "cdks", ownerField: "usedBy.userId", limit: 300, support: "partial" },
  { id: "lottery-fulfillments", label: "抽奖中奖记录", collection: "lottery_fulfillments", ownerField: "userId", limit: 200, support: "full" },
  { id: "linuxdo-credit-orders", label: "LinuxDo 信用订单", collection: "linuxdo_credit_orders", ownerField: "userId", limit: 200, support: "full" },
  { id: "invitations", label: "工作区邀请", collection: "invitations", ownerField: "__email:inviteeEmail", limit: 100, support: "full" },
  { id: "registration-invites", label: "注册邀请码", collection: "registration_invites", ownerField: "userId", limit: 100, support: "full" },
  { id: "bilibili-account-bindings", label: "B 站账号绑定", collection: "bilibili_account_bindings", ownerField: "userId", limit: 20, support: "partial", note: "凭据密文已脱敏" },
  { id: "user-preferences", label: "个人偏好", collection: "user_preferences", ownerField: "userId", limit: 5, support: "full" },
  { id: "security-events", label: "安全事件", collection: "security_events", ownerField: "userId", limit: 300, support: "full" },
  { id: "oauth-grants", label: "OAuth 授权", collection: "oauth_grants", ownerField: "userId", limit: 100, support: "partial" },
  { id: "oauth-clients", label: "OAuth 客户端（元数据）", collection: "oauth_clients", ownerField: "ownerUserId", limit: 50, support: "partial", note: "clientSecret 已脱敏" },
  { id: "devices-doc-tool", label: "文档转换偏好", collection: "doc_tool_prefs", ownerField: "userId", limit: 5, support: "full" },
  { id: "devices-media-tool", label: "媒体工具任务", collection: "media_tool_jobs", ownerField: "ownerId", limit: 100, support: "partial", note: "仅 scope=user 的任务归属账号；管理端任务不在账号数据内" },
  { id: "devices-doc-tool-jobs", label: "文档转换任务", collection: "doc_tool_jobs", ownerField: "userId", limit: 100, support: "partial" },
];

/**
 * 隐私数据地图里明确标注「不可导出」的数据集。
 *
 * 原因直接引用地图里的 `export.reason`，导出文件会把它们列在 `omitted` 里，
 * 这样管理员能回答「为什么这里没有 IP 封禁记录」而不是以为导出漏了。
 */
export const OMITTED_DATASETS: AccountExportOmitted[] = [
  { id: "temp-fingerprints", label: "临时指纹", reason: "短暂的安控信号，不属于账号数据导出范围" },
  { id: "access-tokens", label: "访问令牌", reason: "凭据材料，不外发" },
  { id: "ip-verification-tokens", label: "IP 验证令牌", reason: "凭据材料，不外发" },
  { id: "ip-bans", label: "IP 封禁记录", reason: "安全执行记录，按自身期限保留，不随账号导出" },
  { id: "device-tracking", label: "设备行为遥测", reason: "仅用于管理端调查，不进入账号数据导出" },
  { id: "account-ip-signals", label: "账号 IP 信号", reason: "安全遥测，仅供取证工具使用" },
  { id: "device-fingerprints", label: "设备指纹矩阵", reason: "安全遥测，仅供取证工具使用" },
  { id: "registration-attempts", label: "注册尝试", reason: "按 IP / 指纹 / 邮箱记录的安全遥测，不按账号归属" },
  { id: "blocked-identities", label: "封禁身份", reason: "安全执行记录，可能涉及未注册身份" },
  { id: "ipqs-lookup-logs", label: "IPQS 查询日志", reason: "含第三方原始响应，不外发" },
  { id: "tamper-events", label: "篡改事件", reason: "安全遥测，不属于账号数据导出范围" },
  { id: "proxycheck-risk-cache", label: "ProxyCheck 风险缓存", reason: "按 IP 缓存的第三方信誉数据" },
  { id: "proxycheck-lookup-logs", label: "ProxyCheck 查询日志", reason: "安全遥测，可能含上游原文" },
  { id: "proxycheck-probe-reports", label: "ProxyCheck 探测报告", reason: "反滥用遥测，不按账号归属" },
  { id: "mobile-client-tokens", label: "移动端客户端令牌", reason: "只保存令牌哈希，原文不可恢复；属凭据材料" },
  { id: "bilibili-cookie-reports", label: "B 站 Cookie 上报", reason: "凭据密文，管理端也只提供元数据" },
  { id: "pixel-cdk-mappings", label: "Pixel 卡密映射", reason: "含加密的上游卡密，属凭据材料" },
  { id: "pixel-usage-logs", label: "Pixel 使用日志", reason: "管理端运营查询数据，不进入账号导出" },
  { id: "pixel-integration-configs", label: "Pixel 集成配置", reason: "服务端配置，不属于账号数据" },
  { id: "pixel-evidence-holds", label: "Pixel 证据保全", reason: "法律保留与取证材料，走取证导出通道" },
  { id: "pixel-evidence-approvals", label: "Pixel 保全审批", reason: "法律保留与取证材料，走取证导出通道" },
  { id: "pixel-account-evidence", label: "Pixel 账号证据", reason: "加密取证材料，走取证导出通道" },
  { id: "ticket-attachments", label: "工单附件正文", reason: "附件按单个文件通过工单下载端点获取，不并入账号导出" },
  { id: "legal-holds", label: "法律保留", reason: "合规记录，不按账号导出" },
  { id: "forensic-audit-logs", label: "取证审计", reason: "取证材料，走取证导出通道" },
  { id: "forensic-export-requests", label: "取证导出申请", reason: "取证材料，走取证导出通道" },
  { id: "webhook-events", label: "Webhook 事件", reason: "按投递事件记录，不按账号归属" },
  { id: "browser-local-fingerprint-cache", label: "浏览器本地指纹缓存", reason: "仅保存在用户浏览器，服务端不可读取" },
  { id: "browser-pixel-workbench", label: "浏览器 Pixel 工作台", reason: "仅保存在用户浏览器，服务端不可读取" },
  { id: "browser-geogebra-projects", label: "浏览器 GeoGebra 草稿", reason: "仅保存在用户浏览器，服务端不可读取" },
  { id: "geogebra-share-covers", label: "GeoGebra 分享封面", reason: "公开分享的附属资源，随分享记录元数据体现" },
];

/** 显式跳过、不进入自动纳入的凭证类集合。 */
const CREDENTIAL_COLLECTIONS = new Set([
  "access_tokens",
  "oauth_tokens",
  "verification_tokens",
  "oauth_authorization_codes",
]);

/**
 * 隐私契约标注为「不随账号导出」的集合：即使它们在注销级联清单里，也不自动纳入。
 * 与 `OMITTED_DATASETS` 一一对应，后者负责把原因写进导出文件。
 */
const NON_EXPORTABLE_COLLECTIONS = new Set([
  "tempfingerprints",
  "accesstokens",
  "ip_verification_tokens",
  "ipbans",
  "device_trackings",
  "account_ip_signals",
  "device_fingerprints",
  "registration_attempts",
  "blocked_identities",
  "ipqs_lookup_logs",
  "tamper_events",
  "proxycheck_risk_cache",
  "proxycheck_lookup_logs",
  "proxycheck_probe_reports",
  "mobile_client_tokens",
  "bilibili_cookie_reports",
  "pixel_cdk_mappings",
  "pixel_usage_logs",
  "pixel_integration_configs",
  "pixel_evidence_holds",
  "pixel_evidence_approvals",
  "pixel_evidence",
  "ticket_attachments",
  "legal_holds",
  "forensic_audit_logs",
  "forensic_export_requests",
]);

/** 已由显式登记覆盖的集合。 */
const EXPLICIT_COLLECTIONS = new Set(EXPLICIT_TARGETS.map((target) => target.collection));

/**
 * 自动纳入的归属集合：来自 `USER_CASCADE_COLLECTIONS`（账号注销时的级联清单）。
 * 与显式清单、凭据集合、地图标注不可导出的集合互斥。
 */
export function buildFallbackTargets(): ExportSpec[] {
  return USER_CASCADE_COLLECTIONS
    .filter(({ collection }) => (
      !EXPLICIT_COLLECTIONS.has(collection)
      && !CREDENTIAL_COLLECTIONS.has(collection)
      && !NON_EXPORTABLE_COLLECTIONS.has(collection)
    ))
    .map(({ collection, field }) => ({
      id: `collection-${collection}`,
      label: `账号归属集合：${collection}`,
      collection,
      ownerField: field,
      limit: 100,
      support: "partial" as const,
      note: "自动纳入的账号归属数据；如需更完整的字段说明请在隐私数据地图登记",
    }));
}

export function listAccountExportTargets(): ExportSpec[] {
  return [...EXPLICIT_TARGETS, ...buildFallbackTargets()];
}

// 脱敏规则与 MongoDB 在库浏览共用一份实现，避免两边判据漂移。
export { REDACTED, sanitizeForExport } from "../utils/credentialRedaction";

function database() {
  const db = mongoose.connection.db;
  if (!db) throw new Error("数据库连接不可用");
  return db;
}

function buildOwnerFilter(target: ExportSpec, subject: AccountExportSubject): Record<string, unknown> | null {
  // `__email:<field>`：按账号邮箱匹配（邮件抑制、工作区邀请按收件邮箱归属）。
  if (target.ownerField.startsWith("__email:")) {
    const field = target.ownerField.slice("__email:".length);
    const email = subject.email.trim().toLowerCase();
    return email ? { [field]: email } : null;
  }
  return { [target.ownerField]: subject.id };
}

function toSubject(user: Record<string, unknown>): AccountExportSubject {
  const deletedAtRaw = user.deletedAt;
  const deletedAt = typeof deletedAtRaw === "number" && deletedAtRaw > 0 ? deletedAtRaw : null;
  return {
    id: String(user.id ?? ""),
    username: String(user.username ?? ""),
    email: String(user.email ?? ""),
    role: String(user.role ?? "user"),
    deletedAt,
    deletedBy: typeof user.deletedBy === "string" ? user.deletedBy : null,
    deleteReason: typeof user.deleteReason === "string" ? user.deleteReason : null,
    accountStatus: typeof user.accountStatus === "string" ? user.accountStatus : null,
  };
}

async function loadUser(userId: string): Promise<Record<string, unknown> | null> {
  const user = await UserStorage.getUserById(userId);
  if (!user) return null;
  return sanitizeForExport(user) as Record<string, unknown>;
}

async function countTarget(target: ExportSpec, subject: AccountExportSubject): Promise<number> {
  const filter = buildOwnerFilter(target, subject);
  if (!filter) return 0;
  try {
    return await database().collection(target.collection).countDocuments(filter as any, { maxTimeMS: 5000 });
  } catch (error) {
    logger.warn("[AccountExport] 统计失败", { collection: target.collection, error: (error as Error)?.message });
    return 0;
  }
}

async function readTarget(
  target: ExportSpec,
  subject: AccountExportSubject,
  rowLimit: number,
): Promise<AccountExportDataset> {
  const filter = buildOwnerFilter(target, subject);
  const base: AccountExportDataset = {
    id: target.id,
    label: target.label,
    collection: target.collection,
    support: target.support,
    count: 0,
    returned: 0,
    truncated: false,
    ...(target.note ? { note: target.note } : {}),
  };
  if (!filter) return base;

  try {
    const collection = database().collection(target.collection);
    const count = await collection.countDocuments(filter as any, { maxTimeMS: 5000 });
    const limit = Math.max(1, Math.min(target.limit, rowLimit));
    const rows = await collection
      .find(filter as any)
      .sort({ _id: -1 })
      .limit(limit + 1)
      .maxTimeMS(10000)
      .toArray();
    const truncated = rows.length > limit;
    const kept = truncated ? rows.slice(0, limit) : rows;
    return {
      ...base,
      count,
      returned: kept.length,
      truncated,
      rows: kept.map((row) => sanitizeForExport(row)),
    };
  } catch (error) {
    logger.warn("[AccountExport] 读取失败", {
      collection: target.collection,
      error: (error as Error)?.message,
    });
    return { ...base, note: `${target.note ? `${target.note}；` : ""}读取失败，请稍后重试或联系运维` };
  }
}

export interface AccountExportOptions {
  /** 请求者（写入导出文件头，便于追溯）。 */
  requestedBy?: { id: string; username: string } | null;
  /** 批量导出时降低每个数据集的行数上限。 */
  rowLimit?: number;
}

/** 账户数据摘要：只统计条数，不读取正文（弹窗打开时使用）。 */
export async function summarizeAccountData(userId: string): Promise<{
  subject: AccountExportSubject;
  datasets: Array<Omit<AccountExportDataset, "rows">>;
  omitted: AccountExportOmitted[];
}> {
  const user = await loadUser(userId);
  if (!user) throw new Error("用户不存在");
  const subject = toSubject(user);
  const targets = listAccountExportTargets();
  const counts = await Promise.all(targets.map((target) => countTarget(target, subject)));
  return {
    subject,
    datasets: targets.map((target, index) => ({
      id: target.id,
      label: target.label,
      collection: target.collection,
      support: target.support,
      count: counts[index],
      returned: 0,
      truncated: false,
      ...(target.note ? { note: target.note } : {}),
    })),
    omitted: OMITTED_DATASETS,
  };
}

/** 导出单个账户的完整数据（已脱敏）。 */
export async function exportAccountData(
  userId: string,
  options: AccountExportOptions = {},
): Promise<AccountExportDocument> {
  const user = await loadUser(userId);
  if (!user) throw new Error("用户不存在");
  const subject = toSubject(user);
  const rowLimit = options.rowLimit ?? Number.POSITIVE_INFINITY;

  const datasets = await Promise.all(
    listAccountExportTargets().map((target) => readTarget(target, subject, rowLimit)),
  );

  const document: AccountExportDocument = {
    schemaVersion: ACCOUNT_EXPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    requestedBy: options.requestedBy ?? null,
    subject,
    redaction:
      "密码材料、令牌、密钥、密文与内部存储键已替换为 [redacted]；二进制正文不随导出。"
      + "「未包含的数据」列出了按隐私契约不进入账号导出的数据集及原因。",
    profile: user,
    datasets,
    omitted: OMITTED_DATASETS,
  };

  // 与实际落盘格式（缩进 2 空格）保持一致再量体积，否则会在控制器序列化时超限。
  const bytes = Buffer.byteLength(JSON.stringify(document, null, 2), "utf8");
  if (bytes > ACCOUNT_EXPORT_MAX_BYTES) {
    throw new AccountExportTooLargeError(bytes);
  }
  return document;
}

/** 批量导出（每个账号一份完整文档）。 */
export async function exportAccountsData(
  userIds: string[],
  options: AccountExportOptions = {},
): Promise<{
  schemaVersion: number;
  generatedAt: string;
  requestedBy: { id: string; username: string } | null;
  accounts: AccountExportDocument[];
  errors: Array<{ userId: string; error: string }>;
}> {
  const unique = Array.from(new Set(userIds.filter((id) => typeof id === "string" && id.trim())));
  if (unique.length === 0) throw new Error("请至少选择一个用户");
  if (unique.length > ACCOUNT_EXPORT_MAX_USERS) {
    throw new Error(`单次最多导出 ${ACCOUNT_EXPORT_MAX_USERS} 个账号`);
  }

  const accounts: AccountExportDocument[] = [];
  const errors: Array<{ userId: string; error: string }> = [];
  for (const userId of unique) {
    try {
      accounts.push(await exportAccountData(userId, { ...options, rowLimit: options.rowLimit ?? 100 }));
    } catch (error) {
      errors.push({ userId, error: (error as Error)?.message || "导出失败" });
    }
  }

  const document = {
    schemaVersion: ACCOUNT_EXPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    requestedBy: options.requestedBy ?? null,
    accounts,
    errors,
  };
  // 与实际落盘格式（缩进 2 空格）保持一致再量体积，否则会在控制器序列化时超限。
  const bytes = Buffer.byteLength(JSON.stringify(document, null, 2), "utf8");
  if (bytes > ACCOUNT_EXPORT_MAX_BYTES) {
    throw new AccountExportTooLargeError(bytes);
  }
  return document;
}
