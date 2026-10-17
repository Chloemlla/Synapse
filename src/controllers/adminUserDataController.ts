import type { Request, Response } from "express";
import { isValidUserId } from "./adminUserListHelpers";
import {
  ACCOUNT_EXPORT_MAX_BYTES,
  ACCOUNT_EXPORT_MAX_USERS,
  AccountExportTooLargeError,
  exportAccountData,
  exportAccountsData,
  summarizeAccountData,
} from "../services/accountDataExportService";
import logger from "../utils/logger";

/**
 * 管理端「账户数据」控制器：摘要 / 单账号导出 / 批量导出。
 *
 * 为什么独立成文件：`adminController.ts` 体量常年贴着体积闸门，而这三件事只服务于
 * 用户管理页的「数据」弹窗，放在一起便于保持单一职责。
 *
 * 安全边界（由路由层保证，这里只做防御性校验）：
 * - 仅超级管理员；
 * - 导出要求有效安全会话（会话由密码 / TOTP / Passkey 建立，见 utils/securitySession）；
 * - 每次导出都写路由级审计，审计只记目标与规模，不记正文。
 */

function actorOf(req: Request): { id: string; username: string } | null {
  const user = (req as Request & { user?: { id?: string; username?: string } }).user;
  if (!user?.id) return null;
  return { id: String(user.id), username: String(user.username ?? user.id) };
}

function downloadHeaders(res: Response, filenameBase: string): void {
  const stamp = new Date().toISOString().slice(0, 10);
  const ascii = `${filenameBase.replace(/[^A-Za-z0-9._-]+/g, "-")}-${stamp}.json`;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  // 中文用户名用 RFC 5987 的 filename*，ASCII 回退保证老客户端也能落盘。
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(`${filenameBase}-${stamp}.json`)}`,
  );
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

function sendError(res: Response, error: unknown, fallback: string): void {
  if (error instanceof AccountExportTooLargeError) {
    res.status(413).json({
      error:
        `导出内容约 ${Math.round(error.bytes / 1024 / 1024)}MB，超过 `
        + `${Math.round(ACCOUNT_EXPORT_MAX_BYTES / 1024 / 1024)}MB 上限。请改为单账号导出，或先在数据库中清理历史记录。`,
      code: "ACCOUNT_EXPORT_TOO_LARGE",
    });
    return;
  }
  const message = error instanceof Error ? error.message : "";
  if (message === "用户不存在") {
    res.status(404).json({ error: "用户不存在" });
    return;
  }
  if (message.includes("单次最多导出") || message.includes("请至少选择")) {
    res.status(400).json({ error: message });
    return;
  }
  logger.error(`[AccountExport] ${fallback}`, error);
  res.status(500).json({ error: fallback });
}

export const adminUserDataController = {
  /** GET /api/admin/users/:id/data-summary —— 只统计条数，不读正文。 */
  async getSummary(req: Request, res: Response): Promise<void> {
    const userId = String(req.params.id ?? "");
    if (!isValidUserId(userId)) {
      res.status(400).json({ error: "非法的用户 ID" });
      return;
    }
    try {
      const summary = await summarizeAccountData(userId);
      res.json(summary);
    } catch (error) {
      sendError(res, error, "读取账户数据摘要失败");
    }
  },

  /** GET /api/admin/users/:id/export —— 单账号完整数据（已脱敏）。 */
  async exportUser(req: Request, res: Response): Promise<void> {
    const userId = String(req.params.id ?? "");
    if (!isValidUserId(userId)) {
      res.status(400).json({ error: "非法的用户 ID" });
      return;
    }
    try {
      const document = await exportAccountData(userId, { requestedBy: actorOf(req) });
      const totalRows = document.datasets.reduce((sum, dataset) => sum + dataset.returned, 0);
      logger.info("[AccountExport] 单账号导出完成", {
        subjectId: document.subject.id,
        datasets: document.datasets.length,
        rows: totalRows,
        requestedBy: document.requestedBy?.id ?? "unknown",
      });
      downloadHeaders(res, `account-export-${document.subject.username || userId}`);
      res.send(JSON.stringify(document, null, 2));
    } catch (error) {
      sendError(res, error, "导出账户数据失败");
    }
  },

  /** POST /api/admin/users/export —— 批量导出（最多 10 个账号）。 */
  async exportUsers(req: Request, res: Response): Promise<void> {
    const raw: unknown[] = Array.isArray(req.body?.userIds) ? req.body.userIds : [];
    const userIds = raw.filter((value): value is string => typeof value === "string");
    if (userIds.length !== raw.length) {
      res.status(400).json({ error: "userIds 必须是字符串数组" });
      return;
    }
    if (userIds.length === 0) {
      res.status(400).json({ error: "请至少选择一个用户" });
      return;
    }
    if (userIds.length > ACCOUNT_EXPORT_MAX_USERS) {
      res.status(400).json({ error: `单次最多导出 ${ACCOUNT_EXPORT_MAX_USERS} 个账号` });
      return;
    }
    // 写成 `=== false` 而不是 `!isValidUserId(id)`：后者是「否定类型谓词」，
    // TS 5.5 会把 find 的结果收窄成 never，`.slice` 直接报 TS2339。
    const invalid = userIds.find((id) => isValidUserId(id) === false);
    if (invalid) {
      res.status(400).json({ error: `非法的用户 ID：${invalid.slice(0, 64)}` });
      return;
    }

    try {
      const document = await exportAccountsData(userIds, { requestedBy: actorOf(req) });
      logger.info("[AccountExport] 批量导出完成", {
        accounts: document.accounts.length,
        errors: document.errors.length,
        requestedBy: document.requestedBy?.id ?? "unknown",
      });
      downloadHeaders(res, `accounts-export-${document.accounts.length}`);
      res.send(JSON.stringify(document, null, 2));
    } catch (error) {
      sendError(res, error, "批量导出账户数据失败");
    }
  },
};
