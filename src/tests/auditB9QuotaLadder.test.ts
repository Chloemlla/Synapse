import { describe, expect, it, jest } from "@jest/globals";
import {
  banHoursForOffense,
  buildQuotaLadderView,
  createQuotaLadder,
  resolveBannedUntil,
  type QuotaLadderState,
  type QuotaLadderStore,
} from "../services/quotaLadderService";

jest.mock("../utils/logger", () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

/**
 * RC-29 / RC-37：通用阶梯闸门的语义。
 *
 * 用内存替身而不是 Mongo：这里要钉的是「谁在什么状态下被拒、封多久」，
 * 查询形状由 LibreChat 自己的套件（libreChatQuota.test.ts）继续钉着。
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function makeStore(initial: Record<string, QuotaLadderState> = {}) {
  const docs = new Map<string, QuotaLadderState>(Object.entries(initial));
  const store: QuotaLadderStore & { docs: Map<string, QuotaLadderState> } = {
    docs,
    isAvailable: () => true,
    read: async (userId) => {
      const doc = docs.get(userId);
      return doc ? { ...doc } : null;
    },
    consume: async (userId, dayKey, dailyLimit) => {
      const doc = docs.get(userId);
      if (!doc) return null;
      if (["admin", "superadmin"].includes(String(doc.role || ""))) return null;
      const sameDay = doc.usageDay === dayKey;
      const used = sameDay ? Math.max(0, Number(doc.used) || 0) : 0;
      const banned = resolveBannedUntil(doc, new Date());
      if (banned) return null;
      if (used >= dailyLimit) return null;
      const next: QuotaLadderState = {
        ...doc,
        usageDay: dayKey,
        used: used + 1,
        warnings: sameDay ? Math.max(0, Number(doc.warnings) || 0) : 0,
      };
      docs.set(userId, next);
      return { ...next };
    },
    addWarning: async (userId, dayKey) => {
      const doc = docs.get(userId);
      if (!doc) return null;
      const sameDay = doc.usageDay === dayKey;
      const next: QuotaLadderState = {
        ...doc,
        usageDay: dayKey,
        warnings: (sameDay ? Math.max(0, Number(doc.warnings) || 0) : 0) + 1,
      };
      docs.set(userId, next);
      return { ...next };
    },
    applyBan: async (userId, bannedUntilIso) => {
      const doc = docs.get(userId);
      if (!doc) return null;
      const next: QuotaLadderState = {
        ...doc,
        bannedUntil: bannedUntilIso,
        banCount: Math.max(0, Number(doc.banCount) || 0) + 1,
      };
      docs.set(userId, next);
      return { ...next };
    },
    clearBan: async (userId) => {
      docs.set(userId, {});
    },
  };
  return store;
}

const TEST_DAY = "2026-10-17";

function makeLadder(store: QuotaLadderStore, overrides: Record<string, unknown> = {}) {
  const config = {
    resource: "test-resource",
    dailyLimit: 2,
    maxWarnings: 2,
    banHoursTable: [24, 24 * 7, 24 * 30],
    exemptRoles: ["admin", "superadmin"],
    dayKey: () => TEST_DAY,
    codes: { dailyLimit: "TEST_DAILY_LIMIT", banned: "TEST_BANNED" },
    messages: {
      dailyLimit: (warnings: number, remainingWarnings: number) => `warning ${warnings}/${remainingWarnings}`,
      banned: () => "temporarily blocked",
    },
    store,
    ...overrides,
  };
  return createQuotaLadder(
    config as unknown as Parameters<typeof createQuotaLadder>[0],
  );
}

describe("quotaLadderService（RC-29 / RC-37）", () => {
  it("额度内放行并累计用量；跨日从 1 重算", async () => {
    const store = makeStore({ u1: { role: "user", usageDay: TEST_DAY, used: 1, warnings: 0 } });
    const ladder = makeLadder(store);

    const decision = await ladder.consume("u1");
    expect(decision.allowed).toBe(true);
    expect(decision.view).toMatchObject({ used: 2, remaining: 0, warnings: 0, banned: false });
  });

  it("超额先记警告；警告未到阈值前不封禁", async () => {
    const store = makeStore({ u1: { role: "user", usageDay: TEST_DAY, used: 2, warnings: 0 } });
    const ladder = makeLadder(store);

    const decision = await ladder.consume("u1");
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("TEST_DAILY_LIMIT");
    expect(decision.message).toBe("warning 1/1");
    expect(decision.view).toMatchObject({ warnings: 1, banned: false });
    expect(store.docs.get("u1")?.bannedUntil).toBeUndefined();
  });

  it("警告达到阈值 → 按累计封禁次数封禁，并触发两个联动钩子", async () => {
    const store = makeStore({ u1: { role: "user", usageDay: TEST_DAY, used: 2, warnings: 1, banCount: 0 } });
    const onBan = jest.fn();
    const onBanApplied = jest.fn();
    const ladder = makeLadder(store, { onBan, onBanApplied });

    const decision = await ladder.consume("u1");

    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("TEST_BANNED");
    expect(decision.retryAfterSeconds).toBe(24 * 60 * 60);
    expect(onBan).toHaveBeenCalledWith(expect.objectContaining({ banHours: 24, offenseIndex: 1 }));
    expect(onBanApplied).toHaveBeenCalledWith(expect.objectContaining({ banHours: 24, offenseIndex: 1 }));
    expect(store.docs.get("u1")?.banCount).toBe(1);
  });

  it("RC-37：第二次封禁直接用 7 天（封禁计数跨日累计）", async () => {
    const store = makeStore({ u1: { role: "user", usageDay: TEST_DAY, used: 2, warnings: 1, banCount: 1 } });
    const ladder = makeLadder(store);

    const decision = await ladder.consume("u1");
    expect(decision.code).toBe("TEST_BANNED");
    expect(decision.retryAfterSeconds).toBe(7 * 24 * 60 * 60);
    expect(store.docs.get("u1")?.banCount).toBe(2);
  });

  it("封禁中：拒绝且不消耗额度，返回剩余秒数", async () => {
    const bannedUntil = new Date(Date.now() + 60_000).toISOString();
    const store = makeStore({ u1: { role: "user", usageDay: TEST_DAY, used: 0, bannedUntil } });
    const ladder = makeLadder(store);

    const decision = await ladder.consume("u1");
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("TEST_BANNED");
    expect(decision.retryAfterSeconds).toBeGreaterThan(0);
    expect(store.docs.get("u1")?.used).toBe(0);
  });

  it("管理员豁免：不计数、不封禁", async () => {
    const store = makeStore({ u1: { role: "admin", usageDay: TEST_DAY, used: 99, warnings: 99 } });
    const ladder = makeLadder(store);

    const decision = await ladder.consume("u1");
    expect(decision.allowed).toBe(true);
    expect(decision.view).toMatchObject({ used: 0, remaining: 2 });
    expect(store.docs.get("u1")?.used).toBe(99);
  });

  it("存储不可用 → 放行（额度不是安全边界）", async () => {
    const store = makeStore({ u1: { role: "user" } });
    store.isAvailable = () => false;
    const ladder = makeLadder(store);

    const decision = await ladder.consume("u1");
    expect(decision.allowed).toBe(true);
    expect(store.docs.get("u1")?.used).toBeUndefined();
  });

  it("联动钩子抛错不回滚封禁、也不把 403 变成 500", async () => {
    const store = makeStore({ u1: { role: "user", usageDay: TEST_DAY, used: 2, warnings: 1 } });
    const ladder = makeLadder(store, {
      onBan: () => {
        throw new Error("ticket service down");
      },
      onBanApplied: async () => {
        throw new Error("risk service down");
      },
    });

    const decision = await ladder.consume("u1");
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("TEST_BANNED");
    expect(store.docs.get("u1")?.bannedUntil).toBeTruthy();
  });

  it("时长表：超长取最后一档，表为空回落 24h", () => {
    expect(banHoursForOffense([24, 168, 720], 1)).toBe(24);
    expect(banHoursForOffense([24, 168, 720], 2)).toBe(168);
    expect(banHoursForOffense([24, 168, 720], 9)).toBe(720);
    expect(banHoursForOffense([], 1)).toBe(24);
  });

  it("脏封禁时间按未封禁处理（解析失败不能把用户永久挡在门外）", () => {
    expect(resolveBannedUntil({ bannedUntil: "not-a-date" }, new Date())).toBeNull();
    expect(resolveBannedUntil({ bannedUntil: null }, new Date())).toBeNull();
  });

  it("视图：跨日数据在读数时算 0，但不等下一次消费才生效", () => {
    const view = buildQuotaLadderView(
      { role: "user", usageDay: "2026-10-16", used: 2, warnings: 2 },
      new Date(),
      { dailyLimit: 2, maxWarnings: 2, dayKey: () => TEST_DAY, exemptRoles: [] },
    );
    expect(view).toMatchObject({ used: 0, remaining: 2, warnings: 0 });
    expect(DAY_MS).toBe(24 * 60 * 60 * 1000);
  });
});
