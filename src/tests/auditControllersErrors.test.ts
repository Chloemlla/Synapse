import { NetworkController } from "../controllers/networkController";
import { IPFSController } from "../controllers/ipfsController";
import { NexaiSyncV2Controller } from "../controllers/nexaiSyncV2Controller";
import { GitHubBillingController } from "../controllers/githubBillingController";
import { MobileLoginController } from "../controllers/mobileLoginController";
import { NetworkService } from "../services/networkService";
import { IPFSService } from "../services/ipfsService";
import { NexaiEncryptedSyncService } from "../services/nexaiEncryptedSyncService";
import { GitHubBillingService } from "../services/githubBillingService";
import { issueClientLoginToken, MobileTokenError } from "../services/mobileLoginService";

jest.mock("../utils/logger", () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock("../utils/ipUtils", () => ({ getClientIP: () => "203.0.113.4" }));
jest.mock("../utils/ssrfGuard", () => ({ validatePublicHost: jest.fn(), validatePublicUrl: jest.fn() }));
jest.mock("../middleware/auth", () => ({ isAdminRole: () => false }));
jest.mock("../services/networkService", () => ({ NetworkService: { base64Operation: jest.fn() } }));
jest.mock("../services/ipfsService", () => ({ IPFSService: { uploadFile: jest.fn() } }));
jest.mock("../services/transactionService", () => ({ TransactionService: { executeTransaction: (fn: () => unknown) => fn() } }));
jest.mock("../services/nexaiEncryptedSyncService", () => ({ NexaiEncryptedSyncService: { putSnapshot: jest.fn() } }));
jest.mock("../services/githubBillingService", () => ({ GitHubBillingService: { parseCurlCommand: jest.fn(), saveCurlConfig: jest.fn() } }));
jest.mock("../services/mobileLoginService", () => ({
  issueClientLoginToken: jest.fn(),
  MobileTokenError: class extends Error {
    constructor(message: string, public status: number, public errorCode: string, public retryAfterSeconds?: number) { super(message); }
  },
}));
jest.mock("../services/mobileIntegrityService", () => ({}));
jest.mock("../services/authSessionService", () => ({ getAuthSessionMetadata: () => ({}) }));

function response() {
  const res: any = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

describe("controller error boundaries", () => {
  beforeEach(() => jest.clearAllMocks());

  it("preserves Base64 validation while hiding unexpected upstream errors", async () => {
    const req: any = { query: { type: "decode", text: "invalid" }, headers: {} };
    (NetworkService.base64Operation as jest.Mock).mockResolvedValue({ success: false, error: "Base64解码失败：输入不是有效的Base64字符串" });
    const invalid = response();
    await NetworkController.base64Operation(req, invalid);
    expect(invalid.status).toHaveBeenCalledWith(400);
    (NetworkService.base64Operation as jest.Mock).mockResolvedValue({ success: false, error: "ETIMEDOUT https://private.invalid/?secret=credential" });
    const failed = response();
    await NetworkController.base64Operation(req, failed);
    expect(failed.status).toHaveBeenCalledWith(500);
    expect(failed.json).toHaveBeenCalledWith(expect.objectContaining({ details: expect.objectContaining({ reason: "timeout" }) }));
    expect(JSON.stringify(failed.json.mock.calls)).not.toContain("credential");
  });

  it.each([undefined, "401", 200, 700, 401.5])("rejects an invalid sync error status %s", async (statusCode) => {
    (NexaiEncryptedSyncService.putSnapshot as jest.Mock).mockRejectedValue(Object.assign(new Error("database credential"), { statusCode }));
    const res = response();
    await NexaiSyncV2Controller.putSnapshot({ nexaiUser: { id: "user" }, body: {} } as any, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(JSON.stringify(res.json.mock.calls)).not.toContain("credential");
  });

  it("keeps explicit sync conflicts actionable", async () => {
    (NexaiEncryptedSyncService.putSnapshot as jest.Mock).mockRejectedValue(Object.assign(new Error("版本冲突"), { statusCode: 409, code: "VERSION_CONFLICT" }));
    const res = response();
    await NexaiSyncV2Controller.putSnapshot({ nexaiUser: { id: "user" }, body: {} } as any, res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: "版本冲突", code: "VERSION_CONFLICT" });
  });

  it("checks the parsed billing URL before saving", async () => {
    (GitHubBillingService.parseCurlCommand as jest.Mock).mockReturnValue({ url: "https://evil.invalid", headers: {} });
    const res = response();
    await GitHubBillingController.saveCurlConfig({ body: { curlCommand: "curl https://evil.invalid -H 'Referer: https://github.com/'" } } as any, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(GitHubBillingService.saveCurlConfig).not.toHaveBeenCalled();
  });

  it("preserves mobile token throttling but hides unexpected database failures", async () => {
    const req: any = { user: { id: "user" }, body: {}, headers: {} };
    (issueClientLoginToken as jest.Mock).mockRejectedValue(new MobileTokenError("请稍后重试", 429, "LIMIT", 30));
    const limited = response();
    await MobileLoginController.issueClientToken(req, limited);
    expect(limited.status).toHaveBeenCalledWith(429);
    expect(limited.json).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "LIMIT", retryAfterSeconds: 30 }));
    (issueClientLoginToken as jest.Mock).mockRejectedValue(new Error("Mongo database credential"));
    const failed = response();
    await MobileLoginController.issueClientToken(req, failed);
    expect(failed.status).toHaveBeenCalledWith(500);
    expect(JSON.stringify(failed.json.mock.calls)).not.toContain("credential");
  });

  it("keeps anonymous upload ownership separate and hides upstream detail", async () => {
    (IPFSService.uploadFile as jest.Mock).mockRejectedValue(Object.assign(new Error("ImageBed secret credential"), { statusCode: 503 }));
    const res = response();
    await IPFSController.uploadImage({ file: { buffer: Buffer.from("image"), originalname: "test.png", mimetype: "image/png" }, body: {}, headers: {} } as any, res);
    expect(IPFSService.uploadFile).toHaveBeenCalledWith(expect.anything(), "test.png", "image/png", expect.objectContaining({ userId: "anonymous", username: "anonymous" }), undefined, expect.anything());
    expect(res.status).toHaveBeenCalledWith(503);
    expect(JSON.stringify(res.json.mock.calls)).not.toContain("credential");
  });
});
