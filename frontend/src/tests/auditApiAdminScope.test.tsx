import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../stores/authStore';
import { invalidateAdminScopeCache, useAdminScope } from '../hooks/useAdminScope';
import type { User } from '../types/auth';

const mocks = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('../api/adminScope', () => ({ getMyAdminScope: mocks.load }));
vi.mock('../api/api', () => ({ api: {} }));
vi.mock('../utils/fingerprint', () => ({ getFingerprint: vi.fn() }));
vi.mock('../hooks/useAuth', async () => {
  const { useAuthStore: store } = await import('../stores/authStore');
  return { useAuth: () => ({ user: store(state => state.user) }) };
});
function deferred() {
  let resolve!: (value: any) => void;
  const promise = new Promise<any>(yes => { resolve = yes; });
  return { promise, resolve };
}
const account = (id: string) => ({ id, role: 'admin' } as User);
const scope = (page: string) => ({ pages: [page], availablePages: [] });

describe('administrator scope ownership', () => {
  beforeEach(() => { useAuthStore.getState().reset(); invalidateAdminScopeCache(); vi.clearAllMocks(); });
  afterEach(cleanup);

  it('discards a slow old account response after a same-role account switch', async () => {
    const old = deferred();
    const current = deferred();
    mocks.load.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    useAuthStore.getState().setUser(account('A'));
    const { result } = renderHook(() => useAdminScope());
    act(() => { useAuthStore.getState().setUser(account('B')); });
    expect(result.current.grantedPages).toBeUndefined();
    await act(async () => { current.resolve(scope('B-page')); });
    await act(async () => { old.resolve(scope('A-page')); });
    expect(result.current.grantedPages).toEqual(['B-page']);
  });

  it('an older explicit refresh cannot overwrite the latest revision', async () => {
    mocks.load.mockResolvedValueOnce(scope('initial'));
    useAuthStore.getState().setUser(account('A'));
    const { result } = renderHook(() => useAdminScope());
    await act(async () => { await Promise.resolve(); });
    const old = deferred();
    const current = deferred();
    mocks.load.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => { first = result.current.refresh(); });
    act(() => { second = result.current.refresh(); });
    await act(async () => { current.resolve(scope('current')); await second; });
    await act(async () => { old.resolve(scope('stale')); await first; });
    expect(result.current.grantedPages).toEqual(['current']);
  });
});
