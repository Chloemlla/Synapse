import { ApiKeyBillingEventModel } from "../models/apiKeyBillingModel";
import { QuotaEventModel, type QuotaEventDoc } from "../models/quotaEventModel";
import { mongoose } from "./mongoService";
import logger from "../utils/logger";

/**
 * 配额事件与账户级预算（RC-28）。
 *
 * 两个互不重叠的职责：
 * 1. **预警事件**：余额/预算跨过 80% 与 100% 时各写一条 `quota_events`，
 *    去重键由模型唯一索引保证（并发下也只有一条）。
 * 2. **账户级预算**：把「一个账号开 5 把 Key 就是 5 倍预算」收口成
 *    `min(账户剩余, Key 剩余)`；默认 `off`，可切 `observe`（只告警）/ `enforce`（拒绝）。
 *
 * 所有写事件的地方都**绝不抛出**：预警是旁路，不能因为它把计费/请求主流程弄挂。
 */

export const QUOTA_THRESHOLD_WARNING = 0.8;
export const QUOTA_THRESHOLD_EXHAUSTED = 1;

export const QUOTA_EVENT_CODES = {
  keyWarning: "API_KEY_BALANCE_80_PERCENT",
  keyExhausted: "API_KEY_BALANCE_EXHAUSTED",
  accountWarning: "ACCOUNT_BUDGET_80_PERCENT",
  accountExhausted: "ACCOUNT_BUDGET_EXCEEDED",
  upstreamExhausted: "UPSTREAM_QUOTA_EXHAUSTED",
} as const;

/** 余额已用比例 → 本次跨过的阈值（升序）。比例可以是负数（充值后），此时不跨任何阈值。 */
export function evaluateQuotaThresholds(usageRatio: number): number[] {
  if (!Number.isFinite(usageRatio)) return [];
  const crossed: number[] = [];
  if (usageRatio >= QUOTA_THRESHOLD_WARNING) crossed.push(QUOTA_THRESHOLD_WARNING);
  if (usageRatio >= QUOTA_THRESHOLD_EXHAUSTED) crossed.push(QUOTA_THRESHOLD_EXHAUSTED);
  return crossed;
}

/** 上海时区账期键：`day` → YYYY-MM-DD，`month` → YYYY-MM。 */
export function resolveQuotaPeriodKey(now: Date, kind: "day" | "month"): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const pick = (type: string) => parts.find((part) => part.type === type)?.value || "";
  const year = pick("year");
  const month = pick("month");
  return kind === "day" ? `${year}-${month}-${pick("day")}` : `${year}-${month}`;
}

export interface RecordQuotaEventInput {
  scope: QuotaEventDoc["scope"];
  keyId?: string;
  userId?: string;
  resource: string;
  threshold: number;
  periodKey: string;
  cycle?: number;
  code: string;
  detail?: Record<string, unknown>;
}

/**
 * 写入一条配额事件；返回 true 表示本次真的新建了（false = 已存在/写失败）。
 * 依赖唯一索引 + `$setOnInsert` 实现幂等，不先读后写（那是并发下的双写缝隙）。
 */
export async function recordQuotaEvent(input: RecordQuotaEventInput): Promise<boolean> {
  // 预警是旁路：连接不可用时直接放弃（不缓冲、不延迟主流程）。mongoose 默认缓冲会让
  // 一个 "fire-and-forget" 写入在断连时挂 10 秒，那反而会拖累它本不该影响的计费路径。
  if (mongoose.connection.readyState !== 1) return false;
  try {
    const result = await QuotaEventModel.updateOne(
      {
        scope: input.scope,
        keyId: input.keyId || "",
        resource: input.resource,
        threshold: input.threshold,
        periodKey: input.periodKey,
        cycle: input.cycle || 0,
      },
      {
        $setOnInsert: {
          scope: input.scope,
          keyId: input.keyId || "",
          userId: input.userId || "",
          resource: input.resource,
          threshold: input.threshold,
          periodKey: input.periodKey,
          cycle: input.cycle || 0,
          code: input.code,
          detail: input.detail || {},
          createdAt: new Date(),
        },
      },
      { upsert: true },
    ).exec();
    return (result as { upsertedCount?: number }).upsertedCount === 1;
  } catch (error) {
    // 11000 = 唯一索引冲突，说明别的并发请求刚写过同一条：这是成功语义，不是错误。
    if ((error as { code?: number })?.code === 11000) return false;
    logger.warn("[QuotaEvents] 配额事件写入失败（旁路，不影响主流程）", {
      scope: input.scope,
      keyId: input.keyId,
      resource: input.resource,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export interface BalanceThresholdInput {
  keyId: string;
  userId: string;
  /** 扣费后的余额。 */
  balanceAfter: number;
  /** 本周期基线（最近一次充值后的余额）；<=0 表示未启用阈值预警。 */
  baseline: number;
  /** 预算周期序号：充值 +1，用于充值后重新预警。 */
  cycle?: number;
  now?: Date;
}

/**
 * 预付费余额跨阈值预警。**纯旁路**：调用方 fire-and-forget 即可。
 *
 * 为什么用「基线」而不是「余额百分比」：余额本身没有分母。基线在每次充值后重置，
 * 于是「这个周期已经花掉了多少比例」才有定义，充值后也能重新预警（靠 cycle 去重）。
 */
export async function recordBalanceThresholdEvents(input: BalanceThresholdInput): Promise<void> {
  const baseline = Number(input.baseline);
  if (!Number.isFinite(baseline) || baseline <= 0) return;
  const balanceAfter = Number(input.balanceAfter);
  if (!Number.isFinite(balanceAfter)) return;

  const usageRatio = 1 - balanceAfter / baseline;
  const crossed = evaluateQuotaThresholds(usageRatio);
  if (crossed.length === 0) return;

  const periodKey = resolveQuotaPeriodKey(input.now || new Date(), "month");
  for (const threshold of crossed) {
    await recordQuotaEvent({
      scope: "key",
      keyId: input.keyId,
      userId: input.userId,
      resource: "api-key-balance",
      threshold,
      periodKey,
      cycle: input.cycle || 0,
      code: threshold >= QUOTA_THRESHOLD_EXHAUSTED ? QUOTA_EVENT_CODES.keyExhausted : QUOTA_EVENT_CODES.keyWarning,
      detail: {
        baseline: Math.round(baseline * 10_000) / 10_000,
        balanceAfter: Math.round(balanceAfter * 10_000) / 10_000,
        usageRatio: Math.round(usageRatio * 10_000) / 10_000,
      },
    });
  }
}

export type AccountBudgetMode = "off" | "observe" | "enforce";

export interface AccountBudgetPolicy {
  mode: AccountBudgetMode;
  /** 0 = 未配置（该窗口不设上限）。 */
  dailyCredits: number;
  monthlyCredits: number;
}

function readNonNegativeNumberEnv(name: string): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(parsed, 1_000_000_000);
}

/**
 * 账户级预算配置（env）。默认 `off`：新增闸门按观察期上线，
 * 且账户预算没有历史数据可校准，贸然 enforce 会把正常用户一刀切断。
 * 打开顺序建议：`observe` 跑一周看 `account-budget` 日志 → `enforce`。
 */
export function resolveAccountBudgetPolicy(env: NodeJS.ProcessEnv = process.env): AccountBudgetPolicy {
  const rawMode = String(env.API_KEY_ACCOUNT_BUDGET_MODE || "off").trim().toLowerCase();
  const mode: AccountBudgetMode = rawMode === "observe" || rawMode === "enforce" ? rawMode : "off";
  return {
    mode,
    dailyCredits: readNonNegativeNumberEnv("API_KEY_ACCOUNT_DAILY_BUDGET_CREDITS"),
    monthlyCredits: readNonNegativeNumberEnv("API_KEY_ACCOUNT_MONTHLY_BUDGET_CREDITS"),
  };
}

export interface AccountBudgetUsage {
  dailySpent: number;
  monthlySpent: number;
}

/** 账户当日在/当月已花费的 credits（按 billing_events 的 charge 汇总）。 */
export async function loadAccountBudgetUsage(userId: string, now = new Date()): Promise<AccountBudgetUsage> {
  const dayStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const monthStart = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);
  const rows = (await ApiKeyBillingEventModel.aggregate([
    {
      $match: {
        userId,
        type: "charge",
        state: "completed",
        createdAt: { $gte: monthStart },
      },
    },
    {
      $group: {
        _id: null,
        monthlySpent: { $sum: "$costCredits" },
        dailySpent: {
          $sum: { $cond: [{ $gte: ["$createdAt", dayStart] }, "$costCredits", 0] },
        },
      },
    },
  ]).exec()) as Array<{ dailySpent?: number; monthlySpent?: number }>;

  const row = rows[0];
  return {
    dailySpent: Math.max(0, Number(row?.dailySpent) || 0),
    monthlySpent: Math.max(0, Number(row?.monthlySpent) || 0),
  };
}

export interface AccountBudgetEvaluation {
  enabled: boolean;
  /** 各窗口剩余；null = 该窗口未配置。 */
  dailyRemaining: number | null;
  monthlyRemaining: number | null;
  /** min(账户各窗口剩余, Key 剩余)。 */
  effectiveRemaining: number | null;
  exceeded: boolean;
  dailyRatio: number | null;
  monthlyRatio: number | null;
}

/**
 * 纯函数：给定配置/用量/本次成本，算「还能不能放行」。
 *
 * `keyRemaining` 为 null 表示 Key 侧不限（metered 计费）；预付费传余额。
 * 任一窗口剩余 < 本次成本即视为超预算（用 `>` 的反面，成本恰好等于余额时放行）。
 */
export function evaluateAccountBudget(input: {
  policy: AccountBudgetPolicy;
  usage: AccountBudgetUsage;
  costCredits: number;
  keyRemaining?: number | null;
}): AccountBudgetEvaluation {
  const { policy, usage, costCredits } = input;
  const dailyConfigured = policy.mode !== "off" && policy.dailyCredits > 0;
  const monthlyConfigured = policy.mode !== "off" && policy.monthlyCredits > 0;
  const dailyRemaining = dailyConfigured ? Math.max(0, policy.dailyCredits - usage.dailySpent) : null;
  const monthlyRemaining = monthlyConfigured ? Math.max(0, policy.monthlyCredits - usage.monthlySpent) : null;
  const keyRemaining =
    typeof input.keyRemaining === "number" && Number.isFinite(input.keyRemaining) ? input.keyRemaining : null;

  const candidates = [dailyRemaining, monthlyRemaining, keyRemaining].filter(
    (value): value is number => value !== null,
  );
  const effectiveRemaining = candidates.length > 0 ? Math.min(...candidates) : null;
  const cost = Number.isFinite(costCredits) ? costCredits : 0;

  return {
    enabled: policy.mode !== "off",
    dailyRemaining,
    monthlyRemaining,
    effectiveRemaining,
    exceeded: effectiveRemaining !== null && effectiveRemaining < cost,
    dailyRatio: dailyConfigured ? usage.dailySpent / policy.dailyCredits : null,
    monthlyRatio: monthlyConfigured ? usage.monthlySpent / policy.monthlyCredits : null,
  };
}

/** 账户预算 80%/100% 事件（旁路）。periodKey 按窗口取日/月账期。 */
export async function recordAccountBudgetEvents(params: {
  userId: string;
  evaluation: AccountBudgetEvaluation;
  now?: Date;
}): Promise<void> {
  const { evaluation } = params;
  if (!evaluation.enabled) return;
  const now = params.now || new Date();
  const windows: Array<{ kind: "day" | "month"; ratio: number | null; resource: string }> = [
    { kind: "day", ratio: evaluation.dailyRatio, resource: "account-daily-budget" },
    { kind: "month", ratio: evaluation.monthlyRatio, resource: "account-monthly-budget" },
  ];
  for (const window of windows) {
    for (const threshold of evaluateQuotaThresholds(window.ratio ?? -1)) {
      await recordQuotaEvent({
        scope: "account",
        userId: params.userId,
        resource: window.resource,
        threshold,
        periodKey: resolveQuotaPeriodKey(now, window.kind),
        code:
          threshold >= QUOTA_THRESHOLD_EXHAUSTED
            ? QUOTA_EVENT_CODES.accountExhausted
            : QUOTA_EVENT_CODES.accountWarning,
        detail: {
          ratio: Math.round((window.ratio ?? 0) * 10_000) / 10_000,
          effectiveRemaining: evaluation.effectiveRemaining,
        },
      });
    }
  }
}

/**
 * 上游额度耗尽判定：只认**明确的额度信号**，不把普通 429 限流也算进来
 * （限流是「慢一点」，耗尽要进降级队列）。
 */
export function isUpstreamQuotaExhausted(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { status?: number; statusCode?: number; code?: string; type?: string; message?: string };
  const status = Number(record.status ?? record.statusCode ?? 0);
  const code = String(record.code ?? record.type ?? "").toLowerCase();
  const message = String(record.message ?? "");
  if (
    code === "insufficient_quota" ||
    code === "quota_exceeded" ||
    code === "billing_hard_limit_reached" ||
    code === "upstream_quota_exhausted"
  ) {
    return true;
  }
  if (status === 402) return true;
  return /insufficient[_\s-]?quota|exceeded your current quota|billing hard limit/i.test(message);
}

/** 上游额度作为**独立健康信号**：写事件 + error 日志；绝不冒充用户额度错误。 */
export async function recordUpstreamQuotaExhaustion(params: {
  provider: string;
  userId?: string;
  code?: string;
  detail?: Record<string, unknown>;
}): Promise<void> {
  const now = new Date();
  logger.error("[QuotaEvents] 上游额度耗尽（平台侧健康信号，不是用户额度不足）", {
    provider: params.provider,
    userId: params.userId,
    upstreamCode: params.code,
  });
  await recordQuotaEvent({
    scope: "upstream",
    userId: params.userId,
    resource: "upstream-quota",
    threshold: QUOTA_THRESHOLD_EXHAUSTED,
    periodKey: resolveQuotaPeriodKey(now, "day"),
    code: QUOTA_EVENT_CODES.upstreamExhausted,
    detail: { provider: params.provider, upstreamCode: params.code, ...(params.detail || {}) },
  });
}
