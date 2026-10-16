import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import GeoGebraJobModel from "../models/geogebraJobModel";
import GeoGebraProjectVersionModel from "../models/geogebraProjectVersionModel";
import { getAccessibleGeoGebraProject } from "../geogebra/projectService";
import { createGeoGebraAssetFromBuffer } from "../geogebra/assetService";
import { requestGeoGebraAi, resolveGeoGebraAiProvider } from "../geogebra/aiService";
import {
  cancelGeoGebraJob,
  createGeoGebraAiJob,
  createGeoGebraExportJob,
  listGeoGebraExportCapabilities,
  runGeoGebraJobTick,
} from "../geogebra/jobService";

// 任务域的核心不变量：能力矩阵不撒谎、幂等、配额、失败不泄漏内部细节、租约能恢复。
jest.mock("../models/geogebraJobModel", () => ({
  __esModule: true,
  GEOGEBRA_JOB_KINDS: ["ai-drawing", "ai-insight", "ai-annotation", "ai-explanation", "export"],
  default: {
    create: jest.fn(),
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    find: jest.fn(),
    countDocuments: jest.fn(),
    updateOne: jest.fn(),
    updateMany: jest.fn(),
  },
}));

jest.mock("../models/geogebraProjectVersionModel", () => ({
  __esModule: true,
  default: { find: jest.fn() },
}));

jest.mock("../geogebra/projectService", () => ({
  __esModule: true,
  GeoGebraDomainError: class GeoGebraDomainError extends Error {
    constructor(message: string, public readonly status: number, public readonly code: string) {
      super(message);
      this.name = "GeoGebraDomainError";
    }
  },
  getAccessibleGeoGebraProject: jest.fn(async () => ({ projectId: "proj-1", code: "A = (0, 0)", title: "t", folder: "f", tags: [], canvasMode: "geometry", revision: 3 })),
}));

jest.mock("../geogebra/assetService", () => ({
  __esModule: true,
  createGeoGebraAssetFromBuffer: jest.fn(async () => ({ assetId: "asset_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", purpose: "export-bundle", mimeType: "application/zip", byteSize: 10, createdAt: new Date().toISOString(), expiresAt: new Date().toISOString() })),
  readGeoGebraAsset: jest.fn(),
  deleteGeoGebraAsset: jest.fn(),
}));

jest.mock("../geogebra/aiService", () => ({
  __esModule: true,
  GEOGEBRA_AI_KINDS: ["ai-drawing", "ai-insight", "ai-annotation", "ai-explanation"],
  resolveGeoGebraAiProvider: jest.fn(() => ({ configured: true, baseUrl: "https://ai.test", apiKey: "k", model: "m", vision: false })),
  requestGeoGebraAi: jest.fn(),
}));

const mockedResolveProvider = resolveGeoGebraAiProvider as jest.Mock;
const mockedRequestAi = requestGeoGebraAi as jest.Mock;

function asJobDoc(over: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    jobId: "ggbjob_1",
    kind: "export",
    ownerUserId: "user-1",
    projectId: "proj-1",
    status: "queued",
    idempotencyKey: "export:abc",
    progress: 0,
    input: { projectId: "proj-1", format: "zip-bundle" },
    result: null,
    errorCode: null,
    errorMessage: null,
    attempts: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    subjectDeletedAt: 0,
    createdAt: now,
    updatedAt: now,
    expiresAt: new Date(now.getTime() + 3600_000),
    ...over,
  };
}

beforeEach(async () => {
  jest.clearAllMocks();
  process.env.GEOGEBRA_TMP_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), "ggb-tmp-"));
  mockedResolveProvider.mockReturnValue({ configured: true, baseUrl: "https://ai.test", apiKey: "k", model: "m", vision: false });
  (GeoGebraJobModel.countDocuments as jest.Mock).mockResolvedValue(0);
  (GeoGebraJobModel.create as jest.Mock).mockImplementation(async (doc: unknown) => doc);
  (GeoGebraJobModel.findOneAndUpdate as jest.Mock).mockReturnValue({ lean: () => Promise.resolve(null) });
  (GeoGebraJobModel.updateOne as jest.Mock).mockResolvedValue({ modifiedCount: 1 });
  (GeoGebraJobModel.updateMany as jest.Mock).mockResolvedValue({ modifiedCount: 0 });
  (GeoGebraProjectVersionModel.find as jest.Mock).mockReturnValue({ sort: () => ({ limit: () => ({ lean: () => Promise.resolve([]) }) }) });
});

describe("导出能力矩阵", () => {
  it("只有服务端真能产出的格式才标 serverSide", () => {
    const capabilities = listGeoGebraExportCapabilities();
    expect(capabilities.find((item) => item.format === "zip-bundle")?.serverSide).toBe(true);
    for (const format of ["svg", "pdf", "gif", "mp4", "pptx"]) {
      expect(capabilities.find((item) => item.format === format)?.serverSide).toBe(false);
    }
  });

  it("画布侧格式明确拒绝，而不是排一个永远失败的任务", async () => {
    await expect(createGeoGebraExportJob({ userId: "user-1", projectId: "proj-1", format: "mp4" }))
      .rejects.toMatchObject({ code: "GEOGEBRA_EXPORT_FORMAT_UNSUPPORTED" });
    expect(GeoGebraJobModel.create).not.toHaveBeenCalled();
  });

  it("未知格式与缺项目分别报 400", async () => {
    await expect(createGeoGebraExportJob({ userId: "user-1", projectId: "proj-1", format: "docx" }))
      .rejects.toMatchObject({ code: "GEOGEBRA_EXPORT_FORMAT_UNKNOWN" });
    await expect(createGeoGebraExportJob({ userId: "user-1", projectId: "", format: "zip-bundle" }))
      .rejects.toMatchObject({ code: "GEOGEBRA_EXPORT_PROJECT_REQUIRED" });
  });
});

describe("任务创建", () => {
  it("AI 未配置时 fail-closed，不入队", async () => {
    mockedResolveProvider.mockReturnValue({ configured: false, baseUrl: "", apiKey: "", model: "", vision: false, reason: "未配置" });
    await expect(createGeoGebraAiJob({ userId: "user-1", kind: "ai-insight", code: "A = (0,0)" }))
      .rejects.toMatchObject({ code: "GEOGEBRA_AI_UNAVAILABLE" });
    expect(GeoGebraJobModel.create).not.toHaveBeenCalled();
  });

  it("已有未终态任务时按幂等返回既有任务，不重复创建", async () => {
    (GeoGebraJobModel.findOne as jest.Mock).mockReturnValue({ lean: () => Promise.resolve(asJobDoc({ jobId: "ggbjob_existing" })) });
    const job = await createGeoGebraAiJob({ userId: "user-1", kind: "ai-insight", code: "A = (0,0)" });
    expect(job.jobId).toBe("ggbjob_existing");
    expect(GeoGebraJobModel.create).not.toHaveBeenCalled();
  });

  it("活跃任务超额时拒绝（每用户并发配额）", async () => {
    (GeoGebraJobModel.findOne as jest.Mock).mockReturnValue({ lean: () => Promise.resolve(null) });
    (GeoGebraJobModel.countDocuments as jest.Mock).mockResolvedValue(3);
    await expect(createGeoGebraAiJob({ userId: "user-1", kind: "ai-insight", code: "A = (0,0)" }))
      .rejects.toMatchObject({ code: "GEOGEBRA_JOB_QUOTA_EXCEEDED" });
  });

  it("AI 任务只存参考图 assetId，不把图片字节写进任务文档", async () => {
    (GeoGebraJobModel.findOne as jest.Mock).mockReturnValue({ lean: () => Promise.resolve(null) });
    await createGeoGebraAiJob({
      userId: "user-1",
      kind: "ai-drawing",
      prompt: "画一个圆",
      referenceAssetId: "asset_cccccccccccccccccccccccccccccccc",
    });
    const payload = (GeoGebraJobModel.create as jest.Mock).mock.calls[0][0] as { input: Record<string, unknown> };
    expect(payload.input.referenceAssetId).toBe("asset_cccccccccccccccccccccccccccccccc");
    expect(JSON.stringify(payload.input)).not.toContain("base64");
  });
});

describe("取消", () => {
  it("无活跃任务时幂等返回既有任务状态", async () => {
    (GeoGebraJobModel.findOneAndUpdate as jest.Mock).mockReturnValue({ lean: () => Promise.resolve(null) });
    (GeoGebraJobModel.findOne as jest.Mock).mockReturnValue({ lean: () => Promise.resolve(asJobDoc({ status: "completed" })) });
    const job = await cancelGeoGebraJob("user-1", "ggbjob_1");
    expect(job.status).toBe("completed");
  });

  it("任务不存在时报 404", async () => {
    (GeoGebraJobModel.findOneAndUpdate as jest.Mock).mockReturnValue({ lean: () => Promise.resolve(null) });
    (GeoGebraJobModel.findOne as jest.Mock).mockReturnValue({ lean: () => Promise.resolve(null) });
    await expect(cancelGeoGebraJob("user-1", "ggbjob_missing")).rejects.toMatchObject({ code: "GEOGEBRA_JOB_NOT_FOUND" });
  });
});

describe("runGeoGebraJobTick", () => {
  it("没有可领取任务时回收过期租约", async () => {
    const result = await runGeoGebraJobTick("runner-test");
    expect(result.processed).toBe(false);
    expect(GeoGebraJobModel.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ status: "running" }),
      expect.objectContaining({ $set: expect.objectContaining({ status: "queued" }) }),
    );
  });

  it("领取后执行导出打包，并把结果写回（只按持有租约的 running 任务写）", async () => {
    (GeoGebraJobModel.findOneAndUpdate as jest.Mock).mockReturnValue({ lean: () => Promise.resolve(asJobDoc()) });

    const result = await runGeoGebraJobTick("runner-test");

    expect(result.processed).toBe(true);
    const [, update] = (GeoGebraJobModel.updateOne as jest.Mock).mock.calls[0] as [Record<string, unknown>, { $set: Record<string, unknown> }];
    expect(update.$set.status).toBe("completed");
    expect((update.$set.result as { assetId?: string }).assetId).toBe("asset_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    // 结果与状态只在租约仍归本次 runner、且任务仍是 running 时写入。
    expect((GeoGebraJobModel.updateOne as jest.Mock).mock.calls[0][0]).toMatchObject({ leaseOwner: "runner-test", status: "running" });
    expect(createGeoGebraAssetFromBuffer).toHaveBeenCalledTimes(1);
    expect(getAccessibleGeoGebraProject).toHaveBeenCalledWith("user-1", "proj-1", "read");
  });

  it("执行失败时只记录白名单错误码与面向用户的文案，不写栈", async () => {
    (GeoGebraJobModel.findOneAndUpdate as jest.Mock).mockReturnValue({ lean: () => Promise.resolve(asJobDoc({ kind: "ai-insight", input: { code: "A = (0,0)", canvasMode: "geometry" } })) });
    mockedRequestAi.mockRejectedValue(new Error("upstream exploded: secret=abc"));

    await runGeoGebraJobTick("runner-test");

    const [, update] = (GeoGebraJobModel.updateOne as jest.Mock).mock.calls[0] as [Record<string, unknown>, { $set: Record<string, unknown> }];
    expect(update.$set.status).toBe("failed");
    expect(update.$set.errorCode).toBe("GEOGEBRA_JOB_FAILED");
    expect(String(update.$set.errorMessage)).not.toContain("secret=abc");
    expect(update.$set).not.toHaveProperty("stack");
  });
});
