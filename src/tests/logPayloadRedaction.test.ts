/**
 * `redactLogPayload` 的回归：日志 meta 载荷必须先过一道「按字段名过滤」的边界。
 *
 * 为什么值得单独测：它不是装饰性工具函数，而是 `js/clear-text-logging` 那批告警的
 * 处置点 —— 调用点只写「这里只记 id」的注释对静态分析无效（本仓不发抑制查询），
 * 真正的边界是这个函数。因此「名单内字段一定被打码」「名单外字段一定原样保留」
 * 两条都必须锁住，否则要么泄露、要么排障日志失真。
 */
import { redactLogPayload, REDACTED_LOG_VALUE } from "../utils/auditRedaction";

describe("redactLogPayload", () => {
  it("把名单内的凭据字段替换成占位串", () => {
    const redacted = redactLogPayload({
      apiKey: "sk-live-abcdef",
      password: "hunter2",
      clientSecret: "cs-123",
      verificationToken: "vt-9",
      cookie: "SESSDATA=abc",
    });

    expect(redacted).toEqual({
      apiKey: REDACTED_LOG_VALUE,
      password: REDACTED_LOG_VALUE,
      clientSecret: REDACTED_LOG_VALUE,
      verificationToken: REDACTED_LOG_VALUE,
      cookie: REDACTED_LOG_VALUE,
    });
  });

  it("名单外的排障字段原样保留（keyId 不是 key，scope 也不是 secret）", () => {
    const payload = {
      keyId: "key_123",
      userId: "user_9",
      scope: "key:key_123",
      status: "throttled",
      matched: 2,
      modified: 2,
      stepUpUntil: null,
      error: "boom",
    };

    expect(redactLogPayload(payload)).toEqual(payload);
  });

  it("嵌套对象里的凭据字段同样打码，且不修改入参", () => {
    const inner = { apiKey: "sk-nested", note: "ok" };
    const payload = { context: inner, userId: "user_1" };

    const redacted = redactLogPayload(payload);

    expect(redacted).toEqual({ context: { apiKey: REDACTED_LOG_VALUE, note: "ok" }, userId: "user_1" });
    // 入参未被就地改写：调用点可能还要拿原对象做别的事（例如回写审计）。
    expect(inner.apiKey).toBe("sk-nested");
  });

  it("数组元素逐个脱敏，标量与 Date / Error 原样透传", () => {
    const when = new Date("2026-11-21T00:00:00.000Z");
    const failure = new Error("upstream timeout");

    const redacted = redactLogPayload({
      when,
      failure,
      count: 3,
      flag: true,
      nothing: null,
      list: [{ token: "t-1" }, { keyId: "k-1" }],
    });

    expect(redacted.when).toBe(when);
    expect(redacted.failure).toBe(failure);
    expect(redacted.count).toBe(3);
    expect(redacted.flag).toBe(true);
    expect(redacted.nothing).toBeNull();
    expect(redacted.list).toEqual([{ token: REDACTED_LOG_VALUE }, { keyId: "k-1" }]);
  });

  it("超过递归深度的子树整体打码，而不是让整棵树进日志", () => {
    const redacted = redactLogPayload({
      level1: { level2: { level3: { apiKey: "sk-deep" } } },
    });

    expect(redacted).toEqual({ level1: { level2: { level3: REDACTED_LOG_VALUE } } });
    expect(JSON.stringify(redacted)).not.toContain("sk-deep");
  });

  it("空载荷安全：不发散、不抛错", () => {
    expect(redactLogPayload({})).toEqual({});
  });
});
