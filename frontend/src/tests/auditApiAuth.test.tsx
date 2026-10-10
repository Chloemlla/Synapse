import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../stores/authStore';
import { useAuth } from '../hooks/useAuth';
import type { User } from '../types/auth';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), fingerprint: vi.fn(), navigate: vi.fn() }));
vi.mock('../api/api', () => ({ api: { get: mocks.get, post: mocks.post } }));
vi.mock('../utils/fingerprint', () => ({ getFingerprint: mocks.fingerprint }));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate, useLocation: () => ({ pathname: '/welcome' }) }));
vi.mock('../utils/authSession', () => ({ readSavedAccounts: () => [], writeSavedAccounts: vi.fn(), clearSavedAccounts: vi.fn(), ACCOUNTS_KEY: 'accounts' }));
vi.mock('../utils/penaltyAppeal', () => ({ maybeEmitPenaltyAppealFromError: vi.fn() }));
vi.mock('../utils/adminVerifyCache', () => ({ resetAdminVerifyCache: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const user = (id: string) => ({ id, username: id, role: 'user' } as User);

describe('authentication response ownership', () => {
  beforeEach(() => {
    useAuthStore.getState().reset();
    vi.clearAllMocks();
    mocks.fingerprint.mockResolvedValue('fingerprint');
    mocks.get.mockResolvedValue({ status: 200, data: null });
  });
  afterEach(cleanup);

  it('ignores a late successful identity response after logout', async () => {
    const read = deferred<any>();
    mocks.get.mockReturnValue(read.promise);
    const checking = useAuthStore.getState().checkAuth();
    await Promise.resolve();
    useAuthStore.getState().logout();
    read.resolve({ data: user('old') });
    await checking;
    expect(useAuthStore.getState()).toMatchObject({ user: null, isAuthenticated: false, isLoading: false, error: null });
  });

  it('ignores an old 401 after another account is established', async () => {
    const read = deferred<any>();
    mocks.get.mockReturnValue(read.promise);
    const checking = useAuthStore.getState().checkAuth();
    await Promise.resolve();
    useAuthStore.getState().setUser(user('new'));
    read.reject({ response: { status: 401 } });
    await checking;
    expect(useAuthStore.getState()).toMatchObject({ user: { id: 'new' }, isAuthenticated: true, error: null });
  });

  it('deduplicates concurrent identity reads', async () => {
    const read = deferred<any>();
    mocks.get.mockReturnValue(read.promise);
    const first = useAuthStore.getState().checkAuth();
    const second = useAuthStore.getState().checkAuth();
    await Promise.resolve();
    expect(mocks.get).toHaveBeenCalledTimes(1);
    read.resolve({ data: user('one') });
    await Promise.all([first, second]);
    expect(useAuthStore.getState().user?.id).toBe('one');
  });

  it('does not read the old cookie while a new login is in progress', async () => {
    const loginResponse = deferred<any>();
    mocks.post.mockReturnValue(loginResponse.promise);
    const login = useAuthStore.getState().login('new', 'password');
    await Promise.resolve();
    await useAuthStore.getState().checkAuth();
    expect(mocks.get).not.toHaveBeenCalled();
    loginResponse.resolve({ data: { user: user('new'), token: 'cookie-established' } });
    await login;
    expect(useAuthStore.getState().user?.id).toBe('new');
  });

  it('cancels a pending login before fingerprint completion can send it', async () => {
    const fingerprint = deferred<string>();
    mocks.fingerprint.mockReturnValue(fingerprint.promise);
    const login = useAuthStore.getState().login('old', 'password');
    const rejected = expect(login).rejects.toThrow('登录操作已取消');
    useAuthStore.getState().logout();
    fingerprint.resolve('late-fingerprint');
    await rejected;
    expect(mocks.post).not.toHaveBeenCalled();
    expect(useAuthStore.getState().user).toBeNull();
  });

  it('a late logout response cannot clear a subsequently logged-in account', async () => {
    mocks.get.mockResolvedValue({ status: 200, data: user('old') });
    const { result } = renderHook(() => useAuth());
    await act(async () => { await Promise.resolve(); });
    const logoutResponse = deferred<any>();
    mocks.post.mockReturnValue(logoutResponse.promise);
    let logout!: Promise<void>;
    act(() => { logout = result.current.logout(); });
    expect(useAuthStore.getState().user).toBeNull();
    act(() => { useAuthStore.getState().setUser(user('new')); });
    await act(async () => { logoutResponse.resolve({ data: {} }); await logout; });
    expect(useAuthStore.getState().user?.id).toBe('new');
  });
});
