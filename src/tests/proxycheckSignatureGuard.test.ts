import { assessStoredVerificationKey, isValidHmacKeyShape } from "../services/proxycheckSignature";

/**
 * 回归：存量 PROXYCHECK 文档里的 payloadVerificationKey 被填成本服务的 hmacSecret 时，
 * 载入必须按「未配置」处理，否则每次查询都会因上游不带 http_x_signature 而失败，
 * 风控整段 fail_open 静默放行（2026-10-02 线上事故的形态）。
 */
describe("assessStoredVerificationKey", () => {
  const validKey = "a".repeat(64);
  const hmacSecret = "b".repeat(64);

  it("空值与未配置等价，且不产生告警原因", () => {
    expect(assessStoredVerificationKey("", hmacSecret)).toEqual({ key: "", rejected: null });
    expect(assessStoredVerificationKey(undefined, hmacSecret)).toEqual({ key: "", rejected: null });
    expect(assessStoredVerificationKey(null, hmacSecret)).toEqual({ key: "", rejected: null });
    expect(assessStoredVerificationKey("   ", hmacSecret)).toEqual({ key: "", rejected: null });
  });

  it("与 hmacSecret 同串的存量值被拒收（线上事故形态）", () => {
    expect(assessStoredVerificationKey(hmacSecret, hmacSecret)).toEqual({
      key: "",
      rejected: "same_as_hmac_secret",
    });
    // 前后空白不影响判定
    expect(assessStoredVerificationKey(`  ${hmacSecret}  `, hmacSecret).rejected).toBe("same_as_hmac_secret");
  });

  it("长度不是 64 的存量值被拒收", () => {
    expect(assessStoredVerificationKey("short-key", hmacSecret).rejected).toBe("malformed");
    expect(assessStoredVerificationKey("a".repeat(63), hmacSecret).rejected).toBe("malformed");
    expect(assessStoredVerificationKey("a".repeat(65), hmacSecret).rejected).toBe("malformed");
  });

  it("合法的 Dashboard 密钥原样保留（去空白）", () => {
    expect(assessStoredVerificationKey(validKey, hmacSecret)).toEqual({ key: validKey, rejected: null });
    expect(assessStoredVerificationKey(` ${validKey} `, hmacSecret)).toEqual({ key: validKey, rejected: null });
    expect(isValidHmacKeyShape(validKey)).toBe(true);
  });
});
