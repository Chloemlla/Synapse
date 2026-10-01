import React from 'react';
import { FaAddressBook, FaCheckCircle, FaClock, FaCode, FaCopy, FaEnvelope, FaGlobe } from 'react-icons/fa';
import type { PolicyDocument } from '../../types/policy';
import { cn } from '../../utils/cn';
import { InfoBadge, InfoPanel, InfoSectionTitle } from '../studioTheme';
import { HighlightedText } from './policyCards';

/**
 * 政策页页脚区（从 PolicyPage 拆出）：本次修订、联系方式与程序化入口、条文指纹。
 * 三块都是静态信息，与检索/滚动状态无关，拆出来后 PolicyPage 只留阅读与交互逻辑。
 */
const PolicyFooter: React.FC<{
  policy: PolicyDocument;
  searchQuery: string;
  /** 已复制项的 key（与页面共用，用于反馈态） */
  copiedKey: string | null;
  onCopyHash: () => void;
}> = ({ policy, searchQuery, copiedKey, onCopyHash }) => (
  <>
    <InfoPanel className="print:border-0 print:shadow-none">
      <InfoSectionTitle
        title="本次修订"
        description="版本变化意味着此前的同意不再覆盖新条文，依赖同意的功能会要求重新同意。"
        icon={FaClock}
        tone="sky"
      />
      <div className="space-y-4">
        {policy.revisions.map((revision) => (
          <div key={revision.version} className="rounded-2xl border border-slate-100 bg-white/65 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <InfoBadge tone="sky">v{revision.version}</InfoBadge>
              <span className="inline-flex items-center gap-1.5 text-xs text-slate-500">
                <FaClock className="text-[10px]" /> {revision.date}
              </span>
            </div>
            <ul className="mt-3 space-y-2 text-sm leading-6 text-slate-600">
              {revision.changes.map((change) => (
                <li key={change} className="flex items-start gap-2">
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-sky-400" />
                  <span>
                    <HighlightedText text={change} query={searchQuery} />
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <p className="text-xs leading-6 text-slate-500">{policy.historyNote}</p>
      </div>
    </InfoPanel>

    <InfoPanel className="print:border-0 print:shadow-none">
      <InfoSectionTitle
        title="联系方式与程序化入口"
        description="咨询、反馈、数据权利请求与侵权投诉请使用官方邮箱；自动化客户端可直接调用下列接口。"
        icon={FaAddressBook}
        tone="sky"
      />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {policy.contacts.map((contact) => (
          <a
            key={contact.email}
            href={`mailto:${contact.email}`}
            className="rounded-2xl border border-slate-200 bg-white/70 p-5 transition hover:-translate-y-0.5 hover:shadow-md"
          >
            <div className="flex items-start gap-3">
              <FaEnvelope className="mt-1 text-sky-600" />
              <div>
                <div className="font-semibold text-slate-950">{contact.label}</div>
                <div className="text-sm text-slate-600">{contact.email}</div>
                <div className="mt-1 text-xs leading-5 text-slate-500">{contact.scope}</div>
              </div>
            </div>
          </a>
        ))}
      </div>
      <div className="mt-5 rounded-2xl border border-slate-100 bg-white/65 p-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <FaCode className="text-slate-500" /> 接口说明
        </div>
        <dl className="mt-3 grid grid-cols-1 gap-2 text-xs text-slate-600 sm:grid-cols-2">
          {[
            { label: '获取条文', value: policy.procedures.documentEndpoint },
            { label: '条文存档', value: policy.procedures.documentArchiveEndpoint },
            { label: '获取版本', value: policy.procedures.versionEndpoint },
            { label: '记录同意', value: policy.procedures.recordConsentEndpoint },
            { label: '查询状态', value: policy.procedures.statusEndpoint },
            { label: '同意轨迹', value: policy.procedures.historyEndpoint },
            { label: '查询同意', value: policy.procedures.checkConsentEndpoint },
            { label: '撤回同意', value: policy.procedures.revokeConsentEndpoint },
          ].map((entry) => (
            <div key={entry.value} className="flex items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2">
              <dt className="text-slate-500">{entry.label}</dt>
              <dd className="font-mono text-[11px] text-slate-700">{entry.value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 inline-flex items-center gap-2 text-xs text-slate-500">
          <FaGlobe className="text-[10px]" />
          同意记录默认有效 {policy.procedures.consentValidityDays} 天，过期后需重新同意；
          顶部「下载条文存档」与 API 里的 md 格式是同一份内容。
        </p>
      </div>
    </InfoPanel>

    <div className="space-y-1 px-1 text-xs leading-6 text-slate-400">
      <p>
        本页条文版本 v{policy.version}，生效日期 {policy.effectiveDate}，最近修订 {policy.lastUpdated}。
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <span>条文指纹（sha256，可在同意记录中核对）：</span>
        <code className="break-all font-mono text-[11px] text-slate-500">{policy.documentHash}</code>
        <button
          type="button"
          onClick={onCopyHash}
          aria-label="复制条文指纹"
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold transition print:hidden',
            copiedKey === 'document-hash'
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
              : 'border-slate-200 bg-white/80 text-slate-500 hover:border-slate-300 hover:text-slate-700',
          )}
        >
          {copiedKey === 'document-hash' ? <FaCheckCircle className="text-[10px]" /> : <FaCopy className="text-[10px]" />}
          {copiedKey === 'document-hash' ? '已复制' : '复制指纹'}
        </button>
      </div>
    </div>
  </>
);

export default PolicyFooter;
