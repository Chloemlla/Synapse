import { describe, expect, it } from "@jest/globals";
import { normalizeTicketAttachmentGrantedUserIds } from "../services/runtimeConfigService";
import { resolveAttachmentUploadPermission } from "../controllers/ticketController";

/**
 * 工单附件「单独授权」。
 *
 * 背景：附件上传默认关闭（白名单只挡类型，挡不住「类型对但内容是恶意文件」）。
 * 客服偶尔确实需要某个用户补一张截图，于是加了按用户 ID 的例外名单。
 * 这里钉住两件事：
 *   1. 名单归一化不能把脏数据落库（否则会长期占位且难以排查）；
 *   2. 判据是「全站开关 **或** 名单命中」，且管理员无论如何都放行。
 */

describe("normalizeTicketAttachmentGrantedUserIds", () => {
  it("去空白、去重并保持原有顺序", () => {
    expect(
      normalizeTicketAttachmentGrantedUserIds(["1700000000001", " 1700000000002 ", "1700000000001"]),
    ).toEqual(["1700000000001", "1700000000002"]);
  });

  it("接受换行/逗号分隔的字符串（管理员从表格里粘贴）", () => {
    expect(normalizeTicketAttachmentGrantedUserIds("1001\n1002,1003")).toEqual(["1001", "1002", "1003"]);
  });

  it("丢弃非法形态，而不是原样落库", () => {
    const result = normalizeTicketAttachmentGrantedUserIds([
      "",
      "   ",
      "has space",
      "中文ID",
      "a".repeat(65),
      "contains/slash",
      "valid_1-2",
      null,
      42,
      { id: "nested" },
    ]);
    expect(result).toEqual(["valid_1-2"]);
  });

  it("非数组也非字符串时返回空名单（fail-closed 到不授权）", () => {
    expect(normalizeTicketAttachmentGrantedUserIds(undefined)).toEqual([]);
    expect(normalizeTicketAttachmentGrantedUserIds(null)).toEqual([]);
    expect(normalizeTicketAttachmentGrantedUserIds({ length: 1 })).toEqual([]);
  });

  it("超上限时截断而不是整份丢弃（只会少授权，方向是安全的）", () => {
    const many = Array.from({ length: 250 }, (_, index) => `u${index}`);
    const result = normalizeTicketAttachmentGrantedUserIds(many);
    expect(result).toHaveLength(200);
    expect(result[0]).toBe("u0");
    expect(result).not.toContain("u200");
  });
});

describe("resolveAttachmentUploadPermission", () => {
  const base = { globalEnabled: false, grantedUserIds: ["1001"] as const };

  it("全站关闭、不在名单里 ⇒ 拒绝", () => {
    expect(resolveAttachmentUploadPermission({ ...base, userId: "2002", role: "user" })).toBe(false);
  });

  it("全站关闭但在名单里 ⇒ 放行（单独授权的意义）", () => {
    expect(resolveAttachmentUploadPermission({ ...base, userId: "1001", role: "user" })).toBe(true);
  });

  it("全站打开 ⇒ 所有人都放行，与名单无关", () => {
    expect(
      resolveAttachmentUploadPermission({
        globalEnabled: true,
        grantedUserIds: [],
        userId: "2002",
        role: "user",
      }),
    ).toBe(true);
  });

  it("管理员/超管不受开关与名单限制", () => {
    for (const role of ["admin", "superadmin"]) {
      expect(
        resolveAttachmentUploadPermission({ globalEnabled: false, grantedUserIds: [], role }),
      ).toBe(true);
    }
  });

  it("数字形态的用户 ID 也会按字符串匹配（JWT 载荷与配置的类型口径不同）", () => {
    expect(resolveAttachmentUploadPermission({ ...base, userId: 1001 })).toBe(true);
  });

  it("没有用户 ID 时不会因为名单里有空串而误放行", () => {
    expect(
      resolveAttachmentUploadPermission({
        globalEnabled: false,
        grantedUserIds: [""],
        userId: undefined,
        role: "user",
      }),
    ).toBe(false);
  });

  it("名单缺失（旧配置读出来的 undefined）时按拒绝处理", () => {
    expect(
      resolveAttachmentUploadPermission({
        globalEnabled: false,
        grantedUserIds: undefined,
        userId: "1001",
        role: "user",
      }),
    ).toBe(false);
  });
});
