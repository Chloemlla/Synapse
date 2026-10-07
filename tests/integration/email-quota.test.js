const { Mongoose } = require("mongoose");
const os = require("os");
const mockMongoose = new Mongoose();
const mockEmailConfig = { quotaTotal: 100, outemailQuotaTotal: 100 };

jest.mock("../../src/services/mongoService", () => ({ mongoose: mockMongoose }));
jest.mock("../../src/services/runtimeConfigService", () => ({
  RuntimeConfigService: { getCachedConfig: () => ({ email: mockEmailConfig }) },
}));
jest.mock("../../src/utils/logger", () => ({ __esModule: true, default: { error: jest.fn() } }));

const quota = require("../../src/services/emailQuotaService");
const describeReplica = process.env.MONGO_REPLICA_URI ? describe : describe.skip;

describeReplica("Email quota Mongo reservations", () => {
  let ledgers;
  let legacy;
  beforeAll(async () => {
    await mockMongoose.connect(process.env.MONGO_REPLICA_URI, {
      dbName: `synapse_email_quota_${Date.now()}`,
      serverSelectionTimeoutMS: 10_000,
      runtimeAdapters: { os },
    });
    ledgers = mockMongoose.connection.collection("email_quota_ledgers");
    legacy = mockMongoose.connection.collection("email_quotas");
  });
  beforeEach(async () => {
    await ledgers.deleteMany({});
    await legacy.deleteMany({});
    await mockMongoose.connection.collection("outemail_quotas").deleteMany({});
    mockEmailConfig.quotaTotal = 100;
    mockEmailConfig.outemailQuotaTotal = 100;
  });
  afterAll(async () => {
    if (mockMongoose.connection.readyState === 1) await mockMongoose.connection.dropDatabase();
    await mockMongoose.disconnect();
  });

  test("migrates duplicate active domain buckets without granting a new allowance", async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await legacy.insertMany([
      { userId: "legacy-user", domain: "default", used: 3, resetAt: future },
      { userId: "legacy-user", domain: "example.com", used: 4, resetAt: future },
      { userId: "legacy-user", domain: "example.com", used: 2, resetAt: future },
      { userId: "legacy-user", domain: "expired.test", used: 50, resetAt: new Date(0).toISOString() },
      { userId: "legacy-user", domain: "verification", used: 80, resetAt: future },
    ]);
    mockEmailConfig.quotaTotal = 10;
    expect(await quota.getEmailQuota("legacy-user", "example.com")).toMatchObject({ used: 9, total: 10 });
    expect(await quota.consumeEmailQuota("legacy-user", undefined, 2)).toMatchObject({ success: false, reason: "exhausted" });
    expect(await quota.consumeEmailQuota("legacy-user", "another.test", 1)).toMatchObject({ success: true });
    expect(await legacy.countDocuments({ userId: "legacy-user" })).toBe(5);
  });

  test("concurrent initialization and batches cannot exceed one user allowance", async () => {
    mockEmailConfig.quotaTotal = 10;
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => quota.consumeEmailQuota("new-user", `domain-${i}`, 2)));
    expect(results.filter((result) => result.success)).toHaveLength(5);
    expect(await ledgers.countDocuments({})).toBe(1);
    expect(await quota.getEmailQuota("new-user")).toMatchObject({ used: 10, total: 10 });
  });

  test("runtime changes take effect in the default bucket without restarting", async () => {
    const reserved = await quota.consumeEmailQuota("runtime-user", undefined, 3);
    expect(reserved.success).toBe(true);
    mockEmailConfig.quotaTotal = 3;
    expect(await quota.getEmailQuota("runtime-user")).toMatchObject({ used: 3, total: 3 });
    expect(await quota.consumeEmailQuota("runtime-user")).toMatchObject({ success: false, reason: "exhausted" });
  });

  test("a reservation has exactly one final settlement, even with duplicate refunds", async () => {
    const result = await quota.consumeEmailQuota("settlement-user", undefined, 10);
    expect(result.success).toBe(true);
    await Promise.all([quota.settleEmailQuota(result.reservation, 3), quota.settleEmailQuota(result.reservation, 3)]);
    await quota.refundEmailQuota(result.reservation);
    expect(await quota.getEmailQuota("settlement-user")).toMatchObject({ used: 3 });
    expect((await ledgers.findOne({ _id: result.reservation.ledgerId })).reservations).toEqual({});
  });

  test("late refunds cannot subtract from a new day or an administrator reset", async () => {
    const old = await quota.consumeEmailQuota("rollover-user", undefined, 8);
    await ledgers.updateOne({ _id: old.reservation.ledgerId }, { $set: { resetAt: new Date(0) } });
    const current = await quota.consumeEmailQuota("rollover-user", undefined, 2);
    await quota.refundEmailQuota(old.reservation);
    expect(await quota.getEmailQuota("rollover-user")).toMatchObject({ used: 2 });
    await quota.resetEmailQuota("rollover-user");
    await quota.consumeEmailQuota("rollover-user", undefined, 1);
    await quota.refundEmailQuota(current.reservation);
    expect(await quota.getEmailQuota("rollover-user")).toMatchObject({ used: 1 });
  });

  test("reading an expired quota does not write away concurrent usage", async () => {
    const initial = await quota.consumeEmailQuota("read-user", undefined, 8);
    await ledgers.updateOne({ _id: initial.reservation.ledgerId }, { $set: { resetAt: new Date(0) } });
    expect(await quota.getEmailQuota("read-user")).toMatchObject({ used: 0 });
    expect((await ledgers.findOne({ _id: initial.reservation.ledgerId })).used).toBe(8);
    await Promise.all([quota.getEmailQuota("read-user"), quota.consumeEmailQuota("read-user")]);
    expect(await quota.getEmailQuota("read-user")).toMatchObject({ used: 1 });
  });

  test("public minute limits apply across windows and a newer window cannot be rolled back", async () => {
    expect(await quota.reservePublicEmailQuota(21)).toMatchObject({ success: false, reason: "rate_limited" });
    const first = await quota.reservePublicEmailQuota(20);
    expect(first.success).toBe(true);
    expect(await quota.reservePublicEmailQuota(1)).toMatchObject({ success: false, reason: "rate_limited" });
    const futureMinute = Math.floor(Date.now() / 60_000) * 60_000 + 60_000;
    await ledgers.updateOne({ _id: "public:outemail" }, { $set: { minuteStart: futureMinute, minuteUsed: 19 } });
    expect(await quota.reservePublicEmailQuota(2)).toMatchObject({ success: false, reason: "rate_limited" });
    expect(await quota.reservePublicEmailQuota(1)).toMatchObject({ success: true });
    expect((await ledgers.findOne({ _id: "public:outemail" })).minuteStart).toBe(futureMinute);
    await quota.refundEmailQuota(first.reservation);
    expect((await ledgers.findOne({ _id: "public:outemail" })).minuteUsed).toBe(20);
  });

  test.each([0, -1, 1.5, NaN, Infinity])("rejects invalid counts: %s", async (count) => {
    expect(await quota.consumeEmailQuota("invalid-user", undefined, count)).toMatchObject({ success: false, reason: "invalid" });
    expect(await ledgers.countDocuments({})).toBe(0);
  });
});
