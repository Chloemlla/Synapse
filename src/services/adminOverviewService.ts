import { ApiKeyModel } from "../models/apiKeyModel";
import { AuditLogModel } from "../models/auditLogModel";
import { getAdminUserListPage } from "./userService";
import { TurnstileService } from "./turnstileService";
import { isConnected } from "./mongoService";
import logger from "../utils/logger";
import { sanitizeErrorForLog } from "../utils/requestLogSanitizer";
import type { AdminUserListStats } from "./adminUserListAggregation";

/**
 * 管理总览的系统级汇总。
 *
 * 为什么要单独一个服务：管理仪表盘原先只展示邮件溯源一块数据（其它模块各自拉各自的列表），
 * 管理员想回答「现在有多少用户被停用 / 有多少 Key 被吊销 / 最近一天有多少失败请求 / 封了多少 IP」
 * 得逐个页面点进去看。这里把四类跨集合计数收敛成**一次**请求。
 *
 * 三条硬约束：
 *  1. **不撒谎**：任何一个集合查不动（Mongo 未连接 / 聚合失败）时对应字段返回 `null` 并在
 *     `warnings` 里说明。前端据此显示"暂不可用"，而不是把失败渲染成 0 —— 一个假的 0 会让
 *     值班以为"没有失败请求"，这正是仪表盘最危险的失效方式。
 *  2. **不扫全表**：只走 `countDocuments` 与既有的 aggregation 统计（用户统计复用
 *     `getAdminUserListPage` 的 `$group`，不把用户文档拉进内存）。
 *  3. **只读**：本服务不做任何写入，调用方（`GET /api/admin/overview`）也不挂审计——
 *     仪表盘轮询会把它变成噪音日志；真正的写操作各自已有审计。
 */

export interface AdminOverviewApiKeys {
  total: number;
  enabled: number;
  disabled: number;
}

export interface AdminOverviewAuditLogs {
  total: number;
  last24h: number;
  failures24h: number;
}

export interface AdminOverviewIpBans {
  total: number;
  active: number;
  expired: number;
}

export interface AdminOverviewSnapshot {
  generatedAt: string;
  users: (AdminUserListStats & { total: number }) | null;
  apiKeys: AdminOverviewApiKeys | null;
  auditLogs: AdminOverviewAuditLogs | null;
  ipBans: AdminOverviewIpBans | null;
  /** 某项汇总不可用时的原因（面向管理员，不含堆栈）。 */
  warnings: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function buildAdminOverview(): Promise<AdminOverviewSnapshot> {
  const warnings: string[] = [];
  const generatedAt = new Date().toISOString();

  if (!isConnected()) {
    return {
      generatedAt,
      users: null,
      apiKeys: null,
      auditLogs: null,
      ipBans: null,
      warnings: ["数据库未连接，概览数据暂不可用"],
    };
  }

  const since24h = new Date(Date.now() - DAY_MS);

  const [usersResult, apiKeysResult, auditLogsResult, ipBansResult] = await Promise.allSettled([
    // pageSize=1：只需要那一次 $group 出来的全库 stats，不需要真的取用户行。
    getAdminUserListPage(
      {
        keyword: "",
        role: "",
        accountStatus: "",
        security: "",
        ticket: "",
        translation: "",
        sortBy: "createdAt",
        sortOrder: "desc",
        page: 1,
        pageSize: 1,
      },
      false,
    ),
    loadApiKeyCounts(),
    loadAuditLogCounts(since24h),
    TurnstileService.getIpBanStats(),
  ]);

  let users: AdminOverviewSnapshot["users"] = null;
  if (usersResult.status === "fulfilled") {
    const stats = usersResult.value?.stats;
    if (stats) {
      // 用户总数优先用聚合里的 total（分页 total 是筛选后的），拿不到就退到 stats.total。
      const total = Number((usersResult.value as { total?: number })?.total || stats.total || 0);
      users = { ...stats, total };
    } else {
      warnings.push("用户统计不可用");
    }
  } else {
    logger.warn("[AdminOverview] 用户统计失败", sanitizeErrorForLog(usersResult.reason));
    warnings.push("用户统计不可用");
  }

  let apiKeys: AdminOverviewApiKeys | null = null;
  if (apiKeysResult.status === "fulfilled") {
    apiKeys = apiKeysResult.value;
  } else {
    // codeql[js/clear-text-logging] 记的是**拒绝原因**（经 sanitizeErrorForLog 截断的错误文本），
    // 不是 apiKeysResult 的完成值——该 promise 只在 fulfilled 分支被赋给 apiKeys，失败分支拿不到密钥。
    logger.warn("[AdminOverview] API Key 统计失败", sanitizeErrorForLog(apiKeysResult.reason));
    warnings.push("API Key 统计不可用");
  }

  let auditLogs: AdminOverviewAuditLogs | null = null;
  if (auditLogsResult.status === "fulfilled") {
    auditLogs = auditLogsResult.value;
  } else {
    logger.warn("[AdminOverview] 审计日志统计失败", sanitizeErrorForLog(auditLogsResult.reason));
    warnings.push("审计日志统计不可用");
  }

  let ipBans: AdminOverviewIpBans | null = null;
  if (ipBansResult.status === "fulfilled") {
    const stats = ipBansResult.value;
    ipBans = { total: stats.total, active: stats.active, expired: stats.expired };
  } else {
    logger.warn("[AdminOverview] IP 封禁统计失败", sanitizeErrorForLog(ipBansResult.reason));
    warnings.push("IP 封禁统计不可用");
  }

  return { generatedAt, users, apiKeys, auditLogs, ipBans, warnings };
}

async function loadApiKeyCounts(): Promise<AdminOverviewApiKeys> {
  const [total, enabled] = await Promise.all([
    ApiKeyModel.countDocuments({}).exec(),
    ApiKeyModel.countDocuments({ enabled: true }).exec(),
  ]);
  return { total, enabled, disabled: Math.max(0, total - enabled) };
}

async function loadAuditLogCounts(since: Date): Promise<AdminOverviewAuditLogs> {
  const [total, last24h, failures24h] = await Promise.all([
    AuditLogModel.countDocuments({}).exec(),
    AuditLogModel.countDocuments({ createdAt: { $gte: since } }).exec(),
    AuditLogModel.countDocuments({ createdAt: { $gte: since }, result: "failure" }).exec(),
  ]);
  return { total, last24h, failures24h };
}

export const adminOverviewService = { build: buildAdminOverview };
