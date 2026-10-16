import { FaChevronRight } from 'react-icons/fa';
import { Link, useLocation } from 'react-router-dom';

import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';
import { cn } from '@/lib/utils';

import { checkIsActive, isNavLink } from './url-utils';
import type { NavGroup as NavGroupProps, NavLink } from './types';

/**
 * Sidebar navigation group — flat links with drill-in chevrons where needed.
 */
export function NavGroup({ title, items }: NavGroupProps) {
  const pathname = useLocation().pathname;
  const siblingUrls = items
    .filter(isNavLink)
    .map((item) => item.url)
    .filter(Boolean);

  return (
    <SidebarGroup className='px-2 py-0.5'>
      <SidebarGroupLabel className='text-slate-500/65 h-7 px-2 text-[10px] font-semibold tracking-[0.14em] uppercase'>
        {title}
      </SidebarGroupLabel>
      <SidebarMenu className='gap-0.5'>
        {items.map((item) => {
          if (!isNavLink(item)) {
            if (item.items?.length) {
              return item.items.map((sub) => (
                <SidebarMenuLink
                  key={`${sub.title}-${sub.url}`}
                  item={sub as NavLink}
                  pathname={pathname}
                  siblingUrls={siblingUrls}
                />
              ));
            }
            return null;
          }
          return (
            <SidebarMenuLink
              key={`${item.title}-${item.url}`}
              item={item}
              pathname={pathname}
              siblingUrls={siblingUrls}
            />
          );
        })}
      </SidebarMenu>
    </SidebarGroup>
  );
}

function SidebarMenuLink({
  item,
  pathname,
  siblingUrls,
}: {
  item: NavLink;
  pathname: string;
  siblingUrls: string[];
}) {
  const { setOpenMobile } = useSidebar();
  const Icon = item.icon;
  const active = checkIsActive(pathname, item, { siblingUrls });
  // Only the admin workspace entry is a real drill-in (sidebarViews).
  const isDrillIn = item.url === '/admin' && Boolean(item.matchChildren);

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        isActive={active}
        tooltip={item.title}
        className={cn(
          'h-9 rounded-2xl px-2.5 transition-colors',
          active &&
            'bg-slate-100 text-slate-700 shadow-[inset_0_0_0_1px_rgba(15,23,42,0.18)]',
          !active && 'text-slate-900/85 hover:text-slate-900',
        )}
        render={
          <Link to={item.url} onClick={() => setOpenMobile(false)} />
        }
      >
        {Icon ? (
          <>
            <span
              className={cn(
                'flex size-6 shrink-0 items-center justify-center rounded-full transition-colors group-data-[collapsible=icon]:hidden',
                active
                  ? 'bg-slate-900/15 text-slate-900'
                  : 'bg-slate-100/50 text-slate-900/70 group-hover/menu-button:bg-slate-100 group-hover/menu-button:text-slate-900',
              )}
            >
              <Icon className='size-3.5' aria-hidden='true' />
            </span>
            <Icon
              className={cn(
                'hidden size-4 shrink-0 group-data-[collapsible=icon]:block',
                active ? 'text-slate-900' : 'text-slate-900/75',
              )}
              aria-hidden='true'
            />
          </>
        ) : null}
        <span className='min-w-0 flex-1 truncate text-[13px] font-medium group-data-[collapsible=icon]:hidden'>
          {item.title}
        </span>
        {item.badge ? (
          <span className='bg-slate-900/12 text-slate-900 shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold group-data-[collapsible=icon]:hidden'>
            {item.badge}
          </span>
        ) : null}
        {isDrillIn ? (
          <FaChevronRight
            className={cn(
              'size-3 shrink-0 opacity-40 transition-opacity group-data-[collapsible=icon]:hidden',
              active && 'opacity-70',
            )}
            aria-hidden='true'
          />
        ) : null}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}
