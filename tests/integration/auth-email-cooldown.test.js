const { Mongoose } = require("mongoose");
const os = require("os");
const mockMongoose = new Mongoose();
jest.mock("../../src/services/mongoService", () => ({ mongoose: mockMongoose }));
jest.mock("../../src/utils/logger", () => ({ __esModule: true, default: { warn: jest.fn() } }));

const { reserveAuthEmail, completeAuthEmail, releaseAuthEmail } = require("../../src/services/authEmailCooldownService");
const describeReplica = process.env.MONGO_REPLICA_URI ? describe : describe.skip;

describeReplica("Authentication email Mongo cooldown", () => {
  let cooldowns;
  beforeAll(async () => {
    await mockMongoose.connect(process.env.MONGO_REPLICA_URI, {
      dbName: `synapse_auth_email_cooldown_${Date.now()}`,
      serverSelectionTimeoutMS: 10_000,
      runtimeAdapters: { os },
    });
    cooldowns = mockMongoose.connection.collection("auth_email_cooldowns");
  });
  beforeEach(async () => { await cooldowns.deleteMany({}); });
  afterAll(async () => {
    if (mockMongoose.connection.readyState === 1) await mockMongoose.connection.dropDatabase();
    await mockMongoose.disconnect();
  });

  test("twenty concurrent requests reserve only one delivery for the normalized recipient", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      reserveAuthEmail(index % 2 ? " User@Gmail.com " : "user@gmail.com", "registration")));
    expect(results.filter((result) => result.success)).toHaveLength(1);
    expect(results.filter((result) => !result.success).every((result) => result.retryAfterSeconds > 0)).toBe(true);
    expect(await cooldowns.countDocuments({})).toBe(1);
    expect(await reserveAuthEmail("user@gmail.com", "password-reset")).toMatchObject({ success: true });
  });

  test("a failed delivery releases its lease immediately", async () => {
    const first = await reserveAuthEmail("user@gmail.com", "registration");
    expect(first.success).toBe(true);
    await releaseAuthEmail(first.reservation);
    expect(await reserveAuthEmail("user@gmail.com", "registration")).toMatchObject({ success: true });
  });

  test("a completed delivery starts a short cooldown from completion", async () => {
    const first = await reserveAuthEmail("user@gmail.com", "registration");
    await completeAuthEmail(first.reservation);
    const rejected = await reserveAuthEmail("user@gmail.com", "registration");
    expect(rejected.success).toBe(false);
    expect(rejected.retryAfterSeconds).toBeGreaterThan(0);
    expect(rejected.retryAfterSeconds).toBeLessThanOrEqual(60);
  });

  test("expired leases can be replaced and stale cleanup cannot touch the new owner", async () => {
    const old = await reserveAuthEmail("user@gmail.com", "registration");
    await cooldowns.updateOne({ _id: old.reservation.key }, { $set: { expiresAt: new Date(0) } });
    const current = await reserveAuthEmail("user@gmail.com", "registration");
    expect(current.success).toBe(true);
    expect(current.reservation.id).not.toBe(old.reservation.id);
    const before = await cooldowns.findOne({ _id: current.reservation.key });
    await releaseAuthEmail(old.reservation);
    await completeAuthEmail(old.reservation);
    const after = await cooldowns.findOne({ _id: current.reservation.key });
    expect(after.reservationId).toBe(current.reservation.id);
    expect(after.expiresAt).toEqual(before.expiresAt);
    expect(await reserveAuthEmail("user@gmail.com", "registration")).toMatchObject({ success: false });
  });
});
