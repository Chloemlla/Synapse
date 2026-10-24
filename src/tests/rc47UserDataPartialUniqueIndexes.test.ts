import fs from "node:fs";
import path from "node:path";
import { ACTIVE_USER_PARTIAL_FILTER } from "../utils/softDeleteState";
import { rc47UserDataPartialUniqueIndexes as migration, rc47ActiveIndexFilterRepair as repair, RC47_USER_DATA_MIGRATIONS, SCHEMA_MIGRATIONS, ACTIVE_USER_PARTIAL_FILTER as migrationFilter } from "../services/migrations/rc47UserDataPartialUniqueIndexes";

jest.mock("../utils/logger", () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));
jest.mock("../services/mongoService", () => ({ mongoose: { connection: {} } }));
jest.mock("../services/blockedIdentityService", () => ({ normalizeEmailCanonical: (email: string) => email.trim().toLowerCase() }));

type Index = {
  name: string;
  key: Record<string, number>;
  unique?: boolean;
  partialFilterExpression?: unknown;
  [key: string]: unknown;
};

function target(field: string, patch: Partial<Index> = {}): Index {
  return { name: `${field}_1`, key: { [field]: 1 }, unique: true, partialFilterExpression: ACTIVE_USER_PARTIAL_FILTER, ...patch };
}

function full(field: string): Index {
  return { name: `${field}_1`, key: { [field]: 1 }, unique: true };
}

function database(initial: Index[] = []) {
  const state = { indexes: [...initial], duplicates: {} as Record<string, string[]> };
  const events: string[] = [];
  const users = {
    indexes: jest.fn(async () => [...state.indexes]),
    aggregate: jest.fn((pipeline: { $group?: { _id: string } }[]) => {
      const field = pipeline[1].$group!._id.slice(1);
      return { toArray: async () => (state.duplicates[field] ?? []).map((_id) => ({ _id })) };
    }),
    countDocuments: jest.fn(async () => 0),
    find: jest.fn(() => ({ toArray: async () => [] as Record<string, unknown>[] })),
    dropIndex: jest.fn(async (name: string) => {
      events.push(`drop:${name}`);
      state.indexes = state.indexes.filter((index) => index.name !== name);
    }),
    createIndex: jest.fn(async (key: Record<string, number>, options: Omit<Index, "key">) => {
      events.push(`create:${options.name}`);
      state.indexes.push({ ...options, key } as Index);
      return options.name;
    }),
  };
  const tombstones = { updateOne: jest.fn(async () => ({})) };
  const db = { collection: jest.fn((name: string) => name === "user_datas" ? users : tombstones) };
  return { db, state, users, tombstones, events };
}

async function plan(fixture: ReturnType<typeof database>) {
  // 仅 collection API 的结构性替身；不把它当作 Mongo 过滤器兼容性的验证。
  return migration.plan({ db: fixture.db as unknown as Parameters<typeof migration.plan>[0]["db"] });
}

function expectReadOnly(fixture: ReturnType<typeof database>) {
  expect(fixture.users.dropIndex).not.toHaveBeenCalled();
  expect(fixture.users.createIndex).not.toHaveBeenCalled();
  expect(fixture.tombstones.updateOne).not.toHaveBeenCalled();
}

describe("RC47 migration plan and actions", () => {
  test("schema and migration use the exact shared positive-equality filter", () => {
    expect(migrationFilter).toBe(ACTIVE_USER_PARTIAL_FILTER);
    expect(migrationFilter).toEqual({ $or: [{ deletedAt: 0 }, { deletedAt: null }] });
    // 不加载 userService 的业务依赖；钉住两条 schema 声明都消费共享绑定。
    const source = fs.readFileSync(path.resolve(__dirname, "../services/userService.ts"), "utf8");
    expect(source).toMatch(/import \{[^}]*ACTIVE_USER_PARTIAL_FILTER[^}]*\} from "\.\.\/utils\/softDeleteState"/);
    for (const field of ["email", "username"]) {
      expect(source).toMatch(new RegExp(`userSchema\\.index\\(\\s*\\{ ${field}: 1 \\},\\s*\\{ unique: true, partialFilterExpression: ACTIVE_USER_PARTIAL_FILTER, collation: \\{ locale: "simple" \\} \\}`));
    }
  });

  test.each([26, "NamespaceNotFound"])("plans absent collection as fresh (%s)", async (failure) => {
    const fixture = database();
    fixture.users.indexes.mockRejectedValueOnce(typeof failure === "number" ? { code: failure } : { codeName: failure });
    const pending = await plan(fixture);
    expect(pending).toMatchObject({ state: "fresh", blocked: false });
    expect(pending.actions).toHaveLength(2);
    expectReadOnly(fixture);
    await pending.apply!();
    expect(fixture.events).toEqual(["create:email_1", "create:username_1"]);
    expect(fixture.users.createIndex.mock.calls[0][1].partialFilterExpression).toBe(ACTIVE_USER_PARTIAL_FILTER);
  });

  test("does not mistake a permissions failure for an absent collection", async () => {
    const fixture = database();
    fixture.users.indexes.mockRejectedValueOnce({ code: 13 });
    await expect(plan(fixture)).rejects.toEqual({ code: 13 });
    expectReadOnly(fixture);
  });

  test("legacy replacement is read-only until apply, then replaces each field immediately", async () => {
    const fixture = database([full("email"), full("username")]);
    const pending = await plan(fixture);
    expect(pending.state).toBe("legacy_full_unique");
    expectReadOnly(fixture);
    expect(fixture.users.aggregate.mock.calls.map(([pipeline]) => pipeline[1].$group!._id)).toEqual(["$email", "$username"]);
    expect(fixture.users.aggregate).toHaveBeenNthCalledWith(1, [
      { $match: ACTIVE_USER_PARTIAL_FILTER },
      { $group: { _id: "$email", count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
      { $limit: 10 },
    ], { collation: { locale: "simple" } });
    await pending.apply!();
    expect(fixture.events).toEqual(["drop:email_1", "create:email_1", "drop:username_1", "create:username_1"]);
    expect((await plan(fixture)).actions).toEqual([]);
  });

  test("already-correct indexes are a no-op including reversed explicit equalities", async () => {
    const fixture = database([
      target("email"),
      target("username", { partialFilterExpression: { $or: [{ deletedAt: { $eq: null } }, { deletedAt: { $eq: 0 } }] } }),
    ]);
    const pending = await plan(fixture);
    expect(pending).toEqual({ state: "already_migrated", actions: [], blocked: false });
    expectReadOnly(fixture);
  });

  test("half migration keeps correct email index and creates only username", async () => {
    const fixture = database([target("email")]);
    const pending = await plan(fixture);
    expect(pending.state).toBe("partial_incomplete");
    await pending.apply!();
    expect(fixture.events).toEqual(["create:username_1"]);
  });

  test.each([
    { partialFilterExpression: { deletedAt: null } },
    { partialFilterExpression: { $or: [{ deletedAt: 0 }, { deletedAt: { $exists: false } }] } },
    { partialFilterExpression: { $or: [{ deletedAt: 0 }, { deletedAt: null }, { deletedAt: 1 }] } },
    { partialFilterExpression: { $or: [{ deletedAt: 0 }, { deletedAt: null, enabled: true }] } },
    { partialFilterExpression: { $or: [{ deletedAt: 0 }, { otherField: null }] } },
    { unique: false },
    { hidden: true },
    { sparse: true },
    { expireAfterSeconds: 0 },
    { collation: { locale: "en", strength: 2 } },
    { name: "foreign_email" },
  ] as Partial<Index>[])("normalizes foreign filter/options instead of declaring success (%j)", async (patch) => {
    const fixture = database([target("email", patch), target("username")]);
    const pending = await plan(fixture);
    expect(pending.state).toBe("foreign_unique");
    expectReadOnly(fixture);
    await pending.apply!();
    expect(fixture.events).toEqual([`drop:${patch.name ?? "email_1"}`, "create:email_1"]);
  });

  test("removes a leftover full index even alongside a correct partial target", async () => {
    const fixture = database([target("email"), { ...full("email"), name: "email_old" }, target("username")]);
    const pending = await plan(fixture);
    await pending.apply!();
    expect(fixture.events).toEqual(["drop:email_old"]);
  });

  test("preserves external non-unique identity indexes used for inactive-user queries", async () => {
    const extra = { name: "email_all_records", key: { email: 1 }, unique: false };
    const fixture = database([target("email"), target("username"), extra]);
    expect(await plan(fixture)).toEqual({ state: "already_migrated", actions: [], blocked: false });
    expectReadOnly(fixture);
    const missing = database([target("username"), extra]);
    const pending = await plan(missing);
    await pending.apply!();
    expect(missing.events).toEqual(["create:email_1"]);
    expect(missing.state.indexes).toContain(extra);
  });

  test("does not drop an unrelated key using a target name", async () => {
    const fixture = database([{ name: "email_1", key: { email: -1 } }]);
    expect(await plan(fixture)).toMatchObject({ state: "foreign_name", blocked: true, actions: [] });
    expectReadOnly(fixture);
  });

  test.each(["email", "username"])("checks %s independently despite the other full unique index", async (field) => {
    const other = field === "email" ? "username" : "email";
    const fixture = database([full(other)]);
    fixture.state.duplicates[field] = ["collision"];
    const pending = await plan(fixture);
    expect(pending).toMatchObject({ state: "duplicates_active", blocked: true, actions: [] });
    expect(pending.blockedReason).toContain(field);
    expectReadOnly(fixture);
    expect(fixture.state.indexes).toEqual([full(other)]);
  });

  test("rechecks new duplicates before any old index is dropped", async () => {
    const fixture = database([full("email")]);
    const pending = await plan(fixture);
    fixture.state.duplicates.username = ["new-collision"];
    await expect(pending.apply!()).rejects.toThrow("username");
    expectReadOnly(fixture);
    expect(fixture.state.indexes).toEqual([full("email")]);
  });

  test("createIndex duplicate failure propagates and half migration can be retried", async () => {
    const fixture = database([full("email"), full("username")]);
    const create = fixture.users.createIndex.getMockImplementation()!;
    fixture.users.createIndex.mockImplementationOnce(create).mockRejectedValueOnce({ code: 11000 });
    const pending = await plan(fixture);
    await expect(pending.apply!()).rejects.toMatchObject({ code: 11000 });
    expect(fixture.state.indexes.map((index) => index.name)).toEqual(["email_1"]);
    expect(fixture.tombstones.updateOne).not.toHaveBeenCalled();
    const retry = await plan(fixture);
    expect(retry.state).toBe("partial_incomplete");
    await retry.apply!();
    expect((await plan(fixture)).state).toBe("already_migrated");
  });

  test("versioned index-only repair runs after the unchanged original migration", async () => {
    expect(migration.id).toBe("2026-10-10-rc47-user-datas-partial-unique-indexes");
    expect(repair.id).toBe("2026-10-24-rc47-active-index-filter-repair");
    expect(RC47_USER_DATA_MIGRATIONS).toEqual([migration, repair]);
    expect(SCHEMA_MIGRATIONS).toEqual([migration, repair]);
    const fixture = database([target("email"), target("username")]);
    fixture.users.countDocuments.mockResolvedValue(1);
    const pending = await repair.plan({ db: fixture.db as unknown as Parameters<typeof repair.plan>[0]["db"] });
    expect(pending).toEqual({ state: "already_migrated", actions: [], blocked: false });
    expect(fixture.users.countDocuments).not.toHaveBeenCalled();
    expectReadOnly(fixture);
  });

  test("versioned repair normalizes a wrong filter without replaying tombstones", async () => {
    const fixture = database([target("email", { partialFilterExpression: { deletedAt: null } }), target("username")]);
    const pending = await repair.plan({ db: fixture.db as unknown as Parameters<typeof repair.plan>[0]["db"] });
    expect(pending).toMatchObject({ state: "foreign_unique", blocked: false });
    await pending.apply!();
    expect(fixture.events).toEqual(["drop:email_1", "create:email_1"]);
    expect(fixture.users.countDocuments).not.toHaveBeenCalled();
    expect(fixture.users.find).not.toHaveBeenCalled();
    expect(fixture.tombstones.updateOne).not.toHaveBeenCalled();
  });

  test("backfills tombstones without writing any user records", async () => {
    const fixture = database([target("email"), target("username")]);
    fixture.users.countDocuments.mockResolvedValue(1);
    const candidate = { id: "deleted-user", username: "deleted_user", deletedOriginalEmail: "Old@Example.com", deletedOriginalUsername: "old-user" };
    fixture.users.find.mockReturnValue({ toArray: async () => [candidate] });
    const pending = await plan(fixture);
    expectReadOnly(fixture);
    await pending.apply!();
    expect(fixture.events).toEqual([]);
    expect(fixture.tombstones.updateOne).toHaveBeenCalledWith(
      { emailCanonical: "old@example.com" },
      { $set: expect.objectContaining({ userId: "deleted-user", username: "old-user", reason: "account_deleted_backfill", releasedAt: null, releasedBy: null }) },
      { upsert: true },
    );
  });
});
