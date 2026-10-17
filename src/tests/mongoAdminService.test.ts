import { describe, expect, it } from "@jest/globals";
import {
  assertSafeFilter,
  normalizeMongoValue,
  parseBooleanFlag,
  parseMongoAdminFilter,
  presentMongoDocument,
} from "../services/mongoAdminService";

/**
 * MongoDB 在库数据浏览的两个安全边界：
 * 1. 过滤条件是**受限 JSON**：不允许 `$where` / `$function` / `$accumulator` 之类在服务端执行脚本的操作符；
 * 2. 脱敏是**可选但真实生效**的：默认原样（安全会话已建立），`redact=1` 时凭据字段必须变成 `[redacted]`，
 *    且 BSON 类型要能安全序列化成 JSON。
 */

describe("parseMongoAdminFilter", () => {
  it("空值表示不加条件", () => {
    expect(parseMongoAdminFilter(undefined)).toEqual({ ok: true, filter: {} });
    expect(parseMongoAdminFilter("")).toEqual({ ok: true, filter: {} });
    expect(parseMongoAdminFilter("   ")).toEqual({ ok: true, filter: {} });
  });

  it("接受普通对象，并保留嵌套条件", () => {
    expect(parseMongoAdminFilter('{"userId":"u1","createdAt":{"$gte":"2026-01-01"}}')).toEqual({
      ok: true,
      filter: { userId: "u1", createdAt: { $gte: "2026-01-01" } },
    });
  });

  it("拒绝非 JSON、非对象与超长输入", () => {
    expect(parseMongoAdminFilter("{bad json").ok).toBe(false);
    expect(parseMongoAdminFilter("[1,2,3]").ok).toBe(false);
    expect(parseMongoAdminFilter('"text"').ok).toBe(false);
    expect(parseMongoAdminFilter("x".repeat(5000)).ok).toBe(false);
    expect(parseMongoAdminFilter(42).ok).toBe(false);
  });

  it("拒绝可在服务端执行脚本的操作符（含嵌套）", () => {
    for (const raw of [
      '{"$where":"sleep(1000)"}',
      '{"$function":{"body":"while(true){}"}}',
      '{"$accumulator":"x"}',
      '{"a":{"$where":"1"}}',
      '{"$or":[{"$where":"1"}]}',
    ]) {
      const result = parseMongoAdminFilter(raw);
      expect(result.ok, raw).toBe(false);
    }
  });
});

describe("assertSafeFilter", () => {
  it("允许常规查询操作符", () => {
    expect(assertSafeFilter({ status: "active", createdAt: { $gte: "x" }, $or: [{ a: 1 }, { b: 2 }] })).toBeNull();
  });

  it("嵌套过深时拒绝（防止构造超深表达式拖垮解析）", () => {
    let deep: Record<string, unknown> = { a: 1 };
    for (let i = 0; i < 12; i += 1) deep = { nested: deep };
    expect(assertSafeFilter(deep)).toContain("嵌套过深");
  });
});

describe("parseBooleanFlag", () => {
  it("只认 1 / true", () => {
    expect(parseBooleanFlag("1")).toBe(true);
    expect(parseBooleanFlag("true")).toBe(true);
    expect(parseBooleanFlag(" TRUE ")).toBe(true);
    expect(parseBooleanFlag(true)).toBe(true);
  });

  it("其余一律视为关闭（默认原样返回；外层已强制超管 + 安全会话）", () => {
    for (const value of ["0", "false", "", "yes", undefined, null, 1, {}]) {
      expect(parseBooleanFlag(value)).toBe(false);
    }
  });
});

describe("presentMongoDocument", () => {
  const document = {
    _id: { toHexString: () => "507f1f77bcf86cd799439011" },
    username: "alice",
    password: "plain",
    passwordHash: "hash",
    token: "token",
    apiKey: "key",
    nested: { secretValue: "s" },
  };

  it("默认原样返回（仅把 BSON 归一成 JSON 可序列化的值）", () => {
    const raw = presentMongoDocument(document, false) as Record<string, unknown>;
    expect(raw._id).toBe("507f1f77bcf86cd799439011");
    expect(raw.username).toBe("alice");
    expect(raw.password).toBe("plain");
    expect(raw.passwordHash).toBe("hash");
    expect(raw.token).toBe("token");
    expect(raw.apiKey).toBe("key");
    expect((raw.nested as Record<string, unknown>).secretValue).toBe("s");
    // 结果必须能安全 JSON 序列化（否则前端会看到 {$numberLong:...} 之类的形状）。
    expect(() => JSON.stringify(raw)).not.toThrow();
  });

  it("redact=true 时替换凭据字段", () => {
    const redacted = presentMongoDocument(document, true) as Record<string, unknown>;
    expect(redacted.username).toBe("alice");
    for (const key of ["password", "passwordHash", "token", "apiKey"]) {
      expect(redacted[key]).toBe("[redacted]");
    }
    expect((redacted.nested as Record<string, unknown>).secretValue).toBe("[redacted]");
  });
});

describe("normalizeMongoValue", () => {
  it("转换常见 BSON 类型", () => {
    expect(normalizeMongoValue(new Date("2026-10-17T00:00:00.000Z"))).toBe("2026-10-17T00:00:00.000Z");
    expect(normalizeMongoValue({ _bsontype: "ObjectId", toHexString: () => "abcdefabcdefabcdefabcdef" }))
      .toBe("abcdefabcdefabcdefabcdef");
    expect(normalizeMongoValue({ _bsontype: "Long", toNumber: () => 42 })).toBe(42);
    expect(normalizeMongoValue({ _bsontype: "Decimal128", toString: () => "1.5" })).toBe("1.5");
  });

  it("二进制只报大小，不把字节写进 JSON", () => {
    const value = normalizeMongoValue(Buffer.from("secret-bytes")) as Record<string, unknown>;
    expect(value).toEqual({ redacted: true, type: "binary", bytes: 12 });
  });

  it("嵌套过深时截断", () => {
    let deep: Record<string, unknown> = { value: 1 };
    for (let i = 0; i < 20; i += 1) deep = { child: deep };
    expect(JSON.stringify(normalizeMongoValue(deep))).toContain("[max-depth]");
  });
});
