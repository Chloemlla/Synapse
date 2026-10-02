import React, { useMemo } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  FaArrowLeft,
  FaArrowRight,
  FaChevronRight,
  FaCopy,
  FaExternalLinkAlt,
  FaRegStar,
  FaSearch,
  FaShieldAlt,
  FaStar,
} from 'react-icons/fa';
import { useNotification } from '../Notification';

import { getAdminNavGroups, getSuperAdminOnlyPaths } from '@/navigation/navConfig';
import { findAdminModuleNeighbors, indexAdminNavByUrl, resolveActiveAdminItem } from '@/navigation/adminNavIndex';
import { useAdminNavPrefs } from '@/hooks/useAdminNavPrefs';
import { useAdminScope } from '@/hooks/useAdminScope';
import { useAuth } from '@/hooks/useAuth';
import { canAccessAdminModule, isAdminRole, isSuperAdmin } from '@/utils/rbac';
import { cn } from '@/lib/utils';

import {
  AdminModuleComponents,
  isAdminModuleKey,
  wrapAdminModule,
} from './adminModules';
import { SuperAdminGuard } from './SuperAdminGuard';
import {
  InfoBadge,
  InfoPanel,
  InfoQueryHero,
  InfoQueryShell,
  InfoSectionTitle,
  studioPrimaryButtonClassName,
  studioSecondaryButtonClassName,
} from '../studioTheme';

/**
 * `/admin` index — module hub with grouped cards linking into drill-in routes.
 *
 * 效率增强：置顶/最近访问专区（与侧边栏、⌘K 命令面板共用同一份偏好），
 * 每张卡片可直接置顶；顶部给出 ⌘K 提示，快速搜索入口不再靠"记住路径"。
 */
export const AdminHub: React.FC = () => {
  const { user } = useAuth();
  const { setNotification } = useNotification();
  const { pinned, recent, isPinned, togglePin, clearRecent } = useAdminNavPrefs();
  // 普通管理员能看到哪些卡片，以服务端授权为准（拿不到时自动回退到默认集合）。
  const { grantedPages: grantedAdminPages, degraded: scopeDegraded, loading: scopeLoading } = useAdminScope();

  const groups = useMemo(
    () =>
      getAdminNavGroups({
        isAdmin: isAdminRole(user?.role),
        isSuperAdmin: isSuperAdmin(user?.role),
        canUseTranslation: user?.isTranslationEnabled !== false,
        grantedAdminPages,
      }).filter((g) => g.id !== 'admin-hub'),
    [user?.role, user?.isTranslationEnabled, grantedAdminPages],
  );

  const byUrl = useMemo(() => indexAdminNavByUrl(groups), [groups]);
  const totalModules = groups.reduce((sum, g) => sum + g.items.length, 0);

  const pinnedItems = pinned.map((entry) => byUrl.get(entry.url)).filter(Boolean);
  const recentItems = recent
    .map((entry) => byUrl.get(entry.url))
    .filter((item) => Boolean(item) && !isPinned(item!.url))
    .slice(0, 6);

  const handleTogglePin = (url: string, title: string) => {
    const nowPinned = togglePin({ url, title });
    setNotification({
      type: 'success',
      message: nowPinned ? `已置顶「${title}」` : `已取消置顶「${title}」`,
    });
  };

  return (
    <InfoQueryShell className='logshare-admin-surface'>
      <div className='space-y-6'>
        <InfoQueryHero
          eyebrow='Admin Console'
          title='管理后台'
          description='系统管理与配置中心。桌面端按 ⌘/Ctrl + K 可直接搜索全部模块；置顶后模块会固定到侧边栏顶部。'
          icon={FaShieldAlt}
          tone='slate'
          meta={
            <>
              <InfoBadge tone='slate'>管理员 {user?.username}</InfoBadge>
              <InfoBadge tone='emerald'>权限已验证</InfoBadge>
              <InfoBadge tone='slate'>{totalModules} 个模块</InfoBadge>
              {pinned.length > 0 ? <InfoBadge tone='amber'>{pinned.length} 个置顶</InfoBadge> : null}
            </>
          }
        />

        {scopeDegraded ? (
          <InfoPanel className='border-amber-200 bg-amber-50/60'>
            <p className='text-sm text-amber-800'>
              页面授权服务暂时不可用，当前按<strong>默认可见页面</strong>展示；若你刚被授权了新页面，稍后刷新即可。
            </p>
          </InfoPanel>
        ) : null}

        {pinnedItems.length > 0 || recentItems.length > 0 ? (
          <InfoPanel>
            <InfoSectionTitle title='置顶与最近访问' icon={FaStar} eyebrow='Shortcuts' />
            <div className='mt-4 space-y-4'>
              {pinnedItems.length > 0 ? (
                <div>
                  <p className='mb-2 text-[11px] font-semibold tracking-[0.12em] text-slate-400 uppercase'>
                    已置顶
                  </p>
                  <div className='flex flex-wrap gap-2'>
                    {pinnedItems.map((item) => (
                      <span
                        key={`pinned-${item!.url}`}
                        className='inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 py-1 pr-1 pl-3 text-xs font-semibold text-amber-800'
                      >
                        <Link to={item!.url} className='hover:underline'>
                          {item!.title}
                        </Link>
                        <button
                          type='button'
                          onClick={() => handleTogglePin(item!.url, item!.title)}
                          aria-label={`取消置顶 ${item!.title}`}
                          title='取消置顶'
                          className='flex size-5 items-center justify-center rounded-full text-amber-500 transition hover:bg-amber-100 hover:text-amber-700'
                        >
                          <FaStar className='size-3' aria-hidden='true' />
                        </button>
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}

              {recentItems.length > 0 ? (
                <div>
                  <div className='mb-2 flex items-center justify-between'>
                    <p className='text-[11px] font-semibold tracking-[0.12em] text-slate-400 uppercase'>
                      最近访问
                    </p>
                    <button
                      type='button'
                      onClick={clearRecent}
                      className='rounded-md px-1.5 py-0.5 text-[11px] font-medium text-slate-400 transition hover:bg-slate-100 hover:text-slate-600'
                    >
                      清空
                    </button>
                  </div>
                  <div className='flex flex-wrap gap-2'>
                    {recentItems.map((item) => (
                      <Link
                        key={`recent-${item!.url}`}
                        to={item!.url}
                        className='inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-600 transition hover:border-indigo-200 hover:text-indigo-600'
                      >
                        {item!.title}
                      </Link>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </InfoPanel>
        ) : null}

        <div className='flex items-center gap-2 rounded-2xl border border-dashed border-slate-300 bg-white/60 px-4 py-2.5 text-xs text-slate-500'>
          <FaSearch className='size-3 text-slate-400' aria-hidden='true' />
          <span>
            按 <kbd className='rounded border border-slate-200 bg-white px-1 py-0.5 font-semibold'>⌘/Ctrl</kbd>
            {' + '}
            <kbd className='rounded border border-slate-200 bg-white px-1 py-0.5 font-semibold'>K</kbd>
            {' '}搜索模块；卡片右上角 <FaStar className="inline" aria-hidden /> 可置顶
          </span>
        </div>

        {groups.map((group) => (
          <InfoPanel key={group.id || group.title}>
            <InfoSectionTitle
              title={group.title}
              icon={FaShieldAlt}
              eyebrow='Modules'
            />
            <div className='mt-4 grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3'>
              {group.items.map((item) => {
                if (!('url' in item) || !item.url) return null;
                const Icon = item.icon;
                const pinnedNow = isPinned(item.url);
                return (
                  <div key={item.url} className='group/card relative'>
                    <Link
                      to={item.url}
                      className={cn(
                        'group flex items-center gap-3 rounded-2xl border border-slate-200/90 bg-white/90 px-4 py-3.5',
                        'text-sm font-semibold text-slate-700 shadow-[0_1px_0_rgba(15,23,42,0.03)]',
                        'transition duration-150',
                        'hover:-translate-y-0.5 hover:border-indigo-200 hover:bg-white hover:text-slate-900',
                        'hover:shadow-[0_10px_30px_-18px_rgba(79,70,229,0.45)]',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2',
                        pinnedNow && 'border-amber-200/90',
                      )}
                    >
                      <span className='flex size-9 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-500 transition group-hover:bg-indigo-50 group-hover:text-indigo-600'>
                        {Icon ? (
                          <Icon className='size-4' aria-hidden='true' />
                        ) : (
                          <FaShieldAlt className='size-4' aria-hidden='true' />
                        )}
                      </span>
                      <span className='min-w-0 flex-1 truncate'>{item.title}</span>
                      <FaChevronRight
                        className='size-3 shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-indigo-400'
                        aria-hidden='true'
                      />
                    </Link>
                    <button
                      type='button'
                      onClick={() => handleTogglePin(item.url, item.title)}
                      aria-label={pinnedNow ? `取消置顶 ${item.title}` : `置顶 ${item.title}`}
                      title={pinnedNow ? '取消置顶' : '置顶到侧边栏'}
                      className={cn(
                        'absolute top-2 right-2 flex size-6 items-center justify-center rounded-lg transition',
                        pinnedNow
                          ? 'text-amber-500 hover:bg-amber-50'
                          : 'text-slate-300 opacity-0 hover:bg-slate-100 hover:text-amber-500 focus-visible:opacity-100 group-hover/card:opacity-100',
                      )}
                    >
                      {pinnedNow ? (
                        <FaStar className='size-3.5' aria-hidden='true' />
                      ) : (
                        <FaRegStar className='size-3.5' aria-hidden='true' />
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          </InfoPanel>
        ))}
      </div>
    </InfoQueryShell>
  );
};

/**
 * `/admin/:module` — renders the module matched by the URL segment.
 *
 * 顶部工具条提供：面包屑 + 置顶开关 + 复制路径 + 新标签打开 + 上/下一个模块
 * （Ctrl/⌘ + Shift + ←/→），让管理员在 41 个模块之间横跳不用回总览。
 */
export const AdminModulePage: React.FC = () => {
  const { module } = useParams<{ module: string }>();
  const { user } = useAuth();
  const { setNotification } = useNotification();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { isPinned, togglePin } = useAdminNavPrefs();
  // 深链守卫同样以服务端授权为准：导航里隐藏的页面，直接输 URL 也不应渲染。
  const { grantedPages: grantedAdminPages, loading: scopeLoading } = useAdminScope();

  const groups = useMemo(
    () =>
      getAdminNavGroups({
        isAdmin: isAdminRole(user?.role),
        isSuperAdmin: isSuperAdmin(user?.role),
        canUseTranslation: user?.isTranslationEnabled !== false,
        grantedAdminPages,
      }).filter((g) => g.id !== 'admin-hub'),
    [user?.role, user?.isTranslationEnabled, grantedAdminPages],
  );

  const activeItem = useMemo(
    () => resolveActiveAdminItem(pathname, groups),
    [groups, pathname],
  );
  const neighbors = useMemo(
    () => findAdminModuleNeighbors(pathname, groups),
    [groups, pathname],
  );

  React.useEffect(() => {
    if (!neighbors.prev && !neighbors.next) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return;
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      const target = event.key === 'ArrowLeft' ? neighbors.prev : neighbors.next;
      if (!target) return;
      event.preventDefault();
      navigate(target.url);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [navigate, neighbors]);

  if (!module || !isAdminModuleKey(module)) {
    return (
      <InfoQueryShell className='logshare-admin-surface'>
        <InfoPanel>
          <div className='py-16 text-center'>
            <div className='mx-auto mb-4 flex size-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-400'>
              <FaShieldAlt className='size-5' aria-hidden='true' />
            </div>
            <h2 className='text-xl font-semibold text-slate-900'>
              未找到管理模块
            </h2>
            <p className='mt-2 text-sm text-slate-500'>
              路径 <code className='font-mono'>{module}</code> 不在已注册模块中。
            </p>
            <Link
              to='/admin'
              className={cn(studioPrimaryButtonClassName, 'mt-6 py-2.5')}
            >
              返回管理总览
            </Link>
          </div>
        </InfoPanel>
      </InfoQueryShell>
    );
  }

  const Component = AdminModuleComponents[module];

  // 超管专属模块（navConfig 里 requiredRole=superadmin）与「未授权的普通管理员模块」
  // 都不渲染 UI，也不让深链绕过：授权集合来自 GET /api/admin/admin-scope/me。
  const isSuperAdminOnly =
    getSuperAdminOnlyPaths().has(`/admin/${module}`) ||
    !canAccessAdminModule(user?.role, module, grantedAdminPages);
  if (isSuperAdminOnly && !isSuperAdmin(user?.role)) {
    // 授权还在拉取时先等一下，避免把「未裁定的可见页面」闪成拒绝页。
    if (scopeLoading) {
      return (
        <InfoQueryShell className='logshare-admin-surface'>
          <InfoPanel>
            <div className='py-16 text-center text-sm text-slate-500'>正在校验页面授权…</div>
          </InfoPanel>
        </InfoQueryShell>
      );
    }
    return <SuperAdminGuard />;
  }

  const title = activeItem?.title ?? module;
  const pinnedNow = Boolean(activeItem && isPinned(activeItem.url));

  return (
    <InfoQueryShell className='logshare-admin-surface'>
      <div className='mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-slate-200/90 bg-white/80 px-3 py-2 shadow-[0_1px_0_rgba(15,23,42,0.03)]'>
        <nav aria-label='面包屑' className='flex min-w-0 items-center gap-1.5 text-xs text-slate-500'>
          <Link to='/admin' className='shrink-0 font-medium hover:text-indigo-600'>
            管理总览
          </Link>
          <FaChevronRight className='size-2.5 shrink-0 text-slate-300' aria-hidden='true' />
          <span className='truncate font-semibold text-slate-800'>{title}</span>
          {neighbors.index >= 0 ? (
            <span className='shrink-0 text-slate-400'>
              ({neighbors.index + 1}/{neighbors.total})
            </span>
          ) : null}
        </nav>

        <div className='ml-auto flex flex-wrap items-center gap-1.5'>
          {activeItem ? (
            <button
              type='button'
              onClick={() => {
                const nowPinned = togglePin({ url: activeItem.url, title: activeItem.title });
                setNotification({ type: 'success', message: nowPinned ? '已置顶到侧边栏' : '已取消置顶' });
              }}
              aria-pressed={pinnedNow}
              title={pinnedNow ? '取消置顶' : '置顶到侧边栏'}
              className={cn(
                studioSecondaryButtonClassName,
                'flex items-center gap-1.5 px-2.5 py-1.5 text-xs',
                pinnedNow && 'border-amber-200 bg-amber-50 text-amber-700',
              )}
            >
              {pinnedNow ? (
                <FaStar className='size-3' aria-hidden='true' />
              ) : (
                <FaRegStar className='size-3' aria-hidden='true' />
              )}
              {pinnedNow ? '已置顶' : '置顶'}
            </button>
          ) : null}

          <button
            type='button'
            onClick={() => {
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
            }}
            title='复制当前模块路径'
            className={cn(
              studioSecondaryButtonClassName,
              'flex items-center gap-1.5 px-2.5 py-1.5 text-xs',
            )}
          >
            <FaCopy className='size-3' aria-hidden='true' />
            复制路径
          </button>

          <button
            type='button'
            onClick={() => window.open(window.location.href, '_blank', 'noopener,noreferrer')}
            title='在新标签打开当前模块'
            className={cn(
              studioSecondaryButtonClassName,
              'flex items-center gap-1.5 px-2.5 py-1.5 text-xs',
            )}
          >
            <FaExternalLinkAlt className='size-3' aria-hidden='true' />
            新标签
          </button>

          <div className='flex items-center gap-1'>
            <button
              type='button'
              disabled={!neighbors.prev}
              onClick={() => neighbors.prev && navigate(neighbors.prev.url)}
              title={neighbors.prev ? `上一个模块：${neighbors.prev.title}` : '没有上一个模块'}
              aria-label={neighbors.prev ? `上一个模块：${neighbors.prev.title}` : '没有上一个模块'}
              className={cn(
                studioSecondaryButtonClassName,
                'flex items-center gap-1 px-2 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-40',
              )}
            >
              <FaArrowLeft className='size-2.5' aria-hidden='true' />
              上一个
            </button>
            <button
              type='button'
              disabled={!neighbors.next}
              onClick={() => neighbors.next && navigate(neighbors.next.url)}
              title={neighbors.next ? `下一个模块：${neighbors.next.title}` : '没有下一个模块'}
              aria-label={neighbors.next ? `下一个模块：${neighbors.next.title}` : '没有下一个模块'}
              className={cn(
                studioSecondaryButtonClassName,
                'flex items-center gap-1 px-2 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-40',
              )}
            >
              下一个
              <FaArrowRight className='size-2.5' aria-hidden='true' />
            </button>
          </div>

          <span className='hidden items-center gap-1 text-[10px] text-slate-400 lg:flex'>
            <kbd className='rounded border border-slate-200 bg-white px-1 py-0.5 font-semibold'>⌘K</kbd>
            搜索模块
            <kbd className='ml-1 rounded border border-slate-200 bg-white px-1 py-0.5 font-semibold'>
              ⌘⇧←/→
            </kbd>
            切换
          </span>
        </div>
      </div>

      <div className='min-h-[400px] rounded-2xl border border-slate-200/90 bg-white/70 p-3 shadow-[0_18px_50px_-36px_rgba(15,23,42,0.35)] sm:p-5'>
        {wrapAdminModule(Component)}
      </div>
    </InfoQueryShell>
  );
};

export default AdminHub;
