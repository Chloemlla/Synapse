jest.mock("../services/mongoService", () => ({ mongoose: require("mongoose"), isConnected: () => true }));
jest.mock("../utils/logger", () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock("../models/mediaToolModels", () => ({ MediaToolCookiesModel: { findOne: jest.fn(), updateOne: jest.fn() } }));

import { buildLumenConfigFromEnv } from "../config/lumen";
import { isLocalCaptchaIp } from "../services/turnstile/localIp";
import { readCaptchaKey, writeCaptchaKey } from "../services/turnstile/keyStorage";
import { encryptMediaCookies, decryptMediaCookies } from "../models/mediaToolCookiesCrypto";
import { createMongoMediaCookiesStore } from "../mediaTool/biliCookies";
import { MediaToolCookiesModel } from "../models/mediaToolModels";

it.each(["ture", "flase", "treu"])("rejects misspelled security flags: %s", (value) => {
  const previous = process.env.LUMEN_ACCEPT_UNVERIFIED_PURCHASES;
  process.env.LUMEN_ACCEPT_UNVERIFIED_PURCHASES = value;
  try { expect(() => buildLumenConfigFromEnv()).toThrow("Invalid Lumen boolean"); }
  finally {
    if (previous === undefined) delete process.env.LUMEN_ACCEPT_UNVERIFIED_PURCHASES;
    else process.env.LUMEN_ACCEPT_UNVERIFIED_PURCHASES = previous;
  }
});

it.each(["172.15.255.255", "172.32.0.1", "172.0.0.1", "172.999.0.1"])("keeps %s out of private-IP relaxation", (ip) => {
  expect(isLocalCaptchaIp(ip)).toBe(false);
});

it.each(["172.16.0.1", "172.31.255.255", "::ffff:127.0.0.1", "10.0.0.1"])("recognizes private/loopback %s", (ip) => {
  expect(isLocalCaptchaIp(ip)).toBe(true);
});

function query(value: unknown) {
  const chain: any = { exec: jest.fn(async () => value), lean: () => chain, select: () => chain, sort: jest.fn(() => chain) };
  return chain;
}

it("serializes new key writes using a stable primary key and retries only duplicate-key failures", async () => {
  const model = { updateOne: jest.fn() };
  model.updateOne.mockReturnValueOnce({ exec: async () => { throw { code: 11000 }; } }).mockReturnValue(query({ matchedCount: 1 }));
  await writeCaptchaKey(model as any, "CAP_SECRET_KEY", "first");
  await writeCaptchaKey(model as any, "CAP_SECRET_KEY", "second");
  const ids = model.updateOne.mock.calls.map(([filter]) => String(filter._id));
  expect(new Set(ids).size).toBe(1);
  expect(model.updateOne.mock.calls[1]).toHaveLength(2);
});

it("reads legacy configuration deterministically until a canonical row is saved", async () => {
  const legacy = query({ value: " legacy-value " });
  const model = { findOne: jest.fn().mockReturnValueOnce(query(null)).mockReturnValueOnce(legacy) };
  await expect(readCaptchaKey(model as any, "CAP_SITE_KEY")).resolves.toBe("legacy-value");
  expect(legacy.sort).toHaveBeenCalledWith({ updatedAt: -1, _id: -1 });
});

it("falls back to env when Mongo fails without logging the credential", async () => {
  const old = process.env.HCAPTCHA_SECRET_KEY;
  process.env.HCAPTCHA_SECRET_KEY = "private-test-secret";
  const model = { findOne: () => ({ lean: () => ({ exec: async () => { throw new Error("unavailable"); } }) }) };
  try {
    await expect(readCaptchaKey(model as any, "HCAPTCHA_SECRET_KEY")).resolves.toBe("private-test-secret");
    const logger = require("../utils/logger").default;
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain("private-test-secret");
    expect(logger.info).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ source: "env", databaseState: "error" }));
  } finally {
    if (old === undefined) delete process.env.HCAPTCHA_SECRET_KEY;
    else process.env.HCAPTCHA_SECRET_KEY = old;
  }
});

it("encrypts cookies with authenticated encryption and rejects a modified tag", () => {
  const plaintext = ".bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\tprivate-cookie";
  const encrypted = encryptMediaCookies(plaintext);
  expect(JSON.stringify(encrypted)).not.toContain("private-cookie");
  expect(decryptMediaCookies(encrypted)).toBe(plaintext);
  expect(() => decryptMediaCookies({ ...encrypted, credentialTag: Buffer.alloc(16).toString("base64") })).toThrow();
});

it("migrates a legacy cookie on read without overwriting a concurrent replacement", async () => {
  const model = MediaToolCookiesModel as any;
  model.findOne.mockReturnValue(query({ _id: "legacy", content: "private-cookie" }));
  model.updateOne.mockReturnValue(query({ matchedCount: 1 }));
  await expect(createMongoMediaCookiesStore().read()).resolves.toBe("private-cookie");
  const [filter, update] = model.updateOne.mock.calls[0];
  expect(filter).toEqual({ _id: "legacy", content: "private-cookie", credentialCiphertext: { $exists: false } });
  expect(update.$unset).toEqual({ content: "" });
  expect(decryptMediaCookies(update.$set)).toBe("private-cookie");
});
