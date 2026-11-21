import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { NextFunction, Request, Response } from "express";

/**
 * 令牌血缘只读后台（P4）的控制器语义：Mongo 未就绪回 503、查询参数门、
 * 以及最重要的 —— 出口掩码（哈希/设备/IP 不得以明文出现）。
 */

const mockMongoState = { readyState: 1 };

const mockTokenQuery = {
  countDocuments: jest.fn(),
  distinct: jest.fn(),
  find: jest.fn(),
  updateOne: jest.fn(),
};

const mockSessionFind = jest.fn();

jest.mock("../services/mongoService", () => ({
  mongoose: {
    get connection() {
      return mockMongoState;
    },
  },
}));

jest.mock("../models/mobileClientTokenModel", () => ({
  MobileClientTokenModel: mockTokenQuery,
}));

jest.mock("../models/authSessionModel", () => ({
  AuthSessionModel: { find: mockSessionFind },
}));

import { MobileTokenAdminController } from "../controllers/mobileTokenAdminController";
import { LINEAGE_MAX_GENERATIONS } from "../services/mobileTokenLineageAlertService";

type Chain = Record<string, jest.Mock>;

function chain(result: unknown): Chain {
  const link: Chain = {
    select: jest.fn(() => link),
    sort: jest.fn(() => link),
    skip: jest.fn(() => link),
    limit: jest.fn(() => link),
    lean: jest.fn(() => link),
    exec: jest.fn(async () => result),
  };
  return link;
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: null as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
    setHeader(key: string, value: string) {
      this.headers[key] = value;
    },
  };
  return res;
}

const passThrough: NextFunction = () => undefined;

/** 一张典型的"已被顶替后又复用"的代：触发整链吊销 + reusedAt 打标。 */
const REUSED_DOC = {
  _id: "id-1",
  tokenHash: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
  userId: "user-1",
  deviceId: "0f8e7d6c-5b4a-3928-1706-f5e4d3c2b1a0",
  deviceName: "Pixel 8 Pro",
  createdAt: Date.UTC(2026, 8, 20),
  expiresAt: Date.UTC(2026, 11, 20),
  revokedAt: Date.UTC(2026, 8, 26),
  lineageId: "lineage-hash-value-000000",
  rotationIndex: 6,
  supersededAt: Date.UTC(2026, 8, 25),
  supersededTo: "next-hash-value-0000000000",
  rotatedIp: "203.0.113.77",
  deviceFingerprint: "fp-hash-value-000000000000",
  riskSignals: ["GEO_JUMP"],
  reusedAt: Date.UTC(2026, 8, 26),
  reusedIp: "198.51.100.23",
};

beforeEach(() => {
  mockMongoState.readyState = 1;
  jest.clearAllMocks();
});

describe("Mongo 未就绪时", () => {
  it.each([
    ["getOverview", MobileTokenAdminController.getOverview],
    ["listLineage", MobileTokenAdminController.listLineage],
    ["listReuse", MobileTokenAdminController.listReuse],
    ["listGenerations", MobileTokenAdminController.listGenerations],
    ["listTokens", MobileTokenAdminController.listTokens],
  ] as const)("%s 直接 503，不发任何查询", async (_name, handler) => {
    mockMongoState.readyState = 0;
    const res = makeRes();
    await handler({ query: { userId: "user-1", lineageId: "x" } } as unknown as Request, res as unknown as Response, passThrough);
    expect(res.statusCode).toBe(503);
    expect(mockTokenQuery.find).not.toHaveBeenCalled();
    expect(mockTokenQuery.countDocuments).not.toHaveBeenCalled();
  });
});

describe("概览", () => {
  it("汇总计数并把近期复用事件掩码", async () => {
    mockTokenQuery.countDocuments
      .mockReturnValueOnce(chain(120)) // totalTokens
      .mockReturnValueOnce(chain(30)) // activeTokens
      .mockReturnValueOnce(chain(85)) // supersededTokens
      .mockReturnValueOnce(chain(5)) // revokedTokens
      .mockReturnValueOnce(chain(2)) // reuseTotal
      .mockReturnValueOnce(chain(1)); // reuse24h
    mockTokenQuery.distinct.mockReturnValueOnce(chain(["l-1", "l-2", "l-3"]));
    mockTokenQuery.find
      .mockReturnValueOnce(
        chain([{ userId: "user-1", lineageId: "lineage-hash-value-000000", rotationIndex: 6, deviceId: REUSED_DOC.deviceId, deviceName: "Pixel 8 Pro", reusedAt: REUSED_DOC.reusedAt, reusedIp: "198.51.100.23" }]),
      )
      .mockReturnValueOnce(chain([])); // P5：代次数越线查询，这里没有越线血缘

    const res = makeRes();
    await MobileTokenAdminController.getOverview({} as Request, res as unknown as Response, passThrough);

    const body = res.body as Record<string, any>;
    expect(body.success).toBe(true);
    expect(body.counts).toMatchObject({ totalTokens: 120, activeTokens: 30, lineages: 3, reuseTotal: 2, reuse24h: 1 });
    expect(res.headers["Cache-Control"]).toBe("no-store");

    const event = body.recentReuse[0];
    expect(event.lineageId).toBe("lineage-ha…");
    expect(JSON.stringify(body)).not.toContain("lineage-hash-value-000000");
    expect(event.reusedIp).toBe("198.51.*.*");
    expect(event.deviceId).toBe("0f8e…a0");

    expect(body.lineageAlerts).toEqual([]);
    expect(body.lineageAlertThreshold).toBe(LINEAGE_MAX_GENERATIONS);
  });

  it("代次数越线的血缘按链去重后置顶告警，只保留该链最高的一代", async () => {
    mockTokenQuery.countDocuments.mockReturnValue(chain(0));
    mockTokenQuery.distinct.mockReturnValueOnce(chain([]));
    mockTokenQuery.find
      .mockReturnValueOnce(chain([]))
      .mockReturnValueOnce(
        chain([
          { userId: "user-1", lineageId: "lineage-hash-value-000000", tokenHash: "aaa", rotationIndex: 412, deviceId: REUSED_DOC.deviceId, deviceName: "Pixel 8 Pro", createdAt: REUSED_DOC.createdAt },
          { userId: "user-1", lineageId: "lineage-hash-value-000000", tokenHash: "bbb", rotationIndex: 405, deviceId: REUSED_DOC.deviceId, deviceName: "Pixel 8 Pro", createdAt: REUSED_DOC.createdAt },
        ]),
      );

    const res = makeRes();
    await MobileTokenAdminController.getOverview({} as Request, res as unknown as Response, passThrough);

    expect(mockTokenQuery.find).toHaveBeenLastCalledWith({
      rotationIndex: { $gte: LINEAGE_MAX_GENERATIONS - 1 },
    });

    const body = res.body as Record<string, any>;
    expect(body.lineageAlerts).toHaveLength(1);
    expect(body.lineageAlerts[0].rotationIndex).toBe(412);
    expect(body.lineageAlerts[0].generationCount).toBe(413);
    expect(body.lineageAlerts[0].lineageId).toBe("lineage-ha…");
    expect(JSON.stringify(body)).not.toContain("lineage-hash-value-000000");
  });
});

describe("复用断链看板", () => {
  it("只查 reusedAt 非空的代，并按 userId 过滤", async () => {
    mockTokenQuery.find.mockReturnValueOnce(chain([REUSED_DOC]));
    mockTokenQuery.countDocuments.mockReturnValueOnce(chain(1));

    const res = makeRes();
    await MobileTokenAdminController.listReuse(
      { query: { userId: "user-1", limit: "10", offset: "0" } } as unknown as Request,
      res as unknown as Response,
      passThrough,
    );

    expect(mockTokenQuery.find).toHaveBeenCalledWith(
      expect.objectContaining({ reusedAt: { $ne: null }, userId: "user-1" }),
    );

    const body = res.body as Record<string, any>;
    const row = body.events[0];
    expect(row.tokenHash).toBe("a1b2c3d4e5…");
    expect(JSON.stringify(body)).not.toContain(REUSED_DOC.tokenHash);
    expect(JSON.stringify(body)).not.toContain("198.51.100.23");
    expect(row.reusedIp).toBe("198.51.*.*");
    expect(row.riskSignals).toEqual(["GEO_JUMP"]);
    expect(row.reusedAt).toBe(new Date(REUSED_DOC.reusedAt).toISOString());
  });

  it("limit 超过上限时压到 200", async () => {
    mockTokenQuery.find.mockReturnValueOnce(chain([]));
    mockTokenQuery.countDocuments.mockReturnValueOnce(chain(0));

    const res = makeRes();
    await MobileTokenAdminController.listReuse(
      { query: { limit: "9999" } } as unknown as Request,
      res as unknown as Response,
      passThrough,
    );

    const body = res.body as Record<string, any>;
    expect(body.limit).toBe(200);
  });
});

describe("血缘时间线", () => {
  it("lineageId 与 userId 都没给时 400", async () => {
    const res = makeRes();
    await MobileTokenAdminController.listLineage({ query: {} } as Request, res as unknown as Response, passThrough);
    expect(res.statusCode).toBe(400);
    expect(mockTokenQuery.find).not.toHaveBeenCalled();
  });

  it("按 lineageId 升序列出代次，并给当前代标 current", async () => {
    const currentDoc = {
      ...REUSED_DOC,
      tokenHash: "ffee00112233445566778899aabbccddeeff00112233445566778899aabbccdd",
      rotationIndex: 7,
      revokedAt: null,
      supersededAt: undefined,
      reusedAt: undefined,
      expiresAt: Date.UTC(2999, 0, 1),
    };
    mockTokenQuery.find.mockReturnValueOnce(chain([REUSED_DOC, currentDoc]));
    mockSessionFind.mockReturnValueOnce(
      chain([
        { clientTokenHash: REUSED_DOC.tokenHash, ipLocation: "中国, 北京", lastActivityAt: 1 },
        { clientTokenHash: currentDoc.tokenHash, ipLocation: "日本, 东京", lastActivityAt: 2 },
      ]),
    );

    const res = makeRes();
    await MobileTokenAdminController.listLineage(
      { query: { lineageId: "lineage-hash-value-000000" } } as unknown as Request,
      res as unknown as Response,
      passThrough,
    );

    expect(mockTokenQuery.find).toHaveBeenCalledWith({ lineageId: "lineage-hash-value-000000" });
    const body = res.body as Record<string, any>;
    expect(body.total).toBe(2);
    expect(body.generations[0].current).toBe(false);
    expect(body.generations[0].ipLocation).toBe("中国, 北京");
    expect(body.generations[0].reusedAt).not.toBeNull();
    expect(body.generations[1].current).toBe(true);
    expect(body.generations[1].ipLocation).toBe("日本, 东京");
    expect(JSON.stringify(body)).not.toContain(REUSED_DOC.tokenHash);
  });
});

describe("按用户查代次", () => {
  it("userId 缺失时 400", async () => {
    const res = makeRes();
    await MobileTokenAdminController.listGenerations({ query: {} } as Request, res as unknown as Response, passThrough);
    expect(res.statusCode).toBe(400);
  });

  it("带 deviceFingerprint 过滤并汇总血缘数", async () => {
    mockTokenQuery.find.mockReturnValueOnce(chain([REUSED_DOC]));
    mockTokenQuery.countDocuments.mockReturnValueOnce(chain(9));
    mockTokenQuery.distinct.mockReturnValueOnce(chain(["l-1", "l-2"]));
    mockSessionFind.mockReturnValueOnce(chain([]));

    const res = makeRes();
    await MobileTokenAdminController.listGenerations(
      { query: { userId: "user-1", deviceFingerprint: "fp-hash-value-000000000000" } } as unknown as Request,
      res as unknown as Response,
      passThrough,
    );

    expect(mockTokenQuery.find).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", deviceFingerprint: "fp-hash-value-000000000000" }),
    );
    const body = res.body as Record<string, any>;
    expect(body.total).toBe(9);
    expect(body.summary.lineages).toBe(2);
    expect(body.generations[0].deviceFingerprint).toBe("fp-hash-va…");
  });
});

describe("全部代次（全库列表）", () => {
  it("默认不限状态/关键词，按创建时间倒序分页，并回传 filters", async () => {
    mockTokenQuery.find.mockReturnValueOnce(chain([REUSED_DOC]));
    mockTokenQuery.countDocuments.mockReturnValueOnce(chain(42));
    mockSessionFind.mockReturnValueOnce(chain([]));

    const res = makeRes();
    await MobileTokenAdminController.listTokens(
      { query: { limit: "10", offset: "20" } } as unknown as Request,
      res as unknown as Response,
      passThrough,
    );

    // 不传 status/search 时不能凭空加条件：这是一张“进去就有数据”的全量表。
    expect(mockTokenQuery.find).toHaveBeenCalledWith({});
    const chainValue = mockTokenQuery.find.mock.results[0]?.value as Chain;
    expect(chainValue.sort).toHaveBeenCalledWith({ createdAt: -1 });
    expect(chainValue.skip).toHaveBeenCalledWith(20);
    expect(chainValue.limit).toHaveBeenCalledWith(10);

    const body = res.body as Record<string, any>;
    expect(body.total).toBe(42);
    expect(body.filters).toMatchObject({ search: null, status: "all", sort: "recent" });
    expect(body.generations[0].userId).toBe("user-1");
    // 出口仍然掩码（hash / 指纹 / IP 不得明文）。
    expect(body.generations[0].deviceFingerprint).toBe("fp-hash-va…");
  });

  it("status / search / sort 均下推到查询，并对关键词转义", async () => {
    mockTokenQuery.find.mockReturnValueOnce(chain([]));
    mockTokenQuery.countDocuments.mockReturnValueOnce(chain(0));
    mockSessionFind.mockReturnValueOnce(chain([]));

    const res = makeRes();
    await MobileTokenAdminController.listTokens(
      { query: { status: "reused", sort: "oldest", search: "a.b*" } } as unknown as Request,
      res as unknown as Response,
      passThrough,
    );

    const filter = mockTokenQuery.find.mock.calls[0]?.[0] as Record<string, any>;
    expect(filter.reusedAt).toEqual({ $ne: null });
    // 关键词必须是字面量：`a.b*` 不能变成通配符/病态正则。
    const regex = filter.$or?.[0]?.userId?.$regex as string;
    expect(regex).toBe("a\\.b\\*");
    const chainValue = mockTokenQuery.find.mock.results[0]?.value as Chain;
    expect(chainValue.sort).toHaveBeenCalledWith({ createdAt: 1 });
  });

  it("非法 status 回退成 all，非法 sort 回退成 recent", async () => {
    mockTokenQuery.find.mockReturnValueOnce(chain([]));
    mockTokenQuery.countDocuments.mockReturnValueOnce(chain(0));
    mockSessionFind.mockReturnValueOnce(chain([]));

    const res = makeRes();
    await MobileTokenAdminController.listTokens(
      { query: { status: "bogus", sort: "bogus" } } as unknown as Request,
      res as unknown as Response,
      passThrough,
    );

    expect(mockTokenQuery.find).toHaveBeenCalledWith({});
    expect((res.body as Record<string, any>).filters).toMatchObject({ status: "all", sort: "recent" });
    expect(res.headers["Cache-Control"]).toBe("no-store");
  });
});

describe("错误处理", () => {
  it("查询抛错时交给 next", async () => {
    mockTokenQuery.find.mockReturnValueOnce({
      sort: () => {
        throw new Error("mongo down mid-flight");
      },
    });
    const next = jest.fn();
    await MobileTokenAdminController.listReuse({ query: {} } as Request, makeRes() as unknown as Response, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});
