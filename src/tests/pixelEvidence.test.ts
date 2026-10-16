/**
 * 法律保全 + 内容级取证（「公开、限定、可追责」版）的用例。
 *
 * 这个文件钉的是三条不可退让的约束：
 *   a) 没有有效审批 ⇒ **不写任何账号内容**（默认关闭，而不是默认开启）；
 *   b) 取证内容用独立子密钥加密，密文与明文都可回读，但版本/字段不匹配一律抛错（不回退明文）；
 *   c) 保全快照不带 TTL（purgeAfter 为 null），解除后才开始计时；
 *      且账号注销路径在命中 hold 时必须跳过物理删除。
 */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import PixelEvidenceModel from "../models/pixelEvidenceModel";
import PixelEvidenceApprovalModel from "../models/pixelEvidenceApprovalModel";
import PixelEvidenceHoldModel from "../models/pixelEvidenceHoldModel";
import PixelTaskAccessModel from "../models/pixelTaskAccessModel";
import PixelUsageLogModel from "../models/pixelUsageLogModel";
import { createLegalHold, releaseLegalHold, checkAnyLegalHold } from "../services/legalHoldService";
import { decryptPixelEvidence, encryptPixelEvidence } from "../pixel/evidenceCrypto";
import {
  capturePixelEvidence,
  createEvidenceApproval,
  findActiveEvidenceApproval,
  readPixelEvidence,
  revokeEvidenceApproval,
} from "../pixel/evidenceService";
import {
  createPixelEvidenceHold,
  listPixelEvidenceHolds,
  purgePixelTelemetryUnlessHeld,
  releasePixelEvidenceHold,
} from "../pixel/evidenceHoldService";

jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock("../models/pixelEvidenceModel", () => ({
  __esModule: true,
  default: { create: jest.fn(), find: jest.fn(), findOne: jest.fn(), updateOne: jest.fn() },
}));
jest.mock("../models/pixelEvidenceApprovalModel", () => ({
  __esModule: true,
  default: { create: jest.fn(), find: jest.fn(), findOne: jest.fn() },
}));
jest.mock("../models/pixelEvidenceHoldModel", () => ({
  __esModule: true,
  default: { create: jest.fn(), find: jest.fn(), findOne: jest.fn() },
}));
jest.mock("../models/pixelTaskAccessModel", () => ({
  __esModule: true,
  default: { find: jest.fn() },
}));
jest.mock("../models/pixelUsageLogModel", () => ({
  __esModule: true,
  default: { find: jest.fn(), findOne: jest.fn() },
}));
jest.mock("../services/legalHoldService", () => ({
  __esModule: true,
  createLegalHold: jest.fn(),
  releaseLegalHold: jest.fn(),
  checkAnyLegalHold: jest.fn(),
}));
jest.mock("../pixel/usageLogService", () => ({
  __esModule: true,
  pixelUsageLogService: { deleteForUser: jest.fn() },
}));

const mockedCreateLegalHold = createLegalHold as jest.Mock;
const mockedReleaseLegalHold = releaseLegalHold as jest.Mock;
const mockedCheckAnyLegalHold = checkAnyLegalHold as jest.Mock;
const mockedDeleteForUser = (jest.requireMock("../pixel/usageLogService") as {
  pixelUsageLogService: { deleteForUser: jest.Mock };
}).pixelUsageLogService.deleteForUser;

const ACCOUNTS_TEXT = "a@example.test----SENTINEL-PW----r@example.test----SENTINEL-TOTP";
const ACTOR = { userId: "admin-1", username: "admin" };

function chain(value: unknown) {
  return { lean: () => Promise.resolve(value) };
}

function leanQuery(value: unknown) {
  // find(...).sort(...).limit(...).lean() 与 find(...).limit(...).lean() 两种链都要能走。
  const self = {
    sort: () => self,
    limit: () => self,
    select: () => self,
    lean: () => Promise.resolve(value),
  };
  return self;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedCreateLegalHold.mockResolvedValue({ _id: "hold", caseRef: "CASE-1" });
  mockedReleaseLegalHold.mockResolvedValue(1);
});

describe("evidenceCrypto", () => {
  it("加解密可回读，且密文不等于明文", () => {
    const encrypted = encryptPixelEvidence(ACCOUNTS_TEXT);
    expect(encrypted.ciphertext).not.toContain("SENTINEL-PW");
    expect(decryptPixelEvidence(encrypted)).toBe(ACCOUNTS_TEXT);
  });

  it("版本或字段不匹配一律抛错（不回退明文）", () => {
    const encrypted = encryptPixelEvidence(ACCOUNTS_TEXT);
    expect(() => decryptPixelEvidence({ ...encrypted, cryptoVersion: 0 })).toThrow(/版本/);
    expect(() => decryptPixelEvidence({ ...encrypted, tag: "" })).toThrow(/不完整/);
    expect(() => decryptPixelEvidence({ ...encrypted, ciphertext: Buffer.from("x").toString("base64") })).toThrow();
  });
});

describe("内容级取证：没有审批就不留", () => {
  it("无有效审批时不写任何东西（默认关闭）", async () => {
    (PixelEvidenceApprovalModel.findOne as jest.Mock).mockReturnValue(leanQuery(null));
    const result = await capturePixelEvidence({ userId: "user-1", accountsText: ACCOUNTS_TEXT, accountCount: 1 });
    expect(result).toEqual({ captured: false, reason: "no-active-approval" });
    expect(PixelEvidenceModel.create).not.toHaveBeenCalled();
  });

  it("有审批时写入加密内容，且到期不晚于审批到期", async () => {
    const expiresAt = new Date(Date.now() + 3 * 24 * 60 * 60_000).toISOString();
    (PixelEvidenceApprovalModel.findOne as jest.Mock).mockReturnValue(leanQuery({
      approvalId: "pxa_1", userId: "user-1", caseRef: "CASE-1", legalBasis: "warrant-1", reason: "",
      approvedByUsername: "admin", approvedAt: new Date(), expiresAt,
      revokedAt: null, revokedByUsername: "", revokeReason: "",
    }));
    (PixelEvidenceModel.create as jest.Mock).mockImplementation(async (doc: unknown) => doc);

    const result = await capturePixelEvidence({ userId: "user-1", accountsText: ACCOUNTS_TEXT, accountCount: 1 });

    expect(result.captured).toBe(true);
    const doc = (PixelEvidenceModel.create as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
    expect(doc.caseRef).toBe("CASE-1");
    expect(doc.legalBasis).toBe("warrant-1");
    expect(doc.cryptoVersion).toBe(1);
    expect(String(doc.ciphertext)).not.toContain("SENTINEL-PW");
    expect(new Date(doc.expiresAt as Date).getTime()).toBeLessThanOrEqual(new Date(expiresAt).getTime());
  });

  it("超额内容整条不留（不截断，避免伪造证据）", async () => {
    (PixelEvidenceApprovalModel.findOne as jest.Mock).mockReturnValue(leanQuery({
      approvalId: "pxa_1", userId: "user-1", caseRef: "CASE-1", legalBasis: "warrant-1", reason: "",
      approvedByUsername: "admin", approvedAt: new Date(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
      revokedAt: null, revokedByUsername: "", revokeReason: "",
    }));
    const result = await capturePixelEvidence({
      userId: "user-1",
      accountsText: "x".repeat(256 * 1024 + 1),
      accountCount: 1,
    });
    expect(result).toEqual({ captured: false, reason: "too-large" });
    expect(PixelEvidenceModel.create).not.toHaveBeenCalled();
  });

  it("审批创建/撤销都要求案件与依据，并记录经办人", async () => {
    await expect(createEvidenceApproval({ userId: "user-1", caseRef: "", legalBasis: "warrant", actor: ACTOR }))
      .rejects.toMatchObject({ code: "PIXEL_EVIDENCE_CASE_REQUIRED" });
    await expect(createEvidenceApproval({ userId: "user-1", caseRef: "CASE-1", legalBasis: "", actor: ACTOR }))
      .rejects.toMatchObject({ code: "PIXEL_EVIDENCE_BASIS_REQUIRED" });

    (PixelEvidenceApprovalModel.create as jest.Mock).mockImplementation(async (doc: unknown) => doc);
    const created = await createEvidenceApproval({ userId: "user-1", caseRef: "CASE-1", legalBasis: "warrant-1", validDays: 7, actor: ACTOR });
    expect(created.caseRef).toBe("CASE-1");
    expect(created.revokedAt).toBeNull();
    const doc = (PixelEvidenceApprovalModel.create as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
    expect(doc.approvedByUsername).toBe("admin");
    // 有效天数被硬上限夹住（最长 30 天）。
    expect(new Date(doc.expiresAt as Date).getTime()).toBeLessThanOrEqual(Date.now() + 30 * 24 * 60 * 60_000 + 5_000);
  });

  it("撤销审批会写撤销人与理由", async () => {
    const doc: Record<string, unknown> = {
      approvalId: "pxa_1", userId: "user-1", caseRef: "CASE-1", legalBasis: "warrant-1", reason: "",
      approvedByUserId: "admin-1", approvedByUsername: "admin", approvedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000), revokedAt: null, revokedByUserId: "", revokedByUsername: "", revokeReason: "",
      save: jest.fn(async () => undefined),
    };
    (PixelEvidenceApprovalModel.findOne as jest.Mock).mockResolvedValue(doc);
    const revoked = await revokeEvidenceApproval({ approvalId: "pxa_1", reason: "case closed", actor: ACTOR });
    expect(doc.revokedByUsername).toBe("admin");
    expect(revoked.revokeReason).toBe("case closed");
  });

  it("findActiveEvidenceApproval 只认未撤销未过期", async () => {
    (PixelEvidenceApprovalModel.findOne as jest.Mock).mockReturnValue(leanQuery(null));
    expect(await findActiveEvidenceApproval("user-1")).toBeNull();
    const filter = (PixelEvidenceApprovalModel.findOne as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
    expect(filter).toMatchObject({ userId: "user-1", revokedAt: null });
    expect(filter.expiresAt).toBeTruthy();
  });
});

describe("读取取证内容", () => {
  it("过期记录不可读（TTL 回收前再兜一层）", async () => {
    (PixelEvidenceModel.findOne as jest.Mock).mockReturnValue(leanQuery({
      evidenceId: "pxe_1", caseRef: "CASE-1", expiresAt: new Date(Date.now() - 1_000),
    }));
    await expect(readPixelEvidence("pxe_1")).rejects.toMatchObject({ code: "PIXEL_EVIDENCE_EXPIRED" });
  });

  it("读取成功后累加访问计数，并把密文解密回明文", async () => {
    const encrypted = encryptPixelEvidence(ACCOUNTS_TEXT);
    (PixelEvidenceModel.findOne as jest.Mock).mockReturnValue(leanQuery({
      evidenceId: "pxe_1", userId: "user-1", caseRef: "CASE-1", legalBasis: "warrant-1",
      approvedByUsername: "admin", approvedAt: new Date(), capturedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000), accountCount: 1, byteSize: 10,
      accessCount: 0, lastAccessedAt: null, truncatedFromBytes: null, ...encrypted,
    }));
    (PixelEvidenceModel.updateOne as jest.Mock).mockResolvedValue({ modifiedCount: 1 });

    const result = await readPixelEvidence("pxe_1");
    expect(result.accountsText).toBe(ACCOUNTS_TEXT);
    expect(PixelEvidenceModel.updateOne).toHaveBeenCalledWith(
      { evidenceId: "pxe_1" },
      expect.objectContaining({ $inc: { accessCount: 1 } }),
    );
  });
});

describe("法律保全", () => {
  it("缺案件编号或法律依据直接拒绝（保全必须能解释得清）", async () => {
    await expect(createPixelEvidenceHold({ userId: "user-1", caseRef: "", legalBasis: "warrant", actor: ACTOR }))
      .rejects.toMatchObject({ code: "PIXEL_HOLD_CASE_REQUIRED" });
    await expect(createPixelEvidenceHold({ userId: "user-1", caseRef: "CASE-1", legalBasis: "", actor: ACTOR }))
      .rejects.toMatchObject({ code: "PIXEL_HOLD_BASIS_REQUIRED" });
    expect(mockedCreateLegalHold).not.toHaveBeenCalled();
  });

  it("先登记 hold 再快照，快照只取白名单字段且不带 TTL", async () => {
    (PixelTaskAccessModel.find as jest.Mock).mockReturnValue(leanQuery([{
      accessId: "pxa_1", userId: "user-1", mappingId: "pcm_1", upstreamTaskId: "task-1",
      serviceType: "link_only", accountCount: 1, status: "completed", secretInternalField: "SHOULD-NOT-COPY",
    }]));
    (PixelUsageLogModel.find as jest.Mock).mockReturnValue(leanQuery([{
      logId: "pxl_1", userId: "user-1", requestedCdkMasked: "sent...9f3a", outcome: "success",
    }]));
    (PixelEvidenceHoldModel.create as jest.Mock).mockImplementation(async (doc: unknown) => doc);

    const created = await createPixelEvidenceHold({
      userId: "user-1",
      caseRef: "CASE-1",
      legalBasis: "warrant-1",
      actor: ACTOR,
    });

    expect(mockedCreateLegalHold).toHaveBeenCalledWith(expect.objectContaining({ scope: "user", value: "user-1", caseRef: "CASE-1" }));
    const doc = (PixelEvidenceHoldModel.create as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
    expect(doc.purgeAfter).toBeNull();
    expect(doc.taskAccessCount).toBe(1);
    const snapshot = (doc.taskAccess as Array<Record<string, unknown>>)[0];
    expect(Object.keys(snapshot)).not.toContain("secretInternalField");
    // 先 hold 后快照：legal hold 先被调用（fail-closed 的主依据就是它）。
    expect(mockedCreateLegalHold.mock.invocationCallOrder[0]).toBeLessThan((PixelEvidenceHoldModel.create as jest.Mock).mock.invocationCallOrder[0]);
    expect(created.usageLogCount).toBe(1);
  });

  it("解除保全时同步解除 legal hold，并设置回收时间", async () => {
    const doc: Record<string, unknown> = {
      holdId: "pxh_1", userId: "user-1", caseRef: "CASE-1", legalBasis: "warrant-1", reason: "",
      issuedByUserId: "admin-1", issuedByUsername: "admin", issuedAt: new Date(),
      taskAccess: [], usageLogs: [], taskAccessCount: 0, usageLogCount: 0, truncated: false,
      releasedAt: null, releasedByUserId: "", releasedByUsername: "", releaseReason: "", purgeAfter: null,
      save: jest.fn(async () => undefined),
    };
    (PixelEvidenceHoldModel.findOne as jest.Mock).mockResolvedValue(doc);

    const released = await releasePixelEvidenceHold({ holdId: "pxh_1", releaseReason: "case closed", actor: ACTOR, purgeDelayDays: 10 });

    expect(mockedReleaseLegalHold).toHaveBeenCalledWith(expect.objectContaining({ scope: "user", value: "user-1" }));
    expect(released.purgeAfter).toBeTruthy();
    const purgeAfter = new Date(released.purgeAfter as string).getTime();
    expect(purgeAfter).toBeGreaterThan(Date.now() + 9 * 24 * 60 * 60_000);
    expect(purgeAfter).toBeLessThan(Date.now() + 11 * 24 * 60 * 60_000);
  });

  it("列表默认只返回未解除的保全，且不带快照明细", async () => {
    (PixelEvidenceHoldModel.find as jest.Mock).mockReturnValue(leanQuery([]));
    await listPixelEvidenceHolds({});
    const filter = (PixelEvidenceHoldModel.find as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
    expect(filter).toEqual({ releasedAt: null });
  });
});

describe("账号注销时的 Pixel 溯源清理：法律保留优先", () => {
  it("命中 hold 时一律不删（含库不可用只能给出“疑似被 hold”）", async () => {
    mockedCheckAnyLegalHold.mockResolvedValue({ held: true, unknown: false, hold: { caseRef: "CASE-1" } });
    const result = await purgePixelTelemetryUnlessHeld("user-1");
    expect(result).toEqual({ skipped: true, removed: 0 });
    expect(mockedDeleteForUser).not.toHaveBeenCalled();

    mockedCheckAnyLegalHold.mockResolvedValue({ held: true, unknown: true });
    const undetermined = await purgePixelTelemetryUnlessHeld("user-1");
    expect(undetermined.skipped).toBe(true);
    expect(mockedDeleteForUser).not.toHaveBeenCalled();
  });

  it("未命中 hold 时删掉脱敏溯源", async () => {
    mockedCheckAnyLegalHold.mockResolvedValue({ held: false, unknown: false });
    mockedDeleteForUser.mockResolvedValue(3);
    const result = await purgePixelTelemetryUnlessHeld("user-1");
    expect(result).toEqual({ skipped: false, removed: 3 });
    expect(mockedDeleteForUser).toHaveBeenCalledWith("user-1");
  });
});
