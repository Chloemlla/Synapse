import { describe, expect, it } from 'vitest';
import {
  POLICY_AGREEMENT_KEYS,
  POLICY_CONSENT_ITEMS,
  buildPolicyConsentPayload,
  createPolicyConsentSelection,
  describeAgreementKey,
  isPolicyAgreementSetComplete,
  isPolicyConsentComplete,
  missingPolicyAgreements,
} from './policyConsent';

// 这份清单与后端 src/config/policyDocument.ts 的 POLICY_AGREEMENTS 必须逐项一致：
// 键名决定服务端能不能接受这次提交，锚点决定「查看条文」是否落到真实段落。
// 后端 src/tests/policyDocumentContract.test.ts 钉的是同一份清单，改一侧不改另一侧会红。
describe('policyConsent', () => {
  it('keeps the four agreements in the order the policy document uses', () => {
    expect(POLICY_AGREEMENT_KEYS).toEqual(['terms', 'usage', 'specific-terms', 'supported-regions']);
  });

  it('renders the checkbox labels verbatim', () => {
    expect(POLICY_CONSENT_ITEMS.map(item => item.label)).toEqual([
      '我已阅读并同意服务条款与隐私政策',
      '我已阅读并同意使用政策',
      '我已阅读并同意服务专项条款',
      '我已阅读并同意支持地区',
    ]);
  });

  it('links every item to its own anchor on the policy page', () => {
    expect(POLICY_CONSENT_ITEMS.map(item => item.anchor)).toEqual([
      'policy-agreement-terms',
      'policy-agreement-usage',
      'policy-agreement-specific-terms',
      'policy-agreement-supported-regions',
    ]);
    for (const item of POLICY_CONSENT_ITEMS) {
      expect(item.href).toBe(`/policy#${item.anchor}`);
    }
  });

  it('starts with everything unchecked and incomplete', () => {
    const selection = createPolicyConsentSelection();
    expect(Object.values(selection).every(value => value === false)).toBe(true);
    expect(isPolicyConsentComplete(selection)).toBe(false);
    expect(buildPolicyConsentPayload(selection)).toBeNull();
  });

  it('only builds a payload once all four are ticked', () => {
    const partial = { ...createPolicyConsentSelection(), terms: true, usage: true };
    expect(buildPolicyConsentPayload(partial)).toBeNull();

    const complete = POLICY_AGREEMENT_KEYS.reduce((selection, key) => {
      selection[key] = true;
      return selection;
    }, createPolicyConsentSelection());
    expect(buildPolicyConsentPayload(complete)).toEqual({
      accepted: true,
      agreements: ['terms', 'usage', 'specific-terms', 'supported-regions'],
    });
  });
});

describe('policyConsent helpers used by the panels', () => {
  it('exposes a human-readable title per agreement key', () => {
    expect(POLICY_CONSENT_ITEMS.map(item => item.title)).toEqual([
      '服务条款与隐私政策',
      '使用政策',
      '服务专项条款',
      '支持地区',
    ]);
  });

  it('describes unknown keys verbatim instead of throwing', () => {
    expect(describeAgreementKey('terms')).toBe('服务条款与隐私政策');
    expect(describeAgreementKey('brand-new-agreement')).toBe('brand-new-agreement');
  });

  it('lists the missing agreements of a stored record', () => {
    expect(missingPolicyAgreements(['terms', 'usage', 'specific-terms', 'supported-regions'])).toEqual([]);
    expect(missingPolicyAgreements(['terms'])).toEqual(['usage', 'specific-terms', 'supported-regions']);
    // 早期记录没有 agreements 字段：四份都算缺
    expect(missingPolicyAgreements(undefined)).toEqual([...POLICY_AGREEMENT_KEYS]);
    expect(isPolicyAgreementSetComplete(undefined)).toBe(false);
    expect(isPolicyAgreementSetComplete([...POLICY_AGREEMENT_KEYS, 'extra'])).toBe(true);
  });

  it('anchors every agreement at policy-agreement-<key>', () => {
    for (const item of POLICY_CONSENT_ITEMS) {
      expect(item.anchor).toBe(`policy-agreement-${item.key}`);
      expect(item.href).toBe(`/policy#${item.anchor}`);
    }
  });
});
