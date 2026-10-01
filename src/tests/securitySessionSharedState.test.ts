import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("../services/mongoService", () => ({
  mongoose: {
    connection: { readyState: 0 },
    Schema: class MockSchema {
      index() {
        return this;
      }
      static Types = { Mixed: class MockMixed {} };
    },
    models: {},
    model: () => ({}),
  },
}));

import {
  clearEmailChangeChallenge,
  clearProfileVerificationSessions,
  createEmailChangeChallenge,
  createProfileVerificationSession,
  resetSecuritySessionCacheForTests,
  validateEmailChangeChallenge,
  validateProfileVerificationSession,
} from "../services/profileUpdateVerificationService";
import { sharedStateStore } from "../services/sharedStateStore";

const USER_ID = "u-shared-session";
const REVOCATION_KEY = `security-session:revoked:${USER_ID}`;

/** 让 Date.now 可控：撤销水位是按毫秒比较的，用例不能靠真实时钟碰运气。 */
function mockClock(startMs: number): { advance: (ms: number) => void } {
  let current = startMs;
  jest.spyOn(Date, "now").mockImplementation(() => current);
  return { advance: (ms: number) => (current += ms) };
}

const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

describe("安全会话：自包含令牌 + 共享撤销水位", () => {
  beforeEach(() => {
    sharedStateStore.clearMemory();
    // 每个用例都从「刚启动的干净进程」开始：用例会来回拨时钟，残留水位会让判定失真。
    resetSecuritySessionCacheForTests();
    jest.restoreAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("校验不依赖签发方状态：换个「陌生」用户也能直接验签通过（跨实例/跨重启）", () => {
    const clock = mockClock(1_700_000_000_000);
    const session = createProfileVerificationSession(USER_ID, "totp");
    clock.advance(30_000);

    // 任何实例都只需要 JWT_SECRET 派生出的签名键，不需要「当初签发它的那个进程」。
    const validated = validateProfileVerificationSession(USER_ID, session.token);

    expect(validated?.method).toBe("totp");
    expect(validated?.userId).toBe(USER_ID);
    expect(validated?.expiresAt).toBe(session.expiresAt);
  });

  it("密文/认认标签被篡改、payload 被替换、userId 不匹配都拒绝", () => {
    const session = createProfileVerificationSession(USER_ID, "password");
    const [version, iv, tag, ciphertext] = session.token.split(".");

    // v3：AES-256-GCM 密封（iv.tag.ciphertext），任一字节被动过都会被认证标签挂掉。
    expect(session.token.split(".")).toHaveLength(4);
    expect(version).toBe("v3");
    expect(validateProfileVerificationSession(USER_ID, `${version}.${iv}.${tag}.${ciphertext.slice(0, -2)}xx`)).toBeNull();
    expect(validateProfileVerificationSession(USER_ID, `${version}.${iv}.${tag.slice(0, -2)}xx.${ciphertext}`)).toBeNull();
    expect(validateProfileVerificationSession(USER_ID, session.token)).not.toBeNull();
    expect(validateProfileVerificationSession("someone-else", session.token)).toBeNull();
    expect(validateProfileVerificationSession(USER_ID, "v1.opaque-legacy-token")).toBeNull();
    expect(validateProfileVerificationSession(USER_ID, "v2.legacy-hmac-token.signature")).toBeNull();

    // 没有密钥就造不出可用密文：自造一个「看起来合法」的 4 段令牌只会解密失败。
    const forged = Buffer.from(JSON.stringify({ u: USER_ID, m: 2, iat: Date.now(), exp: Date.now() + 60_000, j: "x" })).toString("base64url");
    expect(validateProfileVerificationSession(USER_ID, `${version}.${iv}.${tag}.${forged}`)).toBeNull();
  });

  it("过期令牌被拒绝", () => {
    const clock = mockClock(1_700_000_000_000);
    const session = createProfileVerificationSession(USER_ID, "password");

    clock.advance(9 * 60 * 1000);
    expect(validateProfileVerificationSession(USER_ID, session.token)).not.toBeNull();

    clock.advance(2 * 60 * 1000);
    expect(validateProfileVerificationSession(USER_ID, session.token)).toBeNull();
  });

  it("结束会话后旧令牌立即失效，且同用户新令牌会顶掉旧令牌", () => {
    const clock = mockClock(1_700_000_000_000);
    const first = createProfileVerificationSession(USER_ID, "totp");

    clock.advance(1_000);
    const second = createProfileVerificationSession(USER_ID, "totp");

    // 后建立的一枚有效；先前那枚（同一用户）被水位覆盖。
    expect(validateProfileVerificationSession(USER_ID, second.token)).not.toBeNull();
    expect(validateProfileVerificationSession(USER_ID, first.token)).toBeNull();

    clock.advance(1_000);
    clearProfileVerificationSessions(USER_ID);
    expect(validateProfileVerificationSession(USER_ID, second.token)).toBeNull();
  });

  it("跨实例撤销：别的实例写下水位后，本地水位缓存刷新即可同步拒绝", async () => {
    const startMs = 1_700_000_000_000;
    const clock = mockClock(startMs);
    const session = createProfileVerificationSession(USER_ID, "password");
    expect(validateProfileVerificationSession(USER_ID, session.token)).not.toBeNull();

    // 模拟「另一台实例」绕开本地缓存直接把水位写进共享层。
    await sharedStateStore.set(REVOCATION_KEY, startMs + 5_000, 60_000);
    clock.advance(5_000);

    // 第一次校验触发异步刷新（本次仍用旧缓存，符合 ≤2s 收敛窗口的语义）……
    validateProfileVerificationSession(USER_ID, session.token);
    await flushAsync();
    // ……刷新落地后即拒绝。
    expect(validateProfileVerificationSession(USER_ID, session.token)).toBeNull();
  });
});

describe("邮箱变更验证码：落共享存储", () => {
  beforeEach(() => {
    sharedStateStore.clearMemory();
    resetSecuritySessionCacheForTests();
    jest.restoreAllMocks();
  });

  it("验证码通过共享层读写，正确码校验成功", async () => {
    const challenge = await createEmailChangeChallenge(USER_ID, "new@example.com");
    expect(challenge.success).toBe(true);
    expect(challenge.code).toMatch(/^\d{6}$/);

    const result = await validateEmailChangeChallenge(USER_ID, "new@example.com", challenge.code as string);
    expect(result).toEqual({ success: true, status: 200 });
  });

  it("错误码累计attempts，达到上限后作废挑战", async () => {
    await createEmailChangeChallenge(USER_ID, "new@example.com");

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const result = await validateEmailChangeChallenge(USER_ID, "new@example.com", "000000");
      expect(result.status).toBe(400);
    }

    const locked = await validateEmailChangeChallenge(USER_ID, "new@example.com", "000000");
    expect(locked.status).toBe(429);

    // 挑战已作废：下一轮必须重新发送。
    const afterLock = await validateEmailChangeChallenge(USER_ID, "new@example.com", "000000");
    expect(afterLock.error).toBe("请先向新邮箱发送验证码");
  });

  it("60 秒内重复发送被拒且带剩余等待时间", async () => {
    const first = await createEmailChangeChallenge(USER_ID, "new@example.com");
    expect(first.success).toBe(true);

    const second = await createEmailChangeChallenge(USER_ID, "new@example.com");
    expect(second.success).toBe(false);
    expect(second.retryAfterMs).toBeGreaterThan(0);
  });

  it("clearEmailChangeChallenge 之后校验按「未发送」处理", async () => {
    await createEmailChangeChallenge(USER_ID, "new@example.com");
    await clearEmailChangeChallenge(USER_ID);

    const result = await validateEmailChangeChallenge(USER_ID, "new@example.com", "123456");
    expect(result.error).toBe("请先向新邮箱发送验证码");
  });
});
