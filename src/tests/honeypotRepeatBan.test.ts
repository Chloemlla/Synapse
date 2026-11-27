import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { AuditLogService } from "../services/auditLogService";
import { IpBanModel } from "../models/ipBanModel";
import { SecurityEvent } from "../models/securityEventModel";
import { manualBanIp } from "../services/turnstile/ipBan";
import {
  HONEYPOT_BAN_DURATION_MINUTES,
  HONEYPOT_BAN_REASON_PREFIX,
  HONEYPOT_REPEAT_THRESHOLD,
  HONEYPOT_REPEAT_WINDOW_MS,
  MAX_BAN_DURATION_MINUTES,
} from "../services/turnstile/constants";
import { evaluateHoneypotRepeatBan } from "../services/turnstile/honeypotBan";

/**
 * 蜜罐连续命中 → 自动封禁的**判据**（owner 2026-11-26 裁决，推翻 RC-42 的「只留痕不封禁」）。
 *
 * 必须钉死的性质：
 * 1. 阈值语义：2 小时内 **≥2** 次才封；1 次不封（单次误入不处置）；
 * 2. 豁免：回环/私网地址永不自动封（NAT 后整段内网会连坐）；
 * 3. 幂等：已有生效封禁时不再改写（否则每次再命中都会把到期时间往后推、覆盖首次判定的原因）；
 * 4. 留痕：自动处置必须写 `ipban.autoHoneypotBan` 审计，事后能说明「谁判的、依据是什么」；
 * 5. 失败不抛：蜜罐命中链路里任何风控故障都不能变成 5xx。
 */

jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock("../services/mongoService", () => ({
  mongoose: { connection: { readyState: 1 } },
  isConnected: () => true,
}));

jest.mock("../models/ipBanModel", () => ({
  IpBanModel: { findOne: jest.fn() },
}));

jest.mock("../models/securityEventModel", () => ({
  // `create` 是 RC-44 豁免留痕用的（riskExemption 直接写 SecurityEvent），不是本服务写命中事件。
  SecurityEvent: { find: jest.fn(), countDocuments: jest.fn(), create: jest.fn(async () => ({})) },
}));

jest.mock("../services/turnstile/ipBan", () => ({
  manualBanIp: jest.fn(),
}));

jest.mock("../services/auditLogService", () => ({
  AuditLogService: { log: jest.fn(async () => undefined) },
}));

const mockedFind = SecurityEvent.find as unknown as jest.Mock;
const mockedCount = SecurityEvent.countDocuments as unknown as jest.Mock;
const mockedEventCreate = SecurityEvent.create as unknown as jest.Mock;
const mockedFindOne = IpBanModel.findOne as unknown as jest.Mock;
const mockedManualBanIp = manualBanIp as unknown as jest.Mock;
const mockedAuditLog = AuditLogService.log as unknown as jest.Mock;

/**
 * 造一个 `find().sort().limit().lean().exec()` 链，返回给定事件文档；
 * `countDocuments` 默认按「匿名命中」口径（`userId == null`）统计，与判据实现一致。
 */
function stubHoneypotHits(docs: Array<Record<string, unknown>>, anonymousCount?: number) {
  const exec = jest.fn(async () => docs);
  const lean = jest.fn(() => ({ exec }));
  const limit = jest.fn(() => ({ lean }));
  const sort = jest.fn(() => ({ limit }));
  mockedFind.mockReturnValue({ sort });
  mockedCount.mockResolvedValue(
    typeof anonymousCount === "number" ? anonymousCount : docs.filter((doc) => doc.userId == null).length,
  );
  return { sort, limit, lean, exec };
}

/** 造一个 `findOne().lean().exec()` 链，返回给定封禁文档（或 null）。 */
function stubExistingBan(doc: Record<string, unknown> | null) {
  const exec = jest.fn(async () => doc);
  const lean = jest.fn(() => ({ exec }));
  mockedFindOne.mockReturnValue({ lean });
}

const hit = (fingerprint = "device-1") => ({
  ip: "203.0.113.9",
  kind: "path_prefix",
  path: "/api/v1/models?limit=5",
  method: "GET",
  userAgent: "KimiBot/1.0",
  fingerprint,
});

describe("蜜罐自动封禁判据（常量口径）", () => {
  it("窗口 2 小时、阈值 2 次、封禁 30 天", () => {
    expect(HONEYPOT_REPEAT_WINDOW_MS).toBe(2 * 60 * 60 * 1000);
    expect(HONEYPOT_REPEAT_THRESHOLD).toBe(2);
    expect(HONEYPOT_BAN_DURATION_MINUTES).toBe(30 * 24 * 60);
    // 手工封禁与自动封禁共用同一个硬顶，不允许两处各写一个数。
    expect(MAX_BAN_DURATION_MINUTES).toBe(HONEYPOT_BAN_DURATION_MINUTES);
  });
});

describe("evaluateHoneypotRepeatBan", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    stubHoneypotHits([]);
    stubExistingBan(null);
    mockedManualBanIp.mockResolvedValue({ success: true, expiresAt: new Date("2026-12-26T00:00:00Z") });
  });

  it("窗口内只有 1 次命中：不封禁（单次误入不处置）", async () => {
    stubHoneypotHits([
      { _id: "e1", eventType: "HONEYPOT_HIT", eventData: { path: "/api/v1/models" }, createdAt: new Date() },
    ]);

    const decision = await evaluateHoneypotRepeatBan(hit());

    expect(decision.banned).toBe(false);
    expect(decision.skippedReason).toBe("below-threshold");
    expect(decision.hitsInWindow).toBe(1);
    expect(mockedManualBanIp).not.toHaveBeenCalled();
    expect(mockedAuditLog).not.toHaveBeenCalled();
  });

  it("窗口内 2 次命中：以 auto 来源封禁 30 天，原因带判据前缀与最近路径", async () => {
    stubHoneypotHits([
      {
        _id: "e2",
        eventType: "HONEYPOT_HIT",
        eventData: { path: "/api/v1/models?limit=5", method: "GET" },
        createdAt: new Date(),
      },
      {
        _id: "e1",
        eventType: "HONEYPOT_HIT",
        eventData: { path: "/api/debug/dump" },
        createdAt: new Date(Date.now() - 60_000),
      },
    ]);

    const decision = await evaluateHoneypotRepeatBan(hit("device-9"));

    expect(decision.banned).toBe(true);
    expect(decision.hitsInWindow).toBe(2);
    expect(decision.expiresAt).toEqual(new Date("2026-12-26T00:00:00Z"));
    expect(mockedManualBanIp).toHaveBeenCalledTimes(1);

    const [ip, reason, durationMinutes, options] = mockedManualBanIp.mock.calls[0] as [
      string,
      string,
      number,
      Record<string, unknown>,
    ];
    expect(ip).toBe("203.0.113.9");
    expect(reason.startsWith(HONEYPOT_BAN_REASON_PREFIX)).toBe(true);
    // 120 分钟的窗口与命中的方法/路径都要进原因：名单页只有一行字，得能自解释。
    expect(reason).toContain("120 分钟");
    expect(reason).toContain("2 次");
    expect(reason).toContain("GET /api/v1/models?limit=5");
    expect(durationMinutes).toBe(HONEYPOT_BAN_DURATION_MINUTES);
    expect(options).toMatchObject({ source: "auto", fingerprint: "device-9", userAgent: "KimiBot/1.0" });
  });

  it("自动处置写 ipban.autoHoneypotBan 审计（含判据参数与命中路径）", async () => {
    stubHoneypotHits([
      { _id: "e2", eventType: "HONEYPOT_HIT", eventData: { path: "/api/v1/models" }, createdAt: new Date() },
      { _id: "e1", eventType: "HONEYPOT_HIT", eventData: { path: "/api/debug/dump" }, createdAt: new Date() },
    ]);

    await evaluateHoneypotRepeatBan(hit());

    expect(mockedAuditLog).toHaveBeenCalledTimes(1);
    const entry = mockedAuditLog.mock.calls[0][0] as Record<string, any>;
    expect(entry).toMatchObject({
      action: "ipban.autoHoneypotBan",
      module: "ipban",
      result: "success",
      targetId: "203.0.113.9",
      role: "system",
      ip: "203.0.113.9",
    });
    expect(entry.detail).toMatchObject({
      ipAddress: "203.0.113.9",
      hitsInWindow: 2,
      windowMinutes: 120,
      threshold: 2,
      durationMinutes: HONEYPOT_BAN_DURATION_MINUTES,
    });
    expect(entry.detail.hitPaths).toEqual(["/api/v1/models", "/api/debug/dump"]);
  });

  it("已登录命中不计入判据：1 次匿名 + 1 次带令牌访问 → 不封", async () => {
    // 管理员工具/旧客户端常带令牌访问 `/api/debug/*`（RC-42 当时担心的误伤面），
    // 这类命中属于「已知主体」，归账户风险处置，不能靠 IP 封禁连坐整个出口。
    stubHoneypotHits([
      { _id: "e2", eventType: "HONEYPOT_HIT", eventData: { path: "/api/debug/dump" }, userId: "u-admin" },
      { _id: "e1", eventType: "HONEYPOT_HIT", eventData: { path: "/api/v1/models" } },
    ]);

    const decision = await evaluateHoneypotRepeatBan(hit());

    expect(decision.banned).toBe(false);
    expect(decision.skippedReason).toBe("below-threshold");
    expect(decision.hitsInWindow).toBe(1);
    expect(decision.totalHitsInWindow).toBe(2);
    expect(mockedManualBanIp).not.toHaveBeenCalled();
  });

  it("超管命中走统一风控豁免判据（RC-44），不封禁但必须留痕", async () => {
    const decision = await evaluateHoneypotRepeatBan({ ...hit(), userId: "u-1", role: "superadmin" });
    expect(decision.banned).toBe(false);
    expect(decision.skippedReason).toBe("risk-exempt");
    expect(mockedCount).not.toHaveBeenCalled();
    expect(mockedManualBanIp).not.toHaveBeenCalled();
    // RC-44：豁免本身也要有取证记录，否则「为什么这个 IP 没被封」事后无从解释。
    expect(mockedEventCreate).toHaveBeenCalledTimes(1);
    expect(mockedEventCreate.mock.calls[0][0]).toMatchObject({
      eventType: "SUPERADMIN_RISK_EXEMPT",
      userId: "u-1",
      eventData: { scope: "honeypot" },
    });
  });

  it("回环 / 私网地址永不自动封，且根本不查库", async () => {
    for (const localIp of ["127.0.0.1", "::1", "10.1.2.3", "192.168.0.7", "172.16.5.5"]) {
      const decision = await evaluateHoneypotRepeatBan({ ...hit(), ip: localIp });
      expect(decision.banned).toBe(false);
      expect(decision.skippedReason).toBe("local-ip");
    }
    expect(mockedFind).not.toHaveBeenCalled();
    expect(mockedCount).not.toHaveBeenCalled();
    expect(mockedManualBanIp).not.toHaveBeenCalled();
  });

  it("非法 / 空 IP 直接跳过（不拿脏数据建封禁记录）", async () => {
    for (const badIp of ["", "not-an-ip", "1.2.3.4/24"]) {
      const decision = await evaluateHoneypotRepeatBan({ ...hit(), ip: badIp });
      expect(decision.skippedReason).toBe("invalid-ip");
    }
    expect(mockedManualBanIp).not.toHaveBeenCalled();
  });

  it("已有生效封禁：不重复改写（保持首次判定的原因与到期时间）", async () => {
    stubHoneypotHits([
      { _id: "e2", eventType: "HONEYPOT_HIT", eventData: { path: "/api/v1/models" }, createdAt: new Date() },
      { _id: "e1", eventType: "HONEYPOT_HIT", eventData: { path: "/api/debug/dump" }, createdAt: new Date() },
    ]);
    stubExistingBan({
      ipAddress: "203.0.113.9",
      reason: `${HONEYPOT_BAN_REASON_PREFIX}：2 次`,
      expiresAt: new Date(Date.now() + 86_400_000),
      source: "auto",
    });

    const decision = await evaluateHoneypotRepeatBan(hit());

    expect(decision.banned).toBe(false);
    expect(decision.skippedReason).toBe("already-banned");
    expect(mockedManualBanIp).not.toHaveBeenCalled();
  });

  it("manualBanIp 失败时如实返回错误，且不写成功审计", async () => {
    stubHoneypotHits([
      { _id: "e2", eventType: "HONEYPOT_HIT", eventData: { path: "/api/v1/models" }, createdAt: new Date() },
      { _id: "e1", eventType: "HONEYPOT_HIT", eventData: { path: "/api/debug/dump" }, createdAt: new Date() },
    ]);
    mockedManualBanIp.mockResolvedValue({ success: false, error: "数据库连接不可用" });

    const decision = await evaluateHoneypotRepeatBan(hit());

    expect(decision.banned).toBe(false);
    expect(decision.error).toBe("数据库连接不可用");
    expect(mockedAuditLog).not.toHaveBeenCalled();
  });

  it("查询抛错时降级为不封禁，绝不向上抛（蜜罐链路不能 5xx）", async () => {
    mockedFind.mockImplementation(() => {
      throw new Error("mongo down");
    });

    const decision = await evaluateHoneypotRepeatBan(hit());

    expect(decision.banned).toBe(false);
    expect(decision.error).toBe("mongo down");
    expect(mockedManualBanIp).not.toHaveBeenCalled();
  });
});
