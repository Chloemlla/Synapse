import { type RequestHandler, Router } from "express";
import { isSuperAdmin } from "../middleware/auth";
import { auditLog } from "../middleware/auditLog";
import { authenticateToken } from "../middleware/authenticateToken";
import { commandLimiter } from "../middleware/routeLimiters";
import { commandService } from "../services/commandService";
import { hasValidSecuritySession } from "../utils/securitySession";
import { encryptCommandPayload } from "../utils/commandCrypto";
import { boundedInt, firstString } from "../utils/httpParam";
import logger from "../utils/logger";

/** `/history` 单次返回上限：历史正文含命令输出，不设界会让超管误触一次就把大段系统信息拉进浏览器。 */
const COMMAND_HISTORY_MAX_LIMIT = 200;

const router = Router();

const ensureAdmin = (req: any, res: any): boolean => {
  if (!isSuperAdmin(req)) {
    res.status(403).json({ error: "需要管理员权限" });
    return false;
  }
  return true;
};

function getBearerToken(req: { headers: { authorization?: string } }): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return null;
  }
  const token = authHeader.slice("Bearer ".length).trim();
  return token || null;
}

function encryptWithToken(payload: unknown, token: string) {
  return encryptCommandPayload(payload, token);
}

/**
 * @openapi
 * /command/y:
 *   post:
 *     summary: 添加命令
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               command:
 *                 type: string
 *               password:
 *                 type: string
 *     responses:
 *       200:
 *         description: 添加命令结果
 */
router.post("/y", commandLimiter, authenticateToken, auditLog({ module: "system", action: "command.add" }), async (req, res) => {
  const { command } = req.body;

  if (!ensureAdmin(req, res)) {
    return;
  }

  if (!hasValidSecuritySession(req)) {
    logger.warn("[CommandManager] 安全会话校验失败", { reason: "invalid-session", path: "/y" });
    return res.status(403).json({ error: "安全会话无效或已过期，请先建立安全会话" });
  }

  try {
    const result = await commandService.addCommand(command as string);

    if (result.status === "error") {
      return res.status(403).json(result);
    }

    return res.json(result);
  } catch (error) {
    logger.error("[CommandManager] 添加命令失败", { error });
    return res.status(500).json({ error: "添加命令失败" });
  }
});

/**
 * @openapi
 * /command/q:
 *   get:
 *     summary: 获取下一个命令
 *     responses:
 *       200:
 *         description: 下一个命令
 */
router.get("/q", commandLimiter, authenticateToken, async (req, res) => {
  try {
    if (!isSuperAdmin(req)) {
      return res.status(403).json({ error: "需要管理员权限" });
    }

    const result = await commandService.getNextCommand();
    const token = getBearerToken(req);
    // Cookie-authenticated browser sessions receive plaintext JSON over TLS.
    // Bearer clients still receive encrypted envelopes for backward compatibility.
    if (!token) {
      logger.info("[CommandManager] 命令队列以会话明文返回", {
        path: "/q",
        hasPayload: Boolean(result),
        mode: "cookie-session",
      });
      return res.json({ success: true, payload: result, mode: "cookie-session" });
    }

    const encrypted = encryptWithToken(result, token);
    logger.info("[CommandManager] 命令队列已加密返回", {
      path: "/q",
      hasPayload: Boolean(result),
      mode: "bearer-encrypted",
    });

    return res.json({
      success: true,
      mode: "bearer-encrypted",
      ...encrypted,
    });
  } catch (error) {
    logger.error("[CommandManager] 获取命令失败", { error });
    return res.status(500).json({ error: "获取命令失败" });
  }
});

/**
 * @openapi
 * /command/p:
 *   post:
 *     summary: 移除命令
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               command:
 *                 type: string
 *     responses:
 *       200:
 *         description: 移除命令结果
 */
router.post("/p", commandLimiter, authenticateToken, auditLog({ module: "system", action: "command.remove" }), async (req, res) => {
  if (!ensureAdmin(req, res)) {
    return;
  }

  // 字段名兼容：`CommandManager` 前端一直发 `commandId`，而这里读的是 `command` —— 结果
  // 后端收到 undefined、静默回 `{status:"error"}`，前端却已把该行从本地队列删掉。
  // 两种名字都接受，缺参数时按 400 明确拒绝，不再用 200 掩盖失败。
  const commandId = firstString(req.body?.commandId) ?? firstString(req.body?.command) ?? "";
  if (!commandId.trim()) {
    return res.status(400).json({ error: "缺少命令 ID" });
  }

  const result = await commandService.removeCommand(commandId.trim());
  if (result.status === "error") {
    return res.status(404).json(result);
  }
  return res.json(result);
});

/**
 * @openapi
 * /command/execute:
 *   post:
 *     summary: 执行命令
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [command, password]
 *             properties:
 *               command:
 *                 type: string
 *                 description: 要执行的命令
 *               password:
 *                 type: string
 *                 description: 管理员密码
 *     responses:
 *       200:
 *         description: 命令执行成功
 *       400:
 *         description: 危险命令被拒绝
 *       403:
 *         description: 密码错误
 *       500:
 *         description: 命令执行失败
 */
router.post(
  "/execute",
  commandLimiter,
  authenticateToken,
  auditLog({
    module: "system",
    action: "command.execute",
    extractDetail: (req) => ({ command: (req.body as any)?.command }),
  }),
  async (req, res) => {
    try {
      if (!ensureAdmin(req, res)) {
        return;
      }

      const { command } = req.body;

      if (!hasValidSecuritySession(req)) {
        logger.warn("[CommandManager] 安全会话校验失败", { reason: "invalid-session", path: "/execute" });
        return res.status(403).json({ error: "安全会话无效或已过期，请先建立安全会话" });
      }

      // 真正的命令白名单/黑名单判定在 commandService.validateCommand，路由层不再维护子串黑名单
      const output = await commandService.executeCommand(command);
      return res.json({ output });
    } catch (error) {
      logger.error("[CommandManager] 命令执行错误", { error });
      return res.status(500).json({ error: "命令执行失败" });
    }
  },
);

/**
 * @openapi
 * /command/status:
 *   post:
 *     summary: 获取服务器状态
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [password]
 *             properties:
 *               password:
 *                 type: string
 *                 description: 管理员密码
 *     responses:
 *       200:
 *         description: 服务器状态信息
 *       403:
 *         description: 密码错误
 */
router.post(
  "/status",
  commandLimiter,
  authenticateToken,
  auditLog({ module: "system", action: "command.status", captureBody: false }),
  async (req, res) => {
    try {
      if (!ensureAdmin(req, res)) {
        return;
      }

      if (!hasValidSecuritySession(req)) {
        logger.warn("[CommandManager] 安全会话校验失败", { reason: "invalid-session", path: "/status" });
        return res.status(403).json({ error: "安全会话无效或已过期，请先建立安全会话" });
      }

      const status = commandService.getServerStatus();
      return res.json(status);
    } catch (error) {
      logger.error("[CommandManager] 获取状态错误", { error });
      return res.status(500).json({ error: "获取服务器状态失败" });
    }
  },
);

/**
 * @openapi
 * /command/history:
 *   get:
 *     summary: 获取执行历史
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: 返回历史记录数量限制
 *     responses:
 *       200:
 *         description: 执行历史列表
 */
router.get("/history", commandLimiter, authenticateToken, async (req, res) => {
  try {
    if (!isSuperAdmin(req)) {
      return res.status(403).json({ error: "需要管理员权限" });
    }

    const limit = boundedInt(req.query.limit, {
      min: 1,
      max: COMMAND_HISTORY_MAX_LIMIT,
      fallback: 50,
    });
    const history = await commandService.getExecutionHistory(limit);
    const token = getBearerToken(req);
    if (!token) {
      return res.json({ success: true, payload: history, mode: "cookie-session" });
    }

    const encrypted = encryptWithToken(history, token);
    return res.json({ success: true, mode: "bearer-encrypted", ...encrypted });
  } catch (error) {
    logger.error("[CommandManager] 获取历史失败", { error });
    return res.status(500).json({ error: "获取执行历史失败" });
  }
});

/**
 * @openapi
 * /command/clear-history:
 *   post:
 *     summary: 清空执行历史
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [password]
 *             properties:
 *               password:
 *                 type: string
 *                 description: 管理员密码
 *     responses:
 *       200:
 *         description: 清空结果
 */
router.post("/clear-history", commandLimiter, authenticateToken, auditLog({ module: "system", action: "command.clearHistory" }), async (req, res) => {
  try {
    // 先判管理员再判操作密码：反过来的话，任何已登录的普通用户都能凭「密码错误 / 需要管理员权限」
    // 两种 403 的差异把这个接口当成操作密码的探测口。
    if (!ensureAdmin(req, res)) {
      return;
    }

    if (!hasValidSecuritySession(req)) {
      logger.warn("[CommandManager] 安全会话校验失败", { reason: "invalid-session", path: "/clear-history" });
      return res.status(403).json({ error: "安全会话无效或已过期，请先建立安全会话" });
    }

    const result = await commandService.clearExecutionHistory();
    return res.json(result);
  } catch (error) {
    logger.error("[CommandManager] 清空历史失败", { error });
    return res.status(500).json({ error: "清空执行历史失败" });
  }
});

/**
 * @openapi
 * /command/clear-queue:
 *   post:
 *     summary: 清空命令队列
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [password]
 *             properties:
 *               password:
 *                 type: string
 *                 description: 管理员密码
 *     responses:
 *       200:
 *         description: 清空结果
 */
router.post("/clear-queue", commandLimiter, authenticateToken, auditLog({ module: "system", action: "command.clearQueue" }), async (req, res) => {
  try {
    if (!ensureAdmin(req, res)) {
      return;
    }

    if (!hasValidSecuritySession(req)) {
      logger.warn("[CommandManager] 安全会话校验失败", { reason: "invalid-session", path: "/clear-queue" });
      return res.status(403).json({ error: "安全会话无效或已过期，请先建立安全会话" });
    }

    const result = await commandService.clearCommandQueue();
    return res.json(result);
  } catch (error) {
    logger.error("[CommandManager] 清空队列失败", { error });
    return res.status(500).json({ error: "清空命令队列失败" });
  }
});

let commandStatusHandler: RequestHandler | undefined = undefined;
for (const r of router.stack) {
  if (r.route && r.route.path === "/status") {
    // 路由栈最后一个 handler 才是真正的业务处理器（前面是 limiter/鉴权/审计中间件）
    const handlers = r.route.stack.map((layer) => layer.handle);
    commandStatusHandler = handlers[handlers.length - 1];
    break;
  }
}

export { commandStatusHandler };

export default router;
