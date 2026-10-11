import { describe, expect, it } from "@jest/globals";
import type { AccountRiskRuntimeConfig } from "../config/runtimeConfigDefaults";
import {
  computeStepUpUntil,
  evaluateAccountRiskScore,
  maxTier,
  tierRank,
  tierRequiresStepUp,
  type AccountRiskFacts,
} from "../utils/accountRiskScoring";

/**
 * 账户风险聚合的折算语义（RC-06 / §4.2）。
 *
 * 全部是纯函数（事实进、分档出），因此这里不连 Mongo、不发网络请求。
 * 阈值由 `baseConfig` 显式给出，验证「改阈值不改公式」。
 */

const baseConfig: AccountRiskRuntimeConfig = {
  enabled: true,
  evaluateOnLogin: true,
  windowDays: 30,
  ipSignalRetentionDays: 180,
  highRiskIpScore: 66,
  minDistinctHighRiskIps: 2,
  watchScoreThreshold: 50,
  restrictedScoreThreshold: 80,
  dangerScoreThreshold: 90,
  autoEscalationCap: "restricted",
  newAccountWatchDays: 7,
  stepUpTtlSeconds: 3600,
  stepUpMode: "sensitive",
  stepUpEnabled: true,
  stepUpChallengeTtlSeconds: 120,
  stepUpGrantTtlSeconds: 30,
  stepUpGrantMaxUses: 5,
};

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

function facts(overrides: Partial<AccountRiskFacts> = {}): AccountRiskFacts {
  return {
    now: NOW,
    accountCreatedAt: NOW - 400 * DAY_MS,
    ipSignals: [],
    deviceMaxRiskScore: 0,
    compromisedDeviceCount: 0,
    recentAbuseEventCount: 0,
    geoJump: false,
    ...overrides,
  };
}

describe("evaluateAccountRiskScore", () => {
  it("无任何信号 → 0 分 / normal / 无旗标", () => {
    const result = evaluateAccountRiskScore(facts(), baseConfig);
    expect(result.riskScore).toBe(0);
    expect(result.riskTier).toBe("normal");
    expect(result.cappedTier).toBe("normal");
    expect(result.flags).toEqual([]);
  });

  it("结论缺失（riskScore=null）不当作 0 分危险，也不触发高危旗标", () => {
    const result = evaluateAccountRiskScore(
      facts({ ipSignals: [{ ipAddress: "1.1.1.1", riskScore: null, loginCount: 5, lastSeenAt: NOW }] }),
      baseConfig,
    );
    expect(result.riskScore).toBe(0);
    expect(result.flags).not.toContain("HIGH_RISK_LOGIN_IP");
  });

  it("新号至少进 watch（与分数无关，§3 触发条件）", () => {
    const result = evaluateAccountRiskScore(
      facts({ accountCreatedAt: NOW - 2 * DAY_MS }),
      baseConfig,
    );
    expect(result.flags).toContain("NEW_ACCOUNT");
    expect(result.riskTier).toBe("watch");
  });

  it("单个高危 IP 不足以触发「多高危 IP」旗标", () => {
    const result = evaluateAccountRiskScore(
      facts({
        ipSignals: [{ ipAddress: "1.1.1.1", riskScore: 90, loginCount: 1, lastSeenAt: NOW }],
      }),
      baseConfig,
    );
    expect(result.flags).toContain("HIGH_RISK_LOGIN_IP");
    expect(result.flags).not.toContain("MULTI_HIGH_RISK_IPS");
  });

  it("两个不同高危 IP + 全部登录来自高危出口 → restricted 档", () => {
    const result = evaluateAccountRiskScore(
      facts({
        ipSignals: [
          { ipAddress: "1.1.1.1", riskScore: 90, loginCount: 3, lastSeenAt: NOW },
          { ipAddress: "2.2.2.2", riskScore: 85, loginCount: 3, lastSeenAt: NOW },
        ],
        deviceMaxRiskScore: 80,
      }),
      baseConfig,
    );
    expect(result.flags).toContain("MULTI_HIGH_RISK_IPS");
    // 90*0.45 + 25 + 80*0.2 = 81.5 → 82
    expect(result.riskScore).toBe(82);
    expect(result.riskTier).toBe("restricted");
    expect(result.cappedTier).toBe("restricted");
  });

  it("自动升档上限为 watch 时，restricted 被压回 watch（默认封顶观察期）", () => {
    const result = evaluateAccountRiskScore(
      facts({
        ipSignals: [
          { ipAddress: "1.1.1.1", riskScore: 100, loginCount: 4, lastSeenAt: NOW },
          { ipAddress: "2.2.2.2", riskScore: 95, loginCount: 4, lastSeenAt: NOW },
        ],
        // 再加一项设备信号才能真正到 restricted（阈值 80）：100*0.45 + 25 + 100*0.2 = 90。
        deviceMaxRiskScore: 100,
      }),
      { ...baseConfig, autoEscalationCap: "watch" },
    );
    expect(result.riskScore).toBe(90);
    expect(result.riskTier).toBe("restricted");
    expect(result.cappedTier).toBe("watch");
  });

  it("机房出口、失陷设备、滥用事件、属地跳变各自贡献旗标与分数", () => {
    const result = evaluateAccountRiskScore(
      facts({
        ipSignals: [{ ipAddress: "3.3.3.3", riskScore: 20, loginCount: 1, lastSeenAt: NOW, isDatacenter: true }],
        compromisedDeviceCount: 1,
        recentAbuseEventCount: 3,
        geoJump: true,
      }),
      baseConfig,
    );
    expect(result.flags).toEqual(
      expect.arrayContaining(["DATACENTER_LOGIN_IP", "COMPROMISED_DEVICE", "ACCOUNT_ABUSE_EVENTS", "GEO_JUMP"]),
    );
    // 20*0.45 + 0 + 0 + min(30, 30) + 15 + 10 = 64
    expect(result.riskScore).toBe(64);
    expect(result.riskTier).toBe("watch");
  });

  it("风险分达到 danger 阈值时只给「建议人工复核」的原因，不自动落 danger", () => {
    const result = evaluateAccountRiskScore(
      facts({
        ipSignals: [
          { ipAddress: "1.1.1.1", riskScore: 100, loginCount: 5, lastSeenAt: NOW },
          { ipAddress: "2.2.2.2", riskScore: 100, loginCount: 5, lastSeenAt: NOW },
        ],
        deviceMaxRiskScore: 100,
      }),
      { ...baseConfig, autoEscalationCap: "restricted" },
    );
    expect(result.riskScore).toBeGreaterThanOrEqual(90);
    expect(result.riskTier).toBe("restricted");
    expect(result.reasons.some((reason) => reason.includes("建议人工复核"))).toBe(true);
  });
});

describe("档位工具函数", () => {
  it("tierRank 单调，maxTier 取更危险的一档", () => {
    expect(tierRank("normal")).toBeLessThan(tierRank("watch"));
    expect(tierRank("watch")).toBeLessThan(tierRank("restricted"));
    expect(tierRank("restricted")).toBeLessThan(tierRank("danger"));
    expect(maxTier("watch", "restricted")).toBe("restricted");
    expect(maxTier("danger", "normal")).toBe("danger");
  });

  it("只有 restricted / danger 需要逐步验证", () => {
    expect(tierRequiresStepUp("normal")).toBe(false);
    expect(tierRequiresStepUp("watch")).toBe(false);
    expect(tierRequiresStepUp("restricted")).toBe(true);
    expect(tierRequiresStepUp("danger")).toBe(true);
    expect(tierRequiresStepUp(undefined)).toBe(false);
  });

  it("computeStepUpUntil 给出有限窗口（避免永久每次验证）", () => {
    expect(computeStepUpUntil(baseConfig, NOW)).toBe(NOW + 3600 * 1000);
    expect(computeStepUpUntil({ ...baseConfig, stepUpTtlSeconds: 10 }, NOW)).toBe(NOW + 60 * 1000);
  });
});
