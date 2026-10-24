const mockRead = jest.fn();
const mockWrite = jest.fn();
const mockDelete = jest.fn();
const mockFind = jest.fn();
jest.mock("../services/mongoService", () => ({ mongoose: { connection: { readyState: 1 } } }));
jest.mock("../models/runtimeConfigModel", () => ({ RuntimeConfigModel: {
  findOne: (...args: unknown[]) => mockRead(...args),
  findOneAndUpdate: (...args: unknown[]) => mockWrite(...args),
  deleteOne: (...args: unknown[]) => mockDelete(...args),
  find: (...args: unknown[]) => mockFind(...args),
} }));
jest.mock("../utils/ssrfGuard", () => ({ ...jest.requireActual("../utils/ssrfGuard"), validatePublicUrl: jest.fn(async () => ({ ok: true })) }));
jest.mock("../utils/logger", () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import { RuntimeConfigService } from "../services/runtimeConfigService";
import { buildCdictUpstreamDefaultsFromEnv, CDICT_UPSTREAM_DEFAULTS, normalizeStoredCdictUpstreamConfig } from "../config/cdictUpstreamConfig";
import { cloneRuntimeConfigDefaults } from "../config/runtimeConfigDefaults";
import { validatePublicUrl } from "../utils/ssrfGuard";
import { isSensitiveAuditField } from "../utils/auditRedaction";

type Stored = { key: string; value: Record<string, unknown>; updatedAt: Date };
const store = new Map<string, Stored>();
const original = cloneRuntimeConfigDefaults(RuntimeConfigService.getCachedConfig());
const deployment = buildCdictUpstreamDefaultsFromEnv({
  VIVO_TRANSLATE_BASE_URL: "https://translate.example.com/base",
  VIVO_TRANSLATE_APP_ID: "env-translate-id",
  VIVO_TTS_URL: "https://speech.example.com/tts",
  VIVO_TTS_APP_ID: "env-speech-id",
  VIVO_TTS_APP_KEY: "synthetic-env-key",
});

beforeAll(() => { jest.useFakeTimers(); });
beforeEach(async () => {
  jest.clearAllMocks();
  store.clear();
  jest.mocked(validatePublicUrl).mockResolvedValue({ ok: true });
  mockRead.mockImplementation(({ key }) => ({ lean: () => ({ exec: async () => store.get(key) || null }) }));
  mockFind.mockImplementation(() => ({ lean: () => ({ exec: async () => [...store.values()] }) }));
  mockDelete.mockImplementation(({ key }) => ({ exec: async () => { store.delete(key); return { deletedCount: 1 }; } }));
  mockWrite.mockImplementation((filter, update) => ({ exec: async () => {
    const previous = store.get(filter.key);
    if (filter.updatedAt && previous?.updatedAt.getTime() !== filter.updatedAt.getTime()) return null;
    const doc = { key: filter.key, ...update };
    store.set(filter.key, doc);
    return doc;
  } }));
  const defaults = cloneRuntimeConfigDefaults(original);
  defaults.cdictUpstream = { ...deployment };
  RuntimeConfigService.configureDefaults(defaults);
  await RuntimeConfigService.initialize(true);
});
afterAll(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  RuntimeConfigService.configureDefaults(original);
});

it("captures all five env defaults and masks GET without mutating the live cache", async () => {
  expect(RuntimeConfigService.getCachedConfig().cdictUpstream).toEqual(deployment);
  const { setting } = await RuntimeConfigService.getCdictUpstreamSetting();
  expect(setting.config).toEqual({ ...deployment, ttsAppKey: "********", hasTtsAppKey: true });
  expect(JSON.stringify(setting)).not.toContain(deployment.ttsAppKey);
  expect(RuntimeConfigService.getCachedConfig().cdictUpstream.ttsAppKey).toBe(deployment.ttsAppKey);
  expect(CDICT_UPSTREAM_DEFAULTS.ttsAppKey).toBe("");
  expect(buildCdictUpstreamDefaultsFromEnv({})).toEqual(CDICT_UPSTREAM_DEFAULTS);
});

it("persists replacement values, hot-applies them, and reloads them through the shared key list", async () => {
  const next = { translateBaseUrl: "https://new.example.com/gateway", translateAppId: "new-id",
    ttsUrl: "https://new.example.com/speech", ttsAppId: "new-tts", ttsAppKey: "short-valid-key" };
  const signing = { ...RuntimeConfigService.getCachedConfig().cdictSigning };
  const result = await RuntimeConfigService.setCdictUpstreamSetting(next);
  expect(result.updatedAt).toBeTruthy();
  expect(store.get("CDICT_UPSTREAM")!.value).toEqual(next);
  expect(RuntimeConfigService.getCachedConfig().cdictUpstream).toEqual(next);
  const defaults = cloneRuntimeConfigDefaults(original);
  defaults.cdictUpstream = { ...deployment };
  RuntimeConfigService.configureDefaults(defaults);
  expect(RuntimeConfigService.getCachedConfig().cdictUpstream).toEqual(next); // loaded key not overwritten
  RuntimeConfigService.getCachedConfig().cdictUpstream = { ...deployment };
  await RuntimeConfigService.initialize(true);
  expect(mockFind.mock.calls.at(-1)![0].key.$in).toContain("CDICT_UPSTREAM");
  expect(RuntimeConfigService.getCachedConfig().cdictUpstream).toEqual(next);
  expect(RuntimeConfigService.getCachedConfig().cdictSigning).toEqual(signing);
  expect(store.has("CDICT_SIGNING")).toBe(false);
  expect(store.has("CDICT_DONATION")).toBe(false);
});

it("preserves omitted/blank key, clears explicitly across reload, and DELETE restores deployment env", async () => {
  await RuntimeConfigService.setCdictUpstreamSetting({ translateAppId: "edited" });
  await RuntimeConfigService.setCdictUpstreamSetting({ ttsAppKey: "   ", ttsAppId: "edited-tts" });
  expect(store.get("CDICT_UPSTREAM")!.value.ttsAppKey).toBe(deployment.ttsAppKey);
  await RuntimeConfigService.setCdictUpstreamSetting({ clearTtsAppKey: true, ttsAppKey: "" });
  expect(store.get("CDICT_UPSTREAM")!.value.ttsAppKey).toBe("");
  await RuntimeConfigService.initialize(true);
  expect(RuntimeConfigService.getCachedConfig().cdictUpstream.ttsAppKey).toBe("");
  expect((await RuntimeConfigService.getCdictUpstreamSetting()).setting.config).toMatchObject({ ttsAppKey: "", hasTtsAppKey: false });
  await RuntimeConfigService.setCdictUpstreamSetting({ ttsAppKey: "" });
  expect(RuntimeConfigService.getCachedConfig().cdictUpstream.ttsAppKey).toBe("");
  await RuntimeConfigService.deleteCdictUpstreamSetting();
  expect(mockDelete).toHaveBeenCalledWith({ key: "CDICT_UPSTREAM" });
  expect(store.has("CDICT_UPSTREAM")).toBe(false);
  expect(RuntimeConfigService.getCachedConfig().cdictUpstream).toEqual(deployment);
  await RuntimeConfigService.initialize(true);
  expect(RuntimeConfigService.getCachedConfig().cdictUpstream).toEqual(deployment);
});

it("converges to another instance's update/deletion on refresh without reviving deleted overrides", async () => {
  store.set("CDICT_UPSTREAM", { key: "CDICT_UPSTREAM", value: { ...deployment, translateAppId: "other-instance", ttsAppKey: "" }, updatedAt: new Date() });
  await RuntimeConfigService.initialize(true);
  expect(RuntimeConfigService.getCachedConfig().cdictUpstream.translateAppId).toBe("other-instance");
  expect(RuntimeConfigService.getCachedConfig().cdictUpstream.ttsAppKey).toBe("");
  store.delete("CDICT_UPSTREAM");
  await RuntimeConfigService.initialize(true);
  expect(RuntimeConfigService.getCachedConfig().cdictUpstream).toEqual(deployment);
  RuntimeConfigService.getCachedConfig().cdictUpstream.translateAppId = "mutated-cache";
  await RuntimeConfigService.initialize(true);
  expect(RuntimeConfigService.getCachedConfig().cdictUpstream).toEqual(deployment); // defaults cloned, not aliased
});

it.each(["********", "ab***cd", "••••", "[redacted]", "masked"])("rejects display placeholder %s instead of persisting it", async (ttsAppKey) => {
  await expect(RuntimeConfigService.setCdictUpstreamSetting({ ttsAppKey })).rejects.toThrow("掩码占位符");
  expect(mockWrite).not.toHaveBeenCalled();
});

it.each([
  { ttsAppKey: "test\nkey" }, { ttsAppKey: "x".repeat(2049) }, { ttsAppKey: 123 }, { clearTtsAppKey: "true" },
  { translateAppId: "" }, { ttsAppId: "x\u0000y" }, { translateBaseUrl: "http://example.com" },
  { ttsUrl: "https://127.1/tts" }, { ttsUrl: "https://[::1]/tts" },
  { ttsUrl: "https://user:secret@example.com" }, { ttsUrl: "https://example.com/#fragment" },
  { translateBaseUrl: "https://example.com/?key=secret" },
])("rejects malformed settings %j before persistence", async (input) => {
  await expect(RuntimeConfigService.setCdictUpstreamSetting(input)).rejects.toThrow();
  expect(mockWrite).not.toHaveBeenCalled();
});

it("refuses DNS resolving to internal targets and keeps previous cache on storage failure", async () => {
  jest.mocked(validatePublicUrl).mockResolvedValueOnce({ ok: false, error: "private" });
  await expect(RuntimeConfigService.setCdictUpstreamSetting({ translateBaseUrl: "https://rebind.example.com" })).rejects.toThrow("公网");
  expect(mockWrite).not.toHaveBeenCalled();
  mockWrite.mockReturnValueOnce({ exec: async () => { throw new Error("Mongo rejected new-synthetic-key"); } });
  await expect(RuntimeConfigService.setCdictUpstreamSetting({ ttsAppKey: "new-synthetic-key" })).rejects.not.toThrow("new-synthetic-key");
  expect(RuntimeConfigService.getCachedConfig().cdictUpstream).toEqual(deployment);
});

it("uses current persisted version for compare-and-swap writes", async () => {
  await RuntimeConfigService.setCdictUpstreamSetting({ ttsAppId: "first" });
  const version = store.get("CDICT_UPSTREAM")!.updatedAt;
  await RuntimeConfigService.setCdictUpstreamSetting({ translateAppId: "second" });
  expect(mockWrite.mock.calls.at(-1)![0]).toEqual({ key: "CDICT_UPSTREAM", updatedAt: version });
});

it("normalizes old partial documents but never revives empty/corrupt stored TTS keys", () => {
  expect(normalizeStoredCdictUpstreamConfig({ translateAppId: "legacy" }, deployment)).toEqual({ ...deployment, translateAppId: "legacy" });
  expect(normalizeStoredCdictUpstreamConfig({ ttsAppKey: "" }, deployment).ttsAppKey).toBe("");
  expect(normalizeStoredCdictUpstreamConfig({ ttsAppKey: "********" }, deployment).ttsAppKey).toBe("");
});

it.each(["ttsAppKey", "tts_app_key", "VIVO_TTS_APP_KEY", "vivo-tts-app-key"])("redacts secret audit field %s, but not hasTtsAppKey metadata", (field) => {
  expect(isSensitiveAuditField(field)).toBe(true);
  expect(isSensitiveAuditField("hasTtsAppKey")).toBe(false);
});
