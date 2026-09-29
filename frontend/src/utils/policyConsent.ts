// 登录/注册必须逐项勾选的四份文件。
// 键名、复选框原文与锚点必须与后端 src/config/policyDocument.ts 的 POLICY_AGREEMENTS
// 逐项一致（键名定义在后端 policyConsentService.POLICY_AGREEMENT_KEYS）；
// 两侧各有契约测试钉住同一份清单，改一侧而不改另一侧会在 CI 失败。

export const POLICY_AGREEMENT_KEYS = ['terms', 'usage', 'specific-terms', 'supported-regions'] as const;

export type PolicyAgreementKey = (typeof POLICY_AGREEMENT_KEYS)[number];

export const POLICY_AGREEMENT_ANCHOR_PREFIX = 'policy-agreement-';

export interface PolicyConsentItem {
  key: PolicyAgreementKey;
  /** 复选框原文，与后端政策文档 agreements[].label 一致 */
  label: string;
  /** 政策页锚点 id，与后端 agreements[].anchor 一致 */
  anchor: string;
  /** 政策页深链，点击直达该文件的说明段落 */
  href: string;
}

const POLICY_AGREEMENT_LABELS: Record<PolicyAgreementKey, string> = {
  terms: '我已阅读并同意服务条款',
  usage: '我已阅读并同意使用政策',
  'specific-terms': '我已阅读并同意服务专项条款',
  'supported-regions': '我已阅读并同意支持地区',
};

export const POLICY_CONSENT_ITEMS: PolicyConsentItem[] = POLICY_AGREEMENT_KEYS.map(key => {
  const anchor = `${POLICY_AGREEMENT_ANCHOR_PREFIX}${key}`;
  return { key, label: POLICY_AGREEMENT_LABELS[key], anchor, href: `/policy#${anchor}` };
});

export type PolicyConsentSelection = Record<PolicyAgreementKey, boolean>;

export const createPolicyConsentSelection = (): PolicyConsentSelection =>
  POLICY_AGREEMENT_KEYS.reduce((selection, key) => {
    selection[key] = false;
    return selection;
  }, {} as PolicyConsentSelection);

export const isPolicyConsentComplete = (selection: PolicyConsentSelection): boolean =>
  POLICY_AGREEMENT_KEYS.every(key => selection[key] === true);

export interface PolicyConsentPayload {
  accepted: true;
  agreements: PolicyAgreementKey[];
}

// 四项未全部勾选时返回 null——客户端先自行拦截，服务端用同一套判据再验一次。
export const buildPolicyConsentPayload = (
  selection: PolicyConsentSelection,
): PolicyConsentPayload | null =>
  isPolicyConsentComplete(selection)
    ? { accepted: true, agreements: [...POLICY_AGREEMENT_KEYS] }
    : null;
