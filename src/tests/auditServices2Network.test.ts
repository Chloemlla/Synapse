import { NetworkService, describeNetworkError } from "../services/networkService";
import { sendProviderGeneratedPasswordEmail } from "../services/providerCredentialEmailService";
import { sendEmail } from "../services/emailSender";

jest.mock("../config/config", () => ({ config: {} }));
jest.mock("../services/emailSender", () => ({ sendEmail: jest.fn() }));
jest.mock("../utils/logger", () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

it("does not report an MD5 digest as MD4", () => {
  expect(NetworkService.hashEncrypt("md4", "hello")).toEqual(expect.objectContaining({ success: false }));
  expect(NetworkService.hashEncrypt("md5", "hello").data.data).toBe("5d41402abc4b2a76b9719d911017c592");
});

it("keeps nested transport codes in diagnostics without serializing request credentials", () => {
  const error = Object.assign(new Error("fetch failed"), { cause: { name: "Error", code: "ENOTFOUND", message: "secret-token", config: { password: "secret" } } });
  expect(describeNetworkError(error)).toEqual({ message: "fetch failed", causeName: "Error", causeCode: "ENOTFOUND" });
});

it("sends account setup guidance without the generated password", async () => {
  (sendEmail as jest.Mock).mockResolvedValue({ success: true });
  await sendProviderGeneratedPasswordEmail({ email: "user@example.com", username: "user", providerLabel: "Google", password: "generated-secret" });
  const message = (sendEmail as jest.Mock).mock.calls[0][0];
  expect(message.html).toContain("忘记密码");
  expect(JSON.stringify(message)).not.toContain("generated-secret");
});
