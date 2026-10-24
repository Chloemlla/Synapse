const { MongoClient } = require("mongodb");
const os = require("os");

// 隔离真实 Mongo 集成测试，只在提供副本集 URI 的 CI job 运行；普通 Jest job 不连接数据库。
const mongoUri = process.env.MONGO_REPLICA_URI;
const describeMongo = process.env.CI && mongoUri ? describe : describe.skip;

jest.mock("../../src/utils/logger", () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("../../src/services/mongoService", () => ({
  mongoose: { connection: { db: undefined, readyState: 1 } },
  isConnected: () => true,
}));
// 只隔离服务模块装配；使用真实规范化函数，绝不 mock Mongo collection / createIndex / 过滤求值。
jest.mock("../../src/models/blockedIdentityModel", () => ({ BlockedIdentityModel: {} }));

const { mongoose } = require("../../src/services/mongoService");
const { runSchemaMigrations } = require("../../src/services/migrationRunner");
const {
  rc47UserDataPartialUniqueIndexes: migration,
  rc47ActiveIndexFilterRepair: repair,
  RC47_USER_DATA_MIGRATIONS,
} = require("../../src/services/migrations/rc47UserDataPartialUniqueIndexes");
const { ACTIVE_USER_PARTIAL_FILTER, activeUserFilter } = require("../../src/utils/softDeleteState");

const activeForms = [
  ["zero", { deletedAt: 0 }],
  ["null", { deletedAt: null }],
  ["missing", {}],
];
const formPairs = activeForms.flatMap(([firstName, first]) =>
  activeForms.map(([secondName, second]) => [firstName, secondName, first, second]),
);

describeMongo("RC47 real Mongo partial-unique migration", () => {
  let client;
  let db;
  let sequence = 0;

  beforeAll(async () => {
    client = new MongoClient(mongoUri, {
      serverSelectionTimeoutMS: 10_000,
      // driver 7 的动态 os import 与 Jest 不兼容，显式提供适配器保证握手元数据完整。
      runtimeAdapters: { os },
    });
    await client.connect();
  });

  beforeEach(() => {
    db = client.db(`synapse_rc47_contract_${Date.now()}_${process.pid}_${sequence++}`);
    mongoose.connection.db = db;
  });

  afterEach(async () => {
    // 只能销毁此用例创建的 CI 临时库，绝不接触 URI 的默认/生产库。
    if (db && process.env.CI && db.databaseName.startsWith("synapse_rc47_contract_")) await db.dropDatabase();
    mongoose.connection.db = undefined;
  });

  afterAll(async () => {
    if (client) await client.close();
  });

  async function apply() {
    const pending = await migration.plan({ db });
    expect(pending.blocked).toBe(false);
    if (pending.apply) await pending.apply();
    return pending;
  }

  async function expectTargetIndexes() {
    const indexes = await db.collection("user_datas").indexes();
    for (const field of ["email", "username"]) {
      expect(indexes.find((index) => index.name === `${field}_1`)).toMatchObject({
        key: { [field]: 1 }, unique: true, partialFilterExpression: ACTIVE_USER_PARTIAL_FILTER,
      });
    }
  }

  test("absent collection supports read-only fresh plan, apply, and repeat no-op", async () => {
    const pending = await migration.plan({ db });
    expect(pending).toMatchObject({ state: "fresh", blocked: false });
    expect(await db.listCollections({ name: "user_datas" }).toArray()).toEqual([]);
    await pending.apply();
    await expectTargetIndexes();
    expect(await migration.plan({ db })).toEqual({ state: "already_migrated", actions: [], blocked: false });
  });

  test("an existing empty collection with no identity indexes is fresh", async () => {
    await db.createCollection("user_datas");
    expect((await apply()).state).toBe("fresh");
    await expectTargetIndexes();
  });

  test("filter matches exactly the same active scalar states as normal queries", async () => {
    const users = db.collection("user_datas");
    await users.insertMany([
      { _id: "zero", deletedAt: 0 }, { _id: "null", deletedAt: null }, { _id: "missing" },
      { _id: "deleted", deletedAt: Date.now() }, { _id: "negative", deletedAt: -1 }, { _id: "string", deletedAt: "0" },
    ]);
    const ids = async (filter) => (await users.find(filter).toArray()).map((user) => user._id).sort();
    expect(await ids(ACTIVE_USER_PARTIAL_FILTER)).toEqual(["missing", "null", "zero"]);
    expect(await ids(ACTIVE_USER_PARTIAL_FILTER)).toEqual(await ids(activeUserFilter()));
  });

  test.each(formPairs)("email and username reject active duplicates %s -> %s", async (_firstName, _secondName, first, second) => {
    await apply();
    const users = db.collection("user_datas");
    await users.insertOne({ _id: "first", email: "shared@example.com", username: "shared", ...first });
    await expect(users.insertOne({ _id: "email-clash", email: "shared@example.com", username: "other", ...second })).rejects.toMatchObject({ code: 11000 });
    await expect(users.insertOne({ _id: "username-clash", email: "other@example.com", username: "shared", ...second })).rejects.toMatchObject({ code: 11000 });
    expect(await users.countDocuments()).toBe(1);
  });

  test.each(formPairs)("preflight blocks email and username duplicates %s / %s before dropping hybrid indexes", async (_firstName, _secondName, first, second) => {
    const users = db.collection("user_datas");
    for (const field of ["email", "username"]) {
      // 每个字段在独立 fixture 上查重；另一字段的 full unique 不能使检查短路。
      if (field === "username") {
        await db.dropDatabase();
      }
      const other = field === "email" ? "username" : "email";
      await users.createIndex({ [other]: 1 }, { unique: true, name: `${other}_1` });
      await users.insertMany([
        { _id: "first", [field]: "same", [other]: "different-1", ...first },
        { _id: "second", [field]: "same", [other]: "different-2", ...second },
      ]);
      const before = await users.indexes();
      const pending = await migration.plan({ db });
      expect(pending).toMatchObject({ state: "duplicates_active", blocked: true, actions: [] });
      expect(pending.blockedReason).toContain(field);
      expect(await users.indexes()).toEqual(before);
      expect(await users.countDocuments()).toBe(2);
      expect(await db.collection("blocked_identities").countDocuments()).toBe(0);
    }
  });

  test("replaces legacy full indexes without changing user documents, deleted duplicates remain allowed", async () => {
    const users = db.collection("user_datas");
    await users.createIndex({ email: 1 }, { unique: true });
    await users.createIndex({ username: 1 }, { unique: true });
    const original = { _id: "active", email: "same@example.com", username: "same", deletedAt: 0 };
    await users.insertOne(original);
    expect((await apply()).state).toBe("legacy_full_unique");
    expect(await users.findOne({ _id: "active" })).toEqual(original);
    await users.insertMany([
      { _id: "deleted-1", email: original.email, username: original.username, deletedAt: 1 },
      { _id: "deleted-2", email: original.email, username: original.username, deletedAt: 2 },
    ]);
    expect(await users.countDocuments()).toBe(3);
    await expectTargetIndexes();
  });

  test("half migration retains the correct target and adds the missing index", async () => {
    const users = db.collection("user_datas");
    await users.createIndex({ email: 1 }, { unique: true, name: "email_1", partialFilterExpression: ACTIVE_USER_PARTIAL_FILTER });
    const emailIndex = (await users.indexes()).find((index) => index.name === "email_1");
    expect((await apply()).state).toBe("partial_incomplete");
    expect((await users.indexes()).find((index) => index.name === "email_1")).toEqual(emailIndex);
    await expectTargetIndexes();
  });

  test("wrong partial and foreign indexes are normalized rather than marked already migrated", async () => {
    const users = db.collection("user_datas");
    await users.createIndex({ email: 1 }, { name: "email_1", unique: true, partialFilterExpression: { deletedAt: null } });
    await users.createIndex({ username: 1 }, { name: "foreign_username", unique: true, partialFilterExpression: { deletedAt: 0 } });
    expect((await apply()).state).toBe("foreign_unique");
    await expectTargetIndexes();
    expect((await users.indexes()).some((index) => index.name === "foreign_username")).toBe(false);
    await users.insertOne({ email: "zero@example.com", username: "zero", deletedAt: 0 });
    await expect(users.insertOne({ email: "zero@example.com", username: "new", deletedAt: null })).rejects.toMatchObject({ code: 11000 });
  });

  test("retains external non-unique indexes alongside the active-identity constraints", async () => {
    const users = db.collection("user_datas");
    await users.createIndex({ email: 1 }, { name: "email_all_records" });
    const extra = (await users.indexes()).find((index) => index.name === "email_all_records");
    await apply();
    await expectTargetIndexes();
    expect((await users.indexes()).find((index) => index.name === "email_all_records")).toEqual(extra);
    expect((await migration.plan({ db })).actions).toEqual([]);
    await users.insertOne({ email: "retired@example.com", username: "retired", deletedAt: 123 });
    expect(await users.find({ email: "retired@example.com" }).hint("email_all_records").toArray()).toHaveLength(1);
  });

  test("a foreign target-name collision blocks without dropping unrelated indexes", async () => {
    const users = db.collection("user_datas");
    await users.createIndex({ email: -1 }, { name: "email_1" });
    const before = await users.indexes();
    expect(await migration.plan({ db })).toMatchObject({ state: "foreign_name", blocked: true, actions: [] });
    expect(await users.indexes()).toEqual(before);
  });

  test("plan/apply race fails before dropping an existing index and never removes users", async () => {
    const users = db.collection("user_datas");
    await users.createIndex({ email: 1 }, { unique: true });
    await users.insertOne({ _id: "first", email: "first@example.com", username: "same", deletedAt: 0 });
    const pending = await migration.plan({ db });
    const before = await users.indexes();
    await users.insertOne({ _id: "racing", email: "second@example.com", username: "same", deletedAt: null });
    await expect(pending.apply()).rejects.toThrow("username");
    expect(await users.indexes()).toEqual(before);
    expect(await users.countDocuments()).toBe(2);
  });

  test("concurrent active inserts have one unique-index rejection, not user-data cleanup", async () => {
    await apply();
    const users = db.collection("user_datas");
    const outcomes = await Promise.allSettled([
      users.insertOne({ _id: "zero", email: "race@example.com", username: "zero", deletedAt: 0 }),
      users.insertOne({ _id: "missing", email: "race@example.com", username: "missing" }),
    ]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find((result) => result.status === "rejected").reason).toMatchObject({ code: 11000 });
    expect(await users.countDocuments()).toBe(1);
  });

  test("tombstone backfill preserves deleted users and is idempotent by identity", async () => {
    const users = db.collection("user_datas");
    const original = {
      _id: "retired", id: "retired", username: "deleted_retired", email: "deleted_retired@example.com",
      deletedAt: 123, deletedOriginalEmail: "U.s.e.r+old@Googlemail.com", deletedOriginalUsername: "original-user",
    };
    await users.insertOne(original);
    await apply();
    await apply();
    expect(await users.findOne({ _id: "retired" })).toEqual(original);
    expect(await db.collection("blocked_identities").countDocuments()).toBe(1);
    expect(await db.collection("blocked_identities").findOne({ emailCanonical: "user@gmail.com" })).toMatchObject({
      userId: "retired", username: "original-user", releasedAt: null, releasedBy: null, reason: "account_deleted_backfill",
    });
  });

  test("new repair id fixes a wrong partial filter despite the original applied marker", async () => {
    const users = db.collection("user_datas");
    await users.createIndex({ email: 1 }, { name: "email_1", unique: true, partialFilterExpression: { deletedAt: null } });
    await users.createIndex({ username: 1 }, { name: "username_1", unique: true, partialFilterExpression: { deletedAt: null } });
    const original = { _id: "active-zero", email: "same@example.com", username: "same", deletedAt: 0 };
    await users.insertOne(original);
    const oldMarker = { _id: migration.id, status: "applied", state: "already_migrated", appliedAt: new Date(0) };
    await db.collection("schema_migrations").insertOne(oldMarker);

    const results = await runSchemaMigrations({ migrations: RC47_USER_DATA_MIGRATIONS });
    expect(results).toEqual([
      expect.objectContaining({ id: migration.id, outcome: "already-marked" }),
      expect.objectContaining({ id: repair.id, outcome: "applied", state: "foreign_unique" }),
    ]);
    await expectTargetIndexes();
    expect(await db.collection("schema_migrations").findOne({ _id: migration.id })).toEqual(oldMarker);
    expect(await db.collection("schema_migrations").findOne({ _id: repair.id })).toMatchObject({ status: "applied" });
    expect(await users.findOne({ _id: original._id })).toEqual(original);
    await expect(users.insertOne({ _id: "duplicate", email: original.email, username: "other", deletedAt: null })).rejects.toMatchObject({ code: 11000 });
    expect(await users.countDocuments()).toBe(1);
  });

  test("correct-index repair only marks completion and does not reblock released tombstones", async () => {
    await apply();
    const users = db.collection("user_datas");
    const original = {
      _id: "retired", id: "retired", username: "deleted_retired", email: "deleted_retired@example.com",
      deletedAt: 123, deletedOriginalEmail: "Old@example.com", deletedOriginalUsername: "old",
    };
    const released = { _id: "released", emailCanonical: "old@example.com", releasedAt: new Date(1000), releasedBy: "admin" };
    await users.insertOne(original);
    await db.collection("blocked_identities").insertOne(released);
    await db.collection("schema_migrations").insertOne({ _id: migration.id, status: "applied" });
    const before = await users.indexes();
    const results = await runSchemaMigrations({ migrations: RC47_USER_DATA_MIGRATIONS });
    expect(results).toEqual([
      expect.objectContaining({ id: migration.id, outcome: "already-marked" }),
      expect.objectContaining({ id: repair.id, outcome: "skipped", state: "already_migrated", actions: [] }),
    ]);
    expect(await users.indexes()).toEqual(before);
    expect(await users.findOne({ _id: original._id })).toEqual(original);
    expect(await db.collection("blocked_identities").findOne({ _id: released._id })).toEqual(released);
    expect(await db.collection("schema_migrations").findOne({ _id: repair.id })).toMatchObject({ status: "applied" });
  });

  test("historical applied plus wrong-filter active duplicates remains blocked without deleting indexes or data", async () => {
    const users = db.collection("user_datas");
    await users.createIndex({ email: 1 }, { name: "email_1", unique: true, partialFilterExpression: { deletedAt: null } });
    await users.createIndex({ username: 1 }, { name: "username_1", unique: true, partialFilterExpression: { deletedAt: null } });
    await users.insertMany([
      { _id: "zero", email: "same@example.com", username: "same", deletedAt: 0 },
      { _id: "null", email: "same@example.com", username: "same", deletedAt: null },
    ]);
    await db.collection("schema_migrations").insertOne({ _id: migration.id, status: "applied" });
    const before = await users.indexes();
    expect(await runSchemaMigrations({ migrations: RC47_USER_DATA_MIGRATIONS })).toEqual([
      expect.objectContaining({ id: migration.id, outcome: "already-marked" }),
      expect.objectContaining({ id: repair.id, outcome: "blocked", state: "duplicates_active", actions: [] }),
    ]);
    expect(await users.indexes()).toEqual(before);
    expect(await users.countDocuments()).toBe(2);
    expect(await db.collection("schema_migrations").findOne({ _id: repair.id })).toMatchObject({ status: "blocked" });
  });

  test("runner retries a failed original-id ledger on the next boot without force", async () => {
    let failOnce = true;
    const failingOnce = {
      ...migration,
      plan: async (ctx) => {
        if (failOnce) {
          failOnce = false;
          throw new Error("interrupted inspection");
        }
        return migration.plan(ctx);
      },
    };
    const failed = await runSchemaMigrations({ migrations: [failingOnce] });
    expect(failed).toEqual([expect.objectContaining({ id: migration.id, outcome: "failed" })]);
    expect(await db.collection("schema_migrations").findOne({ _id: migration.id })).toMatchObject({ status: "failed" });
    expect(await runSchemaMigrations({ migrations: [migration] })).toEqual([expect.objectContaining({ id: migration.id, outcome: "applied" })]);
    expect(await db.collection("schema_migrations").findOne({ _id: migration.id })).toMatchObject({ status: "applied" });
    expect(await runSchemaMigrations({ migrations: [migration] })).toEqual([expect.objectContaining({ outcome: "already-marked" })]);
    await expectTargetIndexes();
  });
});
