const mockReadEmailConfig = jest.fn();
const mockWriteEmailConfig = jest.fn();
jest.mock("../services/mongoService", () => ({ mongoose: { connection: { readyState: 1 } } }));
jest.mock("../models/runtimeConfigModel", () => ({
  RuntimeConfigModel: {
    findOne: (...args: unknown[]) => mockReadEmailConfig(...args),
    findOneAndUpdate: (...args: unknown[]) => mockWriteEmailConfig(...args),
  },
}));
jest.mock("../utils/logger", () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn() } }));

import { RuntimeConfigService } from "../services/runtimeConfigService";

describe("email setting credential preservation", () => {
  const stored = {
    enabled: true, resendDomain: "example.com", resendApiKey: "re_maincredential1234", quotaTotal: 100,
    outemailEnabled: true, outemailDomain: "mail.example.com", outemailApiKey: "re_outcredential5678",
    outemailCode: "send-code-1234", outemailQuotaTotal: 100,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockReadEmailConfig.mockReturnValue({ lean: () => ({ exec: async () => ({ value: stored }) }) });
    mockWriteEmailConfig.mockReturnValue({ exec: async () => ({}) });
  });

  it("preserves all credentials when an old client posts masked GET fields with a quota edit", async () => {
    const { setting } = await RuntimeConfigService.getEmailSetting();
    expect(setting.config.resendApiKey).not.toBe(stored.resendApiKey);
    await RuntimeConfigService.setEmailSetting({ ...setting.config, quotaTotal: 7 });
    const update = mockWriteEmailConfig.mock.calls[0][1];
    expect(update.value).toMatchObject({ ...stored, quotaTotal: 7 });
  });

  it("accepts explicitly replaced credentials and preserves omitted ones", async () => {
    await RuntimeConfigService.setEmailSetting({ resendApiKey: "re_newcredential9876", quotaTotal: 3 });
    expect(mockWriteEmailConfig.mock.calls[0][1].value).toMatchObject({
      ...stored, resendApiKey: "re_newcredential9876", quotaTotal: 3,
    });
  });

  it("does not save a stale display mask when credentials changed since the page loaded", async () => {
    await RuntimeConfigService.setEmailSetting({ enabled: false, resendApiKey: "re***9999", outemailCode: "********" });
    expect(mockWriteEmailConfig.mock.calls[0][1].value).toMatchObject({
      resendApiKey: stored.resendApiKey, outemailCode: stored.outemailCode,
    });
  });
});
