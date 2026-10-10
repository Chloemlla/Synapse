import { afterEach, describe, expect, it, jest } from "@jest/globals";

/**
 * 超级管理员风控豁免（RC-44 / §3.2）。
 *
 * 判据是「唯一判据源」这个事实本身，因此这里的用例重点不在“能不能豁免”，
 * 而在于**谁能被豁免**（只有 superadmin）与**降级开关是否真的生效**。
 */

const mockCreate = jest.fn(async (doc: Record<string, unknown>) => doc);

jest.mock("../models/securityEventModel", () => ({
  SecurityEvent: {
    create: (doc: Record<string, unknown>) => mockCreate(doc),
  },
}));

import {
  isRiskExempt,
  isRiskExemptionEnabled,
  resetRiskExemptionWarningForTests,
  shouldExemptFromRiskControl,
} from "../services/riskExemption";

afterEach(() => {
  delete process.env.RISK_EXEMPTION_DISABLED;
  resetRiskExemptionWarningForTests();
  mockCreate.mockClear();
});

describe("isRiskExempt", () => {
  it("只认 role === 'superadmin'", () => {
    expect(isRiskExempt({ role: "superadmin" })).toBe(true);
    expect(isRiskExempt({ role: "admin" })).toBe(false);
    // trusted 是历史角色，刻意不参与判定（否则它会变成可配置的免死金牌）。
    expect(isRiskExempt({ role: "trusted" })).toBe(false);
    expect(isRiskExempt({ role: "user" })).toBe(false);
    expect(isRiskExempt(null)).toBe(false);
    expect(isRiskExempt(undefined)).toBe(false);
    expect(isRiskExempt({})).toBe(false);
  });

  it("邮箱/ID 之类的其它字段不影响判定", () => {
    const suspicious = { role: "user", email: "ops@chloemlla.com", id: "admin", username: "superadmin" } as {
      role: string;
      email: string;
      id: string;
      username: string;
    };
    expect(isRiskExempt(suspicious)).toBe(false);
  });
});

describe("降级开关", () => {
  it("RISK_EXEMPTION_DISABLED=true 时超级管理员也不豁免", () => {
    process.env.RISK_EXEMPTION_DISABLED = "true";
    expect(isRiskExemptionEnabled()).toBe(false);
    expect(isRiskExempt({ role: "superadmin" })).toBe(false);
  });

  it("开关只认严格的 true（大小写与空白容忍），其它值保持开启", () => {
    process.env.RISK_EXEMPTION_DISABLED = " TRUE ";
    expect(isRiskExemptionEnabled()).toBe(false);
    process.env.RISK_EXEMPTION_DISABLED = "1";
    expect(isRiskExemptionEnabled()).toBe(true);
    process.env.RISK_EXEMPTION_DISABLED = "yes";
    expect(isRiskExemptionEnabled()).toBe(true);
  });
});

describe("shouldExemptFromRiskControl", () => {
  it("命中豁免时写 SUPERADMIN_RISK_EXEMPT 留痕", async () => {
    const exempt = shouldExemptFromRiskControl({ id: "u1", role: "superadmin" }, "stepUp", {
      routeKey: "/api/command",
    });
    expect(exempt).toBe(true);
    // 留痕是 fire-and-forget，等一个微任务让 create 被调用。
    await Promise.resolve();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const doc = mockCreate.mock.calls[0][0];
    expect(doc.eventType).toBe("SUPERADMIN_RISK_EXEMPT");
    expect(doc.userId).toBe("u1");
    expect((doc.eventData as Record<string, unknown>).scope).toBe("stepUp");
  });

  it("未命中豁免时不写留痕", async () => {
    expect(shouldExemptFromRiskControl({ id: "u2", role: "admin" }, "stepUp")).toBe(false);
    await Promise.resolve();
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
