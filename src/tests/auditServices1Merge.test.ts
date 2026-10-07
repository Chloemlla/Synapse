export {};
const mockSharedEntries = new Map<string, { value: unknown; expiresAt: number }>();
const mockSharedStore = {
  set: jest.fn(async (key: string, value: unknown, ttl: number) => {
    mockSharedEntries.set(key, { value: JSON.parse(JSON.stringify(value)), expiresAt: Date.now() + ttl });
    return true;
  }),
  get: jest.fn(async (key: string) => {
    const entry = mockSharedEntries.get(key);
    return entry && entry.expiresAt > Date.now() ? JSON.parse(JSON.stringify(entry.value)) : null;
  }),
  delete: jest.fn(async (key: string) => mockSharedEntries.delete(key)),
  withLock: jest.fn(async (_key: string, _ttl: number, operation: () => Promise<unknown>) => operation()),
  clearMemory: jest.fn(),
};
jest.mock("../services/sharedStateStore", () => ({ sharedStateStore: mockSharedStore }));
jest.mock("../services/mongoService", () => ({ mongoose: { connection: { collection: () => ({ countDocuments: async () => 0 }) } } }));
jest.mock("../models/accountIdentityModel", () => ({ AccountIdentityModel: {} }));
jest.mock("../models/oauthModel", () => ({ OAuthAuthorizationCodeModel: {}, OAuthClientModel: {}, OAuthGrantModel: {}, OAuthTokenModel: {} }));
jest.mock("../models/recommendationHistoryModel", () => ({ __esModule: true, default: { findOne: () => ({ lean: async () => null }) } }));
jest.mock("../models/userPreferencesModel", () => ({ __esModule: true, default: { exists: async () => false } }));
jest.mock("../models/workspaceModel", () => ({ __esModule: true, default: { countDocuments: async () => 0 } }));
jest.mock("../utils/userStorage", () => ({ UserStorage: { getUserById: async (id: string) => ({ id, username: id, email: "same@example.com", role: "user" }) } }));
jest.mock("../services/auditLogService", () => ({ AuditLogService: { log: jest.fn() } }));
jest.mock("../utils/logger", () => ({ __esModule: true, default: { warn: jest.fn(), error: jest.fn() } }));

type MergeService = typeof import("../services/accountMergeService");
function loadInstance(): MergeService {
  let instance!: MergeService;
  jest.isolateModules(() => { instance = require("../services/accountMergeService"); });
  return instance;
}

describe("audit services 1: shared merge previews", () => {
  beforeEach(() => { mockSharedEntries.clear(); jest.clearAllMocks(); });

  it("lets another service instance retrieve the preview and pending UI record", async () => {
    const first = loadInstance();
    const second = loadInstance();
    const created = await first.createMergePreviewSession({ sourceUserId: "source", targetUserId: "target", provider: "google", providerUserId: "provider-user" });
    await expect(second.getMergePreviewByToken(created.token, "target")).resolves.toMatchObject({ sourceAccount: { id: "source" } });
    await expect(second.getPendingMergeSessionForUser("target", "google")).resolves.toMatchObject({ token: created.token });
    await expect(second.getMergePreviewByToken(created.token, "someone-else")).rejects.toThrow("合并预览不存在或已过期");
    expect(mockSharedStore.set).toHaveBeenCalledWith(expect.stringContaining("account-merge:session:"), expect.any(Object), 15 * 60 * 1000);
  });

  it("invalidates the replaced token across instances", async () => {
    const first = loadInstance();
    const second = loadInstance();
    const params = { sourceUserId: "source", targetUserId: "target", provider: "google" as const, providerUserId: "provider-user" };
    const old = await first.createMergePreviewSession(params);
    const current = await second.createMergePreviewSession(params);
    await expect(first.getMergePreviewByToken(old.token, "target")).rejects.toThrow("合并预览不存在或已过期");
    await expect(first.getPendingMergeSessionForUser("target", "google")).resolves.toMatchObject({ token: current.token });
  });
});
