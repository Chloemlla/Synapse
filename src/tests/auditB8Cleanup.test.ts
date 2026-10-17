/**
 * RC-22 裁决三：应用层清理必须在物理删除前校验 legal_holds，且库不可用时 fail-closed。
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { mongoose } from "../services/mongoService";
import { checkAnyLegalHold } from "../services/legalHoldService";
import { runLegalHoldAwareCleanup } from "../services/legalHoldCleanupService";

jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock("../services/legalHoldService", () => ({
  __esModule: true,
  checkAnyLegalHold: jest.fn(),
}));

const mockedCheckAnyLegalHold = checkAnyLegalHold as jest.Mock;

interface FakeCollection {
  find: jest.Mock;
  deleteMany: jest.Mock;
}

function fakeCollection(rows: Array<Record<string, unknown>>): FakeCollection {
  return {
    find: jest.fn(() => ({
      limit: () => ({ toArray: async () => rows }),
    })),
    deleteMany: jest.fn().mockResolvedValue({ deletedCount: 0 }),
  };
}

function setReadyState(value: number): void {
  Object.defineProperty(mongoose.connection, "readyState", { configurable: true, value });
}

let fakeDbInstalled = false;

function setFakeDb(byCollection: Record<string, FakeCollection>): void {
  fakeDbInstalled = true;
  Object.defineProperty(mongoose.connection, "db", {
    configurable: true,
    value: {
      collection: (name: string) => byCollection[name] ?? fakeCollection([]),
    },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedCheckAnyLegalHold.mockResolvedValue({ held: false, unknown: false });
  if (fakeDbInstalled) {
    // 删掉自建的覆盖属性，回到原型上的真实 getter。
    delete (mongoose.connection as unknown as { db?: unknown }).db;
    fakeDbInstalled = false;
  }
  setReadyState(1);
});

describe("runLegalHoldAwareCleanup", () => {
  it("库不可用时整轮跳过，且不做任何删除（fail-closed）", async () => {
    setReadyState(0);
    const report = await runLegalHoldAwareCleanup();
    expect(report.ok).toBe(false);
    expect(report.dbAvailable).toBe(false);
    expect(report.targets).toEqual([]);
    expect(report.totalDeleted).toBe(0);
    expect(mockedCheckAnyLegalHold).not.toHaveBeenCalled();
  });

  it("命中 hold 的过期文档被跳过，不调用 deleteMany", async () => {
    const ipBans = fakeCollection([{ _id: "doc-1", ipAddress: "203.0.113.7", fingerprint: "fp-1" }]);
    setFakeDb({ ipbans: ipBans });
    mockedCheckAnyLegalHold.mockResolvedValue({
      held: true,
      unknown: false,
      hold: { caseRef: "CASE-1" },
    });

    const report = await runLegalHoldAwareCleanup();
    expect(report.ok).toBe(true);
    const target = report.targets.find((item) => item.collection === "ipbans");
    expect(target?.scanned).toBe(1);
    expect(target?.skippedHeld).toBe(1);
    expect(target?.deleted).toBe(0);
    expect(ipBans.deleteMany).not.toHaveBeenCalled();
  });

  it("库读不到 hold 结论（unknown）也按命中处理", async () => {
    const ipBans = fakeCollection([{ _id: "doc-1", ipAddress: "203.0.113.7" }]);
    setFakeDb({ ipbans: ipBans });
    mockedCheckAnyLegalHold.mockResolvedValue({ held: true, unknown: true });

    const report = await runLegalHoldAwareCleanup();
    const target = report.targets.find((item) => item.collection === "ipbans");
    expect(target?.skippedHeld).toBe(1);
    expect(ipBans.deleteMany).not.toHaveBeenCalled();
  });

  it("未命中 hold 的过期文档才被删除（且删除条件仍带过期判据）", async () => {
    const ipBans = fakeCollection([{ _id: "doc-1", ipAddress: "203.0.113.7" }]);
    setFakeDb({ ipbans: ipBans });
    mockedCheckAnyLegalHold.mockResolvedValue({ held: false, unknown: false });
    ipBans.deleteMany.mockResolvedValue({ deletedCount: 1 });

    const report = await runLegalHoldAwareCleanup();
    const target = report.targets.find((item) => item.collection === "ipbans");
    expect(target?.deleted).toBe(1);
    expect(ipBans.deleteMany).toHaveBeenCalledTimes(1);
    const filter = ipBans.deleteMany.mock.calls[0][0] as Record<string, unknown>;
    expect(filter._id).toEqual({ $in: ["doc-1"] });
    expect(filter.expiresAt).toBeDefined();
    expect(report.totalDeleted).toBe(1);
  });

  it("dryRun 只统计不删除", async () => {
    const ipBans = fakeCollection([{ _id: "doc-1", ipAddress: "203.0.113.7" }]);
    setFakeDb({ ipbans: ipBans });

    const report = await runLegalHoldAwareCleanup({ dryRun: true });
    const target = report.targets.find((item) => item.collection === "ipbans");
    expect(target?.deleted).toBe(1);
    expect(report.dryRun).toBe(true);
    expect(ipBans.deleteMany).not.toHaveBeenCalled();
  });
});
