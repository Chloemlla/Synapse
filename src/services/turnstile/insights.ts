import logger from "../../utils/logger";
import { getTraceModel } from "./models";
import { CAPTCHA_PROVIDER_IDS, type CaptchaProviderId } from "./types";

/**
 * 人机验证下发/校验的近期观测数据（读 `shc_traces`）。
 *
 * 用途：管理端「额度与统计」页签要一眼看到「哪家在失败、成功率高不高」——
 * 只看权重配置无法判断供应商是否真的在干活。
 */

export const MIN_STATS_HOURS = 1;
export const MAX_STATS_HOURS = 24 * 30;

export interface CaptchaProviderStatRow {
  provider: CaptchaProviderId;
  total: number;
  success: number;
  failure: number;
  /** 无样本时为 null，避免前端把 0/0 显示成 0%。 */
  successRate: number | null;
  lastSeenAt: string | null;
}

export interface CaptchaProviderStats {
  hours: number;
  since: string;
  providers: CaptchaProviderStatRow[];
  totals: { total: number; success: number; failure: number; successRate: number | null };
}

export function clampStatsHours(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return 24;
  return Math.min(MAX_STATS_HOURS, Math.max(MIN_STATS_HOURS, Math.round(parsed)));
}

interface AggregatedTraceRow {
  _id: string;
  total?: number;
  success?: number;
  lastSeenAt?: Date;
}

export async function getCaptchaProviderStats(hoursInput: unknown): Promise<CaptchaProviderStats> {
  const hours = clampStatsHours(hoursInput);
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  const empty = (): CaptchaProviderStats => ({
    hours,
    since: since.toISOString(),
    providers: CAPTCHA_PROVIDER_IDS.map((provider) => ({
      provider,
      total: 0,
      success: 0,
      failure: 0,
      successRate: null,
      lastSeenAt: null,
    })),
    totals: { total: 0, success: 0, failure: 0, successRate: null },
  });

  try {
    const rows: AggregatedTraceRow[] = await getTraceModel()
      .aggregate<AggregatedTraceRow>([
        { $match: { time: { $gte: since }, verificationMethod: { $in: [...CAPTCHA_PROVIDER_IDS] } } },
        {
          $group: {
            _id: "$verificationMethod",
            total: { $sum: 1 },
            success: { $sum: { $cond: ["$success", 1, 0] } },
            lastSeenAt: { $max: "$time" },
          },
        },
      ])
      .exec();

    const byProvider = new Map(rows.map((row) => [row._id, row]));
    const providers: CaptchaProviderStatRow[] = CAPTCHA_PROVIDER_IDS.map((provider) => {
      const row = byProvider.get(provider);
      const total = row?.total ?? 0;
      const success = row?.success ?? 0;
      return {
        provider,
        total,
        success,
        failure: Math.max(0, total - success),
        successRate: total > 0 ? Math.round((success / total) * 1000) / 10 : null,
        lastSeenAt: row?.lastSeenAt ? new Date(row.lastSeenAt).toISOString() : null,
      };
    });

    const total = providers.reduce((sum, row) => sum + row.total, 0);
    const success = providers.reduce((sum, row) => sum + row.success, 0);

    return {
      hours,
      since: since.toISOString(),
      providers,
      totals: {
        total,
        success,
        failure: Math.max(0, total - success),
        successRate: total > 0 ? Math.round((success / total) * 1000) / 10 : null,
      },
    };
  } catch (error) {
    logger.error("聚合人机验证供应商统计失败", error);
    return empty();
  }
}
