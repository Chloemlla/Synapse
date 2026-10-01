import { CaptchaQuotaModel } from "../../models/captchaQuotaModel";
import logger from "../../utils/logger";
import { getCaptchaProviderSettingDocs } from "./models";
import { CAPTCHA_PROVIDER_IDS, type CaptchaProviderId } from "./types";

/**
 * 人机验证供应商的月度调用配额。
 *
 * 口径对齐现有 proxycheck 限额：计数落库、用尽即「不外呼」并落 trace，
 * 区别只有两点 —— 切分粒度是月（hCaptcha 免费额度按月给），以及用尽的供应商会被
 * 直接从下发候选里摘掉，避免把用户送到一个必然失败的验证码上。
 *
 * limit 为 0 表示不限额（自托管 trycap 与 Cloudflare Turnstile 默认不限）。
 */

export const CAPTCHA_QUOTA_TIME_ZONE = "Asia/Shanghai";

export const DEFAULT_MONTHLY_QUOTA: Record<CaptchaProviderId, number> = {
  turnstile: 0,
  hcaptcha: 10_000,
  trycap: 0,
};

export const MAX_MONTHLY_QUOTA = 10_000_000;

export interface CaptchaQuotaSnapshot {
  provider: CaptchaProviderId;
  monthKey: string;
  limit: number;
  used: number;
  remaining: number;
  percentage: number;
  exhausted: boolean;
  /** 0 表示不限额；否则为本月额度耗尽的时间点。 */
  exhaustedAt?: string;
  lastUsedAt?: string;
  resetsAt: string;
}

const QUOTA_HISTORY_MAX_MONTHS = 24;

/** Asia/Shanghai 的 `YYYY-MM`；避免依赖进程时区。 */
export function getQuotaMonthKey(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: CAPTCHA_QUOTA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
  }).format(date);
  return parts.slice(0, 7);
}

/** 下个月 1 日 00:00（Asia/Shanghai，UTC+8）对应的时刻。 */
export function getQuotaResetAt(monthKey: string): string {
  const [yearStr, monthStr] = monthKey.split("-");
  const year = Number.parseInt(yearStr, 10);
  const month = Number.parseInt(monthStr, 10);
  if (!Number.isFinite(year) || !Number.isFinite(month)) {
    return new Date().toISOString();
  }
  return new Date(Date.UTC(year, month, 1) - 8 * 60 * 60 * 1000).toISOString();
}

export function clampMonthlyQuota(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(MAX_MONTHLY_QUOTA, Math.round(parsed));
}

export function resolveMonthlyLimit(provider: CaptchaProviderId, override?: number | null): number {
  if (override === null || override === undefined) return DEFAULT_MONTHLY_QUOTA[provider] ?? 0;
  return clampMonthlyQuota(override);
}

interface QuotaCounts {
  used: number;
  exhaustedAt?: Date;
  lastUsedAt?: Date;
}

async function readQuotaCounts(provider: CaptchaProviderId, monthKey: string): Promise<QuotaCounts> {
  try {
    const doc = await CaptchaQuotaModel.findOne({ provider, monthKey }).lean().exec();
    return {
      used: typeof doc?.count === "number" && Number.isFinite(doc.count) ? doc.count : 0,
      exhaustedAt: doc?.exhaustedAt ?? undefined,
      lastUsedAt: doc?.lastUsedAt ?? undefined,
    };
  } catch (error) {
    logger.warn("[CaptchaQuota] 读取用量失败，按 0 处理", {
      provider,
      monthKey,
      error: error instanceof Error ? error.message : String(error),
    });
    return { used: 0 };
  }
}

function buildSnapshot(provider: CaptchaProviderId, monthKey: string, limit: number, counts: QuotaCounts): CaptchaQuotaSnapshot {
  const used = Math.max(0, counts.used);
  const unlimited = limit <= 0;
  const remaining = unlimited ? Number.POSITIVE_INFINITY : Math.max(0, limit - used);
  const percentage = unlimited ? 0 : Math.min(100, Math.round((used / limit) * 1000) / 10);

  return {
    provider,
    monthKey,
    limit,
    used,
    remaining: unlimited ? -1 : remaining,
    percentage,
    exhausted: !unlimited && used >= limit,
    ...(counts.exhaustedAt ? { exhaustedAt: counts.exhaustedAt.toISOString() } : {}),
    ...(counts.lastUsedAt ? { lastUsedAt: counts.lastUsedAt.toISOString() } : {}),
    resetsAt: getQuotaResetAt(monthKey),
  };
}

export async function getCaptchaQuotaSnapshot(
  provider: CaptchaProviderId,
  limitOverride?: number | null,
): Promise<CaptchaQuotaSnapshot> {
  const monthKey = getQuotaMonthKey();
  const limit = resolveMonthlyLimit(provider, limitOverride);
  const counts = await readQuotaCounts(provider, monthKey);
  return buildSnapshot(provider, monthKey, limit, counts);
}

/** 一次性取三家的快照（管理端展示用），避免逐家多次往返。 */
export async function getCaptchaQuotaSnapshots(
  limits: Partial<Record<CaptchaProviderId, number | null>> = {},
): Promise<Record<CaptchaProviderId, CaptchaQuotaSnapshot>> {
  const monthKey = getQuotaMonthKey();
  const snapshots = await Promise.all(
    CAPTCHA_PROVIDER_IDS.map(async (provider) => {
      const limit = resolveMonthlyLimit(provider, limits[provider]);
      const counts = await readQuotaCounts(provider, monthKey);
      return [provider, buildSnapshot(provider, monthKey, limit, counts)] as const;
    }),
  );
  return Object.fromEntries(snapshots) as Record<CaptchaProviderId, CaptchaQuotaSnapshot>;
}

/**
 * 消耗一次额度。允许时先自增再返回 allowed=true（宁可多记一次，也不放过超额调用）；
 * 达到上限则写 exhaustedAt 并返回 allowed=false，调用方必须「不外呼」。
 */
export async function consumeCaptchaQuota(
  provider: CaptchaProviderId,
  limitOverride?: number | null,
): Promise<{ allowed: boolean; snapshot: CaptchaQuotaSnapshot }> {
  const monthKey = getQuotaMonthKey();
  const limit = resolveMonthlyLimit(provider, limitOverride);

  if (limit <= 0) {
    // 不限额：仍然计数，便于观察真实用量。
    const updated = await incrementCount(provider, monthKey);
    return { allowed: true, snapshot: buildSnapshot(provider, monthKey, 0, updated) };
  }

  const current = await readQuotaCounts(provider, monthKey);
  if (current.used >= limit) {
    return { allowed: false, snapshot: buildSnapshot(provider, monthKey, limit, current) };
  }

  const updated = await incrementCount(provider, monthKey);
  const exhaustedNow = updated.used >= limit;
  if (exhaustedNow) {
    try {
      await CaptchaQuotaModel.updateOne({ provider, monthKey }, { $set: { exhaustedAt: new Date() } }).exec();
    } catch (error) {
      logger.warn("[CaptchaQuota] 写入 exhaustedAt 失败", {
        provider,
        monthKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    allowed: true,
    snapshot: buildSnapshot(provider, monthKey, limit, {
      ...updated,
      exhaustedAt: exhaustedNow ? new Date() : updated.exhaustedAt,
    }),
  };
}

async function incrementCount(provider: CaptchaProviderId, monthKey: string): Promise<QuotaCounts> {
  try {
    const updated = await CaptchaQuotaModel.findOneAndUpdate(
      { provider, monthKey },
      { $inc: { count: 1 }, $set: { lastUsedAt: new Date() } },
      { upsert: true, returnDocument: "after" },
    )
      .lean()
      .exec();

    return {
      used: typeof updated?.count === "number" ? updated.count : 0,
      exhaustedAt: updated?.exhaustedAt ?? undefined,
      lastUsedAt: updated?.lastUsedAt ?? undefined,
    };
  } catch (error) {
    // 与 proxycheck 同策略：计数失败不能让已经拿到的验证结论丢掉，这里按「未计数」继续。
    logger.warn("[CaptchaQuota] 递增用量失败", {
      provider,
      monthKey,
      error: error instanceof Error ? error.message : String(error),
    });
    return { used: 0 };
  }
}

export async function isCaptchaQuotaExhausted(
  provider: CaptchaProviderId,
  limitOverride?: number | null,
): Promise<boolean> {
  const snapshot = await getCaptchaQuotaSnapshot(provider, limitOverride);
  return snapshot.exhausted;
}

/** 读取管理端为该供应商配置的额度上限（未配置则用默认值）。 */
export async function resolveConfiguredQuotaLimit(provider: CaptchaProviderId): Promise<number> {
  const docs = await getCaptchaProviderSettingDocs();
  const setting = docs.find((doc) => doc.provider === provider);
  return resolveMonthlyLimit(provider, setting?.monthlyQuota ?? null);
}

/** 调用出口的统一入口：按管理端配置的上限消耗一次额度。 */
export async function consumeConfiguredCaptchaQuota(
  provider: CaptchaProviderId,
): Promise<{ allowed: boolean; snapshot: CaptchaQuotaSnapshot }> {
  const limit = await resolveConfiguredQuotaLimit(provider);
  return consumeCaptchaQuota(provider, limit);
}

/** 逐月用量历史（管理端图表用），按月份倒序。 */
export async function readCaptchaQuotaHistory(months = 6): Promise<
  Array<{ provider: string; monthKey: string; count: number; exhaustedAt?: string; lastUsedAt?: string }>
> {
  const bounded = Math.min(QUOTA_HISTORY_MAX_MONTHS, Math.max(1, Math.round(months)));
  try {
    const docs = await CaptchaQuotaModel.find({})
      .sort({ monthKey: -1, provider: 1 })
      .limit(bounded * CAPTCHA_PROVIDER_IDS.length)
      .lean()
      .exec();

    return docs.map((doc) => ({
      provider: doc.provider,
      monthKey: doc.monthKey,
      count: typeof doc.count === "number" ? doc.count : 0,
      ...(doc.exhaustedAt ? { exhaustedAt: new Date(doc.exhaustedAt).toISOString() } : {}),
      ...(doc.lastUsedAt ? { lastUsedAt: new Date(doc.lastUsedAt).toISOString() } : {}),
    }));
  } catch (error) {
    logger.warn("[CaptchaQuota] 读取历史失败", { error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}
