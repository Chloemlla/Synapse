import { beforeEach, describe, expect, it, jest } from "@jest/globals";

interface StoredEntry {
  _id: string;
  value: unknown;
  expiresAt: Date;
}

// 用共享替身承载「Mongo 层」：模型方法换成内存实现，于是能测到 store 里真正的
// 过期过滤 / upsert 抢占 / 一次性读取逻辑，而不需要起 Mongo（CI 也没有 Mongo）。
const mockState = new Map<string, StoredEntry>();

const mockModel = {
  async updateOne(filter: any, update: any, options: any) {
    const id = filter?._id as string;
    const existing = mockState.get(id);
    const onlyExpired = Boolean(filter?.expiresAt?.$lte);
    if (existing && !(onlyExpired && existing.expiresAt <= new Date())) {
      return { matchedCount: 1, upsertedCount: 0 };
    }
    if (!options?.upsert) return { matchedCount: 0, upsertedCount: 0 };
    mockState.set(id, { _id: id, value: update?.$set?.value, expiresAt: new Date(update?.$set?.expiresAt) });
    return { matchedCount: existing ? 1 : 0, upsertedCount: existing ? 0 : 1 };
  },
  findOne(filter: any) {
    return {
      lean: () => ({
        exec: async () => {
          const entry = mockState.get(filter?._id as string);
          if (!entry || entry.expiresAt <= new Date()) return null;
          return { value: entry.value };
        },
      }),
    };
  },
  findOneAndDelete(filter: any) {
    return {
      lean: () => ({
        exec: async () => {
          const id = filter?._id as string;
          const entry = mockState.get(id);
          if (!entry || entry.expiresAt <= new Date()) return null;
          mockState.delete(id);
          return { value: entry.value };
        },
      }),
    };
  },
  async deleteOne(filter: any) {
    const removed = mockState.delete(filter?._id as string);
    return { deletedCount: removed ? 1 : 0 };
  },
  async deleteMany(filter: any) {
    const pattern = filter?._id?.$regex as string | undefined;
    if (!pattern) return { deletedCount: 0 };
    const matcher = new RegExp(pattern);
    let deletedCount = 0;
    for (const id of [...mockState.keys()]) {
      if (matcher.test(id)) {
        mockState.delete(id);
        deletedCount += 1;
      }
    }
    return { deletedCount };
  },
};

const mockMongo = { connection: { readyState: 0 } };

jest.mock("../services/mongoService", () => ({
  mongoose: {
    connection: mockMongo.connection,
    Schema: class MockSchema {
      index() {
        return this;
      }
      static Types = { Mixed: class MockMixed {} };
    },
    models: {},
    model: () => mockModel,
  },
}));

import { sharedStateStore } from "../services/sharedStateStore";

describe("sharedStateStore", () => {
  beforeEach(() => {
    mockState.clear();
    sharedStateStore.clearMemory();
    mockMongo.connection.readyState = 0;
  });

  describe("进程内存兜底层（Mongo/Redis 都不可用）", () => {
    it("层级判定为 memory，且明确标记不共享", () => {
      expect(sharedStateStore.tier()).toBe("memory");
      expect(sharedStateStore.isShared()).toBe(false);
      expect(sharedStateStore.stats().shared).toBe(false);
    });

    it("set/get/delete 与 TTL 生效", async () => {
      await sharedStateStore.set("test:key", { a: 1 }, 60_000);
      expect(await sharedStateStore.get("test:key")).toEqual({ a: 1 });

      await sharedStateStore.set("test:expired", "x", 1);
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(await sharedStateStore.get("test:expired")).toBeNull();

      expect(await sharedStateStore.delete("test:key")).toBe(true);
      expect(await sharedStateStore.get("test:key")).toBeNull();
      expect(await sharedStateStore.delete("test:key")).toBe(false);
    });

    it("claim 在单实例内是一次性语义", async () => {
      expect(await sharedStateStore.claim("test:lock", 60_000)).toBe(true);
      expect(await sharedStateStore.claim("test:lock", 60_000)).toBe(false);
    });

    it("consume 只能成功取到一次", async () => {
      await sharedStateStore.set("test:nonce", "nonce-value", 60_000);
      expect(await sharedStateStore.consume("test:nonce")).toBe("nonce-value");
      expect(await sharedStateStore.consume("test:nonce")).toBeNull();
    });
  });

  describe("Mongo 共享层（未配置 Redis 时的权威层）", () => {
    beforeEach(() => {
      mockMongo.connection.readyState = 1;
    });

    it("层级判定为 mongo 且视为共享", () => {
      expect(sharedStateStore.tier()).toBe("mongo");
      expect(sharedStateStore.isShared()).toBe(true);
    });

    it("set/get 走 Mongo，且过期文档读不到", async () => {
      await sharedStateStore.set("oauth:state:abc", { userId: "u1" }, 60_000);
      expect(mockState.get("oauth:state:abc")?.value).toEqual({ userId: "u1" });
      expect(await sharedStateStore.get("oauth:state:abc")).toEqual({ userId: "u1" });

      mockState.set("oauth:state:stale", {
        _id: "oauth:state:stale",
        value: { userId: "u2" },
        expiresAt: new Date(Date.now() - 1_000),
      });
      expect(await sharedStateStore.get("oauth:state:stale")).toBeNull();
    });

    it("claim 抢占：未过期的锁抢不到，过期后可再次抢到", async () => {
      expect(await sharedStateStore.claim("scheduler:cleanup", 60_000)).toBe(true);
      expect(await sharedStateStore.claim("scheduler:cleanup", 60_000)).toBe(false);

      mockState.set("scheduler:stale", { _id: "scheduler:stale", value: 1, expiresAt: new Date(Date.now() - 1) });
      expect(await sharedStateStore.claim("scheduler:stale", 60_000)).toBe(true);
    });

    it("consume 原子取出，第二个调用方拿不到", async () => {
      await sharedStateStore.set("probe:session:s1", { ip: "1.2.3.4" }, 60_000);
      expect(await sharedStateStore.consume("probe:session:s1")).toEqual({ ip: "1.2.3.4" });
      expect(await sharedStateStore.consume("probe:session:s1")).toBeNull();
    });

    it("deleteByPrefix 只删匹配前缀的键", async () => {
      await sharedStateStore.set("session:u1:a", 1, 60_000);
      await sharedStateStore.set("session:u1:b", 2, 60_000);
      await sharedStateStore.set("session:u2:a", 3, 60_000);

      expect(await sharedStateStore.deleteByPrefix("session:u1:")).toBe(2);
      expect(await sharedStateStore.get("session:u1:a")).toBeNull();
      expect(await sharedStateStore.get("session:u2:a")).toBe(3);
    });
  });
});
