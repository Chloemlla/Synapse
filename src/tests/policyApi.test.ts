import request from "supertest";
import app from "../app";
import type { PolicyDocument } from "../config/policyDocument";
import { PolicyConsent } from "../models/policyConsentModel";
import { connectMongo, mongoose } from "../services/mongoService";
import {
  CONSENT_VALIDITY_DAYS,
  CURRENT_POLICY_VERSION,
  generatePolicyChecksum,
} from "../services/policyConsentService";

describe("Policy API MongoDB contract", () => {
  beforeAll(async () => {
    await connectMongo();
    await PolicyConsent.deleteMany({});
  });

  afterAll(async () => {
    await PolicyConsent.deleteMany({});
    await mongoose.disconnect();
  });

  it("reports the server policy version and validity window", async () => {
    const response = await request(app).get("/api/policy/version").expect(200);

    expect(response.body).toEqual({
      success: true,
      version: CURRENT_POLICY_VERSION,
      validityDays: CONSENT_VALIDITY_DAYS,
    });
  });

  it("serves the policy document with the current version and unique section anchors", async () => {
    const response = await request(app).get("/api/policy/document").expect(200);

    expect(response.body.success).toBe(true);

    const document = response.body.document as PolicyDocument;
    expect(document.version).toBe(CURRENT_POLICY_VERSION);
    expect(document.effectiveDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(document.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(document.sections.length).toBeGreaterThan(0);

    // 章节锚点必须唯一：前端把它渲染成 #policy-<id>，重复会让目录跳错位置
    const ids = document.sections.map((section) => section.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const section of document.sections) {
      expect(section.title.length).toBeGreaterThan(0);
      expect(section.summary.length).toBeGreaterThan(0);
      expect(section.items.length).toBeGreaterThan(0);
    }

    // 条文里给出的程序化入口必须与真实路由一致
    expect(document.procedures.consentValidityDays).toBe(CONSENT_VALIDITY_DAYS);
    expect(document.procedures.documentEndpoint).toBe("GET /api/policy/document");
    expect(document.procedures.revokeConsentEndpoint).toBe("POST /api/policy/revoke");
  });

  it("records, verifies, revokes, and invalidates a consent", async () => {
    // 使用 supertest agent，自动保留 verify 时下发的设备凭据 cookie
    const agent = request.agent(app);

    const consent = {
      timestamp: Date.now(),
      version: CURRENT_POLICY_VERSION,
      fingerprint: `nightly-policy-${Date.now()}`,
    };
    const checksum = generatePolicyChecksum(consent);

    const recorded = await agent
      .post("/api/policy/verify")
      .send({ consent: { ...consent, checksum }, userAgent: "PolicyNightly/1.0" })
      .expect(200);

    expect(recorded.body).toEqual(
      expect.objectContaining({
        success: true,
        consentId: expect.any(String),
        expiresAt: expect.any(String),
      }),
    );

    const verified = await agent
      .get("/api/policy/check")
      .query({ fingerprint: consent.fingerprint, version: consent.version })
      .expect(200);

    expect(verified.body).toEqual(
      expect.objectContaining({
        success: true,
        hasValidConsent: true,
        version: CURRENT_POLICY_VERSION,
      }),
    );

    const revoked = await agent
      .post("/api/policy/revoke")
      .send({ fingerprint: consent.fingerprint, version: consent.version })
      .expect(200);

    expect(revoked.body).toEqual(
      expect.objectContaining({
        success: true,
        revokedCount: 1,
      }),
    );

    const afterRevoke = await agent
      .get("/api/policy/check")
      .query({ fingerprint: consent.fingerprint, version: consent.version })
      .expect(200);

    expect(afterRevoke.body).toEqual(
      expect.objectContaining({
        success: false,
        hasValidConsent: false,
        currentVersion: CURRENT_POLICY_VERSION,
      }),
    );
  });

  it("rejects revoke/check without the device credential (cookie)", async () => {
    const consent = {
      timestamp: Date.now(),
      version: CURRENT_POLICY_VERSION,
      fingerprint: `nightly-unauthorized-${Date.now()}`,
    };
    const checksum = generatePolicyChecksum(consent);

    // 用一个匿名 agent 记录同意（拿到 cookie），再用另一个匿名 agent 尝试撤销
    const ownerAgent = request.agent(app);
    await ownerAgent
      .post("/api/policy/verify")
      .send({ consent: { ...consent, checksum }, userAgent: "PolicyNightly/1.0" })
      .expect(200);

    const attackerAgent = request.agent(app);
    const revoked = await attackerAgent
      .post("/api/policy/revoke")
      .send({ fingerprint: consent.fingerprint, version: consent.version })
      .expect(403);

    expect(revoked.body.code).toBe("DEVICE_CREDENTIAL_REQUIRED");
  });

  it("rejects a consent with an invalid checksum", async () => {
    const response = await request(app)
      .post("/api/policy/verify")
      .send({
        consent: {
          timestamp: Date.now(),
          version: CURRENT_POLICY_VERSION,
          fingerprint: `nightly-invalid-${Date.now()}`,
          checksum: "invalid-checksum",
        },
      })
      .expect(400);

    expect(response.body).toEqual(
      expect.objectContaining({
        success: false,
        code: "INVALID_CHECKSUM",
      }),
    );
  });
});
