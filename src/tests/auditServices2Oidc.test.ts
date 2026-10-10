export {};

const mockKeyStore: { value: any; reads: number } = { value: null, reads: 0 };

jest.mock("node:fs", () => ({ promises: { readFile: jest.fn().mockRejectedValue(new Error("missing")) } }));
jest.mock("../services/oauthService", () => ({ buildOAuthIdentityClaims: () => ({}) }));
jest.mock("../models/oidcKeyModel", () => ({ OidcSigningKeyModel: {
  findOne: jest.fn(() => ({ select: () => ({ sort: () => ({ lean: async () => {
    // 两个独立实例都在生成前看到空库。
    mockKeyStore.reads += 1;
    return mockKeyStore.reads <= 2 ? null : mockKeyStore.value;
  } }) }) })),
  findOneAndUpdate: jest.fn(async (filter: any, update: any) => {
    if (!mockKeyStore.value) mockKeyStore.value = { _id: filter._id, ...update.$setOnInsert };
    return mockKeyStore.value;
  }),
} }));
jest.mock("../utils/logger", () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn() } }));

it("uses the persisted winner in both instances after concurrent first boot", async () => {
  let first!: Promise<{ kid: string; privateKeyPem: string }>;
  let second!: Promise<{ kid: string; privateKeyPem: string }>;
  jest.isolateModules(() => { first = require("../services/oidcService").getOidcSigningKey(); });
  jest.isolateModules(() => { second = require("../services/oidcService").getOidcSigningKey(); });

  const [a, b] = await Promise.all([first, second]);
  expect(a.kid).toBe(b.kid);
  expect(a.privateKeyPem).toBe(b.privateKeyPem);
  expect(a.kid).toBe(mockKeyStore.value.kid);
});
