import {
  DEFAULT_ALLOCATION_POLICY,
  DEFAULT_WIDGET_SETTINGS,
  chooseCandidate,
  clampFailoverAttempts,
  clampRolloutPercent,
  clampRotationSeconds,
  clampStickyTtlMinutes,
  getStickyWindowIndex,
  hashToUnitInterval,
  isCaptchaAllocationStrategy,
  isCaptchaScenario,
  normalizeAllocationPolicy,
  normalizeScenarioWeights,
  normalizeWidgetLanguage,
  normalizeWidgetOverrides,
  normalizeWidgetSettings,
  pickFailoverProvider,
  pickRoundRobinProvider,
  pickWeightedProviderByUnit,
  resolveScenarioStrategy,
  resolveWidgetSettings,
  simulateAllocation,
  type CaptchaAllocationPolicyView,
  type SimulationCandidate,
} from "../services/turnstile/allocation";

/**
 * 分配体系纯函数内核的回归测试。
 *
 * 重点在三条「必须确定性」的性质（多实例部署下同一用户不能得到不同结论）：
 * 粘性分桶、时间轮换、灰度分桶；随机源只允许出现在 weighted 策略里。
 */

const candidates: SimulationCandidate[] = [
  { provider: "turnstile", weight: 50, priority: 10 },
  { provider: "hcaptcha", weight: 30, priority: 20 },
  { provider: "trycap", weight: 20, priority: 5 },
];

function policyWith(overrides: Partial<CaptchaAllocationPolicyView>): CaptchaAllocationPolicyView {
  return { ...DEFAULT_ALLOCATION_POLICY, ...overrides };
}

describe("分配策略归一化", () => {
  it("非法取值回落默认，数值字段被钳制到合法区间", () => {
    const policy = normalizeAllocationPolicy({
      strategy: "bogus" as never,
      rotationSeconds: 1,
      stickyTtlMinutes: 99_999,
      rolloutPercent: 250,
      failoverMaxAttempts: 9,
      rolloutControlProvider: "nope" as never,
      scenarioStrategies: { first_visit: "failover", default: "nope" as never },
      stickyEnabled: true,
    });

    expect(policy.strategy).toBe("weighted");
    expect(policy.rotationSeconds).toBe(30);
    expect(policy.stickyTtlMinutes).toBe(1_440);
    expect(policy.rolloutPercent).toBe(100);
    expect(policy.failoverMaxAttempts).toBe(3);
    expect(policy.rolloutControlProvider).toBe("turnstile");
    expect(policy.scenarioStrategies).toEqual({ first_visit: "failover" });
    expect(policy.stickyEnabled).toBe(true);
  });

  it("未配置时回落到默认策略（不产生副作用）", () => {
    expect(normalizeAllocationPolicy(null)).toMatchObject({
      strategy: DEFAULT_ALLOCATION_POLICY.strategy,
      stickyEnabled: false,
      rolloutPercent: 0,
    });
  });

  it("钳制函数自身边界正确", () => {
    expect(clampRotationSeconds("abc")).toBe(DEFAULT_ALLOCATION_POLICY.rotationSeconds);
    expect(clampStickyTtlMinutes(-5)).toBe(5);
    expect(clampRolloutPercent("42")).toBe(42);
    expect(clampFailoverAttempts(0)).toBe(1);
  });

  it("场景与策略判定只认白名单", () => {
    expect(isCaptchaScenario("first_visit")).toBe(true);
    expect(isCaptchaScenario("nope")).toBe(false);
    expect(isCaptchaAllocationStrategy("round_robin")).toBe(true);
    expect(isCaptchaAllocationStrategy("random")).toBe(false);
  });

  it("按场景解析策略：场景覆盖优先，否则全局", () => {
    const policy = policyWith({ strategy: "weighted", scenarioStrategies: { standalone: "failover" } });
    expect(resolveScenarioStrategy(policy, "standalone")).toBe("failover");
    expect(resolveScenarioStrategy(policy, "first_visit")).toBe("weighted");
  });
});

describe("确定性分桶", () => {
  it("sha256 分桶稳定且落在 [0,1)", () => {
    const first = hashToUnitInterval("sticky|first_visit|abc|123");
    const second = hashToUnitInterval("sticky|first_visit|abc|123");
    const other = hashToUnitInterval("sticky|first_visit|abd|123");

    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(1);
    expect(other).not.toBe(first);
  });

  it("权重区间映射与百分比语义一致", () => {
    expect(pickWeightedProviderByUnit(candidates, 0)?.provider).toBe("turnstile");
    expect(pickWeightedProviderByUnit(candidates, 0.6)?.provider).toBe("hcaptcha");
    expect(pickWeightedProviderByUnit(candidates, 0.9)?.provider).toBe("trycap");
    expect(pickWeightedProviderByUnit([], 0.5)).toBeNull();
  });

  it("权重全 0 时退化为均匀分区", () => {
    const zero = candidates.map((candidate) => ({ ...candidate, weight: 0 }));
    expect(pickWeightedProviderByUnit(zero, 0.1)?.provider).toBe("turnstile");
    expect(pickWeightedProviderByUnit(zero, 0.5)?.provider).toBe("hcaptcha");
    expect(pickWeightedProviderByUnit(zero, 0.99)?.provider).toBe("trycap");
  });

  it("按时间轮换：同一窗口稳定，跨窗口换人，一圈后回到起点", () => {
    const rotation = 60;
    expect(pickRoundRobinProvider(candidates, 0, rotation)?.provider).toBe("turnstile");
    expect(pickRoundRobinProvider(candidates, 59_000, rotation)?.provider).toBe("turnstile");
    expect(pickRoundRobinProvider(candidates, 60_000, rotation)?.provider).toBe("hcaptcha");
    expect(pickRoundRobinProvider(candidates, 120_000, rotation)?.provider).toBe("trycap");
    expect(pickRoundRobinProvider(candidates, 180_000, rotation)?.provider).toBe("turnstile");
    expect(pickRoundRobinProvider([], 0, rotation)).toBeNull();
  });

  it("故障转移按优先级升序，且能排除已失败的家", () => {
    expect(pickFailoverProvider(candidates)?.provider).toBe("trycap");
    expect(pickFailoverProvider(candidates, ["trycap"])?.provider).toBe("turnstile");
    expect(pickFailoverProvider(candidates, ["trycap", "turnstile"])?.provider).toBe("hcaptcha");
    expect(pickFailoverProvider(candidates, ["trycap", "turnstile", "hcaptcha"])).toBeNull();
  });

  it("同一指纹在同一粘性窗口内固定同一家，且窗口编号随时间推进", () => {
    const policy = policyWith({ stickyEnabled: true, stickyTtlMinutes: 30, strategy: "weighted" });
    const options = { scenario: "first_visit" as const, nowMs: 1_700_000_000_000, fingerprint: "fp-abc" };

    const first = chooseCandidate(candidates, policy, options).candidate?.provider;
    const second = chooseCandidate(candidates, policy, options).candidate?.provider;
    expect(first).toBe(second);
    expect(first).toBeTruthy();

    const windowIndex = getStickyWindowIndex(options.nowMs, policy.stickyTtlMinutes);
    expect(getStickyWindowIndex(options.nowMs + policy.stickyTtlMinutes * 60_000, policy.stickyTtlMinutes)).toBe(
      windowIndex + 1,
    );

    // 大量指纹应覆盖全部候选（否则粘性会把人固定在某一家的死角里）
    const seen = new Set<string | undefined>();
    for (let index = 0; index < 200; index += 1) {
      seen.add(chooseCandidate(candidates, policy, { ...options, fingerprint: `fp-${index}` }).candidate?.provider);
    }
    expect(seen.size).toBe(candidates.length);
  });

  it("灰度：对照组可用时按比例分流，对照组不可用时忽略灰度", () => {
    const policy = policyWith({ rolloutPercent: 50, rolloutControlProvider: "turnstile" });
    let controlHits = 0;
    let experimentHits = 0;
    for (let index = 0; index < 400; index += 1) {
      const result = chooseCandidate(candidates, policy, {
        scenario: "standalone",
        fingerprint: `fp-${index}`,
        nowMs: 1_700_000_000_000,
      });
      if (result.rolloutControl) {
        controlHits += 1;
        expect(result.candidate?.provider).toBe("turnstile");
      } else {
        experimentHits += 1;
      }
    }
    expect(controlHits).toBeGreaterThan(0);
    expect(experimentHits).toBeGreaterThan(0);

    // 对照组已不在候选池（下线/额度用尽）时不能把人送进死角
    const pool = candidates.filter((candidate) => candidate.provider !== "turnstile");
    const forced = chooseCandidate(pool, policy, {
      scenario: "standalone",
      fingerprint: "fp-0",
      nowMs: 1_700_000_000_000,
    });
    expect(forced.candidate).not.toBeNull();
    expect(forced.candidate?.provider).not.toBe("turnstile");
  });

  it("rolloutPercent 为 0 / 100 时都不走对照组", () => {
    for (const percent of [0, 100]) {
      const policy = policyWith({ rolloutPercent: percent, rolloutControlProvider: "turnstile" });
      for (let index = 0; index < 50; index += 1) {
        const result = chooseCandidate(candidates, policy, {
          scenario: "default",
          fingerprint: `fp-${index}`,
          nowMs: 1_700_000_000_000,
        });
        expect(result.rolloutControl).toBe(false);
      }
    }
  });

  it("exclude 生效：被排除的家不会出现在结果里", () => {
    const policy = policyWith({ strategy: "failover" });
    const result = chooseCandidate(candidates, policy, {
      scenario: "default",
      nowMs: 1_700_000_000_000,
      exclude: ["trycap", "turnstile"],
    });
    expect(result.candidate?.provider).toBe("hcaptcha");
    expect(result.pool.map((entry) => entry.provider)).toEqual(["hcaptcha"]);
  });
});

describe("分配模拟", () => {
  it("抽样次数与分布百分比自洽", () => {
    const policy = policyWith({ strategy: "weighted" });
    const distribution = simulateAllocation(candidates, policy, {
      scenario: "default",
      draws: 500,
      nowMs: 1_700_000_000_000,
    });

    const total = distribution.reduce((sum, entry) => sum + entry.count, 0);
    const percentage = Math.round(distribution.reduce((sum, entry) => sum + entry.percentage, 0) * 10) / 10;

    expect(total).toBe(500);
    expect(percentage).toBeGreaterThan(99.5);
    expect(percentage).toBeLessThan(100.5);
    // 权重大的应当拿到更多份额（500 次抽样下 50/30/20 的差距不会反转）
    expect(distribution[0].provider).toBe("turnstile");
  });

  it("故障转移策略下模拟结果恒定落在优先级最高的那家", () => {
    const policy = policyWith({ strategy: "failover" });
    const distribution = simulateAllocation(candidates, policy, {
      scenario: "default",
      draws: 20,
      nowMs: 1_700_000_000_000,
    });
    expect(distribution).toEqual([{ provider: "trycap", count: 20, percentage: 100 }]);
  });
});

describe("控件外观归一化", () => {
  it("语言只接受 auto 或 BCP-47，注入式字符串一律回落 auto", () => {
    expect(normalizeWidgetLanguage("zh-CN")).toBe("zh-CN");
    expect(normalizeWidgetLanguage("en")).toBe("en");
    expect(normalizeWidgetLanguage("")).toBe("auto");
    expect(normalizeWidgetLanguage("<script>alert(1)</script>")).toBe("auto");
    expect(normalizeWidgetLanguage(undefined)).toBe("auto");
  });

  it("逐家覆盖优先，缺项回落全局；null 表示清掉覆盖", () => {
    const settings = normalizeWidgetSettings({
      theme: "dark",
      size: "flexible",
      language: "en",
      showProviderLabel: false,
      perProvider: { trycap: { theme: "light", language: "ja" }, hcaptcha: null, turnstile: {} },
    });

    expect(settings.theme).toBe("dark");
    expect(settings.showProviderLabel).toBe(false);
    expect(resolveWidgetSettings(settings, "trycap")).toEqual({
      theme: "light",
      size: "flexible",
      language: "ja",
      showProviderLabel: false,
    });
    expect(resolveWidgetSettings(settings, "turnstile")).toEqual({
      theme: "dark",
      size: "flexible",
      language: "en",
      showProviderLabel: false,
    });
    expect(settings.perProvider.hcaptcha).toBeUndefined();
  });

  it("未知主题/尺寸回落默认值", () => {
    const settings = normalizeWidgetSettings({ theme: "neon" as never, size: "huge" as never });
    expect(settings.theme).toBe(DEFAULT_WIDGET_SETTINGS.theme);
    expect(settings.size).toBe(DEFAULT_WIDGET_SETTINGS.size);
    expect(normalizeWidgetOverrides("nope")).toEqual({});
  });

  it("场景权重只保留合法场景与有限非负数", () => {
    expect(normalizeScenarioWeights({ first_visit: 0, standalone: 5000, default: "x", nope: 10 })).toEqual({
      first_visit: 0,
      standalone: 1000,
    });
    expect(normalizeScenarioWeights(null)).toBeUndefined();
    expect(normalizeScenarioWeights({})).toBeUndefined();
  });
});
