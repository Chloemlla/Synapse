import logger from "../../utils/logger";
import type { Request, Response } from "express";
import { config } from "../../config/config";
import { TurnstileService } from "../../services/turnstileService";
import { firstString } from "../../utils/httpParam";
import { getClientIp, requireAdmin, requireSuperAdmin } from "./_helpers";

/** Cap（trycap）配置管理：Site Key / Secret Key / 实例地址。 */

export async function getCapConfigHandler(req: Request, res: Response) {
  try {
    if (!requireAdmin(req, res)) return;

    const capConfig = await TurnstileService.getCapConfig();

    res.json({
      enabled: capConfig.enabled,
      siteKey: capConfig.siteKey,
      secretKey: capConfig.secretKey ? "***已设置***" : null,
      apiEndpoint: capConfig.apiEndpoint,
    });
  } catch (error) {
    logger.error("获取 Cap 配置失败:", error);
    res.status(500).json({ success: false, error: "服务器内部错误" });
  }
}

export async function updateCapConfigHandler(req: Request, res: Response) {
  try {
    if (!requireSuperAdmin(req, res)) return;

    const { key, value } = req.body;

    if (!TurnstileService.isCapConfigKey(key) || typeof value !== "string" || !value.trim()) {
      return res.status(400).json({ success: false, error: "参数无效" });
    }

    const success = await TurnstileService.updateCapConfig(key, value);

    if (success) {
      res.json({ success: true, message: "配置更新成功" });
    } else {
      res.status(500).json({ success: false, error: "配置更新失败" });
    }
  } catch (error) {
    logger.error("更新 Cap 配置失败:", error);
    res.status(500).json({ success: false, error: "服务器内部错误" });
  }
}

export async function deleteCapConfigHandler(req: Request, res: Response) {
  try {
    if (!requireSuperAdmin(req, res)) return;

    const key = firstString(req.params.key);

    if (!TurnstileService.isCapConfigKey(key)) {
      return res.status(400).json({ success: false, error: "参数无效" });
    }

    const success = await TurnstileService.deleteCapConfig(key);

    if (success) {
      res.json({ success: true, message: "配置删除成功" });
    } else {
      res.status(500).json({ success: false, error: "配置删除失败" });
    }
  } catch (error) {
    logger.error("删除 Cap 配置失败:", error);
    res.status(500).json({ success: false, error: "服务器内部错误" });
  }
}

/** 直接用 Cap 校验一个 token（与 /hcaptcha-verify 对齐的独立入口）。 */
export async function verifyCap(req: Request, res: Response) {
  try {
    const { token } = req.body;
    const validatedClientIp = getClientIp(req);

    if (!config.enableFirstVisitVerification) {
      return res.json({
        success: true,
        message: "验证已跳过",
        verified: true,
        accessToken: null,
        bypassed: true,
      });
    }

    if (!token || typeof token !== "string") {
      return res.status(400).json({ success: false, message: "验证令牌无效" });
    }

    const banStatus = await TurnstileService.isIpBanned(validatedClientIp);
    if (banStatus.banned) {
      return res.status(403).json({
        success: false,
        message: "IP已被封禁",
        details: { reason: banStatus.reason, expiresAt: banStatus.expiresAt },
      });
    }

    const isValid = await TurnstileService.verifyCapToken(token, validatedClientIp);

    if (!isValid) {
      return res.status(400).json({ success: false, message: "验证失败，请重试" });
    }

    res.json({ success: true, message: "验证成功", verified: true });
  } catch (error) {
    logger.error("trycap 验证失败:", error);
    res.status(500).json({ success: false, message: "服务器内部错误" });
  }
}
