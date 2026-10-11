import { describe, expect, it, beforeEach } from "@jest/globals";
import {
  LOTTERY_RISK_DEFAULTS,
  getRiskMetrics,
  recordRiskDecision,
  resetRiskMetrics,
  scoreLotteryRisk,
} from "../services/lottery/risk";

const base = { userDrawsInWindow: 0, fingerprintDrawsInWindow: 0, ipDrawsInWindow: 0 };

describe("lottery/risk 风控评分", () => {
  it("无信号时放行", () => {
    expect(scoreLotteryRisk(base).level).toBe("allow");
  });

  it("上游风控分达到软/硬阈值分别 soft / block", () => {
    expect(scoreLotteryRisk({ ...base, externalScore: 40 }).level).toBe("soft");
    expect(scoreLotteryRisk({ ...base, externalScore: 80 }).level).toBe("block");
  });

  it("短时高频与同设备多账号都计入分数并给出原因", () => {
    const decision = scoreLotteryRisk(
      {
        userDrawsInWindow: LOTTERY_RISK_DEFAULTS.userWindowLimit + 5,
        fingerprintDrawsInWindow: LOTTERY_RISK_DEFAULTS.fingerprintWindowLimit + 5,
        ipDrawsInWindow: 0,
        distinctUsersPerFingerprint: 3,
      },
    );
    expect(decision.score).toBeGreaterThan(0);
    expect(decision.reasons.join(" ")).toContain("高频");
    expect(decision.reasons.join(" ")).toContain("多账号");
  });

  it("分数封顶 100", () => {
    const decision = scoreLotteryRisk({
      externalScore: 100,
      userDrawsInWindow: 10_000,
      fingerprintDrawsInWindow: 10_000,
      ipDrawsInWindow: 10_000,
      distinctUsersPerFingerprint: 100,
    });
    expect(decision.score).toBe(100);
    expect(decision.level).toBe("block");
  });
});

describe("lottery/risk 大盘指标", () => {
  beforeEach(() => resetRiskMetrics());

  it("累计放行/静默/拦截计数，只把非放行记入最近事件", () => {
    recordRiskDecision("u1", { score: 0, level: "allow", reasons: [] });
    recordRiskDecision("u2", { score: 45, level: "soft", reasons: ["高频"] });
    recordRiskDecision("u3", { score: 90, level: "block", reasons: ["黑名单"] });

    const metrics = getRiskMetrics();
    expect(metrics.decisions).toEqual({ allow: 1, soft: 1, block: 1 });
    expect(metrics.recent).toHaveLength(2);
    expect(metrics.recent[0]).toMatchObject({ userId: "u3", level: "block" });
    expect(metrics.thresholds).toEqual({
      soft: LOTTERY_RISK_DEFAULTS.softThreshold,
      block: LOTTERY_RISK_DEFAULTS.blockThreshold,
    });
  });
});
