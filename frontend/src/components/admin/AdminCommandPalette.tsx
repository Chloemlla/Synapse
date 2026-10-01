import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  FaBolt,
  FaCheck,
  FaChevronRight,
  FaCopy,
  FaExternalLinkAlt,
  FaRegClock,
  FaRegStar,
  FaSearch,
  FaShieldAlt,
  FaStar,
  FaSyncAlt,
} from 'react-icons/fa';
import { useNotification } from '../Notification';

import type { ElementType } from 'react';
import type { IconType } from 'react-icons';
import type { NavGroup } from '@/layout/types';
import { useAdminNavPrefs } from '@/hooks/useAdminNavPrefs';
import { indexAdminNavByUrl } from '@/navigation/adminNavIndex';
import { fuzzyMatch } from '@/utils/fuzzyMatch';
import { cn } from '@/lib/utils';

/**
 * 管理员命令面板（⌘/Ctrl + K）。
 *
 * 后台有 41 个模块，散在侧边栏的 8 个分组里；这块面板把「找模块」从"眼睛扫侧栏"
 * 变成"敲两三个字母 + 回车"，并把常用模块置顶、最近访问自动排前。
 *
 * 设计取舍：
 * - 只做**导航与本地动作**，不发任何请求 ⇒ 后台管理面不新增接口、不新增权限点；
 * - 面板自身订阅 `useAdminNavPrefs`，置顶/最近与侧边栏、模块页工具条共用一份状态；
 * - 模糊匹配走 `utils/fuzzyMatch`（有单测），命中字符在标题里高亮。
 */

export type AdminCommandPaletteProps = {
  open: boolean;
  onClose: () => void;
  /** 当前角色可见的管理导航分组（调用方已按权限过滤） */
  groups: NavGroup[];
};

type Highlight = { indexes: number[] };

type PaletteEntry = {
  id: string;
  section: string;
  title: string;
  subtitle?: string;
  icon?: IconType | ElementType;
  /** 命中后跳转的目标（模块条目） */
  url?: string;
  /** 本地动作（不回跳路由） */
  run?: () => void;
  /** 模块条目：允许 ★ 置顶 */
  pinnable?: boolean;
  /** 额外可匹配文本（路径等），命中时不高亮标题 */
  keywords?: string[];
};

const SECTION_QUICK_ACTIONS = '快捷动作';
const SECTION_PINNED = '已置顶';
const SECTION_RECENT = '最近访问';
const SECTION_RESULTS = '搜索结果';

const ROW_CLASS =
  'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition';
const ACTIVE_ROW_CLASS = 'bg-slate-900 text-white shadow-sm';
const IDLE_ROW_CLASS = 'text-slate-700 hover:bg-slate-100';

/** 高亮命中字符（模糊匹配给的是下标数组）。 */
function renderHighlightedText(text: string, highlight?: Highlight): React.ReactNode {
  if (!highlight?.indexes.length) return text;
  const marked = new Set(highlight.indexes);
  return Array.from(text).map((char, index) =>
    marked.has(index) ? (
      <mark
        key={`${char}-${index}`}
        className='rounded bg-amber-200/80 px-0.5 text-slate-900'
      >
        {char}
      </mark>
    ) : (
      <React.Fragment key={`${char}-${index}`}>{char}</React.Fragment>
    ),
  );
}

export const AdminCommandPalette: React.FC<AdminCommandPaletteProps> = ({
  open,
  onClose,
  groups,
}) => {
  const { setNotification } = useNotification();
  const navigate = useNavigate();
  const { pinned, recent, isPinned, togglePin, clearRecent } = useAdminNavPrefs();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const moduleIndex = useMemo(() => indexAdminNavByUrl(groups), [groups]);

  const quickActions = useMemo<PaletteEntry[]>(
    () => [
      {
        id: 'action-hub',
        section: SECTION_QUICK_ACTIONS,
        title: '管理总览',
        subtitle: '全部模块分组入口',
        icon: FaShieldAlt,
        url: '/admin',
        keywords: ['hub', '总览', 'admin'],
      },
      {
        id: 'action-audit-log',
        section: SECTION_QUICK_ACTIONS,
        title: '审计日志',
        subtitle: '谁在什么时候改了什么',
        icon: FaSearch,
        url: '/admin/audit-log',
        keywords: ['audit', 'log'],
      },
      {
        id: 'action-system',
        section: SECTION_QUICK_ACTIONS,
        title: '系统管理',
        subtitle: '运行状态与服务开关',
        icon: FaShieldAlt,
        url: '/admin/system',
        keywords: ['system', 'status'],
      },
      {
        id: 'action-env',
        section: SECTION_QUICK_ACTIONS,
        title: '环境变量',
        subtitle: 'env-manager 分区配置',
        icon: FaBolt,
        url: '/admin/env',
        keywords: ['env', 'config', '配置'],
      },
      {
        id: 'action-copy-path',
        section: SECTION_QUICK_ACTIONS,
        title: '复制当前页面路径',
        subtitle: typeof window === 'undefined' ? '' : window.location.pathname,
        icon: FaCopy,
        run: () => {
          const path = `${window.location.pathname}${window.location.search}`;
          const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
          if (clipboard?.writeText) {
            void clipboard
              .writeText(path)
              .then(() => setNotification({ type: 'success', message: `已复制 ${path}` }))
              .catch(() => setNotification({ type: 'info', message: `当前路径：${path}` }));
            return;
          }
          setNotification({ type: 'info', message: `当前路径：${path}` });
        },
      },
      {
        id: 'action-reload',
        section: SECTION_QUICK_ACTIONS,
        title: '重新加载当前页面',
        subtitle: '模块数据异常时的首选操作',
        icon: FaSyncAlt,
        run: () => window.location.reload(),
      },
      {
        id: 'action-open-new-tab',
        section: SECTION_QUICK_ACTIONS,
        title: '在新标签打开当前页面',
        subtitle: '方便对照两个模块',
        icon: FaExternalLinkAlt,
        run: () => window.open(window.location.href, '_blank', 'noopener,noreferrer'),
      },
    ],
    // 这些动作直接闭包 setNotification / togglePin，一并进依赖，避免用到挂载时的旧引用。
    [setNotification, togglePin],
  );

  const moduleEntries = useMemo<PaletteEntry[]>(() => {
    const entries: PaletteEntry[] = [];
    for (const group of groups) {
      // 调用方可能把「已置顶/最近访问」也拼进 groups（侧边栏就是这么用的）：
      // 这两组在面板里有自己的专区，重复列出反而刷屏。
      if (group.id === 'admin-pinned' || group.id === 'admin-recent') continue;
      const push = (title: string, url: string, icon?: IconType | ElementType) => {
        entries.push({
          id: `module-${url}`,
          section: group.title || '管理模块',
          title,
          subtitle: url,
          icon,
          url,
          pinnable: true,
          keywords: [url, group.title],
        });
      };
      for (const item of group.items) {
        if ('url' in item && typeof item.url === 'string') {
          push(item.title, item.url, item.icon);
          continue;
        }
        for (const sub of item.items ?? []) {
          if ('url' in sub && typeof sub.url === 'string') push(sub.title, sub.url, sub.icon);
        }
      }
    }
    return entries;
  }, [groups]);

  /** 置顶/最近：优先用导航里的标题（角色变更后标题可能已更新）。 */
  const prefEntries = useMemo(() => {
    const build = (list: Array<{ url: string; title: string }>, section: string) =>
      list
        .map((entry) => moduleIndex.get(entry.url))
        .filter((item): item is NonNullable<typeof item> => Boolean(item))
        .map<PaletteEntry>((item) => ({
          id: `${section}-${item.url}`,
          section,
          title: item.title,
          subtitle: item.url,
          icon: item.icon,
          url: item.url,
          pinnable: true,
          keywords: [item.url],
        }));
    return {
      pinned: build(pinned, SECTION_PINNED),
      recent: build(recent, SECTION_RECENT),
    };
  }, [moduleIndex, pinned, recent]);

  const allEntries = useMemo(
    () => [...quickActions, ...prefEntries.pinned, ...prefEntries.recent, ...moduleEntries],
    [moduleEntries, prefEntries.pinned, prefEntries.recent, quickActions],
  );

  const { visibleEntries, highlights, sections } = useMemo(() => {
    const needle = query.trim();
    const highlightMap = new Map<string, Highlight>();
    if (!needle) {
      return {
        visibleEntries: allEntries,
        highlights: highlightMap,
        sections: Array.from(new Set(allEntries.map((entry) => entry.section))),
      };
    }

    const scored: Array<{ entry: PaletteEntry; score: number; indexes: number[] }> = [];
    for (const entry of allEntries) {
      const titleMatch = fuzzyMatch(entry.title, needle);
      if (titleMatch) {
        scored.push({ entry, score: titleMatch.score, indexes: titleMatch.indexes });
        continue;
      }
      // 标题没命中时再退到路径/分组名等关键字，命中则排后
      for (const keyword of entry.keywords ?? []) {
        const keywordMatch = fuzzyMatch(keyword, needle);
        if (keywordMatch) {
          scored.push({ entry, score: keywordMatch.score - 40, indexes: [] });
          break;
        }
      }
    }

    scored.sort((a, b) => b.score - a.score || a.entry.title.length - b.entry.title.length);
    // 搜索态下放弃原分组，统一归到「搜索结果」（否则按 section 过滤会筛空）
    const entries = scored.map((item) => ({ ...item.entry, section: SECTION_RESULTS }));
    for (const item of scored) {
      if (item.indexes.length) {
        highlightMap.set(item.entry.id, { indexes: item.indexes });
      }
    }
    return {
      visibleEntries: entries,
      highlights: highlightMap,
      sections: [SECTION_RESULTS],
    };
  }, [allEntries, query]);

  // 打开时重置查询、聚焦输入框；关闭时把焦点还给触发者。
  useEffect(() => {
    if (open) {
      restoreFocusRef.current = document.activeElement as HTMLElement | null;
      setQuery('');
      setActiveIndex(0);
      const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
      return () => window.clearTimeout(timer);
    }
    restoreFocusRef.current?.focus?.();
    return undefined;
  }, [open]);

  useEffect(() => {
    setActiveIndex((previous) => {
      if (visibleEntries.length === 0) return 0;
      return Math.min(previous, visibleEntries.length - 1);
    });
  }, [visibleEntries.length]);

  // 键盘上下移动时把活动项滚进视野
  useEffect(() => {
    if (!open) return;
    const list = listRef.current;
    if (!list) return;
    const active = list.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    active?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  const commitEntry = useCallback(
    (entry: PaletteEntry | undefined) => {
      if (!entry) return;
      if (entry.url) {
        navigate(entry.url);
        onClose();
        return;
      }
      entry.run?.();
      onClose();
    },
    [navigate, onClose],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        commitEntry(visibleEntries[activeIndex]);
        return;
      }
      if (event.key === 'ArrowDown' || (event.key === 'n' && event.ctrlKey)) {
        event.preventDefault();
        setActiveIndex((previous) => (previous + 1) % Math.max(1, visibleEntries.length));
        return;
      }
      if (event.key === 'ArrowUp' || (event.key === 'p' && event.ctrlKey)) {
        event.preventDefault();
        setActiveIndex((previous) =>
          (previous - 1 + Math.max(1, visibleEntries.length)) % Math.max(1, visibleEntries.length),
        );
        return;
      }
      if (event.key === 'Home') {
        event.preventDefault();
        setActiveIndex(0);
        return;
      }
      if (event.key === 'End') {
        event.preventDefault();
        setActiveIndex(Math.max(0, visibleEntries.length - 1));
      }
    },
    [activeIndex, commitEntry, onClose, visibleEntries],
  );

  if (!open) return null;

  let rowIndex = -1;

  return (
    <div
      className='fixed inset-0 z-[120] flex items-start justify-center bg-slate-900/45 px-4 pt-[12vh] backdrop-blur-sm'
      role='presentation'
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role='dialog'
        aria-modal='true'
        aria-label='管理员命令面板'
        className='w-full max-w-2xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_30px_80px_-30px_rgba(15,23,42,0.55)]'
      >
        <div className='flex items-center gap-2 border-b border-slate-100 px-4 py-3'>
          <FaSearch className='size-3.5 shrink-0 text-slate-400' aria-hidden='true' />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder='搜索管理模块、快捷动作…'
            aria-label='搜索管理模块'
            role='combobox'
            aria-expanded='true'
            aria-controls='admin-palette-listbox'
            aria-activedescendant={
              visibleEntries[activeIndex] ? `admin-palette-option-${activeIndex}` : undefined
            }
            className='min-w-0 flex-1 bg-transparent text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none'
          />
          <kbd className='hidden shrink-0 rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500 sm:block'>
            Esc
          </kbd>
        </div>

        <div
          ref={listRef}
          id='admin-palette-listbox'
          role='listbox'
          aria-label='命令面板结果'
          className='hover-scrollbar max-h-[52vh] min-h-[8rem] overflow-y-auto px-2 py-2'
        >
          {visibleEntries.length === 0 ? (
            <div className='px-3 py-10 text-center text-sm text-slate-500'>
              没有匹配的模块或动作
              <div className='mt-1 text-xs text-slate-400'>试试模块名里的任意几个字，或输入 /admin 的路径片段</div>
            </div>
          ) : (
            sections.map((section) => {
              const sectionEntries = visibleEntries.filter((entry) => entry.section === section);
              if (sectionEntries.length === 0) return null;
              return (
                <div key={section} className='mb-1'>
                  <div className='flex items-center justify-between px-3 py-1.5'>
                    <span className='text-[10px] font-semibold tracking-[0.14em] text-slate-400 uppercase'>
                      {section}
                    </span>
                    {section === SECTION_RECENT && recent.length > 0 ? (
                      <button
                        type='button'
                        onClick={clearRecent}
                        className='rounded-md px-1.5 py-0.5 text-[10px] font-medium text-slate-400 transition hover:bg-slate-100 hover:text-slate-600'
                      >
                        清空
                      </button>
                    ) : null}
                  </div>
                  {sectionEntries.map((entry) => {
                    rowIndex += 1;
                    const index = rowIndex;
                    const isActive = index === activeIndex;
                    const Icon = entry.icon ?? FaChevronRight;
                    const pinnedEntry = entry.pinnable && entry.url ? isPinned(entry.url) : false;
                    return (
                      <div key={entry.id} className='group/row relative'>
                        <div
                          id={`admin-palette-option-${index}`}
                          data-index={index}
                          role='option'
                          tabIndex={-1}
                          aria-selected={isActive}
                          onMouseMove={() => setActiveIndex(index)}
                          onClick={() => commitEntry(entry)}
                          className={cn(ROW_CLASS, 'cursor-pointer', isActive ? ACTIVE_ROW_CLASS : IDLE_ROW_CLASS)}
                        >
                          <span
                            className={cn(
                              'flex size-7 shrink-0 items-center justify-center rounded-lg',
                              isActive ? 'bg-white/15 text-white' : 'bg-slate-100 text-slate-500',
                            )}
                          >
                            <Icon className='size-3.5' aria-hidden='true' />
                          </span>
                          <span className='min-w-0 flex-1'>
                            <span className='block truncate text-sm font-semibold'>
                              {renderHighlightedText(entry.title, highlights.get(entry.id))}
                            </span>
                            {entry.subtitle ? (
                              <span
                                className={cn(
                                  'block truncate text-[11px]',
                                  isActive ? 'text-white/70' : 'text-slate-400',
                                )}
                              >
                                {entry.subtitle}
                              </span>
                            ) : null}
                          </span>
                          {entry.pinnable && entry.url ? (
                            <button
                              type='button'
                              tabIndex={-1}
                              aria-label={pinnedEntry ? '取消置顶' : '置顶该模块'}
                              title={pinnedEntry ? '取消置顶' : '置顶该模块'}
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={(event) => {
                                event.stopPropagation();
                                const nowPinned = togglePin({ url: entry.url!, title: entry.title });
                                setNotification({ type: 'success', message: nowPinned ? '已置顶到侧边栏' : '已取消置顶' });
                              }}
                              className={cn(
                                'flex size-6 shrink-0 items-center justify-center rounded-md transition',
                                pinnedEntry
                                  ? isActive
                                    ? 'text-amber-300'
                                    : 'text-amber-500'
                                  : isActive
                                    ? 'text-white/60 hover:text-white'
                                    : 'text-slate-300 hover:text-amber-500',
                              )}
                            >
                              {pinnedEntry ? (
                                <FaStar className='size-3.5' aria-hidden='true' />
                              ) : (
                                <FaRegStar className='size-3.5' aria-hidden='true' />
                              )}
                            </button>
                          ) : isActive ? (
                            <FaCheck className='size-3 shrink-0 text-white/70' aria-hidden='true' />
                          ) : (
                            <FaRegClock className='size-3 shrink-0 text-slate-300' aria-hidden='true' />
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>

        <div className='flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 bg-slate-50/70 px-4 py-2 text-[11px] text-slate-500'>
          <span className='flex items-center gap-3'>
            <span>
              <kbd className='rounded border border-slate-200 bg-white px-1 py-0.5 font-semibold'>↑</kbd>{' '}
              <kbd className='rounded border border-slate-200 bg-white px-1 py-0.5 font-semibold'>↓</kbd> 选择
            </span>
            <span>
              <kbd className='rounded border border-slate-200 bg-white px-1 py-0.5 font-semibold'>↵</kbd> 打开
            </span>
            <span className='hidden sm:inline'>★ 置顶到侧边栏</span>
          </span>
          <span className='text-slate-400'>共 {moduleEntries.length} 个模块</span>
        </div>
      </div>
    </div>
  );
};

export default AdminCommandPalette;
