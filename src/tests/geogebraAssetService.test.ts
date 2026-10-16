import { afterAll, beforeEach, describe, expect, it, jest } from "@jest/globals";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import GeoGebraAssetModel from "../models/geogebraAssetModel";
import {
  cleanupExpiredGeoGebraAssets,
  createGeoGebraAssetFromBuffer,
  createGeoGebraAssetFromDataUrl,
  detectGeoGebraAssetMimeType,
  readGeoGebraAsset,
} from "../geogebra/assetService";
import { GeoGebraDomainError } from "../geogebra/projectService";

// 资产服务是唯一会落盘的用户上传路径，测试直接落在临时目录里，
// 既验证真实文件行为，又不污染仓库工作树（GEO-18）。
let root = "";

jest.mock("../models/geogebraAssetModel", () => ({
  __esModule: true,
  default: {
    create: jest.fn(),
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    updateMany: jest.fn(),
    deleteOne: jest.fn(),
    find: jest.fn(),
  },
}));

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(32, 7),
]);

function mockAssetCreate() {
  (GeoGebraAssetModel.create as jest.Mock).mockImplementation(async (doc: unknown) => doc);
}

beforeEach(async () => {
  jest.clearAllMocks();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ggb-assets-"));
  process.env.GEOGEBRA_ASSET_ROOT = root;
});

afterAll(async () => {
  delete process.env.GEOGEBRA_ASSET_ROOT;
  if (root) await fs.rm(root, { recursive: true, force: true });
});

describe("detectGeoGebraAssetMimeType", () => {
  it("按魔数识别 PNG / JPEG / WEBP / ZIP", () => {
    expect(detectGeoGebraAssetMimeType(PNG_BYTES)).toBe("image/png");
    expect(detectGeoGebraAssetMimeType(Buffer.from([0xff, 0xd8, 0xff, 0x00]))).toBe("image/jpeg");
    expect(detectGeoGebraAssetMimeType(Buffer.concat([Buffer.alloc(8), Buffer.from("WEBP")]))).toBe("image/webp");
    expect(detectGeoGebraAssetMimeType(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe("application/zip");
  });

  it("未知内容返回 null（调用方必须据此拒绝）", () => {
    expect(detectGeoGebraAssetMimeType(Buffer.from("not-an-image"))).toBeNull();
  });
});

describe("createGeoGebraAssetFromBuffer", () => {
  it("声明格式与真实内容不一致时拒绝，且不落盘", async () => {
    mockAssetCreate();
    await expect(createGeoGebraAssetFromBuffer("user-1", "ai-reference", PNG_BYTES, "image/jpeg"))
      .rejects.toMatchObject({ code: "GEOGEBRA_ASSET_CONTENT_MISMATCH" });
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("超出体积上限时拒绝", async () => {
    mockAssetCreate();
    const big = Buffer.concat([PNG_BYTES, Buffer.alloc(4 * 1024 * 1024 + 1)]);
    await expect(createGeoGebraAssetFromBuffer("user-1", "ai-reference", big))
      .rejects.toMatchObject({ code: "GEOGEBRA_ASSET_TOO_LARGE" });
  });

  it("落盘文件名由服务端生成，且元数据写失败时回收文件", async () => {
    (GeoGebraAssetModel.create as jest.Mock).mockRejectedValueOnce(new Error("mongo down"));
    await expect(createGeoGebraAssetFromBuffer("user-1", "ai-reference", PNG_BYTES)).rejects.toThrow("mongo down");
    expect(await fs.readdir(path.join(root, "user-1"))).toEqual([]);
  });

  it("成功时返回白名单视图且不暴露存储键", async () => {
    mockAssetCreate();
    const asset = await createGeoGebraAssetFromBuffer("user-1", "ai-reference", PNG_BYTES);
    expect(Object.keys(asset).sort()).toEqual(["assetId", "byteSize", "createdAt", "expiresAt", "mimeType", "purpose"].sort());
    const stored = await fs.readdir(path.join(root, "user-1"));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatch(/^asset_[a-f0-9]{32}\.bin$/);
  });
});

describe("createGeoGebraAssetFromDataUrl", () => {
  it("接受合法 PNG data URL", async () => {
    mockAssetCreate();
    const asset = await createGeoGebraAssetFromDataUrl("user-1", "ai-reference", `data:image/png;base64,${PNG_BYTES.toString("base64")}`);
    expect(asset.mimeType).toBe("image/png");
  });

  it("拒绝非图片 MIME 与空输入", async () => {
    mockAssetCreate();
    await expect(createGeoGebraAssetFromDataUrl("user-1", "ai-reference", "data:text/html;base64,PHNjcmlwdD4="))
      .rejects.toMatchObject({ code: "GEOGEBRA_ASSET_UNSUPPORTED_TYPE" });
    await expect(createGeoGebraAssetFromDataUrl("user-1", "ai-reference", ""))
      .rejects.toMatchObject({ code: "GEOGEBRA_ASSET_EMPTY" });
  });
});

describe("readGeoGebraAsset 权限与生命周期", () => {
  it("他人资产按不存在处理（查询条件带 ownerUserId）", async () => {
    (GeoGebraAssetModel.findOne as jest.Mock).mockReturnValue({ lean: () => Promise.resolve(null) });
    await expect(readGeoGebraAsset("intruder", "asset_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"))
      .rejects.toMatchObject({ code: "GEOGEBRA_ASSET_NOT_FOUND" });
  });

  it("过期资产返回 410", async () => {
    (GeoGebraAssetModel.findOne as jest.Mock).mockReturnValue({
      lean: () => Promise.resolve({
        assetId: "asset_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ownerUserId: "user-1",
        storageKey: "asset_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.bin",
        mimeType: "image/png",
        byteSize: 10,
        expiresAt: new Date(Date.now() - 1000),
      }),
    });
    await expect(readGeoGebraAsset("user-1", "asset_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"))
      .rejects.toMatchObject({ code: "GEOGEBRA_ASSET_EXPIRED" });
  });

  it("非法 assetId 不触碰数据层", async () => {
    await expect(readGeoGebraAsset("user-1", "../../etc/passwd")).rejects.toBeInstanceOf(GeoGebraDomainError);
    expect(GeoGebraAssetModel.findOne).not.toHaveBeenCalled();
  });
});

describe("cleanupExpiredGeoGebraAssets", () => {
  it("删除过期元数据与盘上文件", async () => {
    mockAssetCreate();
    const asset = await createGeoGebraAssetFromBuffer("user-1", "ai-reference", PNG_BYTES);
    (GeoGebraAssetModel.find as jest.Mock).mockReturnValue({
      limit: () => ({
        lean: () => Promise.resolve([{
          assetId: asset.assetId,
          ownerUserId: "user-1",
          storageKey: `${asset.assetId}.bin`,
          expiresAt: new Date(Date.now() - 1000),
        }]),
      }),
    });
    (GeoGebraAssetModel.deleteOne as jest.Mock).mockResolvedValue({ deletedCount: 1 });

    const result = await cleanupExpiredGeoGebraAssets();

    expect(result.removed).toBe(1);
    expect(await fs.readdir(path.join(root, "user-1"))).toEqual([]);
    expect(GeoGebraAssetModel.deleteOne).toHaveBeenCalledWith({ assetId: asset.assetId });
  });
});
