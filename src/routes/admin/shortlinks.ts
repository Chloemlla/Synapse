import * as crypto from "node:crypto";
import express from "express";
import mongoose from "mongoose";
import { auditLog } from "../../middleware/auditLog";
import { isAdminRole, isSuperAdmin } from "../../middleware/auth";
import { authenticateToken } from "../../middleware/authenticateToken";
import { replayProtection } from "../../middleware/replayProtection";
import { escapeRegexLiteral } from "../../utils/regexEscape";
import { shortUrlHotQueryService } from "../../services/shortUrlHotQueryService";
import { shortUrlMigrationService } from "../../services/shortUrlMigrationService";
import logger from "../../utils/logger";
import { createUrlSafeRandomId } from "../../utils/randomId";
import { getTokenFromRequest } from "../../utils/authCookie";

const router = express.Router();

// 短链管理API
// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.get("/shortlinks", authenticateToken, async (req, res) => {
  try {
    // 身份字段只进结构化日志（原来 5 行 console.log 把 id/用户名/角色/IP 裸打完事，
    // 既绕过 logger 的级别与脱敏，也不受日志开关控制）。
    logger.debug("[ShortLinkManager] 短链列表请求", {
      userId: req.user?.id,
      role: req.user?.role,
      ip: req.ip,
    });

    // 检查管理员权限
    if (!req.user || !isAdminRole(req.user.role)) {
      return res.status(403).json({ error: "需要管理员权限" });
    }

    // 获取管理员token作为加密密钥（优先从 Authorization header，其次从 cookie）
    const token = getTokenFromRequest(req);
    if (!token) {
      return res.status(401).json({ error: "未携带Token，请先登录" });
    }

    // 输入验证和清理
    const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(String(req.query.pageSize || "10"), 10) || 10));

    const ShortUrlModel = mongoose.models.ShortUrl || mongoose.model("ShortUrl");

    // 安全的查询构建
    let query: any = {};
    if (search && search.length > 0) {
      // 防止正则表达式注入：转义特殊字符（统一实现见 utils/regexEscape）
      const escapedSearch = escapeRegexLiteral(search);
      query = {
        $or: [{ code: { $regex: escapedSearch, $options: "i" } }, { target: { $regex: escapedSearch, $options: "i" } }],
      };
    }

    const total = await ShortUrlModel.countDocuments(query);
    const items = await ShortUrlModel.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * pageSize)
      .limit(pageSize);

    res.set("Cache-Control", "no-store");
    // HttpOnly session cookies are unavailable to JavaScript. Bearer clients retain
    // the existing encrypted response contract because they possess the token.
    if (!req.headers.authorization?.startsWith("Bearer ")) {
      return res.json({ success: true, items, total, page, pageSize });
    }

    // 准备加密数据
    const responseData = { total, items };
    const jsonData = JSON.stringify(responseData);

    // 使用AES-256-CBC加密数据。密钥由管理员 token 派生；中间步骤不再逐步打日志
    // （旧写法把「生成密钥/生成 IV/IV 十六进制/各段长度」全打在 stdout 上，纯噪声）。
    const algorithm = "aes-256-cbc";
    const key = crypto.createHash("sha256").update(token).digest();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(algorithm, key, iv);

    let encrypted = cipher.update(jsonData, "utf8", "hex");
    encrypted += cipher.final("hex");

    // 返回加密后的数据
    const response = {
      success: true,
      data: encrypted,
      iv: iv.toString("hex"),
    };

    logger.debug("[ShortLinkManager] 短链列表已加密返回", {
      count: items.length,
      total,
      payloadBytes: jsonData.length,
    });

    res.json(response);
  } catch (error) {
    logger.error("[ShortLinkManager] 获取短链列表失败", { error });
    res.status(500).json({ error: "获取短链列表失败" });
  }
});

// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.delete("/shortlinks/:id", authenticateToken, auditLog({ module: "shorturl", action: "shorturl.delete", extractTarget: (req) => ({ targetId: req.params.id }) }), async (req, res) => {
  try {
    // 检查管理员权限
    if (!req.user || !isSuperAdmin(req)) {
      return res.status(403).json({ error: "需要管理员权限" });
    }

    const { id } = req.params;

    // 验证ID格式，防止NoSQL注入
    if (!id || typeof id !== "string" || id.length !== 24 || !/^[0-9a-fA-F]{24}$/.test(id)) {
      return res.status(400).json({ error: "无效的短链ID格式" });
    }

    const ShortUrlModel = mongoose.models.ShortUrl || mongoose.model("ShortUrl");
    const link = await ShortUrlModel.findById(id);

    if (!link) {
      return res.status(404).json({ error: "短链不存在" });
    }

    await ShortUrlModel.findByIdAndDelete(id);
    // 管理端是直接删库（不经 ShortUrlService），所以这里也得失效一次热点缓存：
    // 不然被删的短链会继续从 Redis 跳转，直到 10 分钟的条目 TTL 到期。
    await shortUrlHotQueryService.invalidate(String(link?.code ?? ""));
    logger.info("[ShortLink] 管理员删除短链", {
      admin: req.user?.username || req.user?.id,
      code: link?.code,
      target: link?.target,
      id: id,
      time: new Date().toISOString(),
    });
    res.json({ success: true });
  } catch (error) {
    logger.error("[ShortLink] 删除短链失败:", error);
    res.status(500).json({ error: "删除短链失败" });
  }
});

// 批量删除短链
// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.post("/shortlinks/batch-delete", authenticateToken, auditLog({ module: "shorturl", action: "shorturl.batchDelete", extractDetail: (req) => ({ count: Array.isArray(req.body?.ids) ? req.body.ids.length : 0 }) }), async (req, res) => {
  try {
    const { ids } = req.body;

    // 验证请求体
    if (!ids || !Array.isArray(ids)) {
      return res.status(400).json({ error: "请提供有效的短链ID列表" });
    }

    // 检查管理员权限
    if (!req.user || !isSuperAdmin(req)) {
      return res.status(403).json({ error: "需要管理员权限" });
    }

    const ShortUrlModel = mongoose.models.ShortUrl || mongoose.model("ShortUrl");

    // 验证每个ID的格式，防止NoSQL注入
    const validIds = ids.filter((id) => typeof id === "string" && id.length === 24 && /^[0-9a-fA-F]{24}$/.test(id));

    if (validIds.length === 0) {
      return res.status(400).json({ error: "没有有效的短链ID" });
    }

    // 限制批量删除的数量，防止DoS攻击
    if (validIds.length > 100) {
      return res.status(400).json({ error: "批量删除数量不能超过100个" });
    }

    // 查找所有要删除的短链
    const links = await ShortUrlModel.find({ _id: { $in: validIds } });

    if (links.length === 0) {
      return res.status(404).json({ error: "没有找到要删除的短链" });
    }

    // 执行批量删除
    const deleteResult = await ShortUrlModel.deleteMany({ _id: { $in: validIds } });

    // 同样要清缓存（管理端绕过服务直接删库）
    await shortUrlHotQueryService.invalidateMany(links.map((link: any) => String(link.code)));

    logger.info("[ShortLink] 管理员批量删除短链", {
      admin: req.user?.username || req.user?.id,
      requestedCount: ids.length,
      validCount: validIds.length,
      deletedCount: deleteResult.deletedCount,
      deletedCodes: links.map((link: any) => link.code),
      time: new Date().toISOString(),
    });

    res.json({
      success: true,
      message: "批量删除成功",
      data: {
        requestedCount: ids.length,
        validCount: validIds.length,
        deletedCount: deleteResult.deletedCount,
        deletedCodes: links.map((link: any) => link.code),
      },
    });
  } catch (error) {
    logger.error("[ShortLink] 批量删除短链失败:", error);
    res.status(500).json({
      error: "批量删除短链失败",
    });
  }
});

// 创建短链
router.post(
  "/shortlinks",
  // codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
  authenticateToken,
  replayProtection(),
  auditLog({
    module: "shorturl",
    action: "shorturl.create",
    extractDetail: (req) => ({ target: req.body.target, customCode: req.body.customCode }),
  }),
  // codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
  async (req, res) => {
    try {
      // 检查管理员权限
      if (!req.user || !isSuperAdmin(req)) {
        return res.status(403).json({ error: "需要管理员权限" });
      }

      const { target, customCode } = req.body;

      // 输入验证
      if (!target || typeof target !== "string") {
        return res.status(400).json({ error: "目标地址不能为空" });
      }

      // 验证目标URL格式
      const trimmedTarget = target.trim();
      if (trimmedTarget.length === 0 || trimmedTarget.length > 2000) {
        return res.status(400).json({ error: "目标地址长度必须在1-2000个字符之间" });
      }

      // 验证URL格式
      try {
        new URL(trimmedTarget);
      } catch {
        return res.status(400).json({ error: "目标地址必须是有效的URL格式" });
      }

      const ShortUrlModel = mongoose.models.ShortUrl || mongoose.model("ShortUrl");

      let code: string;

      // 如果提供了自定义短链接码
      if (customCode && typeof customCode === "string") {
        const trimmedCode = customCode.trim();

        // 验证自定义短链接码格式
        if (trimmedCode.length < 1 || trimmedCode.length > 200) {
          return res.status(400).json({ error: "自定义短链接码长度必须在1-200个字符之间" });
        }

        // 验证字符格式（只允许字母、数字、连字符和下划线）
        if (!/^[a-zA-Z0-9_-]+$/.test(trimmedCode)) {
          return res.status(400).json({ error: "自定义短链接码只能包含字母、数字、连字符和下划线" });
        }

        // 检查是否已存在
        const existingShortUrl = await ShortUrlModel.findOne({ code: trimmedCode });
        if (existingShortUrl) {
          return res.status(400).json({ error: "该短链接码已被使用，请选择其他短链接码" });
        }

        code = trimmedCode;
      } else {
        // 生成随机短链接码
        let randomCode = createUrlSafeRandomId(6);
        let retries = 0;
        const maxRetries = 10;

        while (retries < maxRetries) {
          const existingCode = await ShortUrlModel.findOne({ code: randomCode });
          if (!existingCode) {
            break;
          }
          randomCode = createUrlSafeRandomId(6);
          retries++;
        }

        if (retries >= maxRetries) {
          return res.status(500).json({ error: "无法生成唯一的短链代码，请重试" });
        }

        code = randomCode;
      }

      // 使用迁移服务自动修正目标URL
      const fixedTarget = shortUrlMigrationService.fixTargetUrlBeforeSave(trimmedTarget);

      const userId = req.user?.id || "admin";
      const username = req.user?.username || "admin";
      const doc = await ShortUrlModel.create({ code, target: fixedTarget, userId, username });
      res.json({ success: true, code, shortUrl: `/s/${code}`, doc });
    } catch (error) {
      logger.error("[ShortLink] 创建短链失败:", error);
      res.status(500).json({ error: "创建短链失败" });
    }
  },
);

// 短链迁移管理API
// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.post("/shortlinks/migrate", authenticateToken, auditLog({ module: "shorturl", action: "shorturl.migrate" }), async (req, res) => {
  try {
    logger.debug("[ShortUrlMigration] 迁移请求", {
      userId: req.user?.id,
      role: req.user?.role,
      ip: req.ip,
    });

    // 检查管理员权限
    if (!req.user || !isSuperAdmin(req)) {
      return res.status(403).json({ error: "需要管理员权限" });
    }

    // 执行迁移
    const result = await shortUrlMigrationService.detectAndFixOldDomainUrls();

    logger.info("[ShortUrlMigration] 迁移完成", {
      totalChecked: result.totalChecked,
      totalFixed: result.totalFixed,
    });

    res.json({
      success: true,
      message: `迁移完成，共修正 ${result.totalFixed} 条记录`,
      data: result,
    });
  } catch (error) {
    logger.error("[ShortUrlMigration] 短链迁移失败", { error });
    res.status(500).json({ error: "短链迁移失败" });
  }
});

// 获取短链迁移统计信息
// codeql[js/missing-rate-limiting] admin subtree rate-limited at mount (/api/admin adminLimiter, preTamperModules G11-06); in-router copy would split quota
router.get("/shortlinks/migration-stats", authenticateToken, async (req, res) => {
  try {
    // 身份字段只进结构化日志，不裸打用户名/角色（同文件其余路径的收敛口径）。
    logger.debug("[ShortUrlMigration] 迁移统计请求", {
      userId: req.user?.id,
      role: req.user?.role,
    });

    // 检查管理员权限
    if (!req.user || !isAdminRole(req.user.role)) {
      return res.status(403).json({ error: "需要管理员权限" });
    }

    // 获取统计信息
    const stats = await shortUrlMigrationService.getMigrationStats();

    logger.debug("[ShortUrlMigration] 迁移统计已获取", {
      totalRecords: stats.totalRecords,
      oldDomainRecords: stats.oldDomainRecords,
      newDomainRecords: stats.newDomainRecords,
    });

    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    logger.error("[ShortUrlMigration] 获取迁移统计失败", { error });
    res.status(500).json({ error: "获取迁移统计失败" });
  }
});

export default router;
