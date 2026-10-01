import type { Request, Response } from "express";
import { TurnstileService } from "../../services/turnstileService";
import logger from "../../utils/logger";
import { requireAdmin, requireSuperAdmin } from "./_helpers";

/**
 * 人机验证供应商调度（上线/下线 + 权重）。
 *
 * 与凭据配置分离：这里只动「用不用、用多少」，siteKey/secret 仍走各自的 *-config 接口。
 * 读：admin；写：superadmin。
 */
export async function getCaptchaProviders(req: Request, res: Response) {
  try {
    if (!requireAdmin(req, res)) return;

    const { providers, candidates } = await TurnstileService.collectCaptchaProviders();
    const maskedSecrets = await TurnstileService.getProviderSecretPresence();

    res.json({
      success: true,
      providers: providers.map((provider) => ({
        ...provider,
        secretKey: maskedSecrets[provider.provider] ?? null,
      })),
      selection: {
        candidateCount: candidates.length,
        // 管理端用来解释「为什么现在不下发这家」的即时结论
        effectiveProviders: candidates.map((candidate) => candidate.provider),
      },
    });
  } catch (error) {
    logger.error("获取人机验证供应商配置失败", error);
    res.status(500).json({ success: false, error: "服务器内部错误" });
  }
}

export async function updateCaptchaProviders(req: Request, res: Response) {
  try {
    if (!requireSuperAdmin(req, res)) return;

    const input = Array.isArray(req.body?.providers) ? req.body.providers : null;
    if (!input || input.length === 0) {
      return res.status(400).json({ success: false, error: "providers 参数无效" });
    }

    const results: Array<{ provider: string; success: boolean; error?: string }> = [];

    for (const entry of input) {
      const provider = entry?.provider;
      if (!TurnstileService.isCaptchaProviderId(provider)) {
        results.push({ provider: String(provider ?? "unknown"), success: false, error: "未知供应商" });
        continue;
      }

      const success = await TurnstileService.upsertCaptchaProviderSetting(provider, {
        enabled: entry.enabled !== false,
        weight: TurnstileService.clampProviderWeight(entry.weight),
      });

      results.push({
        provider,
        success,
        ...(success ? {} : { error: "写入失败，请检查数据库连接" }),
      });
    }

    const failed = results.filter((result) => !result.success);
    if (failed.length === results.length) {
      return res.status(500).json({ success: false, error: "供应商配置保存失败", results });
    }

    const { providers } = await TurnstileService.collectCaptchaProviders();
    res.json({ success: true, message: "配置已保存并立即生效", results, providers });
  } catch (error) {
    logger.error("更新人机验证供应商配置失败", error);
    res.status(500).json({ success: false, error: "服务器内部错误" });
  }
}

/**
 * 供应商自检。目前只有 trycap 能在不消耗 token 的前提下验证「地址可达 + Site Key 有效」；
 * turnstile / hcaptcha 的 siteverify 必须持有效 token，因此这里只做凭据存在性检查并如实说明。
 */
export async function testCaptchaProvider(req: Request, res: Response) {
  try {
    if (!requireSuperAdmin(req, res)) return;

    const provider = req.params.provider;
    if (!TurnstileService.isCaptchaProviderId(provider)) {
      return res.status(400).json({ success: false, error: "未知供应商" });
    }

    if (provider === "trycap") {
      const result = await TurnstileService.testCapConnectivity();
      return res.json({ success: true, supported: true, provider, result });
    }

    const presence = await TurnstileService.getProviderSecretPresence();
    const configured = !!presence[provider];

    return res.json({
      success: true,
      supported: false,
      provider,
      result: {
        ok: configured,
        latencyMs: 0,
        error: configured
          ? "该供应商不支持免令牌自检：请在实际验证码流程中验证密钥"
          : "尚未配置 Secret Key",
      },
    });
  } catch (error) {
    logger.error("人机验证供应商自检失败", error);
    res.status(500).json({ success: false, error: "服务器内部错误" });
  }
}
