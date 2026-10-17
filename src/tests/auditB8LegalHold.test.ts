/**
 * RC-22：法律保留的登记/解除契约。
 *
 * 钉住三件事：
 *  a) 登记必须同时有对象值、案件编号、理由（缺一项就拒绝，且有稳定 code）；
 *  b) 解除必须带案件编号与解除理由，案件编号不一致时拒绝（防止解除错案件）；
 *  c) 游标编解码可往返，用于管理端列表分页（RC-58）。
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { mongoose } from "../services/mongoService";
import {
  LegalHoldValidationError,
  createLegalHold,
  encodeLegalHoldCursor,
  parseLegalHoldCursor,
  releaseLegalHoldById,
  resetLegalHoldCacheForTests,
} from "../services/legalHoldService";
import { LegalHoldModel } from "../models/legalHoldModel";

jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock("../services/auditLogService", () => ({
  __esModule: true,
  AuditLogService: { log: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock("../models/forensicAuditModel", () => ({
  __esModule: true,
  ForensicAuditLogModel: { create: jest.fn().mockResolvedValue({}) },
  ForensicExportRequestModel: { create: jest.fn() },
}));

jest.mock("../models/legalHoldModel", () => ({
  __esModule: true,
  LegalHoldModel: {
    findOne: jest.fn(),
    findById: jest.fn(),
    findOneAndUpdate: jest.fn(),
    create: jest.fn(),
    updateMany: jest.fn(),
    find: jest.fn(),
  },
}));

function leanQuery(value: unknown) {
  return { lean: () => ({ exec: () => Promise.resolve(value) }) };
}

function setReadyState(value: number): void {
  Object.defineProperty(mongoose.connection, "readyState", { configurable: true, value });
}

beforeEach(() => {
  jest.clearAllMocks();
  resetLegalHoldCacheForTests();
  setReadyState(1);
});

describe("createLegalHold", () => {
  it("缺案件编号时拒绝", async () => {
    await expect(
      createLegalHold({ scope: "user", value: "u1", caseRef: "  ", reason: "warrant", issuedBy: "admin" }),
    ).rejects.toMatchObject({ code: "LEGAL_HOLD_CASE_REQUIRED" });
    expect(LegalHoldModel.create).not.toHaveBeenCalled();
  });

  it("缺理由时拒绝", async () => {
    await expect(
      createLegalHold({ scope: "ip", value: "1.2.3.4", caseRef: "CASE-1", reason: "", issuedBy: "admin" }),
    ).rejects.toMatchObject({ code: "LEGAL_HOLD_REASON_REQUIRED" });
    expect(LegalHoldModel.create).not.toHaveBeenCalled();
  });

  it("非法 scope 时拒绝", async () => {
    await expect(
      createLegalHold({
        scope: "email" as never,
        value: "a@example.test",
        caseRef: "CASE-1",
        reason: "warrant",
        issuedBy: "admin",
      }),
    ).rejects.toMatchObject({ code: "LEGAL_HOLD_SCOPE_INVALID" });
  });

  it("合法输入落库，且同案件重复登记返回既有记录（幂等）", async () => {
    (LegalHoldModel.findOne as jest.Mock).mockReturnValue(leanQuery(null));
    (LegalHoldModel.create as jest.Mock).mockImplementation(async (doc: unknown) => ({
      ...(doc as Record<string, unknown>),
      toObject: () => doc,
    }));

    const created = await createLegalHold({
      scope: "user",
      value: "u1",
      caseRef: "CASE-1",
      reason: "warrant-1",
      issuedBy: "admin",
    });
    expect(created?.caseRef).toBe("CASE-1");
    const payload = (LegalHoldModel.create as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
    expect(payload.reason).toBe("warrant-1");
    expect(payload.releasedAt).toBeNull();

    (LegalHoldModel.findOne as jest.Mock).mockReturnValue(leanQuery({ _id: "h1", caseRef: "CASE-1" }));
    const again = await createLegalHold({
      scope: "user",
      value: "u1",
      caseRef: "CASE-1",
      reason: "warrant-1",
      issuedBy: "admin",
    });
    expect(again?._id).toBe("h1");
    expect(LegalHoldModel.create).toHaveBeenCalledTimes(1);
  });
});

describe("releaseLegalHoldById", () => {
  it("缺解除理由时拒绝", async () => {
    await expect(
      releaseLegalHoldById({ holdId: "h1", caseRef: "CASE-1", releasedBy: "admin", releaseReason: " " }),
    ).rejects.toMatchObject({ code: "LEGAL_HOLD_RELEASE_REASON_REQUIRED" });
    expect(LegalHoldModel.findById).not.toHaveBeenCalled();
  });

  it("案件编号不一致时拒绝（不能解除别的案件）", async () => {
    (LegalHoldModel.findById as jest.Mock).mockReturnValue(
      leanQuery({ _id: "h1", scope: "user", value: "u1", caseRef: "CASE-A", releasedAt: null }),
    );
    await expect(
      releaseLegalHoldById({ holdId: "h1", caseRef: "CASE-B", releasedBy: "admin", releaseReason: "closed" }),
    ).rejects.toMatchObject({ code: "LEGAL_HOLD_CASE_MISMATCH" });
    expect(LegalHoldModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("合法解除写入 releasedBy/releasedAt/releaseReason", async () => {
    (LegalHoldModel.findById as jest.Mock).mockReturnValue(
      leanQuery({ _id: "h1", scope: "user", value: "u1", caseRef: "CASE-A", releasedAt: null }),
    );
    (LegalHoldModel.findOneAndUpdate as jest.Mock).mockReturnValue(
      leanQuery({ _id: "h1", scope: "user", value: "u1", caseRef: "CASE-A", releasedAt: new Date(), releaseReason: "closed" }),
    );

    const released = await releaseLegalHoldById({
      holdId: "h1",
      caseRef: "CASE-A",
      releasedBy: "admin",
      releaseReason: "closed",
    });
    expect(released?.releaseReason).toBe("closed");
    const update = (LegalHoldModel.findOneAndUpdate as jest.Mock).mock.calls[0][1] as {
      $set: Record<string, unknown>;
    };
    expect(update.$set.releasedBy).toBe("admin");
    expect(update.$set.releaseReason).toBe("closed");
    expect(update.$set.releasedAt).toBeInstanceOf(Date);
  });

  it("错误类型带稳定 code 与 HTTP 状态", () => {
    const error = new LegalHoldValidationError("LEGAL_HOLD_CASE_REQUIRED", "case", 409);
    expect(error.code).toBe("LEGAL_HOLD_CASE_REQUIRED");
    expect(error.statusCode).toBe(409);
  });
});

describe("游标分页", () => {
  it("编码后可往返解析", () => {
    const cursor = encodeLegalHoldCursor({
      _id: "abc",
      issuedAt: new Date("2026-01-02T03:04:05.000Z"),
    } as never);
    expect(parseLegalHoldCursor(cursor)).toEqual({
      issuedAt: new Date("2026-01-02T03:04:05.000Z").getTime(),
      id: "abc",
    });
  });

  it("非法游标返回 null（按第一页处理，不抛错）", () => {
    expect(parseLegalHoldCursor("not-base64-json")).toBeNull();
    expect(parseLegalHoldCursor(undefined)).toBeNull();
  });
});
