import type { Request, Response } from "express";
import { addSuppression, verifyUnsubscribeToken } from "../services/emailSuppressionService";
import {
  EmailService,
  getAllSenderDomains,
  getEmailQuota,
} from "../services/emailService";
import { deliverEmailRequest } from "./emailDelivery";
import { firstString } from "../utils/httpParam";
import logger from "../utils/logger";

/** EM-2：退订结果页。服务端渲染静态 HTML，不引入脚本。 */
function renderUnsubscribePage(ok: boolean, message: string): string {
  const title = ok ? "已退订" : "链接无效";
  const color = ok ? "#0f9d58" : "#d93025";
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title></head><body style="font-family:system-ui,-apple-system,Segoe UI,Arial,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;background:#f6f7f9;color:#1f2937"><main style="max-width:420px;padding:32px;border-radius:12px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.08);text-align:center"><h1 style="font-size:20px;color:${color};margin:0 0 12px">${title}</h1><p style="font-size:14px;line-height:1.6;color:#4b5563;margin:0">${message}</p></main></body></html>`;
}

function getAllowedSenderDomains(): string[] {
  return getAllSenderDomains();
}

export class EmailController {
  /**
   * 发送邮件
   * @param req.body { from: string, to: string[], subject: string, html: string, text?: string }
   */
  /**
   * EM-2：退订（公开端点，走签名 token，不需要登录）。
   *
   * 同时兼容邮件客户端的一键退订（RFC 8058 `List-Unsubscribe-Post`）：POST 请求同样从
   * query 取 token，返回 200 空体。GET 则回一个极简结果页，便于人直接点链接。
   */
  public static async unsubscribe(req: Request, res: Response) {
    const token = firstString(req.query.token) || firstString((req.body || {}).token);
    const email = verifyUnsubscribeToken(token);
    const isGet = req.method === "GET";
    res.setHeader("Cache-Control", "no-store");

    if (!email) {
      if (isGet) {
        return res.status(400).type("html").send(renderUnsubscribePage(false, "退订链接无效或已过期，请从最新一封邮件里的链接重试。"));
      }
      return res.status(400).json({ success: false, error: "退订链接无效或已过期" });
    }

    const record = await addSuppression({
      email,
      reason: "unsubscribe",
      source: "user-unsubscribe",
      detail: "用户通过邮件链接退订",
    });
    if (!record) {
      logger.error("[EmailController] 退订写入失败", { email });
      if (isGet) {
        return res.status(500).type("html").send(renderUnsubscribePage(false, "退订暂时无法完成，请稍后重试。"));
      }
      return res.status(500).json({ success: false, error: "退订暂时无法完成，请稍后重试" });
    }

    logger.info("[EmailController] 用户退订成功", { email });
    if (isGet) {
      return res.type("html").send(renderUnsubscribePage(true, "该地址已停止接收同类邮件。若误操作，可联系管理员恢复。"));
    }
    return res.json({ success: true });
  }

  public static async sendEmail(req: Request, res: Response) {
    return deliverEmailRequest(req, res, "html");
  }

  public static async sendEmailBatch(req: Request, res: Response) {
    return deliverEmailRequest(req, res, "batch");
  }

  public static async sendSimpleEmail(req: Request, res: Response) {
    return deliverEmailRequest(req, res, "simple");
  }

  public static async sendMarkdownEmail(req: Request, res: Response) {
    return deliverEmailRequest(req, res, "markdown");
  }

  /**
   * 获取邮件服务状态
   */
  public static async getServiceStatus(req: Request, res: Response) {
    try {
      const ip = req.ip || "unknown";
      const user = (req as any).user;

      logger.info("收到邮件服务状态查询请求", {
        ip,
        userId: user?.id,
        username: user?.username,
      });

      const status = await EmailService.getServiceStatus();

      logger.info("邮件服务状态查询完成", {
        available: status.available,
        error: status.error,
        ip,
        userId: user?.id,
      });

      res.json({
        success: true,
        available: status.available,
        error: status.error,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "未知错误";
      logger.error("邮件服务状态查询异常", {
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
        ip: req.ip,
        userId: (req as any).user?.id,
      });
      res.status(500).json({
        success: false,
        error: "服务状态查询失败",
      });
    }
  }

  /**
   * 查询当前用户邮件配额
   * GET /api/email/quota
   */
  public static async getQuota(req: Request, res: Response) {
    try {
      const user = (req as any).user;
      if (!user?.id) return res.status(401).json({ error: "未登录" });
      const quota = await getEmailQuota(user.id);
      res.json(quota);
    } catch (_error) {
      res.status(500).json({ error: "查询配额失败" });
    }
  }

  /**
   * 查询所有可用发件人域名
   * GET /api/email/domains
   */
  public static async getDomains(_req: Request, res: Response) {
    try {
      const domains = getAllSenderDomains();
      res.json({ domains });
    } catch (_error) {
      res.status(500).json({ error: "查询域名失败" });
    }
  }

  /**
   * 验证发件人域名
   * @param req.body { email: string }
   */
  public static async validateSenderDomain(req: Request, res: Response) {
    try {
      const { email } = req.body;
      const ip = req.ip || "unknown";
      const user = (req as any).user;

      logger.info("收到发件人域名验证请求", {
        email,
        ip,
        userId: user?.id,
        username: user?.username,
      });

      if (!email) {
        logger.warn("发件人域名验证失败：参数无效", {
          summary: summarizeEmailBody(req.body),
          ip,
          userId: user?.id,
        });
        return res.status(400).json({
          error: "请提供邮箱地址",
        });
      }

      const isValid = EmailService.isValidSenderDomain(email);

      logger.info("发件人域名验证完成", {
        email,
        isValid,
        ip,
        userId: user?.id,
      });

      res.json({
        success: true,
        email,
        isValid,
        allowedDomains: getAllowedSenderDomains(),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "未知错误";
      logger.error("发件人域名验证异常", {
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
        summary: summarizeEmailBody(req.body),
        ip: req.ip,
        userId: (req as any).user?.id,
      });
      res.status(500).json({
        success: false,
        error: "域名验证失败",
      });
    }
  }

  /**
   * 验证邮箱格式
   * @param req.body { emails: string[] }
   */
  public static async validateEmails(req: Request, res: Response) {
    try {
      const { emails } = req.body;
      const ip = req.ip || "unknown";
      const user = (req as any).user;

      logger.info("收到邮箱验证请求", {
        emailCount: emails?.length,
        ip,
        userId: user?.id,
        username: user?.username,
      });

      if (!emails || !Array.isArray(emails)) {
        logger.warn("邮箱验证失败：参数无效", {
          summary: summarizeEmailBody(req.body),
          ip,
          userId: user?.id,
        });
        return res.status(400).json({
          error: "请提供邮箱地址数组",
        });
      }

      const validation = EmailService.validateEmails(emails);

      logger.info("邮箱验证完成", {
        totalCount: emails.length,
        validCount: validation.valid.length,
        invalidCount: validation.invalid.length,
        ip,
        userId: user?.id,
      });

      res.json({
        success: true,
        total: emails.length,
        valid: validation.valid,
        invalid: validation.invalid,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "未知错误";
      logger.error("邮箱验证异常", {
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
        summary: summarizeEmailBody(req.body),
        ip: req.ip,
        userId: (req as any).user?.id,
      });
      res.status(500).json({
        success: false,
        error: "邮箱验证失败",
      });
    }
  }
}
