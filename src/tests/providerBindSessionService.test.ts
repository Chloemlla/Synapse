import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import {
  confirmProviderBindSession,
  getProviderBindSessionView,
  issueProviderBindSession,
  resetProviderBindSessionsForTests,
} from "../services/providerBindSessionService";
import { AccountSuspendedError } from "../services/providerAuthErrors";
import { bindProviderIdentityToUser } from "../services/accountIdentityService";
import { issueTrackedLoginToken } from "../services/authSessionService";
import { UserStorage } from "../utils/userStorage";

jest.mock("../utils/userStorage", () => ({
  UserStorage: {
    authenticateUser: jest.fn(),
    getUserById: jest.fn(),
    updateUser: jest.fn(),
  },
}));

jest.mock("../services/accountIdentityService", () => ({
  bindProviderIdentityToUser: jest.fn(),
  upsertIdentityForUser: jest.fn(),
}));

jest.mock("../services/authSessionService", () => ({
  issueTrackedLoginToken: jest.fn(),
}));


jest.mock("../services/sharedStateStore", () => {
  const entries = new Map<string, { value: unknown; expiresAt: number }>();
  const locks = new Set<string>();
  const get = async (key: string) => {
    const entry = entries.get(key);
    return entry && entry.expiresAt > Date.now() ? structuredClone(entry.value) : null;
  };
  return { sharedStateStore: {
    get,
    set: async (key: string, value: unknown, ttl: number) => { entries.set(key, { value: structuredClone(value), expiresAt: Date.now() + ttl }); return true; },
    consume: async (key: string) => { const entry = entries.get(key); entries.delete(key); return entry && entry.expiresAt > Date.now() ? structuredClone(entry.value) : null; },
    delete: async (key: string) => entries.delete(key),
    deleteByPrefix: async (prefix: string) => { for (const key of entries.keys()) if (key.startsWith(prefix)) entries.delete(key); return 0; },
    withLock: async (key: string, _ttl: number, run: () => Promise<unknown>) => {
      if (locks.has(key)) throw new Error("操作正在进行中");
      locks.add(key);
      try { return await run(); } finally { locks.delete(key); }
    },
  } };
});

const googleProfile = {
  provider: "google" as const,
  providerUserId: "google-user-1",
  providerEmail: "user@example.com",
  providerUsername: "Example User",
};

const baseUser = {
  id: "user-1",
  username: "existing",
  email: "user@example.com",
  role: "user",
};

function confirmWith(sessionToken: string, password: string) {
  return confirmProviderBindSession({
    sessionToken,
    identifier: "existing",
    password,
    acceptedTerms: true,
  });
}

describe("providerBindSessionService", () => {
  beforeEach(async () => {
    await resetProviderBindSessionsForTests();
    jest.clearAllMocks();
    (issueTrackedLoginToken as jest.Mock).mockResolvedValue("tracked-token");
  });

  it("issues a session view without leaking internals", async () => {
    const view = await issueProviderBindSession(googleProfile);

    expect(view.provider).toBe("google");
    expect(view.providerLabel).toBe("Google");
    expect(view.providerEmail).toBe("user@example.com");
    expect(typeof view.sessionToken).toBe("string");
    expect(view.sessionToken.length).toBeGreaterThan(20);
    // profiles 不允许从视图里泄出
    expect(Object.keys(view)).not.toContain("profile");

    expect((await getProviderBindSessionView(view.sessionToken))?.providerEmail).toBe("user@example.com");
  });

  it("caps password guessing per bind session and invalidates it afterwards", async () => {
    const view = await issueProviderBindSession(googleProfile);
    (UserStorage.authenticateUser as jest.Mock).mockResolvedValue(null);

    await expect(confirmWith(view.sessionToken, "wrong")).rejects.toThrow(/还可尝试 4 次/);

    // 前 4 次失败后会话仍在，第 5 次失败即作废：持有一个 bind token 不能无限试密。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(confirmWith(view.sessionToken, "wrong")).rejects.toThrow(/用户名\/邮箱或密码错误/);
    }
    expect(await getProviderBindSessionView(view.sessionToken)).not.toBeNull();

    await expect(confirmWith(view.sessionToken, "wrong")).rejects.toThrow(/尝试次数过多/);
    expect(await getProviderBindSessionView(view.sessionToken)).toBeNull();
  });

  it("rejects an expired bind session instead of leaving it usable", async () => {
    const view = await issueProviderBindSession(googleProfile);
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(Date.now() + 6 * 60 * 1000);

    try {
      await expect(confirmWith(view.sessionToken, "whatever")).rejects.toThrow(/已过期/);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("refuses suspended accounts with the shared suspension error", async () => {
    const view = await issueProviderBindSession(googleProfile);
    (UserStorage.authenticateUser as jest.Mock).mockResolvedValue({
      ...baseUser,
      accountStatus: "suspended",
    });

    await expect(confirmWith(view.sessionToken, "correct")).rejects.toBeInstanceOf(AccountSuspendedError);
  });

  it("consumes the session and returns a login payload on success", async () => {
    const view = await issueProviderBindSession(googleProfile);
    (UserStorage.authenticateUser as jest.Mock).mockResolvedValue(baseUser);
    (UserStorage.getUserById as jest.Mock).mockResolvedValue(baseUser);
    (UserStorage.updateUser as jest.Mock).mockResolvedValue(baseUser);
    (bindProviderIdentityToUser as jest.Mock).mockResolvedValue({
      success: true,
      status: "bound",
      account: { provider: "google", status: "bound" },
    });

    const result = await confirmWith(view.sessionToken, "correct");

    expect(result.status).toBe("bound");
    expect(result.token).toBe("tracked-token");
    expect(result.user?.id).toBe("user-1");
    expect(result.provider).toBe("google");
    // 一次性：绑定成功后同一个 token 不能再确认一次。
    expect(await getProviderBindSessionView(view.sessionToken)).toBeNull();
  });

  it("keeps the session alive on conflict so the user can try another account", async () => {
    const view = await issueProviderBindSession(googleProfile);
    (UserStorage.authenticateUser as jest.Mock).mockResolvedValue(baseUser);
    (bindProviderIdentityToUser as jest.Mock).mockResolvedValue({
      success: true,
      status: "conflict",
      conflictReason: "Google 已绑定到当前账号的另一个身份",
    });

    const result = await confirmWith(view.sessionToken, "correct");

    expect(result.status).toBe("conflict");
    expect(result.conflictReason).toContain("已绑定");
    expect(await getProviderBindSessionView(view.sessionToken)).not.toBeNull();
  });
});
