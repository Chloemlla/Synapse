import { sanitizeErrorForLog, sanitizeLogValue } from "../utils/requestLogSanitizer";

describe("request log sanitizer", () => {
  it("redacts sensitive keys recursively", () => {
    const sanitized = sanitizeLogValue({
      authorization: "Bearer secret",
      nested: {
        password: "hunter2",
        safe: "visible",
      },
    }) as Record<string, any>;

    expect(sanitized.authorization).toBe("[redacted]");
    expect(sanitized.nested.password).toBe("[redacted]");
    expect(sanitized.nested.safe).toBe("visible");
  });

  it("truncates long strings", () => {
    const sanitized = sanitizeLogValue({ body: "x".repeat(1100) }) as Record<string, string>;

    expect(sanitized.body).toContain("[truncated");
    expect(sanitized.body.length).toBeLessThan(1100);
  });

  it("collapses errors to type and truncated message", () => {
    const error = new Error(`boom ${"y".repeat(400)}`);
    const text = sanitizeErrorForLog(error);

    expect(text.startsWith("Error: boom")).toBe(true);
    expect(text.length).toBeLessThanOrEqual(300);
    expect(text).not.toContain("y".repeat(400));
    expect(sanitizeErrorForLog(null)).toBe("unknown");
    expect(sanitizeErrorForLog({ apiKey: "secret" })).toBe("object");
  });
});

