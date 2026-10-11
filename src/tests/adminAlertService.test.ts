import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockSendBatchHtmlEmails = jest.fn();
const mockFind = jest.fn();

jest.mock("../services/emailService", () => ({
  EmailService: { sendBatchHtmlEmails: (...a: unknown[]) => mockSendBatchHtmlEmails(...a) },
}));

jest.mock("../services/userService", () => ({
  UserModel: { find: (...a: unknown[]) => mockFind(...a) },
}));

jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { getAdminTeamEmails, sendAdminAlert } from "../services/adminAlertService";
import logger from "../utils/logger";

/** find().select().lean() 的链式替身。 */
function adminQuery(rows: unknown[]) {
  return { select: () => ({ lean: async () => rows }) };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSendBatchHtmlEmails.mockResolvedValue({ ids: ["1"] });
  delete process.env.ALERT_WEBHOOK_URL;
  (globalThis as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({ ok: true }));
});

describe("getAdminTeamEmails", () => {
  it("取 admin/superadmin 邮箱并去重、剔除空值", async () => {
    mockFind.mockReturnValueOnce(adminQuery([{ email: "a@x.com" }, { email: "a@x.com" }, { email: "" }, { email: "b@x.com" }]));
    await expect(getAdminTeamEmails()).resolves.toEqual(["a@x.com", "b@x.com"]);
  });
});

describe("sendAdminAlert", () => {
  it("邮件发给管理团队；配置了 ALERT_WEBHOOK_URL 时同时 POST 结构化告警", async () => {
    process.env.ALERT_WEBHOOK_URL = "https://hooks.example/alert";
    mockFind.mockReturnValueOnce(adminQuery([{ email: "a@x.com" }]));
    const mockFetch = (globalThis as unknown as { fetch: jest.Mock }).fetch;

    await sendAdminAlert({ subject: "死信", text: "taskId=t1", detail: { count: 1 }, level: "critical" });

    expect(mockSendBatchHtmlEmails).toHaveBeenCalledWith(
      ["a@x.com"],
      "[Synapse 告警] 死信",
      expect.stringContaining("taskId=t1"),
    );
    expect(mockFetch).toHaveBeenCalledWith(
      "https://hooks.example/alert",
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse((mockFetch.mock.calls[0][1] as { body: string }).body);
    expect(body).toMatchObject({ level: "critical", subject: "死信", detail: { count: 1 } });
  });

  it("未配置 webhook 时不发外呼", async () => {
    mockFind.mockReturnValueOnce(adminQuery([{ email: "a@x.com" }]));
    const mockFetch = (globalThis as unknown as { fetch: jest.Mock }).fetch;

    await sendAdminAlert({ subject: "死信", text: "x" });

    expect(mockSendBatchHtmlEmails).toHaveBeenCalledTimes(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("没有管理员邮箱时跳过邮件，不抛错", async () => {
    mockFind.mockReturnValueOnce(adminQuery([]));

    await expect(sendAdminAlert({ subject: "死信", text: "x" })).resolves.toBeUndefined();
    expect(mockSendBatchHtmlEmails).not.toHaveBeenCalled();
  });

  it("邮件投递失败只记日志，不抛给调用方", async () => {
    mockFind.mockReturnValueOnce(adminQuery([{ email: "a@x.com" }]));
    mockSendBatchHtmlEmails.mockRejectedValueOnce(new Error("smtp down"));

    await expect(sendAdminAlert({ subject: "死信", text: "x" })).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("邮件告警投递失败"), expect.anything());
  });
});
