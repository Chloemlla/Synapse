import express from "express";
import { authenticateSuperAdmin } from "../../middleware/auth";
import { auditLog } from "../../middleware/auditLog";
import { cacheService } from "../../services/cacheService";
import {
  addSuppression,
  getSuppressionStats,
  isEmailSuppressed,
  listSuppressions,
  removeSuppression,
} from "../../services/emailSuppressionService";
import { mongoose } from "../../services/mongoService";
import { recommendationService } from "../../services/recommendationService";
import { redisService } from "../../services/redisService";
import { getRegistrationInviteStats } from "../../services/registrationInviteService";
import { WebhookEventService } from "../../services/webhookEventService";
import logger from "../../utils/logger";
import { firstString } from "../../utils/httpParam";

/**
 * 集成健康中心（只读为主）。
 *
 * 汇总五个集成面的可运维信号：Webhook 端点健康、邮件抑制名单、Redis/缓存层、
 * 推荐系统活跃度、OpenAI/Resend/Svix 配置存在性（只回布尔，绝不回密钥）。
 *
 * 权限：读端点继承 `/api/admin` 的管理员鉴权与页面范围（`adminPages.ts` 里的 `integrations`）；
 * 写端点（清缓存、名单增删、事件清理）一律 `authenticateSuperAdmin` + 审计。
 * 含邮箱明文的名单读取收紧为超管 —— 普通管理员的页面授权不该等价于「能看用户邮箱」。
 *
 * 限流：本子树由 `/api/admin` 挂在 `preTamperModules` 时的 adminLimiter 覆盖（G11-06），
 * 子路由内再挂一份会让配额被扣两次，因此这里只写 codeql 说明。
 */

const router = express.Router();

const readPage = (value: unknown, fallback: number, max: number): number => {
  const parsed = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(parsed)));
};

/** 单个子查询失败不应让整个总览接口 500：回退值 + 记录日志。 */
async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    logger.warn(`[Integrations] ${label} 查询失败`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return fallback;
  }
}

function providerSnapshot() {
  const has = (name: string) => Boolean((process.env[name] || "").trim());
  const openaiKey = (process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || "").trim();
  return {
    openai: {
      apiKeyConfigured: Boolean(openaiKey),
      // OA-2：只回掩码前缀，绝不回原文。
      apiKeyPreview: openaiKey ? `${openaiKey.slice(0, 3)}***${openaiKey.slice(-2)}` : null,
      baseUrlConfigured: has("OPENAI_BASE_URL"),
      model: (process.env.OPENAI_MODEL || "").trim() || null,
    },
    resend: {
      apiKeyConfigured: has("RESEND_API_KEY"),
      domain: (process.env.RESEND_DOMAIN || "").trim() || null,
      outemailEnabled: (process.env.RESEND_OUTEMAIL_ENABLED || "").toLowerCase() === "true",
    },
    svix: {
      envSecretConfigured: Boolean((process.env.RESEND_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET || "").trim()),
    },
  };
}

/**
 * @openapi
 * /admin/integrations/overview:
 *   get:
 *     summary: 集成健康总览（缓存 / 邮件 / Webhook / 推荐 / 邀请）
 *     tags: [Integrations]
 *     responses:
 *       200:
 *         description: 各集成面的聚合状态
 */
// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.get("/integrations/overview", async (_req, res) => {
  const [cache, email, webhook, recommendations, invites] = await Promise.all([
    safe(
      "cache",
      async () => ({
        stats: cacheService.stats(),
        redis: redisService.getStatus(),
        server: await redisService.getServerStats(),
      }),
      null as any,
    ),
    safe("email", () => getSuppressionStats(), null as any),
    safe(
      "webhook",
      async () => {
        const health = await WebhookEventService.health();
        const stats = await WebhookEventService.stats();
        return { routes: health.routes, total7d: stats.total, last24h: stats.last24h, failed: stats.failed };
      },
      null as any,
    ),
    safe("recommendations", () => recommendationService.getAdminAnalytics(), null as any),
    safe("invites", () => getRegistrationInviteStats(), null as any),
  ]);

  return res.json({
    success: true,
    mongoReady: mongoose.connection.readyState === 1,
    providers: providerSnapshot(),
    cache,
    emailSuppressions: email,
    webhooks: webhook,
    recommendations,
    registrationInvites: invites,
    generatedAt: new Date().toISOString(),
  });
});

/**
 * @openapi
 * /admin/integrations/cache:
 *   get:
 *     summary: 缓存层状态（命中率 / 分层 / Redis 服务端统计）
 *     tags: [Integrations]
 */
// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.get("/integrations/cache", async (_req, res) => {
  const [server, secrets] = await Promise.all([
    safe("redis-server", () => redisService.getServerStats(), { dbsize: null, usedMemoryBytes: null }),
    safe("webhook-secrets", () => WebhookEventService.listResendWebhookSecrets(), []),
  ]);
  return res.json({
    success: true,
    stats: cacheService.stats(),
    redis: redisService.getStatus(),
    server,
    webhookSecretKeys: secrets,
  });
});

/**
 * @openapi
 * /admin/integrations/cache/invalidate:
 *   post:
 *     summary: 按 key 前缀失效缓存（超管，审计留痕）
 *     tags: [Integrations]
 */
router.post(
  "/integrations/cache/invalidate",
  // codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
  authenticateSuperAdmin,
  auditLog({
    module: "config",
    action: "integrations.cache.invalidate",
    extractDetail: (req) => ({ prefix: firstString((req as any).body?.prefix) ?? "" }),
  }),
  async (req, res) => {
    const prefix = firstString(req.body?.prefix);
    // 前缀过短会误伤其他命名空间（单个字符等于全清），要求至少 3 个字符。
    if (!prefix || prefix.trim().length < 3) {
      return res.status(400).json({ success: false, error: "prefix 至少 3 个字符" });
    }
    const deleted = await cacheService.delByPrefix(prefix.trim());
    return res.json({ success: true, deleted, prefix: prefix.trim() });
  },
);

/**
 * @openapi
 * /admin/integrations/cache/flush-memory:
 *   post:
 *     summary: 清空本进程内存缓存（超管）
 *     tags: [Integrations]
 */
router.post(
  "/integrations/cache/flush-memory",
  // codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
  authenticateSuperAdmin,
  auditLog({ module: "config", action: "integrations.cache.flushMemory", captureBody: false }),
  async (_req, res) => {
    const cleared = cacheService.clearMemory();
    return res.json({ success: true, cleared });
  },
);

/**
 * @openapi
 * /admin/integrations/email-suppressions:
 *   get:
 *     summary: 邮件抑制名单（超管；含邮箱明文）
 *     tags: [Integrations]
 */
// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.get(
  "/integrations/email-suppressions",
  authenticateSuperAdmin,
  async (req, res) => {
    const result = await listSuppressions({
      page: readPage(req.query.page, 1, 1000),
      pageSize: readPage(req.query.pageSize, 50, 200),
      q: firstString(req.query.q),
      reason: firstString(req.query.reason),
      activeOnly: firstString(req.query.activeOnly) === "true",
    });
    const stats = await getSuppressionStats();
    return res.json({ success: true, ...result, stats });
  },
);

/**
 * @openapi
 * /admin/integrations/email-suppressions:
 *   post:
 *     summary: 手动把邮箱加入抑制名单（超管）
 *     tags: [Integrations]
 */
router.post(
  "/integrations/email-suppressions",
  // codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
  authenticateSuperAdmin,
  auditLog({
    module: "config",
    action: "integrations.emailSuppression.add",
    extractDetail: (req) => ({ reason: firstString((req as any).body?.reason) ?? "manual" }),
  }),
  async (req, res) => {
    const email = firstString(req.body?.email);
    if (!email) return res.status(400).json({ success: false, error: "缺少 email" });
    const reason = firstString(req.body?.reason);
    const allowed = ["bounce", "complaint", "unsubscribe", "manual"] as const;
    const safeReason = allowed.find((item) => item === reason) ?? "manual";
    const record = await addSuppression({
      email,
      reason: safeReason,
      source: "admin",
      detail: firstString(req.body?.detail) || "",
    });
    if (!record) return res.status(400).json({ success: false, error: "邮箱无效或数据库不可用" });
    return res.json({ success: true, item: record });
  },
);

/**
 * @openapi
 * /admin/integrations/email-suppressions:
 *   delete:
 *     summary: 从抑制名单移除邮箱（超管）
 *     tags: [Integrations]
 */
// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.delete(
  "/integrations/email-suppressions",
  authenticateSuperAdmin,
  auditLog({ module: "config", action: "integrations.emailSuppression.remove", captureBody: false }),
  async (req, res) => {
    const email = firstString(req.query.email) || firstString(req.body?.email);
    if (!email) return res.status(400).json({ success: false, error: "缺少 email" });
    const removed = await removeSuppression(email);
    if (!removed) return res.status(404).json({ success: false, error: "名单中没有该邮箱" });
    return res.json({ success: true });
  },
);

/**
 * @openapi
 * /admin/integrations/email-suppressions/check:
 *   get:
 *     summary: 查询单个邮箱是否被抑制（超管）
 *     tags: [Integrations]
 */
// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.get("/integrations/email-suppressions/check", authenticateSuperAdmin, async (req, res) => {
  const email = firstString(req.query.email);
  if (!email) return res.status(400).json({ success: false, error: "缺少 email" });
  const suppressed = await isEmailSuppressed(email);
  return res.json({ success: true, email, suppressed });
});

/**
 * @openapi
 * /admin/integrations/webhooks:
 *   get:
 *     summary: Webhook 端点健康与密钥清单（只回掩码）
 *     tags: [Integrations]
 */
// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.get("/integrations/webhooks", async (_req, res) => {
  const [health, secrets] = await Promise.all([
    WebhookEventService.health(),
    WebhookEventService.listResendWebhookSecrets(),
  ]);
  return res.json({ success: true, ...health, secrets });
});

/**
 * @openapi
 * /admin/integrations/webhooks/prune:
 *   post:
 *     summary: 按保留期清理 webhook 事件（默认 dryRun）
 *     tags: [Integrations]
 */
router.post(
  "/integrations/webhooks/prune",
  // codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
  authenticateSuperAdmin,
  auditLog({
    module: "network",
    action: "integrations.webhooks.prune",
    extractDetail: (req) => ({
      days: (req as any).body?.days ?? null,
      dryRun: (req as any).body?.dryRun !== false,
    }),
  }),
  async (req, res) => {
    const days = readPage(req.body?.days, 90, 3650);
    const result = await WebhookEventService.prune(days, {
      provider: firstString(req.body?.provider),
      routeKey: firstString(req.body?.routeKey),
      dryRun: req.body?.dryRun !== false,
    });
    return res.json({ success: true, ...result });
  },
);

/**
 * @openapi
 * /admin/integrations/recommendations:
 *   get:
 *     summary: 推荐系统分析（聚合，不含个人历史原文）
 *     tags: [Integrations]
 */
// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.get("/integrations/recommendations", async (_req, res) => {
  const analytics = await recommendationService.getAdminAnalytics();
  return res.json({ success: true, analytics });
});

/**
 * @openapi
 * /admin/integrations/invites:
 *   get:
 *     summary: 注册邀请码统计
 *     tags: [Integrations]
 */
// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.get("/integrations/invites", async (_req, res) => {
  const stats = await getRegistrationInviteStats();
  return res.json({ success: true, stats });
});

export default router;
