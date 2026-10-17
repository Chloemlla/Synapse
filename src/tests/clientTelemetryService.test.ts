import { describe, expect, it } from "@jest/globals";
import {
  CLIENT_TELEMETRY_KINDS,
  MAX_EVENTS_PER_REPORT,
  redactTelemetryText,
  sanitizeTelemetryPath,
} from "../services/clientTelemetryService";

// 遥测服务对客户端数据一律不信任：这两条纯函数是「不把凭据与查询串带入库」的最后一道闸。
describe("redactTelemetryText", () => {
  it("抹掉 JWT / Bearer / 常见密钥形态", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefgHIJK";
    const text = [
      `Authorization: Bearer ${jwt}`,
      "api_key=sk-proj-1234567890abcdefghij",
      "token: 'plain-text-token-value'",
      "ghp_1234567890abcdefghijklmn",
    ].join("\n");
    const redacted = redactTelemetryText(text, 8_000);
    expect(redacted).not.toContain(jwt);
    expect(redacted).not.toContain("sk-proj-1234567890abcdefghij");
    expect(redacted).not.toContain("plain-text-token-value");
    expect(redacted).not.toContain("ghp_1234567890abcdefghijklmn");
    expect(redacted).toContain("[redacted]");
  });

  it("长度上限在脱敏之后仍然生效", () => {
    expect(redactTelemetryText("x".repeat(100), 10)).toHaveLength(10);
  });
});

describe("sanitizeTelemetryPath", () => {
  it("丢掉 query 与 hash（它们可能携带令牌）并折叠重复斜杠", () => {
    expect(sanitizeTelemetryPath("/geogebra?token=abc#x")).toBe("/geogebra");
    expect(sanitizeTelemetryPath("//geogebra//share/abc")).toBe("/geogebra/share/abc");
    expect(sanitizeTelemetryPath("geogebra")).toBe("/geogebra");
  });

  it("非字符串一律视为空路径", () => {
    expect(sanitizeTelemetryPath(null)).toBe("");
    expect(sanitizeTelemetryPath({ path: "/x" })).toBe("");
  });
});

describe("客户端遥测上限", () => {
  it("枚举收敛：新增类型必须同时出现在服务端白名单里", () => {
    // 前端 clientTelemetry.ts 的 kind 与这里保持同一集合；漏一个会被服务端归成 console。
    expect(CLIENT_TELEMETRY_KINDS).toEqual([
      "console",
      "window-error",
      "unhandled-rejection",
      "resource",
      "security-policy",
      "network",
      "verification",
      "performance",
      "navigation",
      "lifecycle",
      "manual",
    ]);
  });

  it("单批上限固定，避免一次上报变成写入放大", () => {
    expect(MAX_EVENTS_PER_REPORT).toBe(30);
  });
});
