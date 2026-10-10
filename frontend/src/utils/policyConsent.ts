// 登录/注册必须逐项勾选的四份文件（服务条款与隐私政策 / 使用政策 / 服务专项条款 / 支持地区）。
// 键名、复选框原文与锚点必须与后端 src/config/policyMeta.ts 的 POLICY_AGREEMENT_KEYS 以及
// src/config/policyDocument.ts 的 POLICY_AGREEMENTS 逐项一致；两侧各有契约测试钉住同一份清单，
// 改一侧而不改另一侧会在 CI 失败。

export const POLICY_AGREEMENT_KEYS = ['terms', 'usage', 'specific-terms', 'supported-regions'] as const;

export type PolicyAgreementKey = (typeof POLICY_AGREEMENT_KEYS)[number];

export const POLICY_AGREEMENT_ANCHOR_PREFIX = 'policy-agreement-';

/**
 * 「这个请求因未同意而被拒」的窗口事件名。
 *
 * 为什么放在这里而不是定义在某个组件里：发出方是具体功能（如批量转换面板），
 * 监听方是外层门禁 FeatureConsentGate。两者直接互相 import 会让门禁反依赖具体功能面板，
 * 也会把那个功能的代码拖进其它使用门禁的页面；放到中立工具模块两边都只依赖它。
 */
export const POLICY_CONSENT_REQUIRED_EVENT = 'synapse:policy-consent-required';

export const policyAgreementAnchor = (key: string): string => `${POLICY_AGREEMENT_ANCHOR_PREFIX}${key}`;

export interface PolicyConsentItem {
  key: PolicyAgreementKey;
  /** 复选框原文，与后端政策文档 agreements[].label 一致 */
  label: string;
  /** 政策页上的文件标题，用于面板/清单里的二级说明 */
  title: string;
  /** 政策页锚点 id，与后端 agreements[].anchor 一致 */
  anchor: string;
  /** 政策页深链，点击直达该文件的说明段落 */
  href: string;
}

const POLICY_AGREEMENT_LABELS: Record<PolicyAgreementKey, string> = {
  terms: '我已阅读并同意服务条款与隐私政策',
  usage: '我已阅读并同意使用政策',
  'specific-terms': '我已阅读并同意服务专项条款',
  'supported-regions': '我已阅读并同意支持地区',
};

const POLICY_AGREEMENT_TITLES: Record<PolicyAgreementKey, string> = {
  terms: '服务条款与隐私政策',
  usage: '使用政策',
  'specific-terms': '服务专项条款',
  'supported-regions': '支持地区',
};

export const policyAgreementLabel = (key: PolicyAgreementKey): string => POLICY_AGREEMENT_LABELS[key];

export const policyAgreementTitle = (key: PolicyAgreementKey): string => POLICY_AGREEMENT_TITLES[key];

/** 未知键（例如后端加了新文件而前端还没更新）回落到键名本身，不抛错、不丢项。 */
export const describeAgreementKey = (key: string): string =>
  isPolicyAgreementKey(key) ? POLICY_AGREEMENT_TITLES[key] : key;

export const isPolicyAgreementKey = (value: unknown): value is PolicyAgreementKey =>
  typeof value === 'string' && (POLICY_AGREEMENT_KEYS as readonly string[]).includes(value);

export const POLICY_CONSENT_ITEMS: PolicyConsentItem[] = POLICY_AGREEMENT_KEYS.map(key => {
  const anchor = policyAgreementAnchor(key);
  return { key, label: POLICY_AGREEMENT_LABELS[key], title: POLICY_AGREEMENT_TITLES[key], anchor, href: `/policy#${anchor}` };
});

export type PolicyConsentSelection = Record<PolicyAgreementKey, boolean>;

export const createPolicyConsentSelection = (): PolicyConsentSelection =>
  POLICY_AGREEMENT_KEYS.reduce((selection, key) => {
    selection[key] = false;
    return selection;
  }, {} as PolicyConsentSelection);

export const isPolicyConsentComplete = (selection: PolicyConsentSelection): boolean =>
  POLICY_AGREEMENT_KEYS.every(key => selection[key] === true);

/** 某条后端记录里未勾选的文件键名；缺字段（早期记录）视为四份全缺。 */
export const missingPolicyAgreements = (agreements: readonly string[] | null | undefined): PolicyAgreementKey[] => {
  const seen = new Set(Array.isArray(agreements) ? agreements : []);
  return POLICY_AGREEMENT_KEYS.filter(key => !seen.has(key));
};

/** 某条后端记录是否覆盖当前版本要求的全部文件。 */
export const isPolicyAgreementSetComplete = (agreements: readonly string[] | null | undefined): boolean =>
  missingPolicyAgreements(agreements).length === 0;

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
