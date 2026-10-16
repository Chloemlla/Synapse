import { FaChevronLeft, FaShieldAlt } from 'react-icons/fa';
import { Link } from 'react-router-dom';

import {
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';

import type { SidebarView } from './types';

type SidebarViewHeaderProps = {
  view: SidebarView;
};

/**
 * Nested-view chrome: back control + workspace identity (admin console, etc.).
 */
export function SidebarViewHeader({ view }: SidebarViewHeaderProps) {
  const { setOpenMobile } = useSidebar();
  const isAdmin = view.id === 'admin';
  const hubTo = isAdmin ? '/admin' : view.parent.to;

  return (
    <SidebarHeader className='border-slate-200 gap-1 border-b px-2 py-2.5'>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            tooltip={view.parent.label}
            className={cn(
              'text-slate-500 hover:text-slate-900 h-8 gap-1.5 rounded-2xl',
              'font-medium',
            )}
            render={
              <Link to={view.parent.to} onClick={() => setOpenMobile(false)} />
            }
          >
            <FaChevronLeft className='size-3.5 shrink-0 opacity-70' aria-hidden='true' />
            <span className='truncate text-[13px] group-data-[collapsible=icon]:hidden'>
              {view.parent.label}
            </span>
          </SidebarMenuButton>
        </SidebarMenuItem>
        <SidebarMenuItem>
          <SidebarMenuButton
            tooltip={isAdmin ? '管理后台' : view.id}
            size='lg'
            className={cn(
              'h-auto gap-2.5 rounded-2xl px-2 py-2',
              'bg-slate-100/55 ring-1 ring-slate-200/80',
              'hover:bg-slate-100 data-active:bg-slate-100/55',
            )}
            render={<Link to={hubTo} onClick={() => setOpenMobile(false)} />}
          >
            <span
              className={cn(
                'flex size-8 shrink-0 items-center justify-center rounded-2xl',
                isAdmin
                  ? 'bg-slate-900 text-white shadow-sm'
                  : 'bg-slate-100 text-slate-500',
              )}
            >
              <FaShieldAlt className='size-3.5' aria-hidden='true' />
            </span>
            <div className='grid min-w-0 flex-1 leading-tight group-data-[collapsible=icon]:hidden'>
              <span className='truncate text-sm font-semibold text-slate-900'>
                {isAdmin ? '管理后台' : view.id}
              </span>
              <span className='text-slate-500 truncate text-[11px]'>
                {isAdmin ? '系统配置与运维' : '工作区'}
              </span>
            </div>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarHeader>
  );
}
