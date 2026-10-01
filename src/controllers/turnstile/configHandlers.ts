import type { Request, Response } from "express";
import { isAdminRole } from "../../middleware/auth";
import { TurnstileService } from "../../services/turnstileService";
import { isCaptchaScenario } from "../../services/turnstile/allocation";
import { CAPTCHA_PROVIDER_IDS, type CaptchaProviderId, type CaptchaScenario } from "../../services/turnstile/types";
import { firstString } from "../../utils/httpParam";
import logger from "../../utils/logger";
import { getClientIp, requireSuperAdmin } from "./_helpers";

export async function getTurnstileConfig(req: Request, res: Response) {
  try {
    const config = await TurnstileService.getConfig();

    const isAdmin = isAdminRole((req as any).user?.role);

    const maskedSecretKey =
      config.secretKey && config.secretKey.length > 8
        ? `${config.secretKey.slice(0, 2)}***${config.secretKey.slice(-4)}`
        : config.secretKey
          ? "***"
          : null;

    res.json({
      enabled: config.enabled,
      siteKey: config.siteKey,
      ...(isAdmin && { secretKey: maskedSecretKey }),
    });
  } catch (error) {
    console.error("获取Turnstile配置失败:", error);
    res.status(500).json({ error: "获取配置失败" });
  }
}

export async function getPublicConfig(_req: Request, res: Response) {
  try {
    const config = await TurnstileService.getConfig();
    const hcaptchaConfig = await TurnstileService.getHCaptchaConfig();
    const capConfig = await TurnstileService.getCapConfig();

    res.json({
      enabled: config.enabled,
      siteKey: config.siteKey,
      hcaptchaEnabled: hcaptchaConfig.enabled,
      hcaptchaSiteKey: hcaptchaConfig.siteKey,
      capEnabled: capConfig.enabled,
      capSiteKey: capConfig.siteKey,
      capApiEndpoint: capConfig.apiEndpoint,
    });
  } catch (error) {
    console.error("获取公共配置失败:", error);
    res.status(500).json({ error: "获取配置失败" });
  }
}

export async function getPublicTurnstile(_req: Request, res: Response) {
  try {
    const config = await TurnstileService.getConfig();
    res.json({ enabled: config.enabled, siteKey: config.siteKey });
  } catch (error) {
    console.error("获取Turnstile公共配置失败:", error);
    res.status(500).json({ error: "获取配置失败" });
  }
}

export async function verifyTurnstileToken(req: Request, res: Response) {
  try {
    const { token } = req.body;
    const validatedClientIp = getClientIp(req);

    if (!token || typeof token !== "string") {
      return res.status(400).json({ success: false, error: "token 参数无效" });
    }

    const ok = await TurnstileService.verifyToken(token, validatedClientIp);

    if (ok) {
      return res.json({ success: true, verified: true });
    }

    return res.status(400).json({ success: false, verified: false });
  } catch (error) {
    console.error("验证 Turnstile token 失败:", error);
    res.status(500).json({ success: false, error: "服务器内部错误" });
  }
}

export async function secureCaptchaConfig(req: Request, res: Response) {
  try {
    // G4-24: 该端点只返回验证码类型与公开 siteKey，无敏感信息。
    // 选择逻辑已抽到 services/turnstile/providers（上线开关 + 相对权重 + 分配策略），这里只负责组装响应。
    // 场景（default/first_visit/standalone）决定用哪套场景权重与策略；exclude 是前端控件加载失败后的降级重试。
    const scenario = parseScenario(req.body?.scenario);
    const exclude = parseExclude(req.body?.exclude);
    const selection = await TurnstileService.selectCaptchaProvider(undefined, { scenario, exclude });

    logger.debug("后端CAPTCHA选择", {
      type: selection.provider,
      selectionMethod: selection.reason,
      scenario,
      strategy: selection.strategy,
      excluded: exclude,
      configEnabled: selection.enabled,
      hasSiteKey: !!selection.siteKey,
    });

    // 控件外观是公开项（theme/size/language/是否展示署名），按选中供应商解析后下发；权重与额度绝不下发。
    const [widgets, policy] = await Promise.all([
      TurnstileService.getCaptchaWidgetSettings(),
      TurnstileService.getCaptchaAllocationPolicy(),
    ]);
    const widget = TurnstileService.resolveProviderWidgetSettings(
      widgets,
      selection.enabled ? selection.provider : null,
    );

    res.json({
      success: true,
      captchaType: selection.provider,
      scenario,
      strategy: selection.strategy,
      reason: selection.reason,
      failoverMaxAttempts: policy.failoverMaxAttempts,
      config: {
        enabled: selection.enabled,
        siteKey: selection.siteKey,
        ...(selection.provider === "trycap" ? { apiEndpoint: selection.apiEndpoint } : {}),
      },
      widget,
    });
  } catch (error) {
    logger.error("获取安全CAPTCHA配置失败:", error);
    res.status(500).json({ success: false, error: "服务器内部错误" });
  }
}

function parseScenario(value: unknown): CaptchaScenario {
  const candidate = firstString(value);
  return isCaptchaScenario(candidate) ? candidate : "default";
}

/** 降级重试的排除名单：只接受已知供应商且最多三家。 */
function parseExclude(value: unknown): CaptchaProviderId[] {
  if (!Array.isArray(value)) return [];
  const excluded: CaptchaProviderId[] = [];
  for (const entry of value) {
    if (TurnstileService.isCaptchaProviderId(entry) && !excluded.includes(entry)) excluded.push(entry);
    if (excluded.length >= CAPTCHA_PROVIDER_IDS.length) break;
  }
  return excluded;
}

export async function updateTurnstileConfig(req: Request, res: Response) {
  try {
    if (!requireSuperAdmin(req, res)) return;

    const { key, value } = req.body;

    if (!key || !value || !["TURNSTILE_SECRET_KEY", "TURNSTILE_SITE_KEY"].includes(key)) {
      return res.status(400).json({ success: false, error: "参数无效" });
    }

    const success = await TurnstileService.updateConfig(key as "TURNSTILE_SECRET_KEY" | "TURNSTILE_SITE_KEY", value);

    if (success) {
      res.json({ success: true, message: "配置更新成功" });
    } else {
      res.status(500).json({ success: false, error: "配置更新失败" });
    }
  } catch (error) {
    console.error("更新Turnstile配置失败:", error);
    res.status(500).json({ success: false, error: "服务器内部错误" });
  }
}

export async function deleteTurnstileConfig(req: Request, res: Response) {
  try {
    if (!requireSuperAdmin(req, res)) return;

    const key = firstString(req.params.key);

    if (!key || !["TURNSTILE_SECRET_KEY", "TURNSTILE_SITE_KEY"].includes(key)) {
      return res.status(400).json({ success: false, error: "参数无效" });
    }

    const success = await TurnstileService.deleteConfig(key as "TURNSTILE_SECRET_KEY" | "TURNSTILE_SITE_KEY");

    if (success) {
      res.json({ success: true, message: "配置删除成功" });
    } else {
      res.status(500).json({ success: false, error: "配置删除失败" });
    }
  } catch (error) {
    console.error("删除Turnstile配置失败:", error);
    res.status(500).json({ success: false, error: "服务器内部错误" });
  }
}
