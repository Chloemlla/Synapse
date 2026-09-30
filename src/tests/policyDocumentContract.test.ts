import {
  POLICY_AGREEMENTS,
  POLICY_DOCUMENT,
  POLICY_DOCUMENT_HASH,
  POLICY_SECTIONS,
} from "../config/policyDocument";
import {
  CONSENT_VALIDITY_DAYS,
  CURRENT_POLICY_VERSION,
  POLICY_AGREEMENT_KEYS,
  describeFingerprintForLog,
  isCompleteAgreementSet,
  missingAgreementKeys,
  normalizeAuthPolicyConsent,
  resolveConsentValidityDays,
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

  it("serves the merged status endpoint the frontend actually calls", () => {
    expect(POLICY_DOCUMENT.procedures.checkConsentEndpoint).toBe("GET /api/policy/check");
    expect(POLICY_DOCUMENT.procedures.statusEndpoint).toBe("GET /api/policy/status");
  });
});

// 条文指纹把「用户同意的是哪一份文本」变成可对账的：同意记录落库时一并保存 documentHash。
describe("policy document hash", () => {
  it("is a 64-char sha256 carried on the served document", () => {
    expect(POLICY_DOCUMENT_HASH).toMatch(/^[0-9a-f]{64}$/);
    expect(POLICY_DOCUMENT.documentHash).toBe(POLICY_DOCUMENT_HASH);
  });

  it("is deterministic across fresh module loads", () => {
    let reloaded = "";
    jest.isolateModules(() => {
      reloaded = (require("../config/policyDocument") as typeof import("../config/policyDocument"))
        .POLICY_DOCUMENT_HASH;
    });
    expect(reloaded).toBe(POLICY_DOCUMENT_HASH);
  });

  it("is not just a hash of the version string", () => {
    // 防止实现退化成 `sha256(version)`：那样改条文而不改版本号时指纹不变，对账就失效了。
    const crypto = require("node:crypto") as typeof import("node:crypto");
    const versionOnly = crypto.createHash("sha256").update(CURRENT_POLICY_VERSION).digest("hex");
    expect(POLICY_DOCUMENT_HASH).not.toBe(versionOnly);
  });
});

// 元信息工具的契约：这些函数直接决定「同意算不算有效」与「日志里会不会出现完整指纹」。
describe("policy meta helpers", () => {
  it("sanitizes the consent validity window instead of letting NaN reach the database", () => {
    expect(resolveConsentValidityDays(undefined)).toBe(30);
    expect(resolveConsentValidityDays("")).toBe(30);
    expect(resolveConsentValidityDays("abc")).toBe(30);
    expect(resolveConsentValidityDays("0")).toBe(30);
    expect(resolveConsentValidityDays("-5")).toBe(30);
    expect(resolveConsentValidityDays("99999")).toBe(30);
    expect(resolveConsentValidityDays("45")).toBe(45);
    expect(resolveConsentValidityDays("7.9")).toBe(7);
  });

  it("treats an agreement set as complete only when every key is present", () => {
    expect(isCompleteAgreementSet([...POLICY_AGREEMENT_KEYS])).toBe(true);
    expect(isCompleteAgreementSet([...POLICY_AGREEMENT_KEYS, "extra"])).toBe(true);
    expect(isCompleteAgreementSet(POLICY_AGREEMENT_KEYS.slice(0, 3))).toBe(false);
    expect(isCompleteAgreementSet(undefined)).toBe(false);
    expect(isCompleteAgreementSet(null)).toBe(false);
  });

  it("lists exactly the missing agreement keys", () => {
    expect(missingAgreementKeys(["terms"])).toEqual(["usage", "specific-terms", "supported-regions"]);
    expect(missingAgreementKeys([...POLICY_AGREEMENT_KEYS])).toEqual([]);
    expect(missingAgreementKeys(undefined)).toEqual([...POLICY_AGREEMENT_KEYS]);
  });

  it("never puts a full fingerprint in logs", () => {
    expect(describeFingerprintForLog("abcdef1234567890")).toBe("abcdef…(16)");
    expect(describeFingerprintForLog("  abc  ")).toBe("abc…(3)");
    expect(describeFingerprintForLog("")).toBe("(empty)");
    expect(describeFingerprintForLog(null)).toBe("(empty)");
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
