import { describe, expect, it } from "@jest/globals";
import {
  DEFAULT_API_USAGE_THRESHOLDS,
  evaluateApiUsageFlags,
  minuteKeyOf,
  type ApiUsageFacts,
} from "../services/apiUsageWindowService";

/**
 * API 调用异常的判据（RC-18）：突发看**相对自身基线**，节奏看**变异系数**。
 *
 * 全部纯函数：不连库、不发请求，阈值表驱动。
 */

const thresholds = DEFAULT_API_USAGE_THRESHOLDS;

function facts(overrides: Partial<ApiUsageFacts> = {}): ApiUsageFacts {
  return {
    currentMinuteCount: 0,
    trailingMinuteCounts: [],
    interArrivalCount: 0,
    interArrivalMeanMs: 0,
    interArrivalM2: 0,
    ...overrides,
  };
}

describe("突发（SPIKE）", () => {
  it("远高于自身基线才触发（不是绝对阈值）", () => {
    // 基线每分钟 2 次 → 阈值 max(30, 3*2)=30；31 次触发。
    const trailing = Array.from({ length: 60 }, () => 2);
    expect(evaluateApiUsageFlags(facts({ currentMinuteCount: 31, trailingMinuteCounts: trailing }), thresholds)).toContain(
      "SPIKE",
    );
    expect(
      evaluateApiUsageFlags(facts({ currentMinuteCount: 29, trailingMinuteCounts: trailing }), thresholds),
    ).not.toContain("SPIKE");
  });

  it("高基线 Key 按比例放大阈值（量大不等于异常）", () => {
    const trailing = Array.from({ length: 60 }, () => 500);
    expect(
      evaluateApiUsageFlags(facts({ currentMinuteCount: 1200, trailingMinuteCounts: trailing }), thresholds),
    ).not.toContain("SPIKE");
    expect(
      evaluateApiUsageFlags(facts({ currentMinuteCount: 1600, trailingMinuteCounts: trailing }), thresholds),
    ).toContain("SPIKE");
  });

  it("没有基线时不判突发（避免新 Key 开箱即被降速）", () => {
    expect(evaluateApiUsageFlags(facts({ currentMinuteCount: 10_000 }), thresholds)).not.toContain("SPIKE");
  });
});

describe("爬虫节奏（ROBOTIC_CADENCE）", () => {
  it("样本足够且变异系数很小才触发", () => {
    // 均值 1000ms，σ=100ms → cv=0.1 < 0.15
    const m2 = 0.1 * 0.1 * 1000 * 1000 * 40; // σ² · n
    expect(
      evaluateApiUsageFlags(
        facts({ interArrivalCount: 40, interArrivalMeanMs: 1000, interArrivalM2: m2 }),
        thresholds,
      ),
    ).toContain("ROBOTIC_CADENCE");
  });

  it("人工操作那样的高方差（cv 大）不触发", () => {
    const m2 = 0.8 * 0.8 * 1000 * 1000 * 40;
    expect(
      evaluateApiUsageFlags(
        facts({ interArrivalCount: 40, interArrivalMeanMs: 1000, interArrivalM2: m2 }),
        thresholds,
      ),
    ).not.toContain("ROBOTIC_CADENCE");
  });

  it("样本不足不判（30 个间隔以下没有统计意义）", () => {
    const m2 = 0.01 * 0.01 * 1000 * 1000 * 10;
    expect(
      evaluateApiUsageFlags(
        facts({ interArrivalCount: 10, interArrivalMeanMs: 1000, interArrivalM2: m2 }),
        thresholds,
      ),
    ).not.toContain("ROBOTIC_CADENCE");
  });
});

describe("分钟键", () => {
  it("按 UTC 分钟归桶（稳定、与用户时区无关）", () => {
    expect(minuteKeyOf(new Date("2026-10-11T03:12:45.123Z"))).toBe("2026-10-11T03:12");
  });
});
