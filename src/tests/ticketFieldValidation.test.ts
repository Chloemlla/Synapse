import { describe, expect, it } from "@jest/globals";
import {
  MAX_TICKET_CONTACT_EMAIL_LEN,
  MAX_TICKET_RELATED_TICKETS,
  MAX_TICKET_SERVICE_REF_LEN,
  asTicketRelatedService,
  asTicketType,
  normalizeContactEmail,
  normalizeRelatedServiceRef,
  normalizeRelatedTicketIds,
} from "../utils/ticketFields";

/**
 * 新增工单字段的解析容错：
 * - 用户侧表单字段非法时**回退默认值**（多一个下拉不该让提交失败）；
 * - 显式给错的字段（管理端改字段、关联工单越界）必须报错，否则等于静默丢掉用户的操作。
 */
describe("asTicketType / asTicketRelatedService", () => {
  it("accepts known values and rejects everything else", () => {
    expect(asTicketType("incident")).toBe("incident");
    expect(asTicketType("故障")).toBeNull();
    expect(asTicketType(1)).toBeNull();
    expect(asTicketRelatedService("tts")).toBe("tts");
    expect(asTicketRelatedService("vps")).toBeNull();
    expect(asTicketRelatedService(undefined)).toBeNull();
  });
});

describe("normalizeRelatedServiceRef", () => {
  it("collapses whitespace, trims and caps the length", () => {
    expect(normalizeRelatedServiceRef("  job-1\n\n  任务  ")).toBe("job-1 任务");
    expect(normalizeRelatedServiceRef("")).toBeNull();
    expect(normalizeRelatedServiceRef(null)).toBeNull();
    expect(normalizeRelatedServiceRef(42)).toBeNull();
    expect(normalizeRelatedServiceRef("x".repeat(500))).toHaveLength(MAX_TICKET_SERVICE_REF_LEN);
  });
});

describe("normalizeContactEmail", () => {
  it("treats empty input as 'use the account email'", () => {
    expect(normalizeContactEmail(undefined)).toEqual({ ok: true, email: null });
    expect(normalizeContactEmail("")).toEqual({ ok: true, email: null });
    expect(normalizeContactEmail("   ")).toEqual({ ok: true, email: null });
  });

  it("accepts a valid address and rejects malformed ones", () => {
    expect(normalizeContactEmail(" alice@example.com ")).toEqual({ ok: true, email: "alice@example.com" });
    expect(normalizeContactEmail("not-an-email")).toEqual({ ok: false, error: "联系邮箱格式不正确" });
    expect(normalizeContactEmail("a@b")).toEqual({ ok: false, error: "联系邮箱格式不正确" });
    expect(normalizeContactEmail(123)).toEqual({ ok: false, error: "联系邮箱格式不正确" });
    const tooLong = `${"a".repeat(MAX_TICKET_CONTACT_EMAIL_LEN)}@example.com`;
    const result = normalizeContactEmail(tooLong);
    expect(result.ok).toBe(false);
  });
});

describe("normalizeRelatedTicketIds", () => {
  const id1 = "0123456789abcdef01234567";
  const id2 = "0123456789abcdef01234568";

  it("dedupes, drops empties and keeps the given order", () => {
    expect(normalizeRelatedTicketIds([id1, "", null, id2, id1])).toEqual({ ok: true, ids: [id1, id2] });
    expect(normalizeRelatedTicketIds(undefined)).toEqual({ ok: true, ids: [] });
  });

  it("rejects malformed ids and too many entries", () => {
    const bad = normalizeRelatedTicketIds(["not-an-object-id"]);
    expect(bad.ok).toBe(false);

    const tooMany = normalizeRelatedTicketIds(
      Array.from({ length: MAX_TICKET_RELATED_TICKETS + 1 }, (_, index) =>
        `0123456789abcdef012345${String(index).padStart(2, "0")}`,
      ),
    );
    expect(tooMany.ok).toBe(false);

    const notArray = normalizeRelatedTicketIds(id1);
    expect(notArray.ok).toBe(false);
  });
});
