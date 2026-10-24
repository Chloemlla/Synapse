import express, { type Express } from "express";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { RuntimeConfigService } from "../services/runtimeConfigService";
import { destroyNonceStore } from "../services/nonceStore";
import request from "supertest";
import { config } from "../config/config";
import { FEATURE_CONSENT_REQUIREMENTS, type FeatureConsentView } from "../config/featureConsent";
import { cdictWebRouteModules } from "../routes/routeModules/cdictWebModules";
import cdictRoutes from "../routes/cdictRoutes";
import { authenticateToken } from "../middleware/authenticateToken";
import { translationAccessMiddleware } from "../middleware/translationAccessMiddleware";
import { requireAllowedOriginForWrites } from "../middleware/corsMiddleware";
import { nexaiRequestSignature } from "../middleware/nexaiRequestSignature";
import { createBurstConcurrencyGuard, getBurstConcurrencySnapshot, resetBurstConcurrencyForTests } from "../middleware/routeLimiters";
import { BoundedMemoryRateLimitStore } from "../services/sharedRateLimitStore";
import { assertActiveAuthSession, touchAuthSession } from "../services/authSessionService";
import { resolveFeatureConsentViews } from "../services/policyConsentService";
import * as upstream from "../services/cdictUpstreamService";
import * as donations from "../services/cdictDonationService";
import { UserStorage, type User } from "../utils/userStorage";
import { AUTH_COOKIE_NAME } from "../utils/authCookie";

jest.mock("../utils/logger", () => ({
  __esModule: true, default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock("../utils/userStorage", () => ({ UserStorage: { getUserById: jest.fn() } }));
jest.mock("../services/authSessionService", () => ({
  ...jest.requireActual("../services/authSessionService"),
  assertActiveAuthSession: jest.fn(), touchAuthSession: jest.fn(),
}));
jest.mock("../services/policyConsentService", () => ({ resolveFeatureConsentViews: jest.fn() }));
jest.mock("../services/cdictUpstreamService", () => ({
  translateText: jest.fn(), fetchLanguageList: jest.fn(), synthesizeSpeech: jest.fn(), fetchDictionaryVoice: jest.fn(),
}));
jest.mock("../services/cdictDonationService", () => ({
  getPublicDonationConfig: jest.fn(), resolveDonationImage: jest.fn(), submitDonationClaim: jest.fn(),
}));
// Real rate middleware and real bounded memory counters, independent of CI Redis/Mongo containers.
jest.mock("../services/sharedRateLimitStore", () => {
  const actual = jest.requireActual("../services/sharedRateLimitStore");
  return { ...actual, createSharedRateLimitStore: (prefix: string, windowMs: number) =>
    new actual.BoundedMemoryRateLimitStore(prefix, windowMs) };
});

const mount = cdictWebRouteModules[0];
const prefix = "/api/translate/cdict";
const pcm = Buffer.from([0x00, 0x80, 0xff, 0x7f, 0x34, 0x12]);
const translateResult = { retcode: 0, code: 0, data: { translation: "你好", from: "en", to: "zh-CHS" } };
const endpoints = [
  ["post", "/translate", { text: "hello", to: "zh-CHS" }],
  ["get", "/languages", undefined],
  ["get", "/tts?text=hello", undefined],
  ["get", "/donate", undefined],
  ["post", "/donate/claim", { transactionId: "order123", displayName: "reader" }],
  ["get", "/donate/alipay", undefined],
] as const;

function appForWeb(): Express {
  const app = express();
  app.set("trust proxy", true);
  app.use(express.json());
  app.use(mount.path, ...(mount.middlewares || []), mount.router);
  return app;
}
function cookie(userId = "web-user"): string {
  return `${AUTH_COOKIE_NAME}=${jwt.sign({ userId }, config.jwtSecret, { expiresIn: "1h" })}`;
}
function hit(app: Express, method: "get" | "post", path: string, body?: object) {
  const call = method === "get" ? request(app).get(prefix + path) : request(app).post(prefix + path);
  return method === "post" && body ? call.send(body) : call;
}
function views(satisfied = true): FeatureConsentView[] {
  return Object.values(FEATURE_CONSENT_REQUIREMENTS).map((requirement) => ({
    key: requirement.key, label: requirement.label, category: requirement.category,
    rationale: requirement.rationale, message: requirement.message, satisfied,
    requiredAgreements: requirement.agreements, missingAgreements: satisfied ? [] : requirement.agreements,
    policyVersion: "test", expiresAt: null,
  }));
}
function expectNoBusinessCalls(): void {
  for (const mock of [upstream.translateText, upstream.fetchLanguageList, upstream.synthesizeSpeech,
    upstream.fetchDictionaryVoice, donations.getPublicDonationConfig, donations.resolveDonationImage,
    donations.submitDonationClaim]) expect(mock).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.clearAllMocks();
  BoundedMemoryRateLimitStore.resetForTests();
  resetBurstConcurrencyForTests();
  jest.mocked(UserStorage.getUserById).mockImplementation(async (id) => ({
    id, username: "web", email: "web@example.test", role: "user", accountStatus: "active",
    isTranslationEnabled: true,
  } as User));
  jest.mocked(assertActiveAuthSession).mockResolvedValue({ userAgent: "test" } as Awaited<ReturnType<typeof assertActiveAuthSession>>);
  jest.mocked(touchAuthSession).mockResolvedValue(undefined);
  jest.mocked(resolveFeatureConsentViews).mockResolvedValue(views());
  jest.mocked(upstream.translateText).mockResolvedValue(translateResult);
  jest.mocked(upstream.fetchLanguageList).mockResolvedValue([{ lang: "en", name: "English" }]);
  jest.mocked(upstream.synthesizeSpeech).mockResolvedValue({ contentType: "audio/L16; rate=16000", data: pcm });
  jest.mocked(upstream.fetchDictionaryVoice).mockResolvedValue({ contentType: "audio/mpeg", data: Buffer.from("ID3audio") });
  jest.mocked(donations.getPublicDonationConfig).mockResolvedValue({
    enabled: true, notice: "thanks", channels: [{ id: "alipay", name: "Alipay", hint: "scan" }], supporters: [],
  } as Awaited<ReturnType<typeof donations.getPublicDonationConfig>>);
  jest.mocked(donations.resolveDonationImage).mockResolvedValue({
    kind: "bundled", image: { contentType: "image/png", data: Buffer.from("png") },
  } as Awaited<ReturnType<typeof donations.resolveDonationImage>>);
  jest.mocked(donations.submitDonationClaim).mockResolvedValue({ duplicated: false } as Awaited<ReturnType<typeof donations.submitDonationClaim>>);
});

describe("website CDict mount security", () => {
  it("declares the exact private namespace and mounts real guards in order", () => {
    expect(mount.path).toBe(prefix);
    expect(mount.requiresAuth).toBe(true);
    expect(mount.isPublic).toBe(false);
    expect(mount.strictStackCheck).toBe(true);
    expect(mount.authPolicy).toEqual({ mode: "mount", handlers: ["authenticateToken", "translationAccessMiddleware"] });
    expect(mount.middlewares).toEqual(expect.arrayContaining([
      requireAllowedOriginForWrites, authenticateToken, translationAccessMiddleware,
    ]));
    expect(mount.middlewares!.indexOf(authenticateToken)).toBeLessThan(mount.middlewares!.indexOf(translationAccessMiddleware));
    expect(mount.middlewares).not.toContain(nexaiRequestSignature);
    expect(mount.securityBypass).toBeUndefined();
  });

  it.each(endpoints)("rejects unauthenticated %s %s", async (method, path, body) => {
    const res = await hit(appForWeb(), method, path, body);
    expect(res.status).toBe(401);
    expect(res.body.error).toBeTruthy();
    expect(res.body.success).not.toBe(true);
    expect(res.body.code).not.toBe(0);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expectNoBusinessCalls();
  });

  it.each(endpoints)("rejects invalid/revoked credentials on %s %s", async (method, path, body) => {
    let res = await hit(appForWeb(), method, path, body).set("Cookie", `${AUTH_COOKIE_NAME}=invalid`);
    expect(res.status).toBe(401);
    const revoked = new Error("会话不存在或已撤销");
    revoked.name = "AuthSessionError";
    jest.mocked(assertActiveAuthSession).mockRejectedValue(revoked);
    res = await hit(appForWeb(), method, path, body).set("Cookie", cookie());
    expect(res.status).toBe(401);
    expect(res.body.code).not.toBe(0);
    expectNoBusinessCalls();
  });

  const restrictions = [
    { accountStatus: "suspended" }, { disabled: true }, { isTranslationEnabled: false },
    { translationAccessUntil: new Date(Date.now() + 60 * 60_000).toISOString() },
  ];
  describe.each(restrictions)("account restrictions %j", (restriction) => {
    it.each(endpoints)("denies %s %s before any upstream or donation calls", async (method, path, body) => {
      jest.mocked(UserStorage.getUserById).mockResolvedValue({
        id: "web-user", accountStatus: "active", role: "user", ...restriction,
      } as User);
      const res = await hit(appForWeb(), method, path, body).set("Cookie", cookie());
      expect(res.status).toBe(403);
      expect(res.body.error).toBeTruthy();
      expect(res.body.code).not.toBe(0);
      expect(resolveFeatureConsentViews).not.toHaveBeenCalled();
      expectNoBusinessCalls();
    });
  });

  it.each(endpoints)("Android signature-looking headers never log in %s %s", async (method, path, body) => {
    const res = await hit(appForWeb(), method, path, body)
      .set("X-CDict-Sig-Version", "cdict-sig-v1").set("X-CDict-Install", "install-id")
      .set("X-CDict-Sig", "a".repeat(64)).set("X-CDict-Ts", String(Date.now())).set("X-CDict-Nonce", "nonce");
    expect(res.status).toBe(401);
    expectNoBusinessCalls();
  });

  it.each(endpoints)("a website cookie needs no Android signatures for %s %s", async (method, path, body) => {
    const res = await hit(appForWeb(), method, path, body).set("Cookie", cookie());
    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(assertActiveAuthSession).toHaveBeenCalled();
  });

  it("allows elapsed translation restrictions and bearer website sessions", async () => {
    jest.mocked(UserStorage.getUserById).mockResolvedValue({
      id: "web-user", role: "user", accountStatus: "active",
      translationAccessUntil: new Date(Date.now() - 60_000).toISOString(),
    } as User);
    const token = jwt.sign({ userId: "web-user" }, config.jwtSecret, { expiresIn: "1h" });
    const res = await request(appForWeb()).get(prefix + "/languages").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
  });

  it.each(["/translate", "/donate/claim"])("retains CSRF Origin and Referer checks for %s", async (path) => {
    for (const header of ["Origin", "Referer"]) {
      const res = await request(appForWeb()).post(prefix + path).set("Cookie", cookie())
        .set(header, "https://attacker.example/path").send({ text: "hello", to: "en" });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("ORIGIN_NOT_ALLOWED");
    }
    expectNoBusinessCalls();
  });

  it("allows the website origin without classifying signature headers as a trusted app", async () => {
    let classified = false;
    const app = express();
    app.use(express.json());
    app.use(prefix, ...(mount.middlewares || []), (req, _res, next) => {
      classified = Boolean(req.cdictClient);
      next();
    }, mount.router);
    const res = await request(app).post(prefix + "/translate").set("Cookie", cookie())
      .set("Origin", "https://chloemlla.com").set("X-CDict-Sig", "invalid").send({ text: "hello", to: "en" });
    expect(res.status).toBe(200);
    expect(classified).toBe(false);
  });

  it.each([["post", "/translate", "deeplx-translate"], ["get", "/tts?text=hello", "tts-generate"]] as const)
    ("requires current-user third-party consent for %s %s", async (method, path, feature) => {
      jest.mocked(resolveFeatureConsentViews).mockResolvedValue(views(false));
      const res = await hit(appForWeb(), method, path, { text: "hello", to: "en" }).set("Cookie", cookie());
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("POLICY_CONSENT_REQUIRED");
      expect(res.body.feature).toBe(feature);
      expect(resolveFeatureConsentViews).toHaveBeenCalledWith("web-user", expect.any(String));
      expectNoBusinessCalls();
    });
});

describe("website CDict delegation and validation", () => {
  it("preserves raw translation structure, original text and the auto source default", async () => {
    const res = await request(appForWeb()).post(prefix + "/translate").set("Cookie", cookie())
      .send({ text: ["hello", "world"], to: "zh-CHS" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, ...translateResult });
    expect(upstream.translateText).toHaveBeenCalledWith({ text: "hello\nworld", from: "auto", to: "zh-CHS" });
    expect(res.headers["cache-control"]).toBe("private, no-store");
  });
  it.each([
    [{ text: "", to: "en" }, 400], [{ text: "x".repeat(5001), to: "en" }, 413],
    [{ text: "hello", to: "bad code" }, 400], [{ text: "hello", from: "../en", to: "en" }, 400],
  ])("rejects invalid translation arguments %j", async (body, status) => {
    const res = await request(appForWeb()).post(prefix + "/translate").set("Cookie", cookie()).send(body);
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(status);
    expect(upstream.translateText).not.toHaveBeenCalled();
  });
  it("accepts the exact 5000-character translation limit", async () => {
    const res = await request(appForWeb()).post(prefix + "/translate").set("Cookie", cookie()).send({ text: "x".repeat(5000), to: "en" });
    expect(res.status).toBe(200);
    expect(upstream.translateText).toHaveBeenCalledTimes(1);
  });
  it.each([
    [["en", "zh-CHS"], ["en", "zh-CHS"]],
    [{ code: 0, data: { langs: ["en"], expire: "3600" } }, { success: true, code: 0, data: { langs: ["en"], expire: "3600" }, languages: ["en"] }],
  ])("preserves successful language variants and adds a legacy alias %j", async (upstreamResult, expected) => {
    jest.mocked(upstream.fetchLanguageList).mockResolvedValue(upstreamResult);
    const res = await request(appForWeb()).get(prefix + "/languages").set("Cookie", cookie());
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expected);
  });
  it.each([
    [], { code: 0, data: { en: "English" } },
    { success: true, code: 20000, data: null, msg: "参数非法", requestId: null, serviceRegion: "asia" },
    { retcode: 10000, code: 0, data: { langs: ["en"] } },
  ].map((payload) => ({ payload }))) ("never reports success for invalid or failed language results %j", async ({ payload }) => {
    jest.mocked(upstream.fetchLanguageList).mockResolvedValue(payload);
    const res = await request(appForWeb()).get(prefix + "/languages").set("Cookie", cookie());
    expect(res.status).toBe(502);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe(502);
    expect(res.body.languages).toBeUndefined();
    expect(res.headers["cache-control"]).toBe("private, no-store");
  });
  it.each(["/translate", "/languages", "/tts?text=hello"])("returns nonzero upstream errors for %s", async (path) => {
    jest.mocked(upstream.translateText).mockRejectedValue(new Error("upstream unavailable"));
    jest.mocked(upstream.fetchLanguageList).mockRejectedValue(new Error("upstream unavailable"));
    jest.mocked(upstream.synthesizeSpeech).mockRejectedValue(new Error("upstream unavailable"));
    const method = path === "/translate" ? "post" : "get";
    const res = await hit(appForWeb(), method, path, { text: "hello", to: "en" }).set("Cookie", cookie());
    expect(res.status).toBe(502);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe(502);
    expect(res.headers["cache-control"]).toBe("private, no-store");
  });
  it("delegates claims and public donation config to the existing service", async () => {
    const app = appForWeb();
    const channels = await request(app).get(prefix + "/donate").set("Cookie", cookie());
    expect(channels.body).toEqual({ success: true, notice: "thanks", channels: [{ id: "alipay", name: "Alipay", hint: "scan" }], supporters: [] });
    const body = { transactionId: "order123", displayName: "reader" };
    const claim = await request(app).post(prefix + "/donate/claim").set("Cookie", cookie()).send(body);
    expect(claim.status).toBe(200);
    expect(donations.submitDonationClaim).toHaveBeenCalledWith(body);
    jest.mocked(donations.submitDonationClaim).mockRejectedValue(new Error("invalid claim"));
    const rejected = await request(app).post(prefix + "/donate/claim").set("Cookie", cookie()).send({});
    expect(rejected.status).toBe(400);
    expect(rejected.body.code).toBe(400);
  });
  it("returns a validated external image URL, not a security-header-leaking redirect", async () => {
    jest.mocked(donations.resolveDonationImage).mockResolvedValue({ kind: "redirect", url: "https://images.example.test/qr.png" });
    const res = await request(appForWeb()).get(prefix + "/donate/alipay").set("Cookie", cookie());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, imageUrl: "https://images.example.test/qr.png" });
    expect(res.headers.location).toBeUndefined();
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(donations.resolveDonationImage).toHaveBeenCalledWith("alipay");
  });
  it.each(["http://images.example.test/qr.png", "https://user:password@images.example.test/qr.png"])
    ("rejects unsuitable website image URL %s", async (url) => {
      jest.mocked(donations.resolveDonationImage).mockResolvedValue({ kind: "redirect", url });
      const res = await request(appForWeb()).get(prefix + "/donate/alipay").set("Cookie", cookie());
      expect(res.status).toBe(404);
      expect(res.headers.location).toBeUndefined();
      expect(res.body.imageUrl).toBeUndefined();
    });
});

describe("website CDict speech and Android isolation", () => {
  it("returns a RIFF/WAVE container with 16-bit mono 16kHz PCM and unchanged signed samples", async () => {
    const res = await request(appForWeb()).get(prefix + "/tts?text=hello").set("Cookie", cookie());
    const data = res.body as Buffer;
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^audio\/wav/);
    expect(upstream.synthesizeSpeech).toHaveBeenCalledWith("hello", "en-USA");
    expect(data.toString("ascii", 0, 4)).toBe("RIFF");
    expect(data.readUInt32LE(4)).toBe(pcm.length + 36);
    expect(data.toString("ascii", 8, 12)).toBe("WAVE");
    expect(data.toString("ascii", 12, 16)).toBe("fmt ");
    expect(data.readUInt32LE(16)).toBe(16);
    expect(data.readUInt16LE(20)).toBe(1);
    expect(data.readUInt16LE(22)).toBe(1);
    expect(data.readUInt32LE(24)).toBe(16000);
    expect(data.readUInt32LE(28)).toBe(32000);
    expect(data.readUInt16LE(32)).toBe(2);
    expect(data.readUInt16LE(34)).toBe(16);
    expect(data.toString("ascii", 36, 40)).toBe("data");
    expect(data.readUInt32LE(40)).toBe(pcm.length);
    expect(data.subarray(44)).toEqual(pcm);
    expect(data.readInt16LE(44)).toBe(-32768);
    expect(data.readInt16LE(46)).toBe(32767);
    expect(pcm).toEqual(Buffer.from([0x00, 0x80, 0xff, 0x7f, 0x34, 0x12]));
  });
  it.each(["audio/mpeg", "audio/wav"])("preserves already-containerized %s audio", async (contentType) => {
    const data = Buffer.from(contentType === "audio/mpeg" ? "ID3audio" : "RIFF\u0000\u0000\u0000\u0000WAVEdata");
    jest.mocked(upstream.synthesizeSpeech).mockResolvedValue({ contentType, data });
    const res = await request(appForWeb()).get(prefix + "/tts?text=hello&langType=zh-CHS").set("Cookie", cookie());
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain(contentType);
    expect(res.body).toEqual(data);
    expect(upstream.synthesizeSpeech).toHaveBeenCalledWith("hello", "zh-CHS");
    expect(res.headers["cache-control"]).toBe("private, no-store");
  });
  it("delegates dictionary British/American speech without converting its MP3", async () => {
    for (const type of [1, 2]) {
      const res = await request(appForWeb()).get(prefix + `/tts?text=hello&source=youdao&type=${type}`).set("Cookie", cookie());
      expect(res.status).toBe(200);
      expect(res.body).toEqual(Buffer.from("ID3audio"));
      expect(upstream.fetchDictionaryVoice).toHaveBeenCalledWith("hello", type);
    }
    expect(upstream.synthesizeSpeech).not.toHaveBeenCalled();
  });
  it.each([
    ["", 400], ["?text=", 400], [`?text=${"x".repeat(301)}`, 413],
    ["?text=hello&source=other", 400], ["?text=hello&langType=bad_code", 400],
    ["?text=hello&source=youdao&type=3", 400], ["?text=hello&source=youdao&type=2junk", 400],
  ])("rejects speech arguments %s", async (query, status) => {
    const res = await request(appForWeb()).get(prefix + "/tts" + query).set("Cookie", cookie());
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(status);
    expect(upstream.synthesizeSpeech).not.toHaveBeenCalled();
    expect(upstream.fetchDictionaryVoice).not.toHaveBeenCalled();
  });
  it("accepts the exact 300-character speech limit", async () => {
    const res = await request(appForWeb()).get(prefix + "/tts?text=" + "x".repeat(300)).set("Cookie", cookie());
    expect(res.status).toBe(200);
  });
  it.each([
    { contentType: "audio/L16; rate=16000", data: Buffer.from([1]) },
    { contentType: "audio/L16; rate=44100", data: pcm },
    { contentType: "audio/L16; rate=16000; channels=2", data: pcm },
    { contentType: "audio/L16; rate=16000", data: Buffer.alloc(0) },
  ])("fails closed for malformed/unsupported PCM %j", async (audio) => {
    jest.mocked(upstream.synthesizeSpeech).mockResolvedValue(audio);
    const res = await request(appForWeb()).get(prefix + "/tts?text=hello").set("Cookie", cookie());
    expect(res.status).toBe(502);
    expect(res.body.code).toBe(502);
  });
  it("does not cache private text/audio across requests", async () => {
    const app = appForWeb();
    for (let i = 0; i < 2; i++) {
      const res = await request(app).get(prefix + "/tts?text=private").set("Cookie", cookie());
      expect(res.headers["cache-control"]).toBe("private, no-store");
    }
    expect(upstream.synthesizeSpeech).toHaveBeenCalledTimes(2);
  });
  it("keeps Android PCM bytes, public cache, anonymous routing and image redirects unchanged", async () => {
    const android = express();
    android.use(express.json());
    android.use("/api/cdict", cdictRoutes);
    const audio = await request(android).get("/api/cdict/tts?text=hello");
    expect(audio.status).toBe(200);
    expect(audio.headers["content-type"]).toMatch(/^audio\/L16/i);
    expect(audio.headers["cache-control"]).toBe("public, max-age=86400");
    expect(audio.body).toEqual(pcm);
    const languages = await request(android).get("/api/cdict/languages");
    expect(languages.status).toBe(200);
    expect(assertActiveAuthSession).not.toHaveBeenCalled();
    expect(resolveFeatureConsentViews).not.toHaveBeenCalled();
    jest.mocked(donations.resolveDonationImage).mockResolvedValue({ kind: "redirect", url: "https://images.example.test/qr.png" });
    const image = await request(android).get("/api/cdict/donate/alipay");
    expect(image.status).toBe(302);
    expect(image.headers.location).toBe("https://images.example.test/qr.png");
    expect(image.headers["cache-control"]).toBe("public, max-age=300");
  });
});

describe("website CDict real rate and upstream burst protection", () => {
  it("preserves the shared guard's default exemption for other locally classified routes", () => {
    const guard = createBurstConcurrencyGuard({ name: "legacy-local-exemption", maxConcurrent: 1, methods: ["GET"] });
    const appRequest = { method: "GET", isLocalIp: true } as Parameters<typeof guard>[0];
    const appResponse = {} as Parameters<typeof guard>[1];
    const next = jest.fn();
    guard(appRequest, appResponse, next);
    guard(appRequest, appResponse, next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(getBurstConcurrencySnapshot().totalActive).toBe(0);
  });

  it("keeps a user quota when the same session rotates IP and Android headers", async () => {
    const app = appForWeb();
    for (let i = 0; i < 30; i++) {
      const res = await request(app).get(prefix + "/tts?text=hello").set("Cookie", cookie())
        .set("X-Forwarded-For", `203.0.113.${i + 1}`).set("X-CDict-Install", `install-${i}`);
      expect(res.status).toBe(200);
    }
    const limited = await request(app).get(prefix + "/tts?text=hello").set("Cookie", cookie())
      .set("X-Forwarded-For", "198.51.100.90").set("X-CDict-Install", "new-install");
    expect(limited.status).toBe(429);
    expect(upstream.synthesizeSpeech).toHaveBeenCalledTimes(30);
    expect(limited.headers["cache-control"]).toBe("private, no-store");
  });
  it("retains the upstream IP ceiling even when sessions/accounts rotate", async () => {
    const app = appForWeb();
    for (let i = 0; i < 60; i++) {
      const res = await request(app).get(prefix + "/tts?text=hello").set("Cookie", cookie(`user-${i}`))
        .set("X-Forwarded-For", "203.0.113.50");
      expect(res.status).toBe(200);
    }
    const limited = await request(app).get(prefix + "/tts?text=hello").set("Cookie", cookie("next-user"))
      .set("X-Forwarded-For", "203.0.113.50");
    expect(limited.status).toBe(429);
    expect(upstream.synthesizeSpeech).toHaveBeenCalledTimes(60);
  });
  it("does not grant a superadmin or locally classified request unlimited usage", async () => {
    jest.mocked(UserStorage.getUserById).mockResolvedValue({ id: "web-user", role: "superadmin", accountStatus: "active" } as User);
    const app = express();
    app.use((req, _res, next) => { req.isLocalIp = true; next(); });
    app.use(prefix, ...(mount.middlewares || []), mount.router);
    for (let i = 0; i < 30; i++) {
      const res = await request(app).get(prefix + "/tts?text=hello").set("Cookie", cookie());
      expect(res.status).toBe(200);
    }
    const res = await request(app).get(prefix + "/tts?text=hello").set("Cookie", cookie());
    expect(res.status).toBe(429);
  });
  it("enforces the website burst ceiling even for locally classified sessions", async () => {
    const app = express();
    app.use((req, _res, next) => { req.isLocalIp = true; next(); });
    app.use(prefix, ...(mount.middlewares || []), mount.router);
    const release: Array<() => void> = [];
    let markArrived: () => void = () => undefined;
    const arrived = new Promise<void>((resolve) => { markArrived = resolve; });
    jest.mocked(upstream.synthesizeSpeech).mockImplementation(() => new Promise((resolve) => {
      release.push(() => resolve({ contentType: "audio/L16; rate=16000", data: pcm }));
      if (release.length === 3) markArrived();
    }));
    const pending = Array.from({ length: 3 }, () => request(app).get(prefix + "/tts?text=hello")
      .set("Cookie", cookie()).then((res) => res));
    try {
      await arrived;
      const limited = await request(app).get(prefix + "/tts?text=hello").set("Cookie", cookie()).timeout(5000);
      expect(limited.status).toBe(429);
      expect(limited.body.code).toBe("BURST_CONCURRENCY_LIMIT");
      expect(upstream.synthesizeSpeech).toHaveBeenCalledTimes(3);
    } finally {
      release.forEach((resolve) => resolve());
      await Promise.all(pending);
    }
    expect(getBurstConcurrencySnapshot().totalActive).toBe(0);
  });
  it("caps concurrent GET speech by account across IPs and releases all slots on finish", async () => {
    const app = appForWeb();
    const release: Array<() => void> = [];
    let markArrived: () => void = () => undefined;
    const arrived = new Promise<void>((resolve) => { markArrived = resolve; });
    jest.mocked(upstream.synthesizeSpeech).mockImplementation(() => new Promise((resolve) => {
      release.push(() => resolve({ contentType: "audio/L16; rate=16000", data: pcm }));
      if (release.length === 3) markArrived();
    }));
    const pending = Array.from({ length: 3 }, (_, i) => request(app).get(prefix + "/tts?text=hello")
      .set("Cookie", cookie()).set("X-Forwarded-For", `203.0.113.${i + 1}`).then((res) => res));
    try {
      await arrived;
      const limited = await request(app).get(prefix + "/tts?text=hello").set("Cookie", cookie())
        .set("X-Forwarded-For", "198.51.100.5");
      expect(limited.status).toBe(429);
      expect(limited.body.code).toBe("BURST_CONCURRENCY_LIMIT");
      expect(limited.headers["retry-after"]).toBe("2");
      expect(upstream.synthesizeSpeech).toHaveBeenCalledTimes(3);
      expect(getBurstConcurrencySnapshot().guards["cdict-web-upstream-user-burst"].active).toBe(3);
    } finally {
      release.forEach((resolve) => resolve());
      await Promise.all(pending);
    }
    expect(getBurstConcurrencySnapshot().totalActive).toBe(0);
  });
});

it("a genuinely valid Android signature still cannot replace a website login", async () => {
  const secret = "cdict-test-app-secret";
  const base = RuntimeConfigService.getCachedConfig();
  jest.spyOn(RuntimeConfigService, "getCachedConfig").mockReturnValue({
    ...base, cdictSigning: { ...base.cdictSigning, mode: "enforce", appSignSecret: secret, appSignSecretPrev: "", maxDriftMs: 300000 },
  });
  const headers = (path: string) => {
    const ts = String(Date.now());
    const nonce = crypto.randomBytes(16).toString("hex");
    const install = "cdict-test-install";
    const signature = crypto.createHmac("sha256", secret).update([ts, nonce, install, "GET", path, ""].join("\n")).digest("hex");
    return { "X-CDict-Sig-Version": "1", "X-CDict-Ts": ts, "X-CDict-Nonce": nonce, "X-CDict-Install": install, "X-CDict-Sig": signature };
  };
  const android = express();
  android.use("/api/cdict", nexaiRequestSignature, cdictRoutes);
  const valid = await request(android).get("/api/cdict/languages").set(headers("/api/cdict/languages"));
  expect(valid.status).toBe(200);
  expect(valid.headers["x-cdict-sig-result"]).toBe("ok");
  const web = await request(appForWeb()).get(prefix + "/languages").set(headers(prefix + "/languages"));
  expect(web.status).toBe(401);
  expect(upstream.fetchLanguageList).toHaveBeenCalledTimes(1);
  expect(UserStorage.getUserById).not.toHaveBeenCalled();
});

afterAll(() => destroyNonceStore("cdict-sig-v1"));

it.each([
  [6, "cdict-web-upstream-ip-burst", true],
  [24, "cdict-web-upstream-global-burst", false],
] as const)("caps %i concurrent speech requests with %s", async (maximum, guardName, sameIp) => {
  const app = appForWeb();
  const release: Array<() => void> = [];
  let markArrived: () => void = () => undefined;
  const arrived = new Promise<void>((resolve) => { markArrived = resolve; });
  jest.mocked(upstream.synthesizeSpeech).mockImplementation(() => new Promise((resolve) => {
    release.push(() => resolve({ contentType: "audio/L16; rate=16000", data: pcm }));
    if (release.length === maximum) markArrived();
  }));
  const pending = Array.from({ length: maximum }, (_, i) => request(app).get(prefix + "/tts?text=hello")
    .set("Cookie", cookie(`user-${i}`)).set("X-Forwarded-For", sameIp ? "203.0.113.90" : `203.0.113.${i + 1}`)
    .then((res) => res));
  try {
    await arrived;
    const limited = await request(app).get(prefix + "/tts?text=hello").set("Cookie", cookie("next-user"))
      .set("X-Forwarded-For", sameIp ? "203.0.113.90" : "198.51.100.90");
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("BURST_CONCURRENCY_LIMIT");
    expect(upstream.synthesizeSpeech).toHaveBeenCalledTimes(maximum);
    expect(getBurstConcurrencySnapshot().guards[guardName].active).toBe(maximum);
  } finally {
    release.forEach((resolve) => resolve());
    await Promise.all(pending);
  }
  expect(getBurstConcurrencySnapshot().totalActive).toBe(0);
});
