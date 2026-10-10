let mockContents = "[]";
const mockWrite = jest.fn(async (_path: string, value: unknown) => { mockContents = JSON.stringify(value); });
jest.mock("node:fs", () => {
  const fs = {
    existsSync: () => true,
    readFileSync: () => mockContents,
    mkdirSync: jest.fn(),
  };
  return { __esModule: true, default: fs, ...fs };
});
jest.mock("../services/librechat/atomicJsonWriter", () => ({ SerialAtomicJsonWriter: class {
  write = (...args: [string, unknown]) => mockWrite(...args);
} }));

const mockQueueModel = {
  find: jest.fn(), deleteOne: jest.fn(), deleteMany: jest.fn(),
  collection: { countDocuments: jest.fn(), insertOne: jest.fn() },
};
const mockLockModel = { updateOne: jest.fn(), deleteOne: jest.fn() };
jest.mock("../services/mongoService", () => ({ mongoose: {
  Schema: class { index() {} },
  models: {},
  model: (name: string) => name === "CommandQueueLock" ? mockLockModel : mockQueueModel,
} }));
jest.mock("../utils/logger", () => ({ __esModule: true, default: { warn: jest.fn() } }));

const fileStore = require("../services/commandStorage/file");
const mongoStore = require("../services/commandStorage/mongo");
const mods = require("../services/modlistStorage/file");

beforeEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
  mockContents = "[]";
});

afterEach(() => jest.useRealTimers());

it("concurrent file queue writers cannot exceed the final slot", async () => {
  mockContents = JSON.stringify(Array.from({ length: 199 }, (_, i) => ({ commandId: `c${i}`, status: "pending" })));
  const results = await Promise.allSettled([fileStore.addToQueue("status"), fileStore.addToQueue("status")]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(JSON.parse(mockContents)).toHaveLength(200);
  await expect(fileStore.addToQueue("status")).rejects.toThrow("队列已满");
});

it.each(["{ broken JSON", "{}"])("never overwrites damaged file data: %s", async (contents) => {
  mockContents = contents;
  await expect(fileStore.addToQueue("status")).rejects.toThrow();
  await expect(mods.addMod({ name: "a-mod" })).rejects.toThrow();
  expect(mockWrite).not.toHaveBeenCalled();
  expect(mockContents).toBe(contents);
});

function installMongoLease(initial?: { owner: string; expiresAt: Date }) {
  let lease = initial;
  mockLockModel.updateOne.mockImplementation((filter, update, options) => ({ exec: async () => {
    expect(options.timeoutMS).toBeGreaterThan(0);
    if (options.upsert) {
      if (lease && lease.expiresAt.getTime() > filter.expiresAt.$lte.getTime()) throw { code: 11000 };
      lease = { ...update.$set };
      return { upsertedCount: 1 };
    }
    if (!lease || lease.owner !== filter.owner || lease.expiresAt <= filter.expiresAt.$gt) return { matchedCount: 0 };
    lease = { ...lease, ...update.$set };
    return { matchedCount: 1 };
  } }));
  mockLockModel.deleteOne.mockImplementation((filter) => ({ exec: async () => {
    expect(filter).toEqual({ _id: "enqueue", owner: expect.any(String) });
    if (lease?.owner !== filter.owner) return { deletedCount: 0 };
    lease = undefined;
    return { deletedCount: 1 };
  } }));
  return { getLease: () => lease, replace: (value: typeof lease) => { lease = value; } };
}

it("serializes Mongo admissions before counting the final slot in the original collection", async () => {
  const lock = installMongoLease();
  let count = 199;
  mockQueueModel.collection.countDocuments.mockImplementation(async () => count);
  mockQueueModel.collection.insertOne.mockImplementation(async () => {
    expect(lock.getLease()).toBeDefined();
    count++;
    return {};
  });
  const results = await Promise.allSettled([mongoStore.addToQueue("status"), mongoStore.addToQueue("status")]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(count).toBe(200);
  expect(mockQueueModel.collection.insertOne).toHaveBeenCalledTimes(1);
  expect(lock.getLease()).toBeUndefined();
});

it("keeps reads, removals and clears on the original queue without creating migration state", async () => {
  const legacy = [{ commandId: "legacy", command: "status", status: "pending", addedAt: new Date() }];
  mockQueueModel.find.mockReturnValue({ sort: () => ({ lean: async () => legacy }) });
  mockQueueModel.deleteOne.mockResolvedValue({ deletedCount: 1 });
  mockQueueModel.deleteMany.mockResolvedValue({ deletedCount: 1 });
  await expect(mongoStore.getCommandQueue()).resolves.toEqual(legacy);
  await expect(mongoStore.removeFromQueue("legacy")).resolves.toBe(true);
  await mongoStore.clearQueue();
  expect(mockQueueModel.deleteOne).toHaveBeenCalledWith({ commandId: "legacy" });
  expect(mockQueueModel.deleteMany).toHaveBeenCalledWith({ status: "pending" });
  expect(mockLockModel.updateOne).not.toHaveBeenCalled();
});

it("recovers an expired owner's lease without relying on TTL cleanup", async () => {
  const lock = installMongoLease({ owner: "dead-process", expiresAt: new Date(Date.now() - 1) });
  mockQueueModel.collection.countDocuments.mockResolvedValue(0);
  mockQueueModel.collection.insertOne.mockResolvedValue({});
  await expect(mongoStore.addToQueue("status")).resolves.toMatchObject({ command: "status" });
  expect(lock.getLease()).toBeUndefined();
});

it("refuses a lost lease before insertion and cannot release its successor", async () => {
  const lock = installMongoLease();
  mockQueueModel.collection.countDocuments.mockImplementation(async () => {
    lock.replace({ owner: "successor", expiresAt: new Date(Date.now() + 30_000) });
    return 0;
  });
  await expect(mongoStore.addToQueue("status")).rejects.toThrow("锁已失效");
  expect(mockQueueModel.collection.insertOne).not.toHaveBeenCalled();
  expect(lock.getLease()?.owner).toBe("successor");
});

it("rejects Mongo lock errors rather than falling back to per-process admission", async () => {
  mockLockModel.updateOne.mockReturnValue({ exec: async () => { throw new Error("Mongo unavailable"); } });
  await expect(mongoStore.addToQueue("status")).rejects.toThrow("Mongo unavailable");
  expect(mockQueueModel.collection.countDocuments).not.toHaveBeenCalled();
  expect(mockQueueModel.collection.insertOne).not.toHaveBeenCalled();
});

it("releases its lease when insertion fails", async () => {
  const lock = installMongoLease();
  mockQueueModel.collection.countDocuments.mockResolvedValue(0);
  mockQueueModel.collection.insertOne.mockRejectedValueOnce(new Error("write failed"));
  await expect(mongoStore.addToQueue("status")).rejects.toThrow("write failed");
  expect(lock.getLease()).toBeUndefined();
});

it("does not turn a successful insert into an error when releasing the lease fails", async () => {
  const lock = installMongoLease();
  mockQueueModel.collection.countDocuments.mockResolvedValue(0);
  mockQueueModel.collection.insertOne.mockResolvedValue({});
  mockLockModel.deleteOne.mockReturnValue({ exec: async () => { throw new Error("disconnect"); } });
  await expect(mongoStore.addToQueue("status")).resolves.toMatchObject({ command: "status" });
  expect(lock.getLease()?.expiresAt.getTime()).toBeGreaterThan(Date.now());
});

it("bounds lock contention waiting and leaves the active owner's lock intact", async () => {
  jest.useFakeTimers();
  const lock = installMongoLease({ owner: "active-process", expiresAt: new Date(Date.now() + 30_000) });
  const assertion = expect(mongoStore.addToQueue("status")).rejects.toThrow("命令队列正忙");
  await jest.advanceTimersByTimeAsync(2_100);
  await assertion;
  expect(mockQueueModel.collection.countDocuments).not.toHaveBeenCalled();
  expect(lock.getLease()?.owner).toBe("active-process");
  expect(mockLockModel.deleteOne).not.toHaveBeenCalled();
});
