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

export interface PolicyDataInventoryEntry {
  id: string;
  /** 数据项名称（如「账户设备指纹与最近登录」） */
  label: string;
  /** 展示分组（账户与身份 / 安全与风控 / 服务与业务 / 合规与审计 / 通信与集成 / 客户端本地） */
  category: string;
  /** 具体收集到的信息类别 */
  what: string;
  /** 为什么需要这些信息 */
  why: string;
  /** 面向用户的保存期限表述 */
  retention: string;
  /** 解释该数据项规则的条文章节 id（页面渲染为「详见」链接） */
  policySection: string;
  retentionType: string;
  exportable: 'full' | 'partial' | 'none';
  deleteOnUserDelete: string;
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
  /** 逐项数据清单（由后端隐私数据地图生成，非手写） */
  dataInventory: PolicyDataInventoryEntry[];
  /** 数据地图最后更新日 */
  dataInventoryUpdatedAt: string;
}

export interface PolicyDocumentResponse {
  success?: boolean;
  document?: PolicyDocument;
  error?: string;
  errorCode?: string;
}
