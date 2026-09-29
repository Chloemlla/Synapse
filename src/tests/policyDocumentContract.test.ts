import {
  POLICY_AGREEMENTS,
  POLICY_DOCUMENT,
  POLICY_SECTIONS,
} from "../config/policyDocument";
import {
  CONSENT_VALIDITY_DAYS,
  CURRENT_POLICY_VERSION,
  POLICY_AGREEMENT_KEYS,
  normalizeAuthPolicyConsent,
  resolveRequestFingerprint,
  shouldRequireAuthPolicyConsent,
} from "../services/policyConsentService";

// 契约测试：登录/注册的勾选清单、政策文档里的四份文件、以及同意记录的 agreements 字段
// 必须描述同一件事。这里钉住服务端一侧，前端一侧由
// frontend/src/utils/policyConsent.test.ts 钉住同样四项文案与锚点。
// 本文件不连数据库，因此会进 test:ci 门禁（policyApi.test.ts 因依赖真实环境被排除）。
describe("policy document contract", () => {
  it("documents exactly the four toggleable agreements, in the order the checkboxes use", () => {
    expect(POLICY_AGREEMENTS.map((agreement) => agreement.key)).toEqual([...POLICY_AGREEMENT_KEYS]);
  });

  it("uses the checkbox wording verbatim in the document", () => {
    expect(POLICY_AGREEMENTS.map((agreement) => agreement.label)).toEqual([
      "我已阅读并同意服务条款",
      "我已阅读并同意使用政策",
      "我已阅读并同意服务专项条款",
      "我已阅读并同意支持地区",
    ]);
  });

  it("anchors every agreement at policy-agreement-<key>", () => {
    for (const agreement of POLICY_AGREEMENTS) {
      expect(agreement.anchor).toBe(`policy-agreement-${agreement.key}`);
      expect(agreement.title.length).toBeGreaterThan(0);
      expect(agreement.summary.length).toBeGreaterThan(0);
      expect(agreement.points.length).toBeGreaterThan(0);
    }
    const anchors = POLICY_AGREEMENTS.map((agreement) => agreement.anchor);
    expect(new Set(anchors).size).toBe(anchors.length);
  });

  it("keeps sectionIds pointing at real sections so the page links never dead-end", () => {
    const sectionIds = new Set(POLICY_SECTIONS.map((section) => section.id));
    for (const agreement of POLICY_AGREEMENTS) {
      expect(agreement.sectionIds.length).toBeGreaterThan(0);
      for (const sectionId of agreement.sectionIds) {
        expect(sectionIds.has(sectionId)).toBe(true);
      }
    }
  });

  it("ships the agreements in the served document with the current version", () => {
    expect(POLICY_DOCUMENT.agreements).toEqual(POLICY_AGREEMENTS);
    expect(POLICY_DOCUMENT.version).toBe(CURRENT_POLICY_VERSION);
    expect(POLICY_DOCUMENT.procedures.consentValidityDays).toBe(CONSENT_VALIDITY_DAYS);
  });
});

describe("normalizeAuthPolicyConsent", () => {
  const allAgreements = [...POLICY_AGREEMENT_KEYS];

  it("accepts a payload that ticks all four", () => {
    expect(normalizeAuthPolicyConsent({ accepted: true, agreements: allAgreements })).toEqual({
      accepted: true,
      agreements: allAgreements,
    });
  });

  it("normalizes the order so a client cannot decide what gets recorded", () => {
    const shuffled = [allAgreements[2], allAgreements[0], allAgreements[3], allAgreements[1]];
    expect(normalizeAuthPolicyConsent({ accepted: true, agreements: shuffled })?.agreements).toEqual(allAgreements);
  });

  it("rejects a partially ticked list", () => {
    expect(normalizeAuthPolicyConsent({ accepted: true, agreements: allAgreements.slice(0, 3) })).toBeNull();
  });

  it("rejects unknown, duplicated, and non-string entries", () => {
    expect(normalizeAuthPolicyConsent({ accepted: true, agreements: [...allAgreements, "extra"] })).toBeNull();
    expect(normalizeAuthPolicyConsent({ accepted: true, agreements: [allAgreements[0], ...allAgreements] })).toBeNull();
    expect(normalizeAuthPolicyConsent({ accepted: true, agreements: [1, 2, 3, 4] })).toBeNull();
  });

  it("requires an explicit accepted:true", () => {
    expect(normalizeAuthPolicyConsent({ accepted: false, agreements: allAgreements })).toBeNull();
    expect(normalizeAuthPolicyConsent({ agreements: allAgreements })).toBeNull();
  });

  it("rejects anything that is not an object with the expected shape", () => {
    expect(normalizeAuthPolicyConsent(undefined)).toBeNull();
    expect(normalizeAuthPolicyConsent(null)).toBeNull();
    expect(normalizeAuthPolicyConsent("accepted")).toBeNull();
    expect(normalizeAuthPolicyConsent(allAgreements)).toBeNull();
    expect(normalizeAuthPolicyConsent({ accepted: true, agreements: "terms,usage" })).toBeNull();
  });
});

describe("resolveRequestFingerprint", () => {
  it("prefers the interceptor-injected header", () => {
    expect(resolveRequestFingerprint({ headers: { "x-fingerprint": "header-fp" }, body: { fingerprint: "body-fp" } })).toBe("header-fp");
  });

  it("falls back to the request body", () => {
    expect(resolveRequestFingerprint({ headers: {}, body: { fingerprint: "body-fp" } })).toBe("body-fp");
  });

  it("treats missing, blank, and placeholder values as absent", () => {
    expect(resolveRequestFingerprint({})).toBeNull();
    expect(resolveRequestFingerprint({ headers: { "x-fingerprint": "   " }, body: {} })).toBeNull();
    expect(resolveRequestFingerprint({ body: { fingerprint: "unknown" } })).toBeNull();
    expect(resolveRequestFingerprint({ headers: { "x-fingerprint": 42 } })).toBeNull();
  });
});

describe("shouldRequireAuthPolicyConsent", () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    delete process.env.AUTH_REQUIRE_POLICY_CONSENT;
  });

  it("stays off under test so existing auth suites do not need consent payloads", () => {
    process.env.NODE_ENV = "test";
    process.env.AUTH_REQUIRE_POLICY_CONSENT = "true";
    expect(shouldRequireAuthPolicyConsent()).toBe(false);
  });

  it("defaults to on in production", () => {
    process.env.NODE_ENV = "production";
    delete process.env.AUTH_REQUIRE_POLICY_CONSENT;
    expect(shouldRequireAuthPolicyConsent()).toBe(true);
  });

  it("defaults to off outside production", () => {
    process.env.NODE_ENV = "development";
    delete process.env.AUTH_REQUIRE_POLICY_CONSENT;
    expect(shouldRequireAuthPolicyConsent()).toBe(false);
  });

  it("honours the explicit override in both directions", () => {
    process.env.NODE_ENV = "production";
    process.env.AUTH_REQUIRE_POLICY_CONSENT = "false";
    expect(shouldRequireAuthPolicyConsent()).toBe(false);
    process.env.NODE_ENV = "development";
    process.env.AUTH_REQUIRE_POLICY_CONSENT = "true";
    expect(shouldRequireAuthPolicyConsent()).toBe(true);
  });
});
