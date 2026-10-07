export {};

const mockSharedEntries = new Map<string, { value: any; expiresAt: number }>();
const mockUser = { id: "u-1", username: "user", email: "user@example.com", role: "user" };
const mockIssueLoginToken = jest.fn(async (..._args: unknown[]) => "login-token");

jest.mock("../config/config", () => ({ config: {} }));
jest.mock("../models/mobileClientTokenModel", () => ({ MobileClientTokenModel: {} }));
jest.mock("../services/authSessionService", () => ({ issueTrackedLoginToken: (...args: unknown[]) => mockIssueLoginToken(...args) }));
jest.mock("../utils/userStorage", () => ({ UserStorage: {
  getUserById: async () => mockUser, updateUser: async () => mockUser,
} }));
jest.mock("../utils/ipUtils", () => ({ getClientIP: jest.fn() }));
jest.mock("../services/mobileIntegrityService", () => ({}));
jest.mock("../services/mobileTokenRiskService", () => ({}));
jest.mock("../services/mobileTokenLineageAlertService", () => ({}));
jest.mock("../utils/logger", () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock("../services/sharedStateStore", () => ({ sharedStateStore: {
  get: async (key: string) => {
    const row = mockSharedEntries.get(key);
    return row && row.expiresAt > Date.now() ? structuredClone(row.value) : null;
  },
  set: async (key: string, value: unknown, ttl: number) => {
    mockSharedEntries.set(key, { value: structuredClone(value), expiresAt: Date.now() + ttl }); return true;
  },
  consume: async (key: string) => {
    const row = mockSharedEntries.get(key);
    mockSharedEntries.delete(key);
    return row && row.expiresAt > Date.now() ? structuredClone(row.value) : null;
  },
  withLock: async (_key: string, _ttl: number, run: () => Promise<unknown>) => run(),
} }));

it("allows another instance to approve and poll, and issues only one credential under concurrent polls", async () => {
  let browser!: typeof import("../services/mobileLoginService");
  let phone!: typeof import("../services/mobileLoginService");
  jest.isolateModules(() => { browser = require("../services/mobileLoginService"); });
  jest.isolateModules(() => { phone = require("../services/mobileLoginService"); });
  const challenge = await browser.createMobileLoginChallenge({ apiBaseUrl: "https://example.com" });
  const scanToken = new URL(challenge.qrPayload).searchParams.get("scanToken")!;
  const approval = await phone.approveMobileLoginChallenge({ sessionId: challenge.sessionId, scanToken, user: mockUser as any });
  expect(approval.ok).toBe(true);
  // 刻意让锁替身不串行，直接覆盖最终 consume 的一次性保证。
  const results = await Promise.all([
    browser.pollMobileLoginChallenge({ sessionId: challenge.sessionId, pollToken: challenge.pollToken }),
    phone.pollMobileLoginChallenge({ sessionId: challenge.sessionId, pollToken: challenge.pollToken }),
  ]);
  expect(results.filter((result) => "token" in result)).toHaveLength(1);
  expect(mockIssueLoginToken).toHaveBeenCalledTimes(1);
});
