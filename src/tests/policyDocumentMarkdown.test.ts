import { POLICY_DOCUMENT, POLICY_DOCUMENT_HASH } from "../config/policyDocument";
import { policyArchiveFilename, renderPolicyDocumentMarkdown } from "../utils/policyDocumentMarkdown";

// 条文存档副本：用户被告知「你同意的是哪份文本」时最直接的证据是一份可离线保存的副本。
// 这里钉住三件事：内容与条文同源（每条正文/勾选项/提示都出现）、指纹与版本可对账、
// 以及渲染本身确定性（同一条文 + 同一生成时间必须逐字一致）。
describe("policy document markdown archive", () => {
  const generatedAt = new Date(Date.UTC(2026, 8, 30, 12, 0, 0));
  const markdown = renderPolicyDocumentMarkdown(POLICY_DOCUMENT, { generatedAt });

  it("carries version, fingerprint and dates so an archive can be matched to a consent record", () => {
    expect(markdown).toContain(`# ${POLICY_DOCUMENT.title}`);
    expect(markdown).toContain(POLICY_DOCUMENT.description);
    expect(markdown).toContain(`v${POLICY_DOCUMENT.version}`);
    expect(markdown).toContain(POLICY_DOCUMENT_HASH);
    expect(markdown).toContain(POLICY_DOCUMENT.effectiveDate);
    expect(markdown).toContain(POLICY_DOCUMENT.lastUpdated);
    expect(markdown).toContain(String(POLICY_DOCUMENT.procedures.consentValidityDays));
  });

  it("renders every section title and every clause verbatim", () => {
    for (const section of POLICY_DOCUMENT.sections) {
      expect(markdown).toContain(section.title);
      expect(markdown).toContain(section.summary);
      for (const item of section.items) {
        expect(markdown).toContain(item);
      }
    }
  });

  it("renders the four toggleable agreements with their checkbox wording", () => {
    for (const agreement of POLICY_DOCUMENT.agreements) {
      expect(markdown).toContain(agreement.title);
      expect(markdown).toContain(agreement.label);
      expect(markdown).toContain(agreement.summary);
      for (const point of agreement.points) {
        expect(markdown).toContain(point);
      }
    }
  });

  it("renders highlights, warnings, revisions, contacts and the endpoint table", () => {
    for (const highlight of POLICY_DOCUMENT.highlights) expect(markdown).toContain(highlight.title);
    for (const warning of POLICY_DOCUMENT.warnings) expect(markdown).toContain(warning.title);
    for (const revision of POLICY_DOCUMENT.revisions) {
      expect(markdown).toContain(`v${revision.version}`);
      for (const change of revision.changes) expect(markdown).toContain(change);
    }
    for (const contact of POLICY_DOCUMENT.contacts) expect(markdown).toContain(contact.email);

    expect(markdown).toContain(POLICY_DOCUMENT.procedures.documentEndpoint);
    expect(markdown).toContain(POLICY_DOCUMENT.procedures.documentArchiveEndpoint);
    expect(markdown).toContain(POLICY_DOCUMENT.procedures.statusEndpoint);
    expect(markdown).toContain(POLICY_DOCUMENT.procedures.historyEndpoint);
    expect(markdown).toContain(POLICY_DOCUMENT.procedures.revokeConsentEndpoint);
  });

  it("is deterministic for a fixed generation time", () => {
    expect(renderPolicyDocumentMarkdown(POLICY_DOCUMENT, { generatedAt })).toBe(markdown);
  });

  it("names the archive after the version and fingerprint prefix", () => {
    expect(policyArchiveFilename(POLICY_DOCUMENT)).toBe(
      `synapse-policy-v${POLICY_DOCUMENT.version}-${POLICY_DOCUMENT_HASH.slice(0, 8)}.md`,
    );
  });
});
