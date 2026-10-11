import { describe, expect, it } from "@jest/globals";
import { LOTTERY_RISK_DEFAULTS, scoreLotteryRisk } from "../services/lottery/risk";

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
