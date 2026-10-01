import type { Request, Response } from "express";
import logger from "../../utils/logger";
import { firstString } from "../../utils/httpParam";
import { TurnstileService } from "../../services/turnstileService";
import {
  clampFailoverAttempts,
  clampRolloutPercent,
  clampRotationSeconds,
  clampStickyTtlMinutes,
  normalizeAllocationPolicy,
  normalizeScenarioStrategies,
  normalizeScenarioWeights,
  isCaptchaAllocationStrategy,
  isCaptchaScenario,
  normalizeWidgetLanguage,
  normalizeWidgetOverrides,
  normalizeWidgetSize,
  normalizeWidgetTheme,
  resolveScenarioStrategy,
  simulateAllocation,
  DEFAULT_ALLOCATION_POLICY,
  DEFAULT_WIDGET_SETTINGS,
  MAX_FAILOVER_ATTEMPTS,
  MAX_ROTATION_SECONDS,
  MAX_STICKY_TTL_MINUTES,
  MIN_FAILOVER_ATTEMPTS,
  MIN_ROTATION_SECONDS,
  MIN_STICKY_TTL_MINUTES,
  type CaptchaAllocationPolicyView,
  type CaptchaWidgetSettingsView,
} from "../../services/turnstile/allocation";
import {
  CAPTCHA_ALLOCATION_STRATEGIES,
  CAPTCHA_ALLOCATION_STRATEGY_LABELS,
  CAPTCHA_PROVIDER_IDS,
  CAPTCHA_SCENARIOS,
  CAPTCHA_SCENARIO_LABELS,
  type CaptchaProviderId,
  type CaptchaScenario,
} from "../../services/turnstile/types";
import {
  CAPTCHA_PROVIDER_LABELS,
  buildDraftCandidates,
  describeCandidates,
  isCaptchaProviderId,
  type CaptchaProviderDraftInput,
} from "../../services/turnstile/providers";
import { getCaptchaProviderStats } from "../../services/turnstile/insights";
import { requireAdmin, requireSuperAdmin } from "./_helpers";

/**
 * 「供应商分配体系」的管理端接口：分配策略、控件外观、分配模拟、当下选谁诊断、近期统计。
 *
 * 读写权限与既有 providers 接口一致：读 admin，写 superadmin（路由侧已挂 auditLog）。
 */

const PROVIDER_LABELS = CAPTCHA_PROVIDER_LABELS;

function policyOptions() {
  return {
    scenarios: CAPTCHA_SCENARIOS.map((scenario) => ({ value: scenario, label: CAPTCHA_SCENARIO_LABELS[scenario] })),
    strategies: CAPTCHA_ALLOCATION_STRATEGIES.map((strategy) => ({
      value: strategy,
      label: CAPTCHA_ALLOCATION_STRATEGY_LABELS[strategy],
    })),
    controlProviders: CAPTCHA_PROVIDER_IDS.map((provider) => ({ value: provider, label: PROVIDER_LABELS[provider] })),
    limits: {
      rotationSeconds: { min: MIN_ROTATION_SECONDS, max: MAX_ROTATION_SECONDS },
      stickyTtlMinutes: { min: MIN_STICKY_TTL_MINUTES, max: MAX_STICKY_TTL_MINUTES },
      rolloutPercent: { min: 0, max: 100 },
      failoverMaxAttempts: { min: MIN_FAILOVER_ATTEMPTS, max: MAX_FAILOVER_ATTEMPTS },
    },
  };
}

const WIDGET_THEME_OPTIONS = [
  { value: "auto", label: "跟随系统" },
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
] as const;

const WIDGET_SIZE_OPTIONS = [
  { value: "normal", label: "标准" },
  { value: "compact", label: "紧凑" },
  { value: "flexible", label: "自适应" },
] as const;

const WIDGET_LANGUAGE_OPTIONS = [
  { value: "auto", label: "跟随浏览器" },
  { value: "zh-CN", label: "简体中文" },
  { value: "zh-TW", label: "繁体中文" },
  { value: "en", label: "English" },
  { value: "ja", label: "日本語" },
] as const;

function widgetOptions() {
  return {
    themes: [...WIDGET_THEME_OPTIONS],
    sizes: [...WIDGET_SIZE_OPTIONS],
    languages: [...WIDGET_LANGUAGE_OPTIONS],
  };
}

/** 把请求体里允许的字段抽成策略补丁；出现非法值时返回错误文案。 */
function buildPolicyPatch(body: unknown): { patch: Partial<CaptchaAllocationPolicyView> } | { error: string } {
  const source = (body ?? {}) as Record<string, unknown>;
  const patch: Partial<CaptchaAllocationPolicyView> = {};

  if (source.strategy !== undefined) {
    if (!isCaptchaAllocationStrategy(source.strategy)) return { error: "strategy 取值非法" };
    patch.strategy = source.strategy;
  }
  if (source.rotationSeconds !== undefined) patch.rotationSeconds = clampRotationSeconds(source.rotationSeconds);
  if (source.stickyTtlMinutes !== undefined) patch.stickyTtlMinutes = clampStickyTtlMinutes(source.stickyTtlMinutes);
  if (source.rolloutPercent !== undefined) patch.rolloutPercent = clampRolloutPercent(source.rolloutPercent);
  if (source.failoverMaxAttempts !== undefined) {
    patch.failoverMaxAttempts = clampFailoverAttempts(source.failoverMaxAttempts);
  }
  if (source.stickyEnabled !== undefined) patch.stickyEnabled = source.stickyEnabled === true;
  if (source.rolloutControlProvider !== undefined) {
    if (!isCaptchaProviderId(source.rolloutControlProvider)) {
      return { error: "rolloutControlProvider 取值非法" };
    }
    patch.rolloutControlProvider = source.rolloutControlProvider;
  }
  if (source.scenarioStrategies !== undefined) {
    patch.scenarioStrategies = normalizeScenarioStrategies(source.scenarioStrategies);
  }

  return { patch };
}

function parseProviderDrafts(value: unknown): CaptchaProviderDraftInput[] {
  if (!Array.isArray(value)) return [];
  const drafts: CaptchaProviderDraftInput[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const raw = entry as Record<string, unknown>;
    if (!isCaptchaProviderId(raw.provider)) continue;
    drafts.push({
      provider: raw.provider,
      ...(typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}),
      ...(raw.weight !== undefined ? { weight: raw.weight as number } : {}),
      ...(raw.priority !== undefined ? { priority: raw.priority as number } : {}),
      ...(raw.scenarioWeights !== undefined
        ? { scenarioWeights: normalizeScenarioWeights(raw.scenarioWeights) ?? null }
        : {}),
    });
  }
  return drafts;
}

function parseScenario(value: unknown): CaptchaScenario {
  const candidate = firstString(value);
  return isCaptchaScenario(candidate) ? candidate : "default";
}

function parseExclude(value: unknown): CaptchaProviderId[] {
  if (!Array.isArray(value)) return [];
  const result: CaptchaProviderId[] = [];
  for (const entry of value) {
    if (isCaptchaProviderId(entry) && !result.includes(entry)) result.push(entry);
    if (result.length >= CAPTCHA_PROVIDER_IDS.length) break;
  }
  return result;
}

export async function getCaptchaAllocationPolicyHandler(_req: Request, res: Response) {
  try {
    if (!requireAdmin(_req, res)) return;
    const policy = await TurnstileService.getCaptchaAllocationPolicy();
    res.json({ success: true, policy, defaults: DEFAULT_ALLOCATION_POLICY, options: policyOptions() });
  } catch (error) {
    logger.error("获取人机验证分配策略失败", error);
    res.status(500).json({ success: false, error: "服务器内部错误" });
  }
}

export async function updateCaptchaAllocationPolicyHandler(req: Request, res: Response) {
  try {
    if (!requireSuperAdmin(req, res)) return;

    const built = buildPolicyPatch(req.body);
    if ("error" in built) return res.status(400).json({ success: false, error: built.error });

    const changed = Object.keys(built.patch);
    if (changed.length === 0) {
      return res.status(400).json({ success: false, error: "没有可更新的字段" });
    }

    const policy = await TurnstileService.updateCaptchaAllocationPolicy(built.patch);
    if (!policy) return res.status(500).json({ success: false, error: "分配策略保存失败，请检查数据库连接" });

    res.json({ success: true, message: `已保存 ${changed.length} 项，立即生效`, policy, changed });
  } catch (error) {
    logger.error("更新人机验证分配策略失败", error);
    res.status(500).json({ success: false, error: "服务器内部错误" });
  }
}

export async function getCaptchaWidgetSettingsHandler(_req: Request, res: Response) {
  try {
    if (!requireAdmin(_req, res)) return;
    const widgets = await TurnstileService.getCaptchaWidgetSettings();
    res.json({ success: true, widgets, defaults: DEFAULT_WIDGET_SETTINGS, options: widgetOptions() });
  } catch (error) {
    logger.error("获取人机验证控件外观失败", error);
    res.status(500).json({ success: false, error: "服务器内部错误" });
  }
}

export async function updateCaptchaWidgetSettingsHandler(req: Request, res: Response) {
  try {
    if (!requireSuperAdmin(req, res)) return;

    const source = (req.body ?? {}) as Record<string, unknown>;
    const patch: Partial<Omit<CaptchaWidgetSettingsView, "updatedAt">> = {};
    if (source.theme !== undefined) patch.theme = normalizeWidgetTheme(source.theme);
    if (source.size !== undefined) patch.size = normalizeWidgetSize(source.size);
    if (source.language !== undefined) patch.language = normalizeWidgetLanguage(source.language);
    if (source.showProviderLabel !== undefined) patch.showProviderLabel = source.showProviderLabel !== false;
    // perProvider 按整表覆盖：前端提交的映射就是最终状态，缺项即回落全局。
    if (source.perProvider !== undefined) patch.perProvider = normalizeWidgetOverrides(source.perProvider);

    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ success: false, error: "没有可更新的字段" });
    }

    const widgets = await TurnstileService.updateCaptchaWidgetSettings(patch);
    if (!widgets) return res.status(500).json({ success: false, error: "控件外观保存失败，请检查数据库连接" });

    res.json({ success: true, message: "已保存，前端下次取配置即生效", widgets });
  } catch (error) {
    logger.error("更新人机验证控件外观失败", error);
    res.status(500).json({ success: false, error: "服务器内部错误" });
  }
}

/** 分配模拟：用草稿（可选的供应商/策略覆盖）抽样 N 次，不写库。 */
export async function simulateCaptchaAllocationHandler(req: Request, res: Response) {
  try {
    if (!requireAdmin(req, res)) return;

    const body = (req.body ?? {}) as Record<string, unknown>;
    const scenario = parseScenario(body.scenario);
    const drawsRaw = Number(body.draws);
    const draws = Number.isFinite(drawsRaw) ? drawsRaw : 1000;
    const exclude = parseExclude(body.exclude);

    const base = await TurnstileService.collectCaptchaProviders({ scenario });
    const drafts = parseProviderDrafts(body.providers);
    const candidates = drafts.length
      ? buildDraftCandidates(base.providers, base.candidates, drafts, scenario)
      : base.candidates;

    let policy = base.policy;
    if (body.policy && typeof body.policy === "object") {
      const built = buildPolicyPatch(body.policy);
      if ("error" in built) return res.status(400).json({ success: false, error: built.error });
      policy = normalizeAllocationPolicy({ ...base.policy, ...built.patch });
    }

    const distribution = simulateAllocation(candidates, policy, {
      scenario,
      draws,
      fingerprint: firstString(body.fingerprint) || undefined,
      exclude,
      nowMs: Date.now(),
    });

    res.json({
      success: true,
      scenario,
      strategy: resolveScenarioStrategy(policy, scenario),
      draws: Math.max(1, Math.min(20_000, Math.round(draws))),
      policy,
      candidates: describeCandidates(candidates),
      distribution,
      notes: [
        "模拟只反映草稿里的上线/权重/优先级/场景权重；凭据是否齐全、本月额度是否用尽仍按当前实际状态。",
        drafts.length === 0 ? "未提交草稿，按已保存的配置模拟。" : "按本次提交的草稿模拟（不影响线上）。",
      ],
    });
  } catch (error) {
    logger.error("人机验证分配模拟失败", error);
    res.status(500).json({ success: false, error: "服务器内部错误" });
  }
}

/** 当下会选谁：把真实引擎跑一次（不消耗任何供应商额度），并在 force 时给出该家的下发配置。 */
export async function previewCaptchaSelectionHandler(req: Request, res: Response) {
  try {
    if (!requireAdmin(req, res)) return;

    const scenario = parseScenario(req.query.scenario);
    const exclude = parseExclude(firstString(req.query.exclude)?.split(",") ?? []);
    const fingerprint = firstString(req.query.fingerprint) || undefined;
    const forceRaw = firstString(req.query.force);
    const force = isCaptchaProviderId(forceRaw) ? forceRaw : null;

    const base = await TurnstileService.collectCaptchaProviders({ scenario });
    const selection = await TurnstileService.selectCaptchaProvider(undefined, {
      scenario,
      exclude,
      fingerprint,
      nowMs: Date.now(),
    });

    const widgets = await TurnstileService.getCaptchaWidgetSettings();
    const selectedProvider = selection.enabled ? selection.provider : null;
    const forcedRow = force ? base.providers.find((row) => row.provider === force) : undefined;

    res.json({
      success: true,
      scenario,
      strategy: selection.strategy,
      stickyEnabled: base.policy.stickyEnabled,
      stickyTtlMinutes: base.policy.stickyTtlMinutes,
      rolloutPercent: base.policy.rolloutPercent,
      rolloutControlProvider: base.policy.rolloutControlProvider,
      failoverMaxAttempts: base.policy.failoverMaxAttempts,
      candidates: describeCandidates(base.candidates),
      excluded: exclude,
      selection: {
        provider: selection.provider,
        label: PROVIDER_LABELS[selection.provider],
        reason: selection.reason,
        enabled: selection.enabled,
        siteKey: selection.siteKey,
        apiEndpoint: selection.apiEndpoint,
      },
      widget: TurnstileService.resolveProviderWidgetSettings(widgets, selectedProvider),
      forced: force
        ? {
            provider: force,
            label: PROVIDER_LABELS[force],
            usable: Boolean(forcedRow?.credentialsConfigured) && !forcedRow?.quota.exhausted,
            reason: forcedRow?.reason ?? "ok",
            siteKey: forcedRow?.siteKey ?? null,
            apiEndpoint:
              base.candidates.find((candidate) => candidate.provider === force)?.apiEndpoint ?? null,
            widget: TurnstileService.resolveProviderWidgetSettings(widgets, force),
          }
        : null,
    });
  } catch (error) {
    logger.error("人机验证下发诊断失败", error);
    res.status(500).json({ success: false, error: "服务器内部错误" });
  }
}

/** 近期统计：按供应商聚合 `shc_traces` 的成功/失败。 */
export async function getCaptchaProviderStatsHandler(req: Request, res: Response) {
  try {
    if (!requireAdmin(req, res)) return;
    const stats = await getCaptchaProviderStats(firstString(req.query.hours) ?? "24");
    res.json({ success: true, ...stats });
  } catch (error) {
    logger.error("获取人机验证供应商统计失败", error);
    res.status(500).json({ success: false, error: "服务器内部错误" });
  }
}
