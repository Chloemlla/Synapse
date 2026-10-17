import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock("../services/wsService", () => ({ wsService: {} }));
jest.mock("../tts/tts.history", () => ({
  generationHistoryStore: {},
  redactTtsTextForStorage: (text: string) => text,
}));
jest.mock("../tts/tts.quota", () => ({ quotaLedger: {}, startExpiredReservationSweeper: jest.fn() }));
jest.mock("../tts/tts.service", () => ({ TtsService: class {} }));
jest.mock("../services/adminAlertService", () => ({ sendAdminAlert: jest.fn() }));

const mockCreateJob = jest.fn(async (_job: unknown) => _job);
const mockCountActiveJobsForUser = jest.fn(async (_userId: string) => 0);
jest.mock("../tts/tts.storage", () => ({
  ttsStorage: {
    createJob: (...args: unknown[]) => mockCreateJob(...args),
    countActiveJobsForUser: (...args: unknown[]) => mockCountActiveJobsForUser(...args),
    recoverStaleJobs: jest.fn(async () => ({ failed: [], recovered: 0 })),
    claimNextQueuedJob: jest.fn(async () => null),
    getQueuePosition: jest.fn(async () => 1),
  },
}));

import {
  createBurstConcurrencyGuard,
  getBurstConcurrencySnapshot,
  resetBurstConcurrencyForTests,
} from "../middleware/routeLimiters";
import {
  checkUploadBudget,
  inspectDirectoryUsage,
  inspectUploadedFile,
  resolveMediaSandboxLimits,
} from "../mediaTool/sandbox";
import {
  evaluateAccountBudget,
  evaluateQuotaThresholds,
  isUpstreamQuotaExhausted,
  resolveAccountBudgetPolicy,
  resolveQuotaPeriodKey,
} from "../services/quotaEventService";
import { parseProcStatusRssBytes, startProcessWatchdog } from "../utils/processWatchdog";
import { TtsQueue } from "../tts/tts.queue";

beforeEach(() => {
  jest.clearAllMocks();
  mockCreateJob.mockImplementation(async (job: unknown) => job);
  mockCountActiveJobsForUser.mockResolvedValue(0);
  resetBurstConcurrencyForTests();
});

function fakeResponse() {
  const listeners = new Map<string, Array<() => void>>();
  const res = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: undefined as unknown,
    setHeader(name: string, value: string) {
      res.headers[name] = value;
      return res;
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
    once(event: string, listener: () => void) {
      const list = listeners.get(event) || [];
      list.push(listener);
      listeners.set(event, list);
      return res;
    },
    emit(event: string) {
      for (const listener of listeners.get(event) || []) listener();
    },
  };
  return res;
}

function fakeRequest(overrides: Record<string, unknown> = {}) {
  return {
    method: "POST",
    path: "/api/expensive",
    originalUrl: "/api/expensive",
    ip: "203.0.113.9",
    socket: { remoteAddress: "203.0.113.9" },
    ...overrides,
  } as never;
}

describe("RC-27 突发并发硬顶", () => {
  it("超顶立即 429 + Retry-After；请求结束后槽位释放", () => {
    const guard = createBurstConcurrencyGuard({ name: "test-burst", maxConcurrent: 1, retryAfterSeconds: 3 });
    const first = fakeResponse();
    const a = jest.fn();
    guard(fakeRequest(), first as never, a as never);
    expect(a).toHaveBeenCalledTimes(1);
    expect(getBurstConcurrencySnapshot().guards["test-burst"]).toMatchObject({ active: 1, maxConcurrent: 1 });

    const second = fakeResponse();
    const b = jest.fn();
    guard(fakeRequest(), second as never, b as never);
    expect(b).not.toHaveBeenCalled();
    expect(second.statusCode).toBe(429);
    expect(second.headers["Retry-After"]).toBe("3");
    expect(second.body).toMatchObject({ code: "BURST_CONCURRENCY_LIMIT", retryAfterSeconds: 3 });

    // 第一个请求结束后槽位必须归还，否则会被永久占死。
    first.emit("finish");
    expect(getBurstConcurrencySnapshot().guards["test-burst"]).toMatchObject({ active: 0 });
    const third = fakeResponse();
    const c = jest.fn();
    guard(fakeRequest(), third as never, c as never);
    expect(c).toHaveBeenCalledTimes(1);
  });

  it("匿名请求按 IP 与设备指纹双重判断：换 IP 但同一设备仍被并发硬顶拦住", () => {
    const guard = createBurstConcurrencyGuard({ name: "test-burst-fp", maxConcurrent: 1 });
    const fingerprint = "5f0c9a1e7b3d4c2a9e8f6d5c4b3a2910";
    const first = fakeResponse();
    const a = jest.fn();
    guard(
      fakeRequest({ ip: "203.0.113.9", socket: { remoteAddress: "203.0.113.9" }, headers: { "x-fingerprint": fingerprint } }),
      first as never,
      a as never,
    );
    expect(a).toHaveBeenCalledTimes(1);

    // 同一台设备换了一个出口：IP 桶是新的，但指纹桶已满 —— 这正是「双判据」要挡的绕法。
    const second = fakeResponse();
    const b = jest.fn();
    guard(
      fakeRequest({ ip: "198.51.100.7", socket: { remoteAddress: "198.51.100.7" }, headers: { "x-fingerprint": fingerprint } }),
      second as never,
      b as never,
    );
    expect(b).not.toHaveBeenCalled();
    expect(second.statusCode).toBe(429);

    // 请求结束后两个桶都要归还，否则换 IP 的路径会把指纹槽位永久泄漏。
    first.emit("finish");
    const third = fakeResponse();
    const c = jest.fn();
    guard(
      fakeRequest({ ip: "198.51.100.7", socket: { remoteAddress: "198.51.100.7" }, headers: { "x-fingerprint": fingerprint } }),
      third as never,
      c as never,
    );
    expect(c).toHaveBeenCalledTimes(1);
  });

  it("没有携带指纹的匿名客户端只按 IP 桶判断（行为与改动前一致）", () => {
    const guard = createBurstConcurrencyGuard({ name: "test-burst-nofp", maxConcurrent: 1 });
    const a = jest.fn();
    guard(fakeRequest(), fakeResponse() as never, a as never);
    expect(a).toHaveBeenCalledTimes(1);

    // 不同 IP 且都没有指纹：互不影响，不会被指纹桶误伤。
    const b = jest.fn();
    guard(
      fakeRequest({ ip: "198.51.100.8", socket: { remoteAddress: "198.51.100.8" } }),
      fakeResponse() as never,
      b as never,
    );
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("登录用户不叠加指纹桶（账户键已是更强的身份）", () => {
    const guard = createBurstConcurrencyGuard({ name: "test-burst-user", maxConcurrent: 1 });
    const fingerprint = "9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d";
    const a = jest.fn();
    guard(
      fakeRequest({ user: { id: "u1" }, headers: { "x-fingerprint": fingerprint } }),
      fakeResponse() as never,
      a as never,
    );
    expect(a).toHaveBeenCalledTimes(1);

    // 同一账号换 IP、仍然带同一个指纹：账户键（含 IP）是新的，且不该因指纹桶而被拒。
    // 若指纹桶被错误地叠加到登录请求上，这里会拿到 429。
    const b = jest.fn();
    const second = fakeResponse();
    guard(
      fakeRequest({
        user: { id: "u1" },
        ip: "198.51.100.9",
        socket: { remoteAddress: "198.51.100.9" },
        headers: { "x-fingerprint": fingerprint },
      }),
      second as never,
      b as never,
    );
    expect(second.statusCode).toBe(200);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("GET 等非写方法与 pathFilter 之外的路由不计入并发", () => {
    const guard = createBurstConcurrencyGuard({
      name: "test-burst-get",
      maxConcurrent: 1,
      methods: ["POST"],
      pathFilter: (pathname) => pathname === "/api/expensive",
    });
    const getRes = fakeResponse();
    const next = jest.fn();
    guard(fakeRequest({ method: "GET" }), getRes as never, next as never);
    expect(next).toHaveBeenCalled();

    const other = fakeResponse();
    const next2 = jest.fn();
    guard(fakeRequest({ originalUrl: "/api/cheap" }), other as never, next2 as never);
    expect(next2).toHaveBeenCalled();
    expect(getBurstConcurrencySnapshot().guards["test-burst-get"]).toBeUndefined();
  });
});

describe("RC-30 TTS 每用户活跃任务上限", () => {
  const callbacks = {
    buildUsageSummary: jest.fn(async () => ({})),
    buildNextAction: () => ({ type: "retry", label: "重试", message: "失败" }),
  } as never;
  const job = (overrides: Record<string, unknown> = {}) =>
    ({
      taskId: "t1",
      status: "queued",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      request: { text: "hi", model: "m", voice: "v", outputFormat: "mp3", speed: 1 },
      userId: "u1",
      isAdmin: false,
      ip: "1.1.1.1",
      fingerprint: "fp",
      message: "",
      ...overrides,
    }) as never;

  it("达到上限直接拒绝（429 + 稳定 code），不落库", async () => {
    jest.useFakeTimers();
    const queue = new TtsQueue(callbacks);
    expect(queue.getPerUserMaxActive()).toBe(3);
    mockCountActiveJobsForUser.mockResolvedValue(3);

    await expect(queue.enqueue(job())).rejects.toMatchObject({
      statusCode: 429,
      code: "TTS_USER_CONCURRENCY_LIMIT",
    });
    expect(mockCreateJob).not.toHaveBeenCalled();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("未达上限正常入队；管理员与匿名任务不受该闸门约束", async () => {
    jest.useFakeTimers();
    const queue = new TtsQueue(callbacks);
    mockCountActiveJobsForUser.mockResolvedValue(2);

    await queue.enqueue(job());
    expect(mockCreateJob).toHaveBeenCalledTimes(1);

    mockCountActiveJobsForUser.mockResolvedValue(99);
    await queue.enqueue(job({ taskId: "t2", isAdmin: true }));
    await queue.enqueue(job({ taskId: "t3", userId: undefined }));
    expect(mockCreateJob).toHaveBeenCalledTimes(3);

    expect(await queue.getOccupancyForUser("u1")).toBe(99);
    expect(queue.getOccupancy()).toMatchObject({ perUserMaxActive: 3 });
    jest.clearAllTimers();
    jest.useRealTimers();
  });
});

describe("RC-39 文件沙箱", () => {
  let root = "";
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "synapse-sandbox-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("目录用量统计与配额预检（数量/字节）", () => {
    fs.writeFileSync(path.join(root, "a.mp3"), Buffer.alloc(10));
    fs.writeFileSync(path.join(root, "b.mp3"), Buffer.alloc(20));
    const usage = inspectDirectoryUsage(root);
    expect(usage).toMatchObject({ files: 2, bytes: 30, truncated: false });

    const limits = resolveMediaSandboxLimits({}, { maxUserDirFiles: 2, maxUserDirBytes: 1024 });
    const countCheck = checkUploadBudget({ dir: root, incomingBytes: 10, limits });
    expect(countCheck.ok).toBe(false);
    if (!countCheck.ok) expect(countCheck.code).toBe("MEDIA_SANDBOX_FILE_COUNT_EXCEEDED");

    const byteLimits = resolveMediaSandboxLimits({}, { maxUserDirFiles: 10, maxUserDirBytes: 100 });
    const byteCheck = checkUploadBudget({ dir: root, incomingBytes: 80, limits: byteLimits });
    expect(byteCheck.ok).toBe(false);
    if (!byteCheck.ok) expect(byteCheck.code).toBe("MEDIA_SANDBOX_DIR_QUOTA_EXCEEDED");
  });

  it("落盘复核：类型/大小/空文件/越界全部失败关闭", () => {
    const limits = resolveMediaSandboxLimits({}, { maxFileBytes: 5, maxFilesPerJob: 1 });
    const audio = path.join(root, "ok.mp3");
    fs.writeFileSync(audio, Buffer.alloc(3));
    expect(inspectUploadedFile(audio, root, limits).ok).toBe(true);

    const empty = path.join(root, "empty.mp3");
    fs.writeFileSync(empty, Buffer.alloc(0));
    expect(inspectUploadedFile(empty, root, limits)).toMatchObject({ ok: false, code: "MEDIA_SANDBOX_FILE_EMPTY" });

    const big = path.join(root, "big.mp3");
    fs.writeFileSync(big, Buffer.alloc(64));
    expect(inspectUploadedFile(big, root, limits)).toMatchObject({
      ok: false,
      code: "MEDIA_SANDBOX_FILE_TOO_LARGE",
    });

    const textFile = path.join(root, "note.txt");
    fs.writeFileSync(textFile, "hello");
    expect(inspectUploadedFile(textFile, root, limits)).toMatchObject({
      ok: false,
      code: "MEDIA_SANDBOX_TYPE_NOT_ALLOWED",
    });

    const outside = path.join(os.tmpdir(), `outside-${Date.now()}.mp3`);
    fs.writeFileSync(outside, Buffer.alloc(1));
    expect(inspectUploadedFile(outside, root, limits)).toMatchObject({
      ok: false,
      code: "MEDIA_SANDBOX_PATH_INVALID",
    });
    fs.rmSync(outside, { force: true });
  });
});

describe("RC-39 子进程看门狗（只按子进程计量）", () => {
  it("解析 /proc 的 VmRSS", () => {
    expect(parseProcStatusRssBytes("Name: node\nVmRSS:\t  1024 kB\n")).toBe(1024 * 1024);
    expect(parseProcStatusRssBytes("Name: node\n")).toBeNull();
  });

  it("超限走 enforce 时只杀目标子进程（不碰主进程）", async () => {
    const child = {
      pid: 999_999_999,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: jest.fn(() => true),
    };
    const onLimit = jest.fn();
    const handle = startProcessWatchdog({
      label: "test-child",
      child: child as never,
      mode: "enforce",
      maxRssBytes: 100,
      maxDurationMs: 60_000,
      sampleIntervalMs: 10,
      readRss: () => 1000,
      onLimit,
    });

    await new Promise((resolve) => setTimeout(resolve, 60));
    handle.stop();

    expect(onLimit).toHaveBeenCalledWith(expect.objectContaining({ reason: "rss", killed: true, mode: "enforce" }));
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("观察期只告警不击杀；时长上限独立于内存判据", async () => {
    const child = {
      pid: 999_999_998,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill: jest.fn(() => true),
    };
    const onLimit = jest.fn();
    const handle = startProcessWatchdog({
      label: "test-observe",
      child: child as never,
      mode: "observe",
      maxRssBytes: 10_000,
      maxDurationMs: 10,
      sampleIntervalMs: 10,
      readRss: () => 5,
      onLimit,
    });

    await new Promise((resolve) => setTimeout(resolve, 80));
    handle.stop();

    expect(onLimit).toHaveBeenCalledWith(expect.objectContaining({ reason: "duration", killed: false }));
    expect(child.kill).not.toHaveBeenCalled();
  });
});

describe("RC-28 配额阈值与账户预算", () => {
  it("80% / 100% 阈值只在跨过时各返回一次", () => {
    expect(evaluateQuotaThresholds(0.1)).toEqual([]);
    expect(evaluateQuotaThresholds(0.8)).toEqual([0.8]);
    expect(evaluateQuotaThresholds(0.95)).toEqual([0.8]);
    expect(evaluateQuotaThresholds(1)).toEqual([0.8, 1]);
    expect(evaluateQuotaThresholds(Number.NaN)).toEqual([]);
  });

  it("账期键按上海时区（日/月两种）", () => {
    // UTC 2026-10-16T16:30Z = 上海 2026-10-17 00:30
    const now = new Date("2026-10-16T16:30:00.000Z");
    expect(resolveQuotaPeriodKey(now, "day")).toBe("2026-10-17");
    expect(resolveQuotaPeriodKey(now, "month")).toBe("2026-10");
  });

  it("账户预算取 min(账户各窗口剩余, Key 剩余)，任一不够即超限", () => {
    const policy = { mode: "enforce" as const, dailyCredits: 100, monthlyCredits: 1000 };
    const byDaily = evaluateAccountBudget({
      policy,
      usage: { dailySpent: 95, monthlySpent: 100 },
      costCredits: 10,
      keyRemaining: 500,
    });
    expect(byDaily.effectiveRemaining).toBe(5);
    expect(byDaily.exceeded).toBe(true);

    const byKey = evaluateAccountBudget({
      policy,
      usage: { dailySpent: 0, monthlySpent: 0 },
      costCredits: 10,
      keyRemaining: 5,
    });
    expect(byKey.effectiveRemaining).toBe(5);
    expect(byKey.exceeded).toBe(true);

    const ok = evaluateAccountBudget({
      policy,
      usage: { dailySpent: 0, monthlySpent: 0 },
      costCredits: 10,
      keyRemaining: 500,
    });
    expect(ok.exceeded).toBe(false);
  });

  it("默认 off，且未被 env 意外打开", () => {
    const saved = {
      mode: process.env.API_KEY_ACCOUNT_BUDGET_MODE,
      daily: process.env.API_KEY_ACCOUNT_DAILY_BUDGET_CREDITS,
    };
    delete process.env.API_KEY_ACCOUNT_BUDGET_MODE;
    delete process.env.API_KEY_ACCOUNT_DAILY_BUDGET_CREDITS;
    try {
      expect(resolveAccountBudgetPolicy({})).toEqual({ mode: "off", dailyCredits: 0, monthlyCredits: 0 });
    } finally {
      if (saved.mode !== undefined) process.env.API_KEY_ACCOUNT_BUDGET_MODE = saved.mode;
      if (saved.daily !== undefined) process.env.API_KEY_ACCOUNT_DAILY_BUDGET_CREDITS = saved.daily;
    }
  });

  it("上游额度耗尽只认明确信号：与用户额度不足用不同 code 区分", () => {
    expect(isUpstreamQuotaExhausted({ status: 402 })).toBe(true);
    expect(isUpstreamQuotaExhausted({ code: "insufficient_quota" })).toBe(true);
    expect(isUpstreamQuotaExhausted({ message: "You exceeded your current quota" })).toBe(true);
    // 普通限流不是"耗尽"：它只该触发退避，不该进降级队列。
    expect(isUpstreamQuotaExhausted({ status: 429, message: "rate limit" })).toBe(false);
    expect(isUpstreamQuotaExhausted(new Error("ECONNRESET"))).toBe(false);
  });
});
