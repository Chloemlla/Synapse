import type { Request, Response } from "express";
import { TurnstileService } from "../../services/turnstileService";
import logger from "../../utils/logger";
import {
  DEFAULT_ALLOCATION_POLICY,
  DEFAULT_WIDGET_SETTINGS,
  clampProviderPriority,
  normalizeScenarioWeights,
} from "../../services/turnstile/allocation";
import {
  CAPTCHA_ALLOCATION_STRATEGIES,
  CAPTCHA_ALLOCATION_STRATEGY_LABELS,
  CAPTCHA_SCENARIOS,
  CAPTCHA_SCENARIO_LABELS,
} from "../../services/turnstile/types";
import { requireAdmin, requireSuperAdmin } from "./_helpers";

/**
 * 人机验证供应商调度（上线/下线 + 权重 + 优先级 + 场景权重）。
 *
 * 与凭据配置分离：这里只动「用不用、用多少、排第几、哪个场景」，siteKey/secret 仍走各自的 *-config 接口。
 * 分配策略与控件外观在 allocationHandlers.ts，本接口一次把它们的当前值一并带回，减少管理端往返。
 * 读：admin；写：superadmin。
 */
export async function getCaptchaProviders(req: Request, res: Response) {
  try {
    if (!requireAdmin(req, res)) return;

    const { providers, candidates, policy, widgets, scenario } = await TurnstileService.collectCaptchaProviders();
    const maskedSecrets = await TurnstileService.getProviderSecretPresence();

    res.json({
      success: true,
      scenario,
      providers: providers.map((provider) => ({
        ...provider,
        secretKey: maskedSecrets[provider.provider] ?? null,
      })),
      policy,
      widgets,
      scenarios: CAPTCHA_SCENARIOS.map((entry) => ({ value: entry, label: CAPTCHA_SCENARIO_LABELS[entry] })),
      strategies: CAPTCHA_ALLOCATION_STRATEGIES.map((entry) => ({
        value: entry,
        label: CAPTCHA_ALLOCATION_STRATEGY_LABELS[entry],
      })),
      defaults: { policy: DEFAULT_ALLOCATION_POLICY, widgets: DEFAULT_WIDGET_SETTINGS },
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

      // 额度字段缺省 = 不改动现有设置；显式 0 = 解除限额。
      const hasQuota = entry.monthlyQuota !== undefined && entry.monthlyQuota !== null;
      const hasPriority = entry.priority !== undefined && entry.priority !== null;
      const hasScenarioWeights = entry.scenarioWeights !== undefined && entry.scenarioWeights !== null;
      const success = await TurnstileService.upsertCaptchaProviderSetting(provider, {
        enabled: entry.enabled !== false,
        weight: TurnstileService.clampProviderWeight(entry.weight),
        ...(hasQuota ? { monthlyQuota: TurnstileService.clampMonthlyQuota(entry.monthlyQuota) } : {}),
        ...(hasPriority ? { priority: clampProviderPriority(entry.priority) } : {}),
        ...(hasScenarioWeights ? { scenarioWeights: normalizeScenarioWeights(entry.scenarioWeights) ?? {} } : {}),
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

    const { providers, policy, widgets } = await TurnstileService.collectCaptchaProviders();
    res.json({ success: true, message: "配置已保存并立即生效", results, providers, policy, widgets });
  } catch (error) {
    logger.error("更新人机验证供应商配置失败", error);
    res.status(500).json({ success: false, error: "服务器内部错误" });
  }
}

/** 本月额度历史（按供应商 + 月份），管理端图表用。 */
export async function getCaptchaQuotaHistory(req: Request, res: Response) {
  try {
    if (!requireAdmin(req, res)) return;

    const monthsRaw = Number.parseInt(String(req.query.months ?? "6"), 10);
    const months = Number.isFinite(monthsRaw) ? monthsRaw : 6;

    const [history, providers] = await Promise.all([
      TurnstileService.readCaptchaQuotaHistory(months),
      TurnstileService.collectCaptchaProviders(),
    ]);

    res.json({
      success: true,
      months,
      history,
      quotas: providers.providers.map((provider) => provider.quota),
    });
  } catch (error) {
    logger.error("获取人机验证额度历史失败", error);
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
