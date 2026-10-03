import React from 'react';
import { FaArrowUp } from 'react-icons/fa';
import type { PolicySection } from '../../types/policy';
import { cn } from '../../utils/cn';
import { formatSectionNumber } from './policyCards';

/**
 * 政策页左侧目录（从 PolicyPage 拆出，见 policyCards.tsx 顶部的拆分说明）。
 * 阅读进度条与目录高亮共用一个由父级维护的滚动状态，这里只负责渲染与回调。
 */
const PolicyToc: React.FC<{
  sections: PolicySection[];
  activeId: string;
  progress: number;
  /** 搜索命中的章节 id；非空时未命中的章节置灰，便于在长文里定位 */
  matchedSectionIds?: ReadonlySet<string>;
  onJump: (id: string) => void;
  onTop: () => void;
}> = ({ sections, activeId, progress, matchedSectionIds, onJump, onTop }) => {
  const searching = Boolean(matchedSectionIds && matchedSectionIds.size > 0);

  return (
    <>
      <div className="mb-4">
        <div className="flex items-center justify-between text-xs font-semibold text-slate-500">
          <span>阅读进度</span>
          <span>{progress}%</span>
        </div>
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
          <div
            className="h-full rounded-full bg-slate-900 transition-[width] duration-150"
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
      <nav aria-label="条款目录" className="max-h-[60vh] space-y-1 overflow-y-auto pr-1">
        {sections.map((section, index) => {
          const target = `policy-${section.id}`;
          const active = activeId === target;
          const dimmed = searching && matchedSectionIds ? !matchedSectionIds.has(section.id) : false;
          return (
            <button
              key={section.id}
              type="button"
              onClick={() => onJump(section.id)}
              aria-current={active ? 'true' : undefined}
              title={section.title}
              className={cn(
                'flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm transition',
                active
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
                // F5-23：未命中态原先用 slate-300（≈1.7:1）低视力读不清，改为达 4.5:1 的中灰
                dimmed && !active && 'text-slate-500 hover:text-slate-700',
              )}
            >
              <span className={cn('font-mono text-[11px]', active ? 'text-white/70' : 'text-slate-500')}>
                {formatSectionNumber(index)}
              </span>
              <span className="flex-1 leading-5">
                {section.title}
                {/* F5-23：命中/未命中不能只靠颜色传达 */}
                {dimmed && !active && <span className="sr-only">（与当前搜索不匹配）</span>}
              </span>
            </button>
          );
        })}
      </nav>
      <button
        type="button"
        onClick={onTop}
        className="mt-4 inline-flex items-center gap-2 text-xs font-semibold text-slate-500 transition hover:text-slate-900"
      >
        <FaArrowUp className="text-[10px]" /> 回到顶部
      </button>
    </>
  );
};

export default PolicyToc;
