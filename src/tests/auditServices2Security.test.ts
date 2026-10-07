import crypto from "node:crypto";
import axios from "axios";
import { ShortUrlService } from "../services/shortUrlService";
import { createLinuxDoCreditRecharge } from "../services/linuxDoCreditService";

jest.mock("axios");
jest.mock("../services/mongoService", () => ({ mongoose: jest.requireActual("mongoose") }));
jest.mock("../services/transactionService", () => ({ TransactionService: {} }));
jest.mock("../services/shortUrlMigrationService", () => ({ shortUrlMigrationService: {} }));
jest.mock("../models/shortUrlModel", () => ({ __esModule: true, default: {
  countDocuments: async () => 1,
  find: () => ({ sort: () => ({ select: () => ({ lean: () => ({ cursor: async function* () {
    yield { code: "abc", target: "https://private.example.com", createdAt: new Date() };
  } }) }) }) }),
} }));
jest.mock("../models/linuxDoCreditOrderModel", () => ({ LinuxDoCreditOrderModel: { create: async () => ({}) } }));
jest.mock("../models/apiKeyModel", () => ({ ApiKeyModel: { findOne: () => ({ lean: async () => ({ userId: "u", billingMode: "prepaid" }) }) } }));
jest.mock("../services/apiKeyBillingService", () => ({}));
jest.mock("../config/config", () => ({ config: {
  baseUrl: "https://example.com", frontendBaseUrl: "https://example.com",
  linuxdoCredit: { enabled: true, protocol: "epay", pid: "test", key: "test-key", gatewayBase: "https://credit.linux.do", creditRate: 1, maxMoney: 100 },
} }));
jest.mock("../utils/logger", () => ({ __esModule: true, default: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

afterEach(() => jest.restoreAllMocks());

it("rejects an export when encryption fails instead of returning its plaintext", async () => {
  jest.spyOn(ShortUrlService as any, "getCachedAesKey").mockResolvedValue("test-key-for-export");
  jest.spyOn(crypto, "createCipheriv").mockImplementation(() => { throw new Error("cipher failed"); });
  await expect(ShortUrlService.exportAllShortUrls()).rejects.toThrow("导出加密失败");
});

it.each(["javascript:alert(1)", "data:text/html,content", "//evil.example/pay", "\\evil.example/pay"])(
  "rejects an unsafe upstream payment Location: %s", async (location) => {
    (axios.post as jest.Mock).mockResolvedValue({ headers: { location }, data: "" });
    const result = await createLinuxDoCreditRecharge({ userId: "u", keyId: "k", money: 1 });
    expect(result.payUrl).toBeNull();
    expect(result.formAction).toBe("https://credit.linux.do/pay/submit.php");
  },
);

it("resolves a normal relative payment Location", async () => {
  (axios.post as jest.Mock).mockResolvedValue({ headers: { location: "/paying?trade=123" }, data: "" });
  const result = await createLinuxDoCreditRecharge({ userId: "u", keyId: "k", money: 1 });
  expect(result.payUrl).toBe("https://credit.linux.do/paying?trade=123");
});
