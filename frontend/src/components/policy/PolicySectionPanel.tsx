import React from 'react';
import { motion } from 'framer-motion';
import { FaCheckCircle, FaCopy } from 'react-icons/fa';
import type { PolicySection } from '../../types/policy';
import { cn } from '../../utils/cn';
import { InfoPanel, InfoSectionTitle } from '../studioTheme';
import { HighlightedText, formatSectionNumber, resolveIcon, resolveTone } from './policyCards';

/**
 * 条文章节面板（从 PolicyPage 拆出，见 policyCards.tsx 顶部的拆分说明）。
 * 只负责「一章」的渲染：序号、强调色、命中高亮、复制链接。搜索过滤与滚动定位由页面负责。
 */
const PolicySectionPanel: React.FC<{
  section: PolicySection;
  /** 该章在全文中的序号（0 起）与总章数 */
  index: number;
  totalSections: number;
  /** 命中的条文序号（0 起）；空数组表示本章只有标题/摘要命中 */
  matchedItemIndexes: number[];
  searchQuery: string;
  copied: boolean;
  onCopy: () => void;
}> = ({ section, index, totalSections, matchedItemIndexes, searchQuery, copied, onCopy }) => {
  const Icon = resolveIcon(section.icon);
  const tone = resolveTone(section.emphasis, index);
  const number = formatSectionNumber(index);

  return (
    <motion.section
      id={`policy-${section.id}`}
      className="scroll-mt-24"
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, delay: Math.min(index * 0.03, 0.3) }}
    >
      <InfoPanel className="print:border-0 print:shadow-none">
        <InfoSectionTitle
          eyebrow={`第 ${number} 章 / 共 ${totalSections} 章`}
          title={section.title}
          description={section.summary}
          icon={Icon}
          tone={tone}
          action={(
            <button
              type="button"
              onClick={onCopy}
              aria-label={`复制「${section.title}」章节链接`}
              className={cn(
                'inline-flex shrink-0 items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold transition print:hidden',
                copied
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  : 'border-slate-200 bg-white/80 text-slate-500 hover:border-slate-300 hover:text-slate-700',
              )}
            >
              {copied ? <FaCheckCircle className="text-[11px]" /> : <FaCopy className="text-[11px]" />}
              {copied ? '已复制' : '复制链接'}
            </button>
          )}
        />
        <ul className="space-y-3 text-sm leading-7 text-slate-600">
          {section.items.map((item, itemIndex) => {
            const hit = matchedItemIndexes.includes(itemIndex);
            return (
              <li
                key={item}
                className={cn(
                  'flex items-start gap-3 rounded-2xl border p-3',
                  hit ? 'border-amber-200 bg-amber-50/60' : 'border-slate-100 bg-white/65',
                )}
              >
                <span className="mt-1 font-mono text-[11px] text-slate-400">
                  {number}.{itemIndex + 1}
                </span>
                <span>
                  <HighlightedText text={item} query={searchQuery} />
                </span>
              </li>
            );
          })}
        </ul>
        {section.emphasis === 'critical' && (
          <p className="mt-4 rounded-2xl border border-rose-100 bg-rose-50/70 px-4 py-3 text-xs leading-6 text-rose-700">
            本章节涉及账户处置、数据保留或自动化风控，请重点阅读。
          </p>
        )}
      </InfoPanel>
    </motion.section>
  );
};

export default PolicySectionPanel;
