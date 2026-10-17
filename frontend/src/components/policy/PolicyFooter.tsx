import React from 'react';
import { FaAddressBook, FaCheckCircle, FaClock, FaCopy, FaEnvelope } from 'react-icons/fa';
import type { PolicyDocument } from '../../types/policy';
import { cn } from '../../utils/cn';
import { InfoBadge, InfoPanel, InfoSectionTitle } from '../studioTheme';
import { HighlightedText } from './policyCards';

/**
 * 政策页页脚区（从 PolicyPage 拆出）：本次修订、联系方式、条文指纹。
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
        title="联系方式"
        description="咨询、反馈、数据权利请求与侵权投诉请使用官方邮箱。"
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
