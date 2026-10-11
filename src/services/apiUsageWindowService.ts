import crypto from "node:crypto";
import { ApiUsageWindow } from "../models/apiUsageWindowModel";
import { mongoose } from "./mongoService";
import logger from "../utils/logger";

/**
 * API 调用的**异常判据**（RC-18）：突发（SPIKE）与爬虫节奏（ROBOTIC_CADENCE）。
 *
 * 两条判据都刻意做成「纯函数 + 增量统计量」，理由与仓库既有范式一致
 *（`mobileTokenRiskService.collectRotationRiskSignals`、`accountRiskScoring`）：
 * 阈值能表驱动单测，判定不依赖库。
 *
 * - **突增**：当前分钟计数 ≥ `max(minSpikeCount, spikeMultiplier × 近 1 小时均值)`。
 *   用“相对**自己**的基线”而不是绝对阈值：不同 Key 的正常量级差几个数量级；
 * - **节奏**：到达间隔的变异系数 `cv = σ/μ < 0.15` 且样本 ≥ 30。
 *   人工操作间隔方差大，脚本轮询间隔极规整 —— 这是低成本、高信噪比的判据；
 * - 两条都不单独触发封禁：只给出 `throttled` 建议（降速），由调用方按 §5 B7 的观察期决定是否执行。
 */

export interface ApiUsageFacts {
  /** 当前分钟计数。 */
  currentMinuteCount: number;
  /** 近 1 小时（不含当前分钟）的分钟计数样本。 */
  trailingMinuteCounts: number[];
  /** 到达间隔统计（Welford）。 */
  interArrivalCount: number;
  interArrivalMeanMs: number;
  interArrivalM2: number;
}

export interface ApiUsageThresholds {
  minSpikeCount: number;
  spikeMultiplier: number;
  cadenceCvThreshold: number;
  cadenceMinSamples: number;
}

export const DEFAULT_API_USAGE_THRESHOLDS: ApiUsageThresholds = {
  minSpikeCount: 30,
  spikeMultiplier: 3,
  cadenceCvThreshold: 0.15,
  cadenceMinSamples: 30,
};

function readPositiveNumberEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getApiUsageThresholds(): ApiUsageThresholds {
  return {
    minSpikeCount: readPositiveNumberEnv("API_USAGE_MIN_SPIKE_COUNT", DEFAULT_API_USAGE_THRESHOLDS.minSpikeCount),
    spikeMultiplier: readPositiveNumberEnv("API_USAGE_SPIKE_MULTIPLIER", DEFAULT_API_USAGE_THRESHOLDS.spikeMultiplier),
    cadenceCvThreshold: readPositiveNumberEnv(
      "API_USAGE_CADENCE_CV_THRESHOLD",
      DEFAULT_API_USAGE_THRESHOLDS.cadenceCvThreshold,
    ),
    cadenceMinSamples: readPositiveNumberEnv(
      "API_USAGE_CADENCE_MIN_SAMPLES",
      DEFAULT_API_USAGE_THRESHOLDS.cadenceMinSamples,
    ),
  };
}

export type ApiUsageFlag = "SPIKE" | "ROBOTIC_CADENCE";

/** 纯函数：把事实折算成旗标列表（便于表驱动单测）。 */
export function evaluateApiUsageFlags(
  facts: ApiUsageFacts,
  thresholds: ApiUsageThresholds = getApiUsageThresholds(),
): ApiUsageFlag[] {
  const flags: ApiUsageFlag[] = [];

  const trailing = (facts.trailingMinuteCounts || []).filter((value) => Number.isFinite(value) && value >= 0);
  if (trailing.length > 0) {
    const average = trailing.reduce((sum, value) => sum + value, 0) / trailing.length;
    const spikeCeiling = Math.max(thresholds.minSpikeCount, thresholds.spikeMultiplier * average);
    if (facts.currentMinuteCount >= spikeCeiling) flags.push("SPIKE");
  }

  const samples = Math.max(0, Math.floor(facts.interArrivalCount || 0));
  const mean = Number(facts.interArrivalMeanMs) || 0;
  const m2 = Number(facts.interArrivalM2) || 0;
  if (samples >= thresholds.cadenceMinSamples && mean > 0 && m2 > 0) {
    const variance = m2 / samples;
    const cv = Math.sqrt(variance) / mean;
    if (cv < thresholds.cadenceCvThreshold) flags.push("ROBOTIC_CADENCE");
  }

  return flags;
}

function mongoReady(): boolean {
  return mongoose.connection.readyState === 1;
}

/** 分钟键（UTC，稳定且与用户时区无关）。 */
export function minuteKeyOf(date: Date): string {
  return date.toISOString().slice(0, 16);
}

export interface ApiUsageSampleInput {
  keyId: string;
  userId?: string;
  now?: Date;
}

/**
 * 记一次调用样本并（按需）返回判定结果。
 *
 * 用**一条聚合管道更新**同时完成：计数 +1、Welford 均值/二阶矩递推、lastSampleAt 写入。
 * 之所以不用“读出来再算再写”：那正是并发下统计量互相覆盖的老问题（仓库里已有多处同类教训）。
 */
export async function recordApiUsageSample(input: ApiUsageSampleInput): Promise<ApiUsageFlag[]> {
  if (!input.keyId || !mongoReady()) return [];
  const now = input.now ?? new Date();
  const minuteKey = minuteKeyOf(now);

  try {
    const delta = { $max: [0, { $subtract: [now, { $ifNull: ["$lastSampleAt", now] }] }] };
    const prevCount = { $ifNull: ["$interArrivalCount", 0] };
    const nextCount = { $add: [prevCount, 1] };
    const prevMean = { $ifNull: ["$interArrivalMeanMs", 0] };
    const nextMeanDelta = { $divide: [{ $subtract: [delta, prevMean] }, nextCount] };
    const nextMean = { $add: [prevMean, nextMeanDelta] };

    await ApiUsageWindow.findOneAndUpdate(
      { keyId: input.keyId, minuteKey },
      [
        {
          $set: {
            keyId: input.keyId,
            userId: input.userId || "",
            minuteKey,
            count: { $add: [{ $ifNull: ["$count", 0] }, 1] },
            interArrivalMeanMs: nextMean,
            interArrivalM2: {
              $add: [
                { $ifNull: ["$interArrivalM2", 0] },
                { $multiply: [{ $subtract: [delta, prevMean] }, { $subtract: [delta, nextMean] }] },
              ],
            },
            interArrivalCount: nextCount,
            lastSampleAt: now,
            updatedAt: now,
          },
        },
      ],
      // Mongoose 9：数组形式的更新管道必须显式声明（否则运行时报 “Cannot pass an array to query updates”）。
      { upsert: true, returnDocument: "after", updatePipeline: true },
    ).exec();

    return await evaluateApiUsageForKey(input.keyId, now);
  } catch (error) {
    logger.warn("[ApiUsage] 记录调用样本失败（不影响请求）", {
      keyId: input.keyId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/** 读当前事实并给出旗标（供 recordApiUsageSample 与定时巡检共用）。 */
export async function evaluateApiUsageForKey(keyId: string, now = new Date()): Promise<ApiUsageFlag[]> {
  if (!mongoReady()) return [];
  try {
    const minuteKey = minuteKeyOf(now);
    const current = (await ApiUsageWindow.findOne({ keyId, minuteKey })
      .select("count interArrivalCount interArrivalMeanMs interArrivalM2")
      .lean()) as {
      count?: number;
      interArrivalCount?: number;
      interArrivalMeanMs?: number;
      interArrivalM2?: number;
    } | null;

    const since = new Date(now.getTime() - 60 * 60 * 1000);
    const trailing = (await ApiUsageWindow.find({ keyId, createdAt: { $gte: since }, minuteKey: { $ne: minuteKey } })
      .select("count")
      .lean()) as Array<{ count?: number }>;

    return evaluateApiUsageFlags({
      currentMinuteCount: Number(current?.count) || 0,
      trailingMinuteCounts: trailing.map((row) => Number(row.count) || 0),
      interArrivalCount: Number(current?.interArrivalCount) || 0,
      interArrivalMeanMs: Number(current?.interArrivalMeanMs) || 0,
      interArrivalM2: Number(current?.interArrivalM2) || 0,
    });
  } catch (error) {
    logger.warn("[ApiUsage] 判定失败（按无旗标处理）", {
      keyId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/** 把旗标写回桶（便于事后解释“当时为什么给它降速”，也给面板用）。 */
export async function persistApiUsageFlags(keyId: string, flags: ApiUsageFlag[], now = new Date()): Promise<void> {
  if (!mongoReady() || flags.length === 0) return;
  try {
    await ApiUsageWindow.updateOne({ keyId, minuteKey: minuteKeyOf(now) }, { $addToSet: { flags: { $each: flags } } });
  } catch {
    // 快照写失败不影响判定与处罚
  }
}

/** 随机短抖动：避免“整点同一秒全部一起判定”把库打出一波尖峰。 */
export function jitterMs(maxMs = 5_000): number {
  return crypto.randomInt(0, Math.max(1, maxMs));
}
