import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminRedisApi, type RedisAdminKeysPage, type RedisAdminOverview } from '../api/adminRedis';
import { clearSecuritySession, setSecuritySession } from '../hooks/useSecuritySession';
import RedisDataBrowser from '../components/admin/RedisDataBrowser';

/**
 * Redis 在库数据浏览器的最小契约：
 *  - 没有安全会话时**一个请求都不发**（明文数据必须先二次验证）；
 *  - 会话建立后才拉取并渲染键列表；
 *  - 会话清掉后已拉到的数据要从页面上消失。
 */

// 会话级稳定的替身函数：若每次渲染都新建 setNotification，load() 的依赖会一直变，
// 造成「加载 → setState → 重渲染 → 再加载」的死循环（生产代码里该函数是 useCallback 稳定的）。
const notify = vi.hoisted(() => vi.fn());

vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { role: 'superadmin' } }) }));
vi.mock('../components/Notification', () => ({ useNotification: () => ({ setNotification: notify }) }));
vi.mock('../components/EstablishSecuritySession', () => ({
  default: () => <div data-testid='establish-security-session'>建立安全会话</div>,
}));
vi.mock('../api/adminRedis', () => ({
  adminRedisApi: {
    getOverview: vi.fn(),
    listKeys: vi.fn(),
    getKey: vi.fn(),
    exportSnapshot: vi.fn(),
  },
  extractAdminRedisErrorMessage: vi.fn(async (_error: unknown, fallback: string) => fallback),
}));

const OVERVIEW: RedisAdminOverview = {
  status: { configured: true, enabled: true, ready: true, available: true },
  dbsize: 12,
  usedMemoryBytes: 4096,
  scope: { restricted: false, prefixes: [], source: 'all' },
  maxPageLimit: 200,
  defaultPageLimit: 50,
};

const PAGE: RedisAdminKeysPage = {
  cursor: '0',
  done: true,
  keys: [{ key: 'cache:recommendation:popular', type: 'string', ttlMs: 60_000 }],
  scanned: 1,
  outOfScope: 0,
  match: '*',
  hasFilter: false,
  namespace: null,
  scope: OVERVIEW.scope,
};

describe('RedisDataBrowser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSecuritySession();
    vi.mocked(adminRedisApi.getOverview).mockResolvedValue(OVERVIEW);
    vi.mocked(adminRedisApi.listKeys).mockResolvedValue(PAGE);
  });

  afterEach(() => {
    clearSecuritySession();
  });

  it('没有安全会话时只提示建立会话，不发任何请求', () => {
    render(<RedisDataBrowser />);
    expect(screen.getByText(/需先建立安全会话/)).toBeInTheDocument();
    expect(screen.getByTestId('establish-security-session')).toBeInTheDocument();
    expect(adminRedisApi.getOverview).not.toHaveBeenCalled();
    expect(adminRedisApi.listKeys).not.toHaveBeenCalled();
  });

  it('建立会话后加载概览与键列表', async () => {
    setSecuritySession('verification-token', Date.now() + 600_000, 'totp');
    render(<RedisDataBrowser />);

    expect(await screen.findByText('cache:recommendation:popular')).toBeInTheDocument();
    await waitFor(() => expect(adminRedisApi.getOverview).toHaveBeenCalledTimes(1));
    expect(adminRedisApi.listKeys).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: '0', limit: 50 }),
      'verification-token',
    );
    // 会话令牌走请求头（GET 没有 body），组件把它作为第二参数传下去。
    expect(vi.mocked(adminRedisApi.listKeys).mock.calls[0]?.[1]).toBe('verification-token');
  });

  it('会话失效后清空已加载的数据', async () => {
    setSecuritySession('verification-token', Date.now() + 600_000, 'totp');
    render(<RedisDataBrowser />);
    expect(await screen.findByText('cache:recommendation:popular')).toBeInTheDocument();

    act(() => {
      clearSecuritySession();
    });
    await waitFor(() => expect(screen.queryByText('cache:recommendation:popular')).not.toBeInTheDocument());
    expect(screen.getByText(/需先建立安全会话/)).toBeInTheDocument();
  });
});
