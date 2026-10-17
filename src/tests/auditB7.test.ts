import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { AccountRiskRuntimeConfig } from "../config/runtimeConfigDefaults";

/**
 * B7 剩余项（RC-14 / RC-15 / RC-20 / RC-26 / RC-38 / RC-56 / RC-57）的回归。
 *
 * 三层：
 * 1. 纯函数（`geoRisk` / `accountRiskScoring`）：不连库、不读配置，表驱动钉住阈值边界；
 * 2. 账户风险服务：替身 Mongo / 模型，验证「开关关闭时零副作用」「IDC 升档只经
 *    applyAccountRiskAction」「匿名信号必须归因到已知出口」；
 * 3. RC-38 通道映射：钉住裁决一（ACCOUNT_RESTRICTED + 申诉）与 RC-61 的相邻边界。
 */

const BASE_ACCOUNT_RISK: AccountRiskRuntimeConfig = {
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
  stepUpEnabled: false,
  stepUpChallengeTtlSeconds: 120,
  stepUpGrantTtlSeconds: 30,
  stepUpGrantMaxUses: 5,
  ipRecheckEnabled: false,
  sharingDetectionEnabled: false,
  sharingSessionWindowMinutes: 10,
  sharingMinDevices: 3,
  sharingMinCountries: 2,
  sharingMinConcurrentSessions: 3,
  sharingScoreWeight: 20,
  fingerprintComponentsEnabled: false,
};

const mockAccountRiskConfig: AccountRiskRuntimeConfig = { ...BASE_ACCOUNT_RISK };

// ── 服务层替身 ──────────────────────────────────────────────────────────────
const mockGetAccountRiskState = jest.fn();
const mockUpdateUser = jest.fn(async () => true);
const mockRevokeAllAuthSessions = jest.fn(async () => undefined);
const mockAuditLog = jest.fn(async () => undefined);
const mockSetApiKeyPenalty = jest.fn(async (_input: Record<string, unknown>) => ({ modified: 1, matched: 1 }));
const mockSecurityCreate = jest.fn(async (doc: Record<string, unknown>) => doc);
const mockSecurityExists = jest.fn(async (): Promise<unknown> => null);
const mockSecurityFindOneLean = jest.fn(async (): Promise<unknown> => null);
const mockSecurityCountDocuments = jest.fn(
  async (_filter: Record<string, unknown>): Promise<number> => 0,
);
const mockAccountIpExists = jest.fn(async (): Promise<unknown> => null);
const mockAccountIpFind = jest.fn(async (..._args: unknown[]): Promise<unknown[]> => []);
const mockAccountIpDistinct = jest.fn(async (..._args: unknown[]): Promise<unknown[]> => []);
const mockDeviceAggregate = jest.fn(async (): Promise<unknown[]> => []);
const mockProbeCountDocuments = jest.fn(
  async (_filter: Record<string, unknown>): Promise<number> => 0,
);
const mockGetCachedIpRisk = jest.fn(async (_ip: string): Promise<unknown> => null);
const mockLoadDeviceFingerprintFacts = jest.fn(async () => ({
  fingerprintCount: 0,
  componentDrift: false,
  driftFingerprintIds: [],
  sharedAcrossAccounts: false,
  sharedFingerprintIds: [],
  sharedComponentHashes: [],
}));

function mockChain<T>(result: T) {
  const api: Record<string, unknown> = {
    exec: async () => result,
    select: () => api,
    sort: () => api,
    limit: () => api,
    lean: async () => result,
  };
  return api;
}

jest.mock("../config/config", () => ({
  config: {
    jwtSecret: "test-secret",
    accountRisk: mockAccountRiskConfig,
  },
}));

jest.mock("../services/mongoService", () => ({
  mongoose: { connection: { readyState: 1 } },
  isConnected: () => true,
}));

jest.mock("../services/userService", () => ({
  UserModel: { countDocuments: () => ({ exec: async () => 2 }) },
  getAccountRiskState: (...args: unknown[]) => mockGetAccountRiskState(...args),
  updateUser: (...args: unknown[]) => mockUpdateUser(...(args as [])),
}));

jest.mock("../services/authSessionService", () => ({
  getLatestAuthSessionIpLocation: jest.fn(async () => null),
  revokeAllAuthSessions: (...args: unknown[]) => mockRevokeAllAuthSessions(...args),
}));

jest.mock("../services/auditLogService", () => ({
  AuditLogService: { log: (...args: unknown[]) => mockAuditLog(...args) },
}));

jest.mock("../services/apiKeyService", () => ({
  setApiKeyPenalty: (...args: unknown[]) => mockSetApiKeyPenalty(...args),
}));

jest.mock("../services/deviceFingerprintService", () => ({
  loadDeviceFingerprintFacts: (...args: unknown[]) => mockLoadDeviceFingerprintFacts(...args),
}));

jest.mock("../models/securityEventModel", () => ({
  SecurityEvent: {
    create: (...args: unknown[]) => mockSecurityCreate(...(args as [Record<string, unknown>])),
    exists: () => ({ exec: async () => mockSecurityExists() }),
    findOne: () => ({ select: () => ({ lean: async () => mockSecurityFindOneLean() }) }),
    countDocuments: (filter: Record<string, unknown>) => ({
      exec: async () => mockSecurityCountDocuments(filter),
    }),
  },
}));

jest.mock("../models/accountIpSignalModel", () => ({
  AccountIpSignal: {
    find: (...args: unknown[]) => mockChain(mockAccountIpFind(...args)),
    distinct: (...args: unknown[]) => ({ exec: async () => mockAccountIpDistinct(...args) }),
    exists: () => ({ exec: async () => mockAccountIpExists() }),
    countDocuments: () => ({ exec: async () => 0 }),
  },
}));

jest.mock("../models/deviceTrackingModel", () => ({
  DeviceTracking: {
    aggregate: () => ({ exec: async () => mockDeviceAggregate() }),
  },
}));

jest.mock("../models/authSessionModel", () => ({
  AuthSessionModel: { countDocuments: () => ({ exec: async () => 0 }) },
}));

jest.mock("../services/ipRiskService", () => ({
  getCachedIpRisk: (...args: unknown[]) => mockGetCachedIpRisk(...(args as [string])),
  getIpRisk: jest.fn(async () => ({ source: "unavailable" })),
}));

// 延迟加载（`require`）的模型也必须能被 jest 拦截；只会被「探测报告」用例命中。
jest.mock("../models/proxycheckProbeReportModel", () => ({
  ProxycheckProbeReportModel: {
    countDocuments: (filter: Record<string, unknown>) => ({
      exec: async () => mockProbeCountDocuments(filter),
    }),
  },
}));

import {
  detectAutomationTrace,
  evaluateAccountRiskScore,
  resolveAccountRiskChannelDecision,
  resolveIdcEscalationAction,
  type AccountRiskFacts,
} from "../utils/accountRiskScoring";
import { isDatacenterEgress, isGeoJump } from "../services/geoRisk";
import {
  evaluateAccountRisk,
  getAccountRiskChannelDecision,
  handleIdcEgressRisk,
  recordAccountAbuseSignal,
  recordAutomationTraceSignal,
} from "../services/accountRiskService";

const NOW = Date.UTC(2026, 9, 17, 8, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;

function baseFacts(overrides: Partial<AccountRiskFacts> = {}): AccountRiskFacts {
  return {
    now: NOW,
    accountCreatedAt: NOW - 400 * DAY_MS,
    ipSignals: [],
    deviceMaxRiskScore: 0,
    compromisedDeviceCount: 0,
    recentAbuseEventCount: 0,
    ...overrides,
  };
}

// 探测缓存的最小形状：测试只关心 risk / flags / networkType / detections.hosting，
// 其余字段在真实 IpRiskResult 里由 provider 填充，这里无需复刻。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sampleIpRisk(overrides: Record<string, unknown> = {}): any {
  return {
    ip: "203.0.113.7",
    risk: 20,
    level: "low",
    detections: { hosting: false, proxy: false, vpn: false, tor: false },
    flags: [] as string[],
    networkType: "",
    ...overrides,
  };
}

function baseState(overrides: Record<string, unknown> = {}) {
  return {
    id: "u1",
    role: "user",
    riskTier: "normal",
    riskScore: 0,
    riskFlags: [],
    stepUpUntil: 0,
    stepUpMode: "sensitive",
    accountStatus: "active",
    createdAt: new Date(NOW - 400 * DAY_MS).toISOString(),
    ...overrides,
  };
}

/** 让 fire-and-forget 的 `.then/.catch` 链有机会执行。 */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  Object.assign(mockAccountRiskConfig, BASE_ACCOUNT_RISK);
  jest.clearAllMocks();
  mockGetAccountRiskState.mockResolvedValue(baseState());
  mockUpdateUser.mockResolvedValue(true);
  mockSecurityCreate.mockImplementation(async (doc: Record<string, unknown>) => doc);
  mockSecurityExists.mockResolvedValue(null);
  mockSecurityFindOneLean.mockResolvedValue(null);
  mockSecurityCountDocuments.mockResolvedValue(0);
  mockAccountIpExists.mockResolvedValue(null);
  mockAccountIpFind.mockResolvedValue([]);
  mockAccountIpDistinct.mockResolvedValue([]);
  mockDeviceAggregate.mockResolvedValue([]);
  mockProbeCountDocuments.mockResolvedValue(0);
  mockGetCachedIpRisk.mockResolvedValue(null);
});

// ── RC-15：isGeoJump 单一入口 ──────────────────────────────────────────────
describe("RC-15 geoRisk.isGeoJump（从移动端收敛后的行为不变）", () => {
  const BEIJING = "中国, 北京, 北京 运营商: 中国联通";
  const SHANGHAI = "中国, 上海, 上海 运营商: 中国电信";
  const TOKYO = "日本, 东京, 东京 运营商: NTT";

  it("country 粒度：跨国即突变，同国跨省不算", () => {
    expect(isGeoJump(BEIJING, TOKYO, "country")).toBe(true);
    expect(isGeoJump(BEIJING, SHANGHAI, "country")).toBe(false);
  });

  it("region 粒度：同国跨省算突变", () => {
    expect(isGeoJump(BEIJING, SHANGHAI, "region")).toBe(true);
  });

  it("失败哨兵（未知/未找到位置）永不判突变", () => {
    expect(isGeoJump("未知", TOKYO, "region")).toBe(false);
    expect(isGeoJump(BEIJING, "未找到位置", "region")).toBe(false);
    expect(isGeoJump(null, TOKYO)).toBe(false);
  });

  it("省份缺失时不拿「少一段」当跨省", () => {
    expect(isGeoJump("中国", "中国, 上海", "region")).toBe(false);
  });
});

describe("RC-14 geoRisk.isDatacenterEgress（两份历史实现取并集）", () => {
  it("hosting 检测、datacenter flag、networkType 命中任一即成立", () => {
    expect(isDatacenterEgress({ hosting: true })).toBe(true);
    expect(isDatacenterEgress({ flags: ["datacenter"] })).toBe(true);
    expect(isDatacenterEgress({ networkType: "hosting" })).toBe(true);
    expect(isDatacenterEgress({ networkType: "business" })).toBe(false);
    expect(isDatacenterEgress(null)).toBe(false);
  });
});

// ── RC-20：匿名来源滥用信号 ────────────────────────────────────────────────
describe("RC-20 匿名来源信号的评分语义", () => {
  it("匿名事件半权重、总额封顶 10 分，单靠它到不了 watch", () => {
    const result = evaluateAccountRiskScore(
      baseFacts({ recentAnonymousAbuseEventCount: 20 }),
      { ...BASE_ACCOUNT_RISK, autoEscalationCap: "watch" },
    );
    expect(result.riskScore).toBe(10);
    expect(result.riskTier).toBe("normal");
    expect(result.flags).toContain("ACCOUNT_ABUSE_EVENTS");
  });

  it("已认证事件仍按每件 +10、总额封顶 30 计分（回归）", () => {
    const result = evaluateAccountRiskScore(
      baseFacts({ recentAbuseEventCount: 3 }),
      BASE_ACCOUNT_RISK,
    );
    expect(result.riskScore).toBe(30);
  });

  it("已认证 + 匿名混合计分（1 件 + 10 件匿名 = 20）", () => {
    const result = evaluateAccountRiskScore(
      baseFacts({ recentAbuseEventCount: 1, recentAnonymousAbuseEventCount: 10 }),
      BASE_ACCOUNT_RISK,
    );
    expect(result.riskScore).toBe(20);
  });
});

// ── RC-26 / RC-56：WebRTC 出口不一致 ───────────────────────────────────────
describe("RC-26 / RC-56 探测报告的评分语义", () => {
  it("只加固定权重并置旗标，单独不足以升档", () => {
    const result = evaluateAccountRiskScore(baseFacts({ probeExitMismatch: true }), BASE_ACCOUNT_RISK);
    expect(result.riskScore).toBe(10);
    expect(result.riskTier).toBe("normal");
    expect(result.flags).toContain("PROBE_EXIT_MISMATCH");
  });
});

// ── RC-57：早期自动化痕迹判据 ──────────────────────────────────────────────
describe("RC-57 detectAutomationTrace", () => {
  it("navigator.webdriver === true 命中", () => {
    expect(detectAutomationTrace({ webdriver: true }, "").signals).toEqual(["webdriver"]);
  });

  it("Chrome 系 UA 缺 UA-CH 命中；Firefox 缺 UA-CH 不命中", () => {
    const chrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36";
    const firefox = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0";
    expect(detectAutomationTrace({ uaCh: false }, chrome).hint).toBe(true);
    expect(detectAutomationTrace({ uaCh: false }, firefox).hint).toBe(false);
    expect(detectAutomationTrace({ uaCh: true }, chrome).hint).toBe(false);
  });

  it("不把 plugins/languages 为空当判据（误报成本高于收益）", () => {
    expect(detectAutomationTrace({ plugins: 0, languages: 0 }, "").hint).toBe(false);
  });
});

// ── RC-14：升档映射 ────────────────────────────────────────────────────────
describe("RC-14 resolveIdcEscalationAction", () => {
  it("normal → mark_watch；watch/restricted 只在 cap=restricted 时 restrict", () => {
    expect(resolveIdcEscalationAction("normal", "watch")).toBe("mark_watch");
    expect(resolveIdcEscalationAction("normal", "restricted")).toBe("mark_watch");
    expect(resolveIdcEscalationAction("watch", "watch")).toBeNull();
    expect(resolveIdcEscalationAction("watch", "restricted")).toBe("restrict");
    expect(resolveIdcEscalationAction("restricted", "restricted")).toBe("restrict");
  });

  it("永不把 danger 自动升级（必须人工）", () => {
    expect(resolveIdcEscalationAction("danger", "restricted")).toBeNull();
  });
});

// ── RC-38：交叉株连映射 ────────────────────────────────────────────────────
describe("RC-38 resolveAccountRiskChannelDecision", () => {
  it("normal/watch 不锁；restricted 锁算力/CDK/上传/LibreChat，但保留工单申诉", () => {
    expect(resolveAccountRiskChannelDecision({ tier: "watch", channel: "tts_generate" }).locked).toBe(false);
    const compute = resolveAccountRiskChannelDecision({ tier: "restricted", channel: "tts_generate" });
    expect(compute.locked).toBe(true);
    expect(compute.code).toBe("ACCOUNT_RESTRICTED");
    expect(compute.appealChannel).toBe("ticket");
    expect(resolveAccountRiskChannelDecision({ tier: "restricted", channel: "ticket" }).locked).toBe(false);
  });

  it("danger 连工单一起冻结，改走支持邮箱（仍提供申诉通道）", () => {
    const decision = resolveAccountRiskChannelDecision({ tier: "danger", channel: "ticket" });
    expect(decision.locked).toBe(true);
    expect(decision.code).toBe("ACCOUNT_RESTRICTED");
    expect(decision.appealChannel).toBe("support_email");
    expect(decision.supportEmail).toContain("@");
  });

  it("RC-61：通道自身的处罚不跨通道（channel_local 恒不锁）", () => {
    const decision = resolveAccountRiskChannelDecision({
      tier: "danger",
      channel: "librechat",
      source: "channel_local",
    });
    expect(decision.locked).toBe(false);
  });

  it("RC-44：superadmin 不参与交叉株连", () => {
    expect(
      resolveAccountRiskChannelDecision({ tier: "danger", channel: "ticket", exempt: true }).locked,
    ).toBe(false);
  });
});

// ── 服务层：IDC 升档的唯一出口 ────────────────────────────────────────────
describe("RC-14 handleIdcEgressRisk", () => {
  it("观察期开关关闭时零副作用（不查缓存、不写信号）", async () => {
    mockAccountRiskConfig.ipRecheckEnabled = false;
    const result = await handleIdcEgressRisk({
      userId: "u-disabled",
      ipAddress: "203.0.113.1",
      ipRisk: sampleIpRisk({ networkType: "hosting" }),
      source: "logged_in_request",
    });
    expect(result.reason).toBe("disabled");
    expect(mockGetCachedIpRisk).not.toHaveBeenCalled();
    expect(mockSecurityCreate).not.toHaveBeenCalled();
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it("非 IDC 出口不写信号、不动档位", async () => {
    mockAccountRiskConfig.ipRecheckEnabled = true;
    const result = await handleIdcEgressRisk({
      userId: "u-residential",
      ipAddress: "203.0.113.2",
      ipRisk: sampleIpRisk({ networkType: "business" }),
      source: "logged_in_request",
    });
    expect(result.detected).toBe(false);
    expect(result.reason).toBe("not-idc");
    expect(mockSecurityCreate).not.toHaveBeenCalled();
    expect(mockUpdateUser).not.toHaveBeenCalled();
  });

  it("normal + IDC → mark_watch，经 applyAccountRiskAction 落库并写审计", async () => {
    mockAccountRiskConfig.ipRecheckEnabled = true;
    const result = await handleIdcEgressRisk({
      userId: "u-normal-idc",
      ipAddress: "203.0.113.3",
      ipRisk: sampleIpRisk({ networkType: "hosting", flags: ["hosting"], risk: 30 }),
      source: "logged_in_request",
    });
    expect(result.action).toBe("mark_watch");
    expect(mockUpdateUser).toHaveBeenCalledWith(
      "u-normal-idc",
      expect.objectContaining({ riskTier: "watch", flaggedBy: "auto" }),
    );
    expect(mockSecurityCreate).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "ACCOUNT_ABUSE_IDC_EGRESS" }),
    );
    expect(mockAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: "security.account-risk.mark_watch" }),
    );
  });

  it("watch + IDC + cap=restricted → restrict，并联动全部 API Key 降速", async () => {
    mockAccountRiskConfig.ipRecheckEnabled = true;
    mockGetAccountRiskState.mockResolvedValue(baseState({ id: "u-watch-idc", riskTier: "watch" }));
    const result = await handleIdcEgressRisk({
      userId: "u-watch-idc",
      ipAddress: "203.0.113.4",
      ipRisk: sampleIpRisk({ detections: { hosting: true } }),
      source: "api_key",
    });
    expect(result.action).toBe("restrict");
    expect(mockSetApiKeyPenalty).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u-watch-idc", status: "throttled", source: "account-risk:restricted" }),
    );
  });

  it("danger 永不自动升级/封停", async () => {
    mockAccountRiskConfig.ipRecheckEnabled = true;
    mockGetAccountRiskState.mockResolvedValue(baseState({ id: "u-danger", riskTier: "danger" }));
    const result = await handleIdcEgressRisk({
      userId: "u-danger",
      ipAddress: "203.0.113.5",
      ipRisk: sampleIpRisk({ networkType: "datacenter" }),
      source: "logged_in_request",
    });
    expect(result.action).toBeNull();
    expect(result.reason).toBe("cap-reached");
    expect(mockUpdateUser).not.toHaveBeenCalled();
    expect(mockSetApiKeyPenalty).not.toHaveBeenCalled();
  });

  it("superadmin 豁免：留痕但不升档", async () => {
    mockAccountRiskConfig.ipRecheckEnabled = true;
    mockGetAccountRiskState.mockResolvedValue(baseState({ id: "u-owner", role: "superadmin" }));
    const result = await handleIdcEgressRisk({
      userId: "u-owner",
      ipAddress: "203.0.113.6",
      ipRisk: sampleIpRisk({ hosting: true, networkType: "hosting" }),
      source: "logged_in_request",
    });
    expect(result.exempt).toBe(true);
    expect(result.action).toBeNull();
    expect(mockUpdateUser).not.toHaveBeenCalled();
    expect(mockSecurityCreate).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "SUPERADMIN_RISK_EXEMPT" }),
    );
  });

  it("同账户 5 分钟内重复命中只处理一次（频率闸）", async () => {
    mockAccountRiskConfig.ipRecheckEnabled = true;
    const input = {
      userId: "u-throttle",
      ipAddress: "203.0.113.8",
      ipRisk: sampleIpRisk({ networkType: "hosting" }),
      source: "logged_in_request" as const,
    };
    const first = await handleIdcEgressRisk(input);
    const second = await handleIdcEgressRisk(input);
    expect(first.action).toBe("mark_watch");
    expect(second.reason).toBe("throttled");
    expect(mockUpdateUser).toHaveBeenCalledTimes(1);
  });
});

// ── 服务层：匿名信号归因 ──────────────────────────────────────────────────
describe("RC-20 recordAccountAbuseSignal 的匿名归因闸", () => {
  it("来源 IP 不是该账户的已知出口 ⇒ 不写信号（防止拿别人 identifier 刷分）", async () => {
    mockAccountIpExists.mockResolvedValue(null);
    recordAccountAbuseSignal({
      userId: "u-unknown-ip",
      eventType: "ACCOUNT_ABUSE_CAPTCHA_FAILED",
      anonymous: true,
      requireKnownIp: true,
      ipAddress: "198.51.100.9",
    });
    await flush();
    expect(mockSecurityCreate).not.toHaveBeenCalled();
  });

  it("已知出口才归因，且事件显式带 anonymous:true", async () => {
    mockAccountIpExists.mockResolvedValue({ _id: "x" });
    recordAccountAbuseSignal({
      userId: "u-known-ip",
      eventType: "ACCOUNT_ABUSE_CAPTCHA_FAILED",
      anonymous: true,
      requireKnownIp: true,
      ipAddress: "198.51.100.10",
    });
    await flush();
    expect(mockSecurityCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "ACCOUNT_ABUSE_CAPTCHA_FAILED",
        eventData: expect.objectContaining({ anonymous: true }),
      }),
    );
  });

  it("同一 (userId, eventType) 10 分钟内只写一次", async () => {
    mockAccountIpExists.mockResolvedValue({ _id: "x" });
    for (let index = 0; index < 3; index += 1) {
      recordAccountAbuseSignal({
        userId: "u-dedupe",
        eventType: "ACCOUNT_ABUSE_CAPTCHA_FAILED",
        anonymous: true,
        requireKnownIp: true,
        ipAddress: "198.51.100.11",
      });
    }
    await flush();
    expect(mockSecurityCreate).toHaveBeenCalledTimes(1);
  });
});

// ── 服务层：自动化痕迹事件 ────────────────────────────────────────────────
describe("RC-57 recordAutomationTraceSignal", () => {
  it("首次命中写 AUTOMATION_TRACE（不带 ACCOUNT_ABUSE_ 前缀，避免双重计分）", async () => {
    mockSecurityFindOneLean.mockResolvedValue(null);
    await recordAutomationTraceSignal({
      userId: "u-automation",
      signals: ["webdriver"],
      traces: { webdriver: true },
    });
    expect(mockSecurityCreate).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "AUTOMATION_TRACE" }),
    );
  });

  it("24 小时内已有同类事件则不重复写", async () => {
    mockSecurityFindOneLean.mockResolvedValue({ _id: "existing" });
    await recordAutomationTraceSignal({ userId: "u-automation-2", signals: ["webdriver"] });
    expect(mockSecurityCreate).not.toHaveBeenCalled();
  });
});

// ── 服务层：RC-38 通道判定（读库包装） ────────────────────────────────────
describe("RC-38 getAccountRiskChannelDecision", () => {
  it("restricted 账户：算力通道回 ACCOUNT_RESTRICTED + 工单申诉", async () => {
    mockGetAccountRiskState.mockResolvedValue(baseState({ id: "u-restricted", riskTier: "restricted" }));
    const decision = await getAccountRiskChannelDecision({ userId: "u-restricted", channel: "transcribe" });
    expect(decision.locked).toBe(true);
    expect(decision.code).toBe("ACCOUNT_RESTRICTED");
    expect(decision.appealChannel).toBe("ticket");
  });

  it("superadmin 豁免不锁通道", async () => {
    mockGetAccountRiskState.mockResolvedValue(baseState({ id: "u-root", role: "superadmin", riskTier: "danger" }));
    const decision = await getAccountRiskChannelDecision({ userId: "u-root", channel: "ticket" });
    expect(decision.locked).toBe(false);
  });
});

// ── 服务层：RC-56 探测报告接入（只作信号） ────────────────────────────────
describe("RC-26 / RC-56 探测报告接入账户风险", () => {
  it("ipRecheckEnabled 关闭时不读探测报告", async () => {
    mockAccountRiskConfig.ipRecheckEnabled = false;
    await evaluateAccountRisk("u-probe-off", { reason: "test" });
    expect(mockProbeCountDocuments).not.toHaveBeenCalled();
  });

  it("开关打开且该账户 IP 有 WebRTC 不一致报告 ⇒ 旗标 + 10 分，但不封禁", async () => {
    mockAccountRiskConfig.ipRecheckEnabled = true;
    mockAccountIpDistinct.mockResolvedValue(["203.0.113.20"]);
    mockProbeCountDocuments.mockImplementation(async (filter: Record<string, unknown>) =>
      "mismatch.webrtcVsExit" in filter ? 1 : 0,
    );
    const result = await evaluateAccountRisk("u-probe-on", { reason: "test" });
    expect(result?.flags).toContain("PROBE_EXIT_MISMATCH");
    expect(result?.riskScore).toBe(10);
    // 只写档位/事件，不触碰封停。
    expect(mockUpdateUser).not.toHaveBeenCalledWith(
      "u-probe-on",
      expect.objectContaining({ accountStatus: "suspended" }),
    );
  });
});
