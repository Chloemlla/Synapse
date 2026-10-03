import { describe, expect, it } from "@jest/globals";
import { buildAccountSecurityOverview, countBackupCodes } from "../services/accountSecurityOverviewService";
import type { User } from "../utils/userStorageTypes";

/**
 * 回归守护：备用恢复码余量必须区分「未知」与「真的为 0」。
 *
 * 背景（线上缺陷）：安全总览用 `UserStorage.getUserById`（公开投影，G2-22 起不含 backupCodes）
 * 拿到的用户对象算余量，`Array.isArray(undefined)` 为假 → 余量恒为 0 → **每个启用 TOTP 的
 * 用户都会看到「恢复码已用尽，验证器丢失后将无法自行登录」的红色告警**，而实际上他们手里
 * 有 10 个码。同一根因还会把「有密码」判成「没设密码」。
 *
 * 这些用例钉住三条语义：
 *   1. 字段缺失 = 未知 ⇒ 只报 warn，绝不说「已用尽」；
 *   2. 权威事实（facts）优先于用户对象上现算的值；
 *   3. facts 里的 hasPasswordMaterial 能修正公开投影缺字段导致的误判。
 */

const baseUser = (extra: Partial<User> = {}): User =>
  ({
    id: "u-1",
    username: "alice",
    email: "alice@example.com",
    role: "user",
    accountStatus: "active",
    totpEnabled: true,
    passkeyEnabled: false,
    ...extra,
  }) as User;

const backupCheck = (user: User, facts: Parameters<typeof buildAccountSecurityOverview>[2] = {}) =>
  buildAccountSecurityOverview(user, [], facts).checks.find((check) => check.id === "backup_codes")!;

describe("countBackupCodes", () => {
  it("字段缺失返回 null（未知），而不是 0", () => {
    expect(countBackupCodes(baseUser())).toBeNull();
  });

  it("空数组才是真的 0", () => {
    expect(countBackupCodes(baseUser({ backupCodes: [] }))).toBe(0);
  });

  it("有码时返回条数", () => {
    expect(countBackupCodes(baseUser({ backupCodes: ["a", "b", "c"] }))).toBe(3);
  });
});

describe("安全总览的备用恢复码检查", () => {
  it("未知余量时不报「已用尽」，只提示无法读取", () => {
    const check = backupCheck(baseUser());
    expect(check.status).toBe("warn");
    expect(check.detail).not.toContain("已用尽");
  });

  it("确实用尽（空数组）时仍然按原样报 fail", () => {
    const check = backupCheck(baseUser({ backupCodes: [] }));
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("已用尽");
    expect(check.action).toBe("regenerate_backup_codes");
  });

  it("权威事实优先：用户对象上没有字段，facts 说还有 5 个 ⇒ pass", () => {
    const overview = buildAccountSecurityOverview(baseUser(), [], { backupCodesRemaining: 5 });
    expect(overview.backupCodesRemaining).toBe(5);
    expect(overview.backupCodesKnown).toBe(true);
    expect(overview.backupCodesLow).toBe(false);
    expect(overview.checks.find((c) => c.id === "backup_codes")!.status).toBe("pass");
  });

  it("权威事实为 0 时按 fail 处理（facts 覆盖现算值）", () => {
    const overview = buildAccountSecurityOverview(baseUser({ backupCodes: ["a", "b", "c"] }), [], {
      backupCodesRemaining: 0,
    });
    expect(overview.backupCodesRemaining).toBe(0);
    expect(overview.checks.find((c) => c.id === "backup_codes")!.status).toBe("fail");
  });

  it("未知余量时 backupCodesLow 不能为 true，否则 UI 会显示「（偏低）」", () => {
    const overview = buildAccountSecurityOverview(baseUser(), [], { backupCodesRemaining: null });
    expect(overview.backupCodesKnown).toBe(false);
    expect(overview.backupCodesLow).toBe(false);
  });

  it("已知余量 <= 2 时标记偏低", () => {
    const overview = buildAccountSecurityOverview(baseUser(), [], { backupCodesRemaining: 2 });
    expect(overview.backupCodesLow).toBe(true);
  });
});

describe("安全总览的账号密码检查", () => {
  it("公开投影缺密码字段时不再误报「没有设置密码」（facts 修正）", () => {
    const overview = buildAccountSecurityOverview(baseUser(), [], { hasPasswordMaterial: true });
    expect(overview.checks.find((c) => c.id === "password")!.status).toBe("pass");
  });

  it("确实没有密码材料时保持 warn", () => {
    const overview = buildAccountSecurityOverview(baseUser(), [], { hasPasswordMaterial: false });
    const check = overview.checks.find((c) => c.id === "password")!;
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("没有设置密码");
  });

  it("调用方传完整用户对象（含 passwordHash）时也能判出已设置密码", () => {
    const overview = buildAccountSecurityOverview(baseUser({ passwordHash: "$2b$10$abc" }), []);
    expect(overview.checks.find((c) => c.id === "password")!.status).toBe("pass");
  });
});
