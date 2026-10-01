import { isValidCapSiteKey, sanitizeCapEndpoint, validateCapEndpoint } from "../services/turnstile/capEndpoint";

describe("validateCapEndpoint（Cap 实例地址 SSRF 防护）", () => {
  it("接受公网 http/https 地址并去掉尾斜杠", () => {
    expect(validateCapEndpoint("https://cap.example.com/")).toEqual({ ok: true, origin: "https://cap.example.com" });
    expect(validateCapEndpoint("http://cap.example.com")).toEqual({ ok: true, origin: "http://cap.example.com" });
    expect(validateCapEndpoint("https://cap.example.com:8443/")).toEqual({
      ok: true,
      origin: "https://cap.example.com:8443",
    });
  });

  it("丢弃 query/hash（origin 重建）", () => {
    expect(validateCapEndpoint("https://cap.example.com/?a=1#x").ok).toBe(true);
    expect(validateCapEndpoint("https://cap.example.com/?a=1#x").origin).toBe("https://cap.example.com");
  });

  it("拒绝回环、私网、链路本地与云元数据地址", () => {
    for (const target of [
      "http://localhost:3000",
      "http://127.0.0.1:3000",
      "http://10.1.2.3",
      "http://192.168.1.10",
      "http://172.16.5.5",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]:3000",
      "http://metadata.google.internal",
      "http://cap.internal",
    ]) {
      const result = validateCapEndpoint(target);
      expect(result.ok).toBe(false);
      expect(result.reason).toBeTruthy();
    }
  });

  it("拒绝非 http(s) 协议与带凭据的 URL", () => {
    expect(validateCapEndpoint("ftp://cap.example.com").ok).toBe(false);
    expect(validateCapEndpoint("file:///etc/passwd").ok).toBe(false);
    expect(validateCapEndpoint("https://user:pass@cap.example.com").ok).toBe(false);
  });

  it("拒绝子路径部署（显式报错而非静默截断）", () => {
    const result = validateCapEndpoint("https://cap.example.com/cap");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("子路径");
  });

  it("无法解析或留空时回落到默认实例", () => {
    expect(validateCapEndpoint("not a url").ok).toBe(false);
    const fallback = sanitizeCapEndpoint(null);
    expect(fallback.startsWith("https://")).toBe(true);
    expect(sanitizeCapEndpoint("http://127.0.0.1:1")).toBe(fallback);
  });
});

describe("isValidCapSiteKey", () => {
  it("只接受 Cap 的 10 位十六进制站点密钥", () => {
    expect(isValidCapSiteKey("e8e48d07cf")).toBe(true);
    expect(isValidCapSiteKey("E8E48D07CF")).toBe(true);
    expect(isValidCapSiteKey(" e8e48d07cf ")).toBe(true);
  });

  it("拒绝越界、带路径或非十六进制的值", () => {
    for (const bad of ["", "short", "0123456789ab", "../../etc/passwd", "e8e48d07cg", "a@evil.com", "//evil.com"]) {
      expect(isValidCapSiteKey(bad)).toBe(false);
    }
    expect(isValidCapSiteKey(undefined)).toBe(false);
    expect(isValidCapSiteKey(12345)).toBe(false);
  });
});
