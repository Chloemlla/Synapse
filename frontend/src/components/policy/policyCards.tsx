import React from 'react';
import {
  FaAddressBook,
  FaBalanceScale,
  FaBan,
  FaCheckCircle,
  FaCookieBite,
  FaCopy,
  FaCopyright,
  FaFileAlt,
  FaFileAudio,
  FaFileContract,
  FaGavel,
  FaGlobeAsia,
  FaHistory,
  FaInfoCircle,
  FaLock,
  FaScroll,
  FaServer,
  FaShieldAlt,
  FaSyncAlt,
  FaUserSecret,
  FaUserShield,
} from 'react-icons/fa';
import type { IconType } from 'react-icons';
import type {
  PolicyAgreement,
  PolicyHighlight,
  PolicyIconKey,
  PolicySection,
  PolicyWarning,
} from '../../types/policy';
import type { PolicyAgreementKey } from '../../utils/policyConsent';
import { splitHighlight } from '../../utils/policySearch';
import { cn } from '../../utils/cn';
import {
  InfoBadge,
  studioElevatedPanelClassName,
  type InfoTone,
} from '../studioTheme';

/**
 * 政策页的展示型小组件（从 PolicyPage 拆出）。
 *
 * 拆分的直接原因是仓库的 TypeScript 文件尺寸闸门（scripts/governance/check-ts-file-size.js，
 * 上限 800 行）：PolicyPage 已经 731 行，站内搜索、字号控制与状态徽标都要落在那一个文件里。
 * 这些组件不持有页面状态，只接收数据与回调，放在同目录下便于一起维护。
 */

// 图标与配色由前端决定：后端只给语义键（icon / emphasis），换风格不必动条文。
export const sectionIcons: Record<PolicyIconKey, IconType> = {
  info: FaInfoCircle,
  service: FaFileAudio,
  account: FaLock,
  conduct: FaBan,
  privacy: FaUserSecret,
  'third-party': FaServer,
  retention: FaHistory,
  rights: FaUserShield,
  cookies: FaCookieBite,
  enforcement: FaShieldAlt,
  copyright: FaCopyright,
  liability: FaBalanceScale,
  changes: FaSyncAlt,
  law: FaGavel,
  contact: FaAddressBook,
};

export const accentPalette: InfoTone[] = ['sky', 'emerald', 'violet', 'slate', 'teal'];

// 登录/注册的四份必读文件各自的图标与强调色，与 PolicyConsentChecklist 的勾选项一一对应
export const agreementIcons: Record<PolicyAgreementKey, IconType> = {
  terms: FaFileContract,
  usage: FaShieldAlt,
  'specific-terms': FaScroll,
  'supported-regions': FaGlobeAsia,
};

export const agreementTones: Record<PolicyAgreementKey, InfoTone> = {
  terms: 'sky',
  usage: 'amber',
  'specific-terms': 'violet',
  'supported-regions': 'emerald',
};

export function resolveIcon(key: PolicyIconKey): IconType {
  return sectionIcons[key] || FaFileAlt;
}

/** critical / notice 章节固定用警示色，其余按顺序轮转强调色。 */
export function resolveTone(emphasis: PolicySection['emphasis'], index: number): InfoTone {
  if (emphasis === 'critical') return 'rose';
  if (emphasis === 'notice') return 'amber';
  return accentPalette[index % accentPalette.length];
}

export function formatSectionNumber(index: number): string {
  return String(index + 1).padStart(2, '0');
}

const toneTextClass = (tone: InfoTone): string =>
  cn(
    tone === 'emerald' && 'text-emerald-600',
    tone === 'sky' && 'text-sky-600',
    tone === 'rose' && 'text-rose-600',
    tone === 'amber' && 'text-amber-600',
    tone === 'violet' && 'text-violet-600',
    tone === 'teal' && 'text-teal-600',
    tone === 'slate' && 'text-slate-600',
  );

/** 把命中片段渲染成 <mark>；未搜索时就是一个普通文本节点。 */
export const HighlightedText: React.FC<{ text: string; query: string }> = ({ text, query }) => {
  if (!query) return <>{text}</>;
  return (
    <>
      {splitHighlight(text, query).map((segment, index) =>
        segment.hit ? (
          <mark key={index} className="rounded bg-amber-200/70 px-0.5 text-slate-900">
            {segment.text}
          </mark>
        ) : (
          <React.Fragment key={index}>{segment.text}</React.Fragment>
        ),
      )}
    </>
  );
};

export const HighlightCard: React.FC<{ highlight: PolicyHighlight; tone: InfoTone }> = ({ highlight, tone }) => {
  const Icon = resolveIcon(highlight.icon);
  return (
    <div className={cn(studioElevatedPanelClassName, 'border')}>
      <Icon className={toneTextClass(tone)} />
      <h3 className="mt-3 font-semibold text-slate-950">{highlight.title}</h3>
      <p className="mt-2 text-sm leading-6 text-slate-600">{highlight.body}</p>
    </div>
  );
};

export const AgreementCard: React.FC<{
  agreement: PolicyAgreement;
  copied: boolean;
  onCopy: () => void;
  onOpenSection: (sectionId: string) => void;
  sectionTitle: (sectionId: string) => string;
  searchQuery?: string;
}> = ({ agreement, copied, onCopy, onOpenSection, sectionTitle, searchQuery = '' }) => {
  const Icon = agreementIcons[agreement.key] || FaFileContract;
  const tone = agreementTones[agreement.key] || 'slate';
  return (
    <div id={agreement.anchor} className={cn(studioElevatedPanelClassName, 'scroll-mt-24 border')}>
      <div className="flex items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-white ring-1 ring-slate-100">
          <Icon className={toneTextClass(tone)} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold text-slate-950">
              <HighlightedText text={agreement.title} query={searchQuery} />
            </h3>
            <InfoBadge tone={tone}>登录 / 注册勾选项</InfoBadge>
          </div>
          <p className="mt-2 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-500">{agreement.label}</p>
        </div>
      </div>
      <p className="mt-3 text-sm leading-7 text-slate-600">
        <HighlightedText text={agreement.summary} query={searchQuery} />
      </p>
      <ul className="mt-3 space-y-2 text-sm leading-6 text-slate-600">
        {agreement.points.map((point) => (
          <li key={point} className="flex items-start gap-2">
            <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-300" />
            <span>
              <HighlightedText text={point} query={searchQuery} />
            </span>
          </li>
        ))}
      </ul>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        {agreement.sectionIds.map((sectionId) => (
          <button
            key={sectionId}
            type="button"
            onClick={() => onOpenSection(sectionId)}
            className="rounded-full border border-slate-200 bg-white/80 px-3 py-1 text-xs font-medium text-slate-600 transition hover:border-slate-300 hover:text-slate-800"
          >
            相关章节：{sectionTitle(sectionId)}
          </button>
        ))}
        <button
          type="button"
          onClick={onCopy}
          aria-label={`复制「${agreement.title}」链接`}
          className={cn(
            'ml-auto inline-flex shrink-0 items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold transition print:hidden',
            copied
              ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
              : 'border-slate-200 bg-white/80 text-slate-500 hover:border-slate-300 hover:text-slate-700',
          )}
        >
          {copied ? <FaCheckCircle className="text-[11px]" /> : <FaCopy className="text-[11px]" />}
          {copied ? '已复制' : '复制链接'}
        </button>
      </div>
    </div>
  );
};

export const WarningCard: React.FC<{ warning: PolicyWarning; searchQuery?: string }> = ({
  warning,
  searchQuery = '',
}) => {
  const Icon = resolveIcon(warning.icon);
  return (
    <div className="rounded-2xl border border-rose-200 bg-rose-50/75 p-5 text-rose-800">
      <div className="flex items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-white text-rose-700 ring-1 ring-rose-100">
          <Icon />
        </div>
        <div>
          <h3 className="font-semibold">
            <HighlightedText text={warning.title} query={searchQuery} />
          </h3>
          <p className="mt-2 text-sm leading-7">
            <HighlightedText text={warning.body} query={searchQuery} />
          </p>
        </div>
      </div>
    </div>
  );
};
