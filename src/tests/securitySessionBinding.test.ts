import { beforeEach, describe, expect, it, jest } from "@jest/globals";

/**
 * 安全会话的 TTL 与绑定（RC-40 / RC-41 / 裁决二）。
 *
 * 三条性质在这里钉死（都不需要连库）：
 * 1. TTL 来自运行时配置（默认 5 分钟，不再写死 10 分钟）；
 * 2. **UA 不匹配立即失效**（同步路径，防令牌被拿到另一环境重放）；
 * 3. IP 变化本身**不**让会话失效 —— 踢不踢人由高危路径的异步属地判定决定
 *    （移动网络换基站是常态，裁决二明确禁止“任一跳变即踢”）。
 */

const mockSecuritySessionConfig = {
  ttlSeconds: 120,
  bindUserAgent: true,
  revokeOnGeoJump: true,
};

jest.mock("../config/config", () => ({
  config: {
    jwtSecret: "test-secret-for-security-session",
    securitySession: mockSecuritySessionConfig,
    mobileTokenRotationRisk: { geoJumpScope: "country" },
  },
}));

jest.mock("../services/sharedStateStore", () => ({
  SharedStateLockedError: class SharedStateLockedError extends Error {},
  sharedStateStore: {
    get: jest.fn(async () => null),
    set: jest.fn(async () => undefined),
    withLock: jest.fn(async (_key: string, _ttl: number, fn: () => Promise<unknown>) => fn()),
  },
}));

jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import {
  createProfileVerificationSession,
  resetSecuritySessionCacheForTests,
  validateProfileVerificationSession,
} from "../services/profileUpdateVerificationService";

const USER_ID = "u-binding-1";

beforeEach(() => {
  jest.clearAllMocks();
  resetSecuritySessionCacheForTests();
  mockSecuritySessionConfig.ttlSeconds = 120;
  mockSecuritySessionConfig.bindUserAgent = true;
  mockSecuritySessionConfig.revokeOnGeoJump = true;
});

describe("安全会话 TTL（RC-40）", () => {
  it("TTL 取自运行时配置，不再写死 10 分钟", () => {
    const session = createProfileVerificationSession(USER_ID, "password", {
      ipAddress: "203.0.113.5",
      userAgent: "UA-A",
    });
    expect(session.expiresAt - session.createdAt).toBe(120 * 1000);

    mockSecuritySessionConfig.ttlSeconds = 300;
    const longer = createProfileVerificationSession(USER_ID, "password");
    expect(longer.expiresAt - longer.createdAt).toBe(300 * 1000);
  });
});

describe("UA 绑定（RC-41 裁决二：不匹配立即失效）", () => {
  it("同一 UA 可继续使用；UA 变了立刻失效", () => {
    const session = createProfileVerificationSession(USER_ID, "totp", {
      ipAddress: "203.0.113.5",
      userAgent: "Mozilla/5.0 (X11) Test/1.0",
    });

    expect(
      validateProfileVerificationSession(USER_ID, session.token, { userAgent: "Mozilla/5.0 (X11) Test/1.0" }),
    ).not.toBeNull();
    expect(
      validateProfileVerificationSession(USER_ID, session.token, { userAgent: "curl/8.0" }),
    ).toBeNull();
  });

  it("关掉绑定开关后 UA 不再参与判定（可审计的逃生舱）", () => {
    const session = createProfileVerificationSession(USER_ID, "password", { userAgent: "UA-A" });
    mockSecuritySessionConfig.bindUserAgent = false;
    expect(validateProfileVerificationSession(USER_ID, session.token, { userAgent: "UA-B" })).not.toBeNull();
  });

  it("签发时没带 UA（老客户端/脚本）时不因为“本次带 UA”而被误杀", () => {
    const session = createProfileVerificationSession(USER_ID, "password", { ipAddress: "203.0.113.5" });
    expect(validateProfileVerificationSession(USER_ID, session.token, { userAgent: "UA-ANY" })).not.toBeNull();
  });
});

describe("IP 只作信号（踢人交给高危路径的异步判定）", () => {
  it("IP 变化不直接影响同步校验，但会话里留下了签发 IP 供判定", () => {
    const session = createProfileVerificationSession(USER_ID, "password", {
      ipAddress: "203.0.113.5",
      userAgent: "UA-A",
    });
    expect(session.issuedIp).toBe("203.0.113.5");
    expect(
      validateProfileVerificationSession(USER_ID, session.token, {
        ipAddress: "198.51.100.9",
        userAgent: "UA-A",
      }),
    ).not.toBeNull();
  });
});
