// GEO-G6：公开分享撤销后的失效链路（getShare / cover / fork 全 404），
// 以及 GEO-17 的 embedUrl 契约。
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("../models/geogebraShareModel", () => ({
  __esModule: true,
  default: { findOne: jest.fn(), updateOne: jest.fn(), find: jest.fn() },
}));
jest.mock("../models/geogebraProjectModel", () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock("../models/geogebraProjectVersionModel", () => ({ __esModule: true, default: {} }));
jest.mock("../models/geogebraReviewCommentModel", () => ({ __esModule: true, default: {} }));
jest.mock("../geogebra/shareAssetStorage", () => ({
  __esModule: true,
  decodeGeoGebraPngDataUrl: jest.fn(() => null),
  deleteGeoGebraShareCover: jest.fn(async () => undefined),
  readGeoGebraShareCover: jest.fn(async () => null),
  writeGeoGebraShareCover: jest.fn(async () => undefined),
}));

import GeoGebraShareModel from "../models/geogebraShareModel";
import { deleteGeoGebraShareCover } from "../geogebra/shareAssetStorage";
import {
  deleteGeoGebraShare,
  forkGeoGebraShare,
  getPublicGeoGebraShare,
  getPublicGeoGebraShareCover,
} from "../geogebra/shareService";

const shareFindOne = (GeoGebraShareModel as unknown as { findOne: jest.Mock }).findOne;
const shareUpdateOne = (GeoGebraShareModel as unknown as { updateOne: jest.Mock }).updateOne;
const deleteCover = deleteGeoGebraShareCover as unknown as jest.Mock;

const ACTIVE_SHARE = {
  shareId: "share_0123456789abcdef",
  slug: "canvas-abc123",
  ownerUserId: "owner",
  projectId: null,
  title: "公开画布",
  canvasMode: "geometry",
  commands: ["A = (0, 0)", "B = (3, 0)"],
  coverStored: true,
  allowFork: true,
  revokedAt: null,
  subjectDeletedAt: 0,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

function lean(value: unknown) {
  return { lean: async () => value } as never;
}

beforeEach(() => {
  jest.clearAllMocks();
  shareFindOne.mockReturnValue(lean(null));
  shareUpdateOne.mockResolvedValue({} as never);
});

describe("GEO-17 embedUrl", () => {
  it("活跃分享返回相对 embed 地址，并带 ?embed=1", async () => {
    shareFindOne.mockReturnValue(lean(ACTIVE_SHARE));
    const share = await getPublicGeoGebraShare("canvas-abc123");
    expect(share.embedUrl).toBe("/geogebra/share/canvas-abc123?embed=1");
    expect(share.coverUrl).toBe("/api/geogebra/shares/canvas-abc123/cover");
    // 公开读取必须把撤销/软删除条件下推到查询，不能先查出来再在内存里过滤。
    expect(shareFindOne).toHaveBeenCalledWith(expect.objectContaining({
      slug: "canvas-abc123",
      revokedAt: null,
      subjectDeletedAt: 0,
    }));
  });
});

describe("GEO-G6 撤销后全部 404", () => {
  it("getShare / cover / fork 在撤销后都不可用", async () => {
    // 撤销后的查询条件（revokedAt: null）命不中任何文档 → 三条路径都必须 404。
    shareFindOne.mockReturnValue({
      lean: async () => null,
      select: () => lean(null),
    } as never);
    await expect(getPublicGeoGebraShare("canvas-abc123"))
      .rejects.toMatchObject({ status: 404, code: "GEOGEBRA_SHARE_NOT_FOUND" });

    await expect(getPublicGeoGebraShareCover("canvas-abc123"))
      .rejects.toMatchObject({ status: 404, code: "GEOGEBRA_SHARE_COVER_NOT_FOUND" });

    await expect(forkGeoGebraShare("user-1", "canvas-abc123"))
      .rejects.toMatchObject({ status: 404, code: "GEOGEBRA_SHARE_NOT_FOUND" });
  });

  it("撤销操作写入 revokedAt 并删除封面文件", async () => {
    shareFindOne.mockReturnValue(lean(ACTIVE_SHARE));
    await deleteGeoGebraShare("owner", ACTIVE_SHARE.shareId);

    expect(shareUpdateOne).toHaveBeenCalledTimes(1);
    const update = shareUpdateOne.mock.calls[0][1] as { $set: { revokedAt: Date; coverStored: boolean } };
    expect(update.$set.revokedAt).toBeInstanceOf(Date);
    expect(update.$set.coverStored).toBe(false);
    expect(deleteCover).toHaveBeenCalledWith(ACTIVE_SHARE.shareId);
  });

  it("非所有者撤销同样按 404 处理（不泄漏分享是否存在）", async () => {
    shareFindOne.mockReturnValue(lean(ACTIVE_SHARE));
    await expect(deleteGeoGebraShare("intruder", ACTIVE_SHARE.shareId))
      .rejects.toMatchObject({ status: 404, code: "GEOGEBRA_SHARE_NOT_FOUND" });
    expect(shareUpdateOne).not.toHaveBeenCalled();
    expect(deleteCover).not.toHaveBeenCalled();
  });
});
