import { Suspense, lazy, useEffect, useState } from 'react';
import type { CSSProperties, ReactNode, Ref } from 'react';
import { useLocation } from 'react-router-dom';
import { FaSearch } from 'react-icons/fa';

import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import { useSidebarView } from '@/hooks/useSidebarView';
import { cn } from '@/lib/utils';

import { checkIsActive, isNavLink } from './url-utils';
import { AppSidebar } from './app-sidebar';
import { getSidebarDefaultOpen } from './cookies';
import type { NavGroup } from './types';

// 命令面板只在管理员工作区里才需要 ⇒ 懒加载，普通用户不进这个 chunk。
const AdminCommandPalette = lazy(
  () => import('@/components/admin/AdminCommandPalette'),
);

type DesktopShellProps = {
  children: ReactNode;
  /** Right-side account controls (e.g. account-only MobileNav). */
  headerEnd?: ReactNode;
  /** Focus / scroll target for route changes (the scrollable main pane). */
  contentRef?: Ref<HTMLDivElement>;
};

function resolveHeaderLabel(
  pathname: string,
  navGroups: NavGroup[],
  isAdminView: boolean,
): string {
  let best: { title: string; len: number } | null = null;
  for (const group of navGroups) {
    for (const item of group.items) {
      if (!isNavLink(item)) continue;
      if (!checkIsActive(pathname, item)) continue;
      const len = item.url === '/' ? 1 : item.url.length;
      if (!best || len > best.len) best = { title: item.title, len };
    }
  }
  if (best) return best.title;
  return isAdminView ? '管理后台' : '工作台';
}

/**
 * Desktop-only chrome: collapsible left sidebar + inset with header trigger.
 * Lazy-loaded from App so Base UI / Hugeicons stay out of the entry chunk.
 *
 * Brand lives only in AppSidebar — header is collapse control + account.
 */
export default function DesktopShell({
  children,
  headerEnd,
  contentRef,
}: DesktopShellProps) {
  const viewState = useSidebarView();
  const { pathname } = useLocation();
  const headerLabel = resolveHeaderLabel(
    pathname,
    viewState.navGroups,
    Boolean(viewState.view),
  );

  const isAdminView = viewState.view?.id === 'admin';
  const [paletteOpen, setPaletteOpen] = useState(false);

  // ⌘/Ctrl + K：管理员随时唤起模块搜索；非管理员工作区不注册监听，也不挂载面板。
  useEffect(() => {
    if (!isAdminView) {
      setPaletteOpen(false);
      return undefined;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isAdminView]);

  return (
    <SidebarProvider
      defaultOpen={getSidebarDefaultOpen()}
      // Fill remaining viewport under outer flex column.
      className='relative z-10 flex h-full min-h-0 flex-1 flex-col'
      style={
        {
          // Full-height sidebar; chrome header sits inside the inset.
          '--app-header-height': '0px',
        } as CSSProperties
      }
    >
      <div className='flex h-full min-h-0 w-full flex-1'>
        <AppSidebar viewState={viewState} collapsible='icon' />
        <SidebarInset
          className={cn(
            'min-h-0 flex-1 overflow-hidden bg-transparent',
            'md:peer-data-[variant=inset]:bg-transparent',
          )}
        >
          <header
            aria-label='工作台工具栏'
            className={cn(
              'z-20 flex h-14 shrink-0 items-center gap-2',
              'border-b border-slate-200/80 bg-white/90 px-3 backdrop-blur-xl',
              'shadow-[0_1px_0_rgba(15,23,42,0.04)] sm:px-4',
            )}
          >
            <SidebarTrigger
              className='text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              aria-label='折叠/展开侧栏'
              title='折叠/展开侧栏'
            />
            <div className='min-w-0 flex-1 truncate text-sm font-semibold tracking-tight text-slate-800'>
              {headerLabel}
            </div>
            {isAdminView ? (
              <button
                type='button'
                onClick={() => setPaletteOpen(true)}
                title='搜索管理模块（⌘/Ctrl + K）'
                aria-label='搜索管理模块'
                className={cn(
                  'ml-2 hidden shrink-0 items-center gap-2 rounded-xl border border-slate-200 bg-slate-50/80 px-3 py-1.5',
                  'text-xs font-medium text-slate-500 transition hover:border-slate-300 hover:bg-white hover:text-slate-700 sm:flex',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2',
                )}
              >
                <FaSearch className='size-3' aria-hidden='true' />
                <span>搜索模块</span>
                <kbd className='rounded border border-slate-200 bg-white px-1 py-0.5 text-[10px] font-semibold text-slate-400'>
                  ⌘K
                </kbd>
              </button>
            ) : null}
            <div className='ml-auto flex shrink-0 items-center gap-2'>{headerEnd}</div>
          </header>
          <div
            id='app-main-content'
            ref={contentRef}
            role='main'
            tabIndex={-1}
            className='hover-scrollbar min-h-0 flex-1 overflow-auto outline-none'
          >
            {children}
          </div>
        </SidebarInset>
      </div>

      {isAdminView ? (
        <Suspense fallback={null}>
          <AdminCommandPalette
            open={paletteOpen}
            onClose={() => setPaletteOpen(false)}
            groups={viewState.navGroups}
          />
        </Suspense>
      ) : null}
    </SidebarProvider>
  );
}
