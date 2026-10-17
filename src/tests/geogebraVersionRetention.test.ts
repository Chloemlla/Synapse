// GEO-11：云端版本保留上限。
//
// PRD 默认保留 24 个版本；实现按项目内最旧裁剪，但**不删除被评论引用的版本**
// （评论以 versionId 为锚点，删掉会制造悬空引用）。仓库没有 GeoGebra 版本级 legal hold。
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("../models/geogebraProjectModel", () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock("../models/geogebraProjectVersionModel", () => ({
  __esModule: true,
  default: { create: jest.fn(), find: jest.fn(), deleteMany: jest.fn() },
}));
jest.mock("../models/geogebraReviewCommentModel", () => ({
  __esModule: true,
  default: { distinct: jest.fn() },
}));
jest.mock("../models/geogebraShareModel", () => ({ __esModule: true, default: {} }));
jest.mock("../services/workspaceService", () => ({ workspaceService: { getMemberRole: jest.fn() } }));

import GeoGebraProjectModel from "../models/geogebraProjectModel";
import GeoGebraProjectVersionModel from "../models/geogebraProjectVersionModel";
import GeoGebraReviewCommentModel from "../models/geogebraReviewCommentModel";
import {
  createGeoGebraVersion,
  DEFAULT_GEOGEBRA_VERSION_RETENTION,
  geoGebraVersionRetentionLimit,
  pruneGeoGebraVersions,
} from "../geogebra/projectService";

const projectFindOne = (GeoGebraProjectModel as unknown as { findOne: jest.Mock }).findOne;
const versionFind = (GeoGebraProjectVersionModel as unknown as { find: jest.Mock }).find;
const versionCreate = (GeoGebraProjectVersionModel as unknown as { create: jest.Mock }).create;
const versionDeleteMany = (GeoGebraProjectVersionModel as unknown as { deleteMany: jest.Mock }).deleteMany;
const commentDistinct = (GeoGebraReviewCommentModel as unknown as { distinct: jest.Mock }).distinct;

let rows: Array<{ versionId: string }> = [];

function lean(value: unknown) {
  return { lean: async () => value } as never;
}

function mockVersionQuery() {
  return {
    sort: () => ({ select: () => lean(rows) }),
  } as never;
}

const PROJECT = {
  projectId: "proj_retention_1",
  ownerUserId: "owner",
  workspaceId: null,
  code: "A = (0, 0)",
  canvasMode: "geometry",
  revision: 1,
};

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.GEOGEBRA_VERSION_RETENTION_LIMIT;
  rows = [];
  projectFindOne.mockReturnValue(lean(PROJECT));
  versionFind.mockImplementation(mockVersionQuery);
  versionCreate.mockImplementation(async (doc: unknown) => doc);
  versionDeleteMany.mockResolvedValue({ deletedCount: 0 } as never);
  commentDistinct.mockResolvedValue([] as never);
});

describe("GEO-11 版本保留上限", () => {
  it("默认上限是 24，环境变量可覆盖并被钳制在 1..500", () => {
    expect(DEFAULT_GEOGEBRA_VERSION_RETENTION).toBe(24);
    expect(geoGebraVersionRetentionLimit({})).toBe(24);
    expect(geoGebraVersionRetentionLimit({ GEOGEBRA_VERSION_RETENTION_LIMIT: "12" })).toBe(12);
    expect(geoGebraVersionRetentionLimit({ GEOGEBRA_VERSION_RETENTION_LIMIT: "0" })).toBe(1);
    expect(geoGebraVersionRetentionLimit({ GEOGEBRA_VERSION_RETENTION_LIMIT: "9999" })).toBe(500);
    expect(geoGebraVersionRetentionLimit({ GEOGEBRA_VERSION_RETENTION_LIMIT: "not-a-number" })).toBe(24);
  });

  it("按项目内最旧裁剪，且跳过被评论引用的版本", async () => {
    rows = [{ versionId: "v1" }, { versionId: "v2" }, { versionId: "v3" }, { versionId: "v4" }, { versionId: "v5" }];
    commentDistinct.mockResolvedValue(["v4"] as never);
    versionDeleteMany.mockResolvedValue({ deletedCount: 1 } as never);

    const result = await pruneGeoGebraVersions("proj_retention_1", 3);

    expect(commentDistinct).toHaveBeenCalledWith("versionId", {
      projectId: "proj_retention_1",
      versionId: { $in: ["v4", "v5"] },
    });
    expect(versionDeleteMany).toHaveBeenCalledWith({
      projectId: "proj_retention_1",
      versionId: { $in: ["v5"] },
    });
    expect(result).toEqual({ removed: 1, protected: 1 });
  });

  it("未超过上限时不做任何删除", async () => {
    rows = [{ versionId: "v1" }, { versionId: "v2" }];
    const result = await pruneGeoGebraVersions("proj_retention_1", 3);
    expect(versionDeleteMany).not.toHaveBeenCalled();
    expect(result).toEqual({ removed: 0, protected: 0 });
  });

  it("全部超出项都被评论引用时不删除，并如实报告 protected 数量", async () => {
    rows = [{ versionId: "v1" }, { versionId: "v2" }, { versionId: "v3" }, { versionId: "v4" }];
    commentDistinct.mockResolvedValue(["v3", "v4"] as never);
    const result = await pruneGeoGebraVersions("proj_retention_1", 2);
    expect(versionDeleteMany).not.toHaveBeenCalled();
    expect(result).toEqual({ removed: 0, protected: 2 });
  });

  it("创建版本后会自动执行裁剪（上限不是只写在文档里）", async () => {
    await createGeoGebraVersion("owner", "proj_retention_1", {
      label: "手动快照",
      code: "A = (0, 0)",
      canvasMode: "geometry",
      trigger: "manual",
    });
    expect(versionCreate).toHaveBeenCalledTimes(1);
    expect(versionFind).toHaveBeenCalledWith({ projectId: "proj_retention_1", subjectDeletedAt: 0 });
  });
});
