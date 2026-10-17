// GEO-G6：跨用户 / 团队角色 / 资产归属的授权断言。
//
// 判据来自 PRD §10-D：他人项目/评论/资产必须 404（不泄漏存在性）、viewer 不能写、
// 关闭 fork 的分享不能创建副本。这里通过替身模型直接驱动 service 层，不连 Mongo。
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("../models/geogebraProjectModel", () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock("../models/geogebraProjectVersionModel", () => ({
  __esModule: true,
  default: { find: jest.fn(), findOne: jest.fn(), exists: jest.fn(), deleteMany: jest.fn() },
}));
jest.mock("../models/geogebraReviewCommentModel", () => ({
  __esModule: true,
  default: { find: jest.fn(), findOne: jest.fn(), create: jest.fn() },
}));
jest.mock("../models/geogebraShareModel", () => ({
  __esModule: true,
  default: { findOne: jest.fn(), find: jest.fn(), updateOne: jest.fn(), updateMany: jest.fn() },
}));
jest.mock("../models/geogebraAssetModel", () => ({
  __esModule: true,
  default: { findOne: jest.fn() },
}));
jest.mock("../services/workspaceService", () => ({
  workspaceService: { getMemberRole: jest.fn(), getUserWorkspaces: jest.fn() },
}));
jest.mock("../geogebra/shareAssetStorage", () => ({
  __esModule: true,
  decodeGeoGebraPngDataUrl: jest.fn(() => null),
  deleteGeoGebraShareCover: jest.fn(async () => undefined),
  readGeoGebraShareCover: jest.fn(async () => null),
  writeGeoGebraShareCover: jest.fn(async () => undefined),
}));

import GeoGebraProjectModel from "../models/geogebraProjectModel";
import GeoGebraProjectVersionModel from "../models/geogebraProjectVersionModel";
import GeoGebraReviewCommentModel from "../models/geogebraReviewCommentModel";
import GeoGebraShareModel from "../models/geogebraShareModel";
import GeoGebraAssetModel from "../models/geogebraAssetModel";
import { workspaceService } from "../services/workspaceService";
import { getAccessibleGeoGebraProject, listGeoGebraVersions } from "../geogebra/projectService";
import { createGeoGebraComment, listGeoGebraComments } from "../geogebra/reviewCommentService";
import { readGeoGebraAsset } from "../geogebra/assetService";
import { forkGeoGebraShare } from "../geogebra/shareService";

const projectFindOne = (GeoGebraProjectModel as unknown as { findOne: jest.Mock }).findOne;
const versionFind = (GeoGebraProjectVersionModel as unknown as { find: jest.Mock }).find;
const commentFind = (GeoGebraReviewCommentModel as unknown as { find: jest.Mock }).find;
const shareFindOne = (GeoGebraShareModel as unknown as { findOne: jest.Mock }).findOne;
const assetFindOne = (GeoGebraAssetModel as unknown as { findOne: jest.Mock }).findOne;
const getMemberRole = (workspaceService as unknown as { getMemberRole: jest.Mock }).getMemberRole;

function lean(value: unknown) {
  return { lean: async () => value } as never;
}

const OWNED_BY_SOMEONE_ELSE = {
  projectId: "proj_owner_0001",
  ownerUserId: "owner",
  workspaceId: null,
  code: "A = (0, 0)",
  canvasMode: "geometry",
  revision: 1,
};

beforeEach(() => {
  jest.clearAllMocks();
  projectFindOne.mockReturnValue(lean(OWNED_BY_SOMEONE_ELSE));
  versionFind.mockReturnValue({ sort: () => ({ limit: () => lean([]) }) } as never);
  commentFind.mockReturnValue({ sort: () => ({ limit: () => lean([]) }) } as never);
  shareFindOne.mockReturnValue(lean(null));
  assetFindOne.mockReturnValue(lean(null));
  getMemberRole.mockResolvedValue(null);
});

describe("GeoGebra 项目访问（GEO-G6）", () => {
  it("他人项目一律 404，即使知道 projectId 也不泄漏存在性", async () => {
    await expect(getAccessibleGeoGebraProject("intruder", "proj_owner_0001", "read"))
      .rejects.toMatchObject({ status: 404, code: "GEOGEBRA_PROJECT_NOT_FOUND" });
    // 没有工作区时连成员查询都不做：授权只可能来自 owner 或工作区成员。
    expect(getMemberRole).not.toHaveBeenCalled();
  });

  it("viewer 可以读、不能写、不能评论", async () => {
    projectFindOne.mockReturnValue(lean({ ...OWNED_BY_SOMEONE_ELSE, workspaceId: "ws_1" }));
    getMemberRole.mockResolvedValue("viewer");

    await expect(getAccessibleGeoGebraProject("viewer-1", "proj_owner_0001", "read")).resolves.toBeTruthy();
    await expect(getAccessibleGeoGebraProject("viewer-1", "proj_owner_0001", "write"))
      .rejects.toMatchObject({ status: 404 });
    await expect(getAccessibleGeoGebraProject("viewer-1", "proj_owner_0001", "comment"))
      .rejects.toMatchObject({ status: 404 });
  });

  it("editor 可以写、不能评论（评论需要 reviewer 及以上）", async () => {
    projectFindOne.mockReturnValue(lean({ ...OWNED_BY_SOMEONE_ELSE, workspaceId: "ws_1" }));
    getMemberRole.mockResolvedValue("editor");

    await expect(getAccessibleGeoGebraProject("editor-1", "proj_owner_0001", "write")).resolves.toBeTruthy();
    await expect(getAccessibleGeoGebraProject("editor-1", "proj_owner_0001", "comment"))
      .rejects.toMatchObject({ status: 404 });
  });

  it("无权限用户列版本时在读权限一步就 404，不会查版本表", async () => {
    await expect(listGeoGebraVersions("intruder", "proj_owner_0001"))
      .rejects.toMatchObject({ status: 404, code: "GEOGEBRA_PROJECT_NOT_FOUND" });
    expect(versionFind).not.toHaveBeenCalled();
  });
});

describe("GeoGebra 评论与资产越权（GEO-G6）", () => {
  it("不能给他人项目写评论，也不能读他人项目评论", async () => {
    await expect(createGeoGebraComment("intruder", { projectId: "proj_owner_0001", body: "越权评论" }))
      .rejects.toMatchObject({ status: 404, code: "GEOGEBRA_PROJECT_NOT_FOUND" });
    await expect(listGeoGebraComments("intruder", "proj_owner_0001"))
      .rejects.toMatchObject({ status: 404, code: "GEOGEBRA_PROJECT_NOT_FOUND" });
    expect(commentFind).not.toHaveBeenCalled();
  });

  it("资产读取把 ownerUserId 写进查询条件，他人资产 404", async () => {
    await expect(readGeoGebraAsset("intruder", `asset_${"a".repeat(32)}`))
      .rejects.toMatchObject({ status: 404, code: "GEOGEBRA_ASSET_NOT_FOUND" });
    expect(assetFindOne).toHaveBeenCalledWith(expect.objectContaining({
      ownerUserId: "intruder",
      subjectDeletedAt: 0,
    }));
  });
});

describe("GeoGebra 分享 fork（GEO-G6）", () => {
  it("分享关闭 fork 时拒绝创建副本", async () => {
    shareFindOne.mockReturnValue(lean({
      slug: "canvas-abc123",
      allowFork: false,
      revokedAt: null,
      subjectDeletedAt: 0,
      commands: ["A = (0, 0)"],
    }));
    await expect(forkGeoGebraShare("user-1", "canvas-abc123"))
      .rejects.toMatchObject({ status: 403, code: "GEOGEBRA_SHARE_FORK_DISABLED" });
  });

  it("已撤销/不存在的分享 fork 一律 404", async () => {
    shareFindOne.mockReturnValue(lean(null));
    await expect(forkGeoGebraShare("user-1", "canvas-abc123"))
      .rejects.toMatchObject({ status: 404, code: "GEOGEBRA_SHARE_NOT_FOUND" });
  });
});
