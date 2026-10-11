import { beforeEach, afterEach, describe, expect, it, jest } from "@jest/globals";

const mockGenerate = jest.fn();
const mockAddRecord = jest.fn();
const mockLedgerConfirm = jest.fn();
const mockLedgerRelease = jest.fn();
const mockUpdateJob = jest.fn();
const mockCompleteJob = jest.fn();
const mockFailJob = jest.fn();
const mockRenewLease = jest.fn();
const mockRecoverStale = jest.fn();
const mockNotifyComplete = jest.fn();
const mockNotifyError = jest.fn();
const mockSendAdminAlert = jest.fn();

jest.mock("../services/wsService", () => ({
  wsService: {
    notifyTtsProgress: jest.fn(),
    notifyTtsComplete: (...a: unknown[]) => mockNotifyComplete(...a),
    notifyTtsError: (...a: unknown[]) => mockNotifyError(...a),
  },
}));

jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock("../services/adminAlertService", () => ({
  sendAdminAlert: (...a: unknown[]) => mockSendAdminAlert(...a),
}));

jest.mock("../tts/tts.history", () => ({
  generationHistoryStore: { addRecord: (...a: unknown[]) => mockAddRecord(...a) },
  redactTtsTextForStorage: (text: string) => text,
}));

jest.mock("../tts/tts.quota", () => ({
  quotaLedger: {
    confirm: (...a: unknown[]) => mockLedgerConfirm(...a),
    release: (...a: unknown[]) => mockLedgerRelease(...a),
    confirmAnonymous: jest.fn(),
    releaseAnonymous: jest.fn(),
  },
  startExpiredReservationSweeper: jest.fn(),
  buildAnonymousScopeKey: () => "anon",
  buildUsageSummaryFromSnapshot: () => ({ authenticated: true, isAdmin: false, dailyLimit: 10, usedToday: 1, remainingToday: 9 }),
}));

jest.mock("../tts/tts.service", () => ({
  TtsService: class {
    resolveProviderExecution = jest.fn(async () => ({ providerId: "edge", model: "m", voice: "v" }));
    resolveSpeed = jest.fn(() => 1);
    generateSpeech = (...a: unknown[]) => mockGenerate(...a);
  },
}));

jest.mock("../tts/tts.storage", () => ({
  ttsStorage: {
    createJob: jest.fn(),
    getJob: jest.fn(),
    updateJob: (...a: unknown[]) => mockUpdateJob(...a),
    completeJob: (...a: unknown[]) => mockCompleteJob(...a),
    failJob: (...a: unknown[]) => mockFailJob(...a),
    claimNextQueuedJob: jest.fn(async () => null),
    renewJobLease: (...a: unknown[]) => mockRenewLease(...a),
    recoverStaleJobs: (...a: unknown[]) => mockRecoverStale(...a),
  },
}));

import { TTS_LEASE_HEARTBEAT_MS, TTS_PROCESSING_LEASE_MS, TtsQueue } from "../tts/tts.queue";
import logger from "../utils/logger";

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    taskId: "t1",
    status: "processing",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    request: { text: "hi", model: "m", voice: "v", outputFormat: "mp3", speed: 1 },
    userId: "u1",
    isAdmin: false,
    ip: "1.1.1.1",
    fingerprint: "fp",
    message: "",
    ...overrides,
  } as any;
}

const SUCCESS_RESULT = {
  contentHash: "h",
  fileName: "a.mp3",
  audioUrl: "u",
  audioFileId: "id",
  audioStorage: "file",
  audioMimeType: "audio/mpeg",
  audioSize: 1,
  outputFormat: "mp3",
  provider: "edge",
  providerModel: "m",
  providerVoice: "v",
  isDuplicate: false,
  watermarkId: undefined,
};

const callbacks = {
  buildUsageSummary: jest.fn(async () => ({})),
  buildNextAction: () => ({ type: "retry", label: "重试", message: "失败" }),
} as any;

function makeQueue() {
  return new TtsQueue(callbacks);
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockAddRecord.mockResolvedValue(undefined);
  mockLedgerConfirm.mockResolvedValue({ user: { id: "u1" }, remainingToday: 9, reservedToday: 0, consumedToday: 1 });
  mockLedgerRelease.mockResolvedValue({ user: { id: "u1" }, remainingToday: 10, reservedToday: 0, consumedToday: 0 });
  mockUpdateJob.mockResolvedValue({});
  mockCompleteJob.mockResolvedValue({ taskId: "t1", status: "completed" });
  mockFailJob.mockResolvedValue({ taskId: "t1", status: "failed" });
  mockRenewLease.mockResolvedValue({ taskId: "t1", status: "processing" });
  mockRecoverStale.mockResolvedValue({ recovered: 0, failed: [] });
  mockSendAdminAlert.mockResolvedValue(undefined);
  mockGenerate.mockResolvedValue(SUCCESS_RESULT);
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe("TTS 队列看门狗：终态与租约", () => {
  it("正常完成：终态写入带认领时的 owner，并通知用户", async () => {
    const queue = makeQueue();
    await (queue as any).processJob(makeJob());

    expect(mockCompleteJob).toHaveBeenCalledWith(
      "t1",
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.stringMatching(/^tts-worker-/),
    );
    expect(mockNotifyComplete).toHaveBeenCalledWith("u1", expect.objectContaining({ taskId: "t1" }));
  });

  it("终态写入被拒（租约已被回收/转交）时不通知用户", async () => {
    mockCompleteJob.mockResolvedValueOnce(null);
    const queue = makeQueue();

    await (queue as any).processJob(makeJob());

    expect(mockNotifyComplete).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("放弃终态提交"),
      expect.objectContaining({ taskId: "t1" }),
    );
  });

  it("长任务按心跳周期续租", async () => {
    let resolveGenerate!: (value: unknown) => void;
    mockGenerate.mockReturnValueOnce(new Promise((resolve) => { resolveGenerate = resolve; }));
    const queue = makeQueue();

    const processing = (queue as any).processJob(makeJob());
    await jest.advanceTimersByTimeAsync(TTS_LEASE_HEARTBEAT_MS);

    expect(mockRenewLease).toHaveBeenCalledWith(
      "t1",
      expect.stringMatching(/^tts-worker-/),
      TTS_PROCESSING_LEASE_MS,
    );

    resolveGenerate(SUCCESS_RESULT);
    await processing;
  });

  it("失败路径写 failed 并通知错误", async () => {
    mockGenerate.mockRejectedValueOnce(new Error("boom"));
    const queue = makeQueue();

    await (queue as any).processJob(makeJob());

    expect(mockFailJob).toHaveBeenCalledWith("t1", "boom", expect.anything(), expect.anything(), expect.stringMatching(/^tts-worker-/));
    expect(mockNotifyError).toHaveBeenCalledWith("u1", expect.objectContaining({ taskId: "t1", error: "boom" }));
  });

  it("失败态写入被拒时不通知错误", async () => {
    mockGenerate.mockRejectedValueOnce(new Error("boom"));
    mockFailJob.mockResolvedValueOnce(null);
    const queue = makeQueue();

    await (queue as any).processJob(makeJob());

    expect(mockNotifyError).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("失败态写入被拒"),
      expect.objectContaining({ taskId: "t1" }),
    );
  });
});

describe("TTS 队列看门狗：死信告警", () => {
  it("一轮回收出现死信时合并投递一次告警（邮件 + 可选 webhook）", async () => {
    const failed = [makeJob({ taskId: "dead-1", status: "failed", attempts: 3, error: "任务重试次数已达上限，已终止" })];
    mockRecoverStale.mockResolvedValueOnce({ recovered: 0, failed });
    const queue = makeQueue();

    await (queue as any).recoverStaleJobsAndReleaseQuota();
    // alertDeadLetterJobs 是 fire-and-forget 的动态 import：冲几轮微任务等它落地。
    for (let i = 0; i < 10 && mockSendAdminAlert.mock.calls.length === 0; i += 1) {
      await Promise.resolve();
    }

    expect(mockSendAdminAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "critical",
        subject: expect.stringContaining("死信"),
        detail: { count: 1, taskIds: ["dead-1"] },
      }),
    );
  });

  it("没有死信时不发告警", async () => {
    const queue = makeQueue();
    await (queue as any).recoverStaleJobsAndReleaseQuota();
    for (let i = 0; i < 3; i += 1) await Promise.resolve();

    expect(mockSendAdminAlert).not.toHaveBeenCalled();
  });
});
