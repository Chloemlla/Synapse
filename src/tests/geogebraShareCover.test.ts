// 分享封面是客户端上传的 data URL：格式/体积不符时应得到可理解的 400，
// 而不是被控制器归为 500；并且校验失败前不能把分享写进库。
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("../models/geogebraShareModel", () => ({
  __esModule: true,
  default: { create: jest.fn(), findOne: jest.fn(), updateOne: jest.fn() },
}));
jest.mock("../models/geogebraProjectModel", () => ({ __esModule: true, default: { findOne: jest.fn() } }));
jest.mock("../models/geogebraProjectVersionModel", () => ({ __esModule: true, default: {} }));
jest.mock("../models/geogebraReviewCommentModel", () => ({ __esModule: true, default: {} }));
jest.mock("../geogebra/shareAssetStorage", () => ({
  __esModule: true,
  decodeGeoGebraPngDataUrl: jest.fn(() => { throw new Error("封面仅支持 PNG 图片。"); }),
  deleteGeoGebraShareCover: jest.fn(async () => undefined),
  readGeoGebraShareCover: jest.fn(async () => null),
  writeGeoGebraShareCover: jest.fn(async () => undefined),
}));

import GeoGebraShareModel from "../models/geogebraShareModel";
import { createGeoGebraShare, GeoGebraDomainError } from "../geogebra/shareService";

const shareCreate = (GeoGebraShareModel as unknown as { create: jest.Mock }).create;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("createGeoGebraShare cover validation", () => {
  it("封面无法解码时返回 400 业务错且不落库", async () => {
    await expect(createGeoGebraShare("user-1", {
      title: "公开画布",
      canvasMode: "geometry",
      commands: ["A = (0, 0)"],
      coverDataUrl: "data:image/png;base64,not-a-png",
    })).rejects.toMatchObject({
      name: "GeoGebraDomainError",
      status: 400,
      code: "GEOGEBRA_SHARE_COVER_INVALID",
    } satisfies Partial<GeoGebraDomainError>);
    expect(shareCreate).not.toHaveBeenCalled();
  });
});
