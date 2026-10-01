// 服务条款与隐私政策的类型定义，结构对齐后端 GET /api/policy/document 返回的 document 字段
// （后端单一来源：src/config/policyDocument.ts）。新增字段时两边一起改。

import type { PolicyAgreementKey } from '../utils/policyConsent';

export type PolicyEmphasis = 'normal' | 'notice' | 'critical';

export type PolicyIconKey =
  | 'info'
  | 'service'
  | 'account'
  | 'conduct'
  | 'privacy'
  | 'third-party'
  | 'retention'
  | 'rights'
  | 'cookies'
  | 'enforcement'
  | 'copyright'
  | 'liability'
  | 'changes'
  | 'law'
  | 'contact';

export interface PolicySection {
  /** 锚点 id，页面渲染为 #policy-<id> */
  id: string;
  title: string;
  summary: string;
  icon: PolicyIconKey;
  emphasis?: PolicyEmphasis;
  items: string[];
}

export interface PolicyHighlight {
  title: string;
  body: string;
  icon: PolicyIconKey;
}

export interface PolicyWarning {
  title: string;
  body: string;
  icon: PolicyIconKey;
}

export interface PolicyRevision {
  version: string;
  date: string;
  changes: string[];
}

export interface PolicyContact {
  label: string;
  email: string;
  scope: string;
}

// 登录/注册必须逐项勾选的四份文件；key 与 utils/policyConsent.ts 的复选框一一对应
export interface PolicyAgreement {
  key: PolicyAgreementKey;
  label: string;
  title: string;
  anchor: string;
  summary: string;
  points: string[];
  sectionIds: string[];
}

export interface PolicyProcedures {
  consentValidityDays: number;
  documentEndpoint: string;
  /** 条文存档副本（Markdown）入口：同一份内容，供用户离线保存 */
  documentArchiveEndpoint: string;
  versionEndpoint: string;
  recordConsentEndpoint: string;
  revokeConsentEndpoint: string;
  checkConsentEndpoint: string;
  /** 一次取回「版本 + 本设备同意状态」的合并端点 */
  statusEndpoint: string;
  /** 本设备的同意轨迹（历次同意与撤回） */
  historyEndpoint: string;
}

export interface PolicyDocument {
  version: string;
  /**
   * 条文指纹：后端对「章节正文 + 勾选项文案 + 重点提示」取的 SHA-256。
   * 同意记录会一并落库，可与本设备记录里的 consentDocumentHash 对账。
   */
  documentHash: string;
  title: string;
  eyebrow: string;
  description: string;
  effectiveDate: string;
  lastUpdated: string;
  historyNote: string;
  procedures: PolicyProcedures;
  highlights: PolicyHighlight[];
  sections: PolicySection[];
  agreements: PolicyAgreement[];
  warnings: PolicyWarning[];
  revisions: PolicyRevision[];
  contacts: PolicyContact[];
}

export interface PolicyDocumentResponse {
  success?: boolean;
  document?: PolicyDocument;
  error?: string;
  errorCode?: string;
}
