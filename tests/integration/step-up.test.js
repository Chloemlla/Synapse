const { Mongoose } = require("mongoose");
const os = require("os");
const mockMongoose = new Mongoose();

jest.mock("../../src/services/mongoService", () => ({ mongoose: mockMongoose, isConnected: () => mockMongoose.connection.readyState === 1 }));
jest.mock("../../src/utils/logger", () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
// 不加载真实 config：它是 env 驱动的（lumen 布尔值等），CI 环境里一旦有脏值就在 import 阶段抛 ZodError，
// 把“集成用例挂了”伪装成“配置坏了”。本套件只用到 step-up 的 TTL/次数上限与票据密钥。
jest.mock("../../src/config/config", () => ({
  config: {
    jwtSecret: "integration-step-up-secret",
    accountRisk: {
      enabled: true,
      stepUpChallengeTtlSeconds: 120,
      stepUpGrantTtlSeconds: 30,
      stepUpGrantMaxUses: 5,
    },
  },
}));

const {
  issueStepUpChallenge,
  consumeStepUpChallenge,
  createStepUpGrant,
  redeemStepUpGrant,
  discardStepUpGrant,
  signChallengeTicket,
  verifyChallengeTicket,
} = require("../../src/services/stepUpService");

const describeReplica = process.env.MONGO_REPLICA_URI ? describe : describe.skip;

/**
 * step-up 的**并发语义**（RC-03 / RC-46 的验收）：
 * 这些性质只有真库能证明 —— 内存替身无论怎么写都会“通过”。
 */
describeReplica("Step-up challenge and grant concurrency", () => {
  let challenges;
  let grants;

  beforeAll(async () => {
    await mockMongoose.connect(process.env.MONGO_REPLICA_URI, {
      dbName: `synapse_step_up_${Date.now()}`,
      serverSelectionTimeoutMS: 10_000,
      runtimeAdapters: { os },
    });
    challenges = mockMongoose.connection.collection("step_up_challenges");
    grants = mockMongoose.connection.collection("step_up_grants");
  });

  beforeEach(async () => {
    await challenges.deleteMany({});
    await grants.deleteMany({});
  });

  afterAll(async () => {
    if (mockMongoose.connection.readyState === 1) await mockMongoose.connection.dropDatabase();
    await mockMongoose.disconnect();
  });

  async function issue(userId, ticketSeed = "route") {
    const result = await issueStepUpChallenge({
      userId,
      riskTier: "restricted",
      routeKey: `/api/tts/${ticketSeed}`,
      payloadHash: `hash-${ticketSeed}`,
      provider: "trycap",
      type: "captcha",
    });
    expect(result).not.toBeNull();
    return result;
  }

  test("并发消费同一枚挑战只成功一次（原子单次消费）", async () => {
    const { challengeId } = await issue("u1");

    const results = await Promise.all(
      Array.from({ length: 10 }, () => consumeStepUpChallenge({ userId: "u1", challengeId })),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await challenges.countDocuments({ challengeId, consumedAt: { $ne: null } })).toBe(1);
  });

  test("挑战绑定 userId：换人消费必失败", async () => {
    const { challengeId } = await issue("u1");
    expect(await consumeStepUpChallenge({ userId: "u2", challengeId })).toBeNull();
    expect(await consumeStepUpChallenge({ userId: "u1", challengeId })).not.toBeNull();
  });

  test("过期挑战拒绝消费（TTL 后台清理有竞态窗口，不能只靠 TTL）", async () => {
    const { challengeId } = await issue("u1");
    await challenges.updateOne({ challengeId }, { $set: { expiresAt: new Date(Date.now() - 1_000) } });
    expect(await consumeStepUpChallenge({ userId: "u1", challengeId })).toBeNull();
  });

  test("两枚票据换一枚 grant：次数等于合法票据数，routeKeys 去重，票据不可复用", async () => {
    const first = await issue("u1", "a");
    const second = await issue("u1", "a");

    const grant = await createStepUpGrant({ userId: "u1", tickets: [first.ticket, second.ticket] });
    expect(grant).toMatchObject({ remainingUses: 2, routeKeys: ["/api/tts/a"] });
    expect(grant.grantId).toBeTruthy();

    // 票据对应的挑战已被消费：再用同一批票据只会得到错误。
    const replay = await createStepUpGrant({ userId: "u1", tickets: [first.ticket, second.ticket] });
    expect(replay).toMatchObject({ error: expect.any(String) });
  });

  test("伪造/他人票据被拒（HMAC + userId 绑定）", async () => {
    const foreign = await issue("u2", "b");
    expect(await createStepUpGrant({ userId: "u1", tickets: [foreign.ticket] })).toMatchObject({
      error: expect.any(String),
    });

    const tampered = signChallengeTicket({
      challengeId: "sc_nope",
      userId: "u1",
      routeKey: "/api/command",
      issuedAt: Date.now(),
    });
    expect(await createStepUpGrant({ userId: "u1", tickets: [tampered] })).toMatchObject({
      error: expect.any(String),
    });
  });

  test("grant 兑换是原子的：并发 10 次、额度 2 → 恰好 2 次成功", async () => {
    const first = await issue("u1", "c");
    const second = await issue("u1", "c");
    const grant = await createStepUpGrant({ userId: "u1", tickets: [first.ticket, second.ticket] });

    const hashes = Array.from({ length: 10 }, (_, index) => `payload-${index}`);
    const results = await Promise.all(
      hashes.map((payloadHash, index) =>
        redeemStepUpGrant({
          grantId: grant.grantId,
          userId: "u1",
          routeKey: "/api/tts/c",
          payloadHash: index < 2 ? "same" : payloadHash,
        }),
      ),
    );
    // 前两次用的是同一个 payloadHash，因此只有第一次成功 → 总成功数仍是 2（额度耗尽）。
    expect(results.filter(Boolean)).toHaveLength(2);
  });

  test("同一 payloadHash 在额度充足时也只能兑换一次（防同一请求重放）", async () => {
    const tickets = [];
    for (let index = 0; index < 3; index += 1) tickets.push((await issue("u1", "d")).ticket);
    const grant = await createStepUpGrant({ userId: "u1", tickets });

    const first = await redeemStepUpGrant({
      grantId: grant.grantId,
      userId: "u1",
      routeKey: "/api/tts/d",
      payloadHash: "same-body",
    });
    const second = await redeemStepUpGrant({
      grantId: grant.grantId,
      userId: "u1",
      routeKey: "/api/tts/d",
      payloadHash: "same-body",
    });
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  test("grant 不跨越 routeKey：允许集外的路由拒绝", async () => {
    const { ticket } = await issue("u1", "e");
    const grant = await createStepUpGrant({ userId: "u1", tickets: [ticket] });
    expect(
      await redeemStepUpGrant({
        grantId: grant.grantId,
        userId: "u1",
        routeKey: "/api/command",
        payloadHash: "x",
      }),
    ).toBe(false);
    expect(
      await redeemStepUpGrant({
        grantId: grant.grantId,
        userId: "u1",
        routeKey: "/api/tts/e",
        payloadHash: "x",
      }),
    ).toBe(true);
  });

  test("过期 grant 拒绝兑换；主动作废后也拒绝", async () => {
    const first = await issue("u1", "f");
    const expired = await createStepUpGrant({ userId: "u1", tickets: [first.ticket] });
    await grants.updateOne({ grantId: expired.grantId }, { $set: { expiresAt: new Date(Date.now() - 1_000) } });
    expect(
      await redeemStepUpGrant({
        grantId: expired.grantId,
        userId: "u1",
        routeKey: "/api/tts/f",
        payloadHash: "x",
      }),
    ).toBe(false);

    const second = await issue("u1", "f");
    const active = await createStepUpGrant({ userId: "u1", tickets: [second.ticket] });
    await discardStepUpGrant(active.grantId, "u1");
    expect(
      await redeemStepUpGrant({
        grantId: active.grantId,
        userId: "u1",
        routeKey: "/api/tts/f",
        payloadHash: "x",
      }),
    ).toBe(false);
  });

  test("票据签名是域分离的：换一个 JWT 密钥语义的签名不可接受", () => {
    const ticket = signChallengeTicket({ challengeId: "sc_1", userId: "u1", routeKey: "/a", issuedAt: Date.now() });
    // 破坏签名任意一个字符即失效
    const [body, signature] = ticket.split(".");
    const broken = `${body}.${signature.slice(0, -1)}${signature.slice(-1) === "A" ? "B" : "A"}`;
    expect(verifyChallengeTicket(broken)).toBeNull();
    expect(verifyChallengeTicket(ticket)).not.toBeNull();
  });
});
