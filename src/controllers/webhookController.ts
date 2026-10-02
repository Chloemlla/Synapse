import type { Request, Response } from "express";
import { suppressFromDeliveryEvent } from "../services/emailSuppressionService";
import { getResendSecret, verifyResendPayload, WebhookEventService } from "../services/webhookEventService";
import logger from "../utils/logger";

/** 从 Resend 事件里提取收件人（`to` 可能是数组或单值）。 */
function extractRecipients(data: any): string[] {
  const raw = data?.to ?? data?.recipient;
  if (Array.isArray(raw)) return raw.map((item) => String(item).trim()).filter(Boolean);
  if (typeof raw === "string" && raw.trim()) return [raw.trim()];
  return [];
}

/** 退信/投诉的可读细节：只取 SMTP 归类信息，不落邮件正文。 */
function extractDeliveryDetail(data: any): string {
  const bounce = data?.bounce || {};
  return [bounce.type, bounce.subType, bounce.message, data?.status]
    .filter((value) => typeof value === "string" && value.trim())
    .join(" / ")
    .slice(0, 500);
}

export class WebhookController {
  // POST /api/webhooks/resend
  static async handleResendWebhook(req: Request, res: Response) {
    try {
      // 读取原始请求体（express.raw 中间件提供 Buffer）并验证 Svix 签名
      const payload = Buffer.isBuffer(req.body)
        ? req.body.toString("utf8")
        : typeof req.body === "string"
          ? req.body
          : JSON.stringify(req.body || {});
      // 支持从路由读取多密钥的 key（/resend-:key）
      const routeKey = (req.params as any)?.key as string | undefined;
      // WH-5：取密钥失败是服务端配置缺失，不能伪装成「签名不对」（400）——
      // 否则运维看到的是客户端错误，真正该修的是环境/DB 里的密钥。
      let secret: string;
      try {
        secret = await getResendSecret(routeKey);
      } catch (e) {
        logger.error("[ResendWebhook] 密钥未配置，拒绝处理", {
          routeKey: routeKey || "DEFAULT",
          error: e instanceof Error ? e.message : String(e),
        });
        return res.status(503).json({ error: "Webhook secret is not configured" });
      }

      let event: any;
      try {
        event = await verifyResendPayload(payload, req.headers, secret);
      } catch (e) {
        logger.warn("[ResendWebhook] 签名验证失败", { error: e instanceof Error ? e.message : String(e) });
        return res.status(400).json({ error: "Invalid webhook signature" });
      }

      // Basic validation
      if (!event) {
        return res.status(400).json({ error: "Invalid webhook payload" });
      }

      // Log safely (avoid logging huge content)
      const { type, created_at, data, id: evtId } = event;
      const summary = {
        type,
        created_at,
        messageId: data?.id || data?.message?.id,
        to: data?.to || data?.recipient,
        subject: data?.subject || data?.message?.subject,
        status: data?.status,
      };
      logger.info("[ResendWebhook] Received event", summary);

      // Persist to database（WH-1：幂等 ingest，重投只累加 deliveryCount）
      let duplicate = false;
      try {
        const result = await WebhookEventService.ingest({
          provider: "resend",
          routeKey: routeKey,
          eventId: evtId || data?.id || data?.message?.id,
          type,
          created_at: created_at ? new Date(created_at) : undefined,
          to: data?.to || data?.recipient,
          subject: data?.subject || data?.message?.subject,
          status: data?.status,
          data,
          raw: event,
        });
        duplicate = result.duplicate;
      } catch (dbErr) {
        logger.warn("[ResendWebhook] 保存事件到数据库失败", {
          error: dbErr instanceof Error ? dbErr.message : String(dbErr),
        });
      }

      // EM-1：退信 / 投诉自动入抑制名单。失败不回滚已存事件，也不影响应答（Svix 重投会幂等）。
      const recipients = extractRecipients(data);
      if (recipients.length > 0) {
        try {
          const added = await suppressFromDeliveryEvent({
            type: String(type || ""),
            recipients,
            detail: extractDeliveryDetail(data),
          });
          if (added > 0) {
            logger.info("[ResendWebhook] 已将地址加入邮件抑制名单", { count: added, type });
          }
        } catch (suppressErr) {
          logger.warn("[ResendWebhook] 写入邮件抑制名单失败", {
            error: suppressErr instanceof Error ? suppressErr.message : String(suppressErr),
          });
        }
      }

      // Acknowledge receipt
      return res.status(200).json({ success: true, duplicate });
    } catch (err) {
      logger.error("[ResendWebhook] Error handling webhook", {
        error: err instanceof Error ? err.message : String(err),
      });
      return res.status(500).json({ error: "Webhook handling failed" });
    }
  }
}