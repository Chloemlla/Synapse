import React from 'react';
import { FaMinus, FaPlus, FaSearch, FaTimes } from 'react-icons/fa';
import { cn } from '../../utils/cn';
import { studioFieldClassName } from '../studioTheme';

/**
 * 政策页的检索与阅读控制（从 PolicyPage 拆出）。
 * 两者都只受控：状态留在页面组件里，便于与滚动定位、打印样式共享。
 */

export const PolicySearchBar: React.FC<{
  value: string;
  onChange: (value: string) => void;
  /** 命中的条文条目数 */
  itemMatchCount: number;
  /** 命中的章节数 */
  sectionMatchCount: number;
  sectionsTotal: number;
  itemsTotal: number;
  /** 供外部的「/」快捷键把焦点交给检索框 */
  inputRef?: React.Ref<HTMLInputElement>;
}> = ({ value, onChange, itemMatchCount, sectionMatchCount, sectionsTotal, itemsTotal, inputRef }) => {
  const searching = value.trim().length > 0;

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center print:hidden">
      <div className="relative min-w-0 flex-1">
        <FaSearch className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[12px] text-slate-400" />
        <input
          ref={inputRef}
          type="search"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={`在 ${sectionsTotal} 章 / ${itemsTotal} 条正文中检索（按 / 快速聚焦）`}
          aria-label="在政策条文中检索"
          className={cn(studioFieldClassName, 'w-full pl-9 pr-9 text-sm')}
        />
        {searching && (
          <button
            type="button"
            onClick={() => onChange('')}
            aria-label="清空检索"
            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 transition hover:text-slate-700"
          >
            <FaTimes className="text-[12px]" />
          </button>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 text-xs text-slate-500" aria-live="polite">
        {searching ? (
          sectionMatchCount === 0 ? (
            <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1.5 font-semibold text-amber-700">
              没有命中，换个关键词试试
            </span>
          ) : (
            <span className="rounded-full border border-slate-200 bg-white/80 px-3 py-1.5 font-semibold text-slate-700">
              命中 {sectionMatchCount} 章 · {itemMatchCount} 条
            </span>
          )
        ) : (
          <span className="hidden text-slate-400 sm:inline">支持检索章节标题、摘要与全部条文</span>
        )}
      </div>
    </div>
  );
};

export const READING_SCALES = [0.92, 1, 1.08] as const;
export type ReadingScale = (typeof READING_SCALES)[number];

export const scaleLabel = (scale: number): string => `${Math.round(scale * 100)}%`;

/** 字号控制：三档，写入 localStorage，刷新后保持。 */
export const PolicyReadingControls: React.FC<{
  scale: ReadingScale;
  onChange: (scale: ReadingScale) => void;
}> = ({ scale, onChange }) => {
  const index = READING_SCALES.indexOf(scale);

  return (
    <div className="inline-flex items-center gap-1 rounded-2xl border border-slate-200 bg-white/80 px-2 py-1 print:hidden">
      <span className="px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">字号</span>
      <button
        type="button"
        aria-label="缩小条文正文字号"
        disabled={index <= 0}
        onClick={() => onChange(READING_SCALES[Math.max(0, index - 1)])}
        className="rounded-xl px-2 py-1 text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 disabled:opacity-40"
      >
        <FaMinus className="text-[10px]" />
      </button>
      <span className="w-10 text-center text-xs font-semibold text-slate-700">{scaleLabel(scale)}</span>
      <button
        type="button"
        aria-label="放大条文正文字号"
        disabled={index >= READING_SCALES.length - 1}
        onClick={() => onChange(READING_SCALES[Math.min(READING_SCALES.length - 1, index + 1)])}
        className="rounded-xl px-2 py-1 text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 disabled:opacity-40"
      >
        <FaPlus className="text-[10px]" />
      </button>
      <button
        type="button"
        onClick={() => onChange(1)}
        disabled={scale === 1}
        className="rounded-xl px-2 py-1 text-[11px] font-semibold text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 disabled:opacity-40"
      >
        重置
      </button>
    </div>
  );
};

export default PolicySearchBar;
