import React, { StrictMode } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/api';
import EmailVerifyPage from '../components/EmailVerifyPage';
import ResetPasswordLinkPage from '../components/ResetPasswordLinkPage';

const { navigate, notify, query } = vi.hoisted(() => ({
  navigate: vi.fn(), notify: vi.fn(), query: { value: 'token=first' },
}));
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }: any) => <a href={to} {...rest}>{children}</a>,
  useNavigate: () => navigate,
  useSearchParams: () => [new URLSearchParams(query.value)],
}));
vi.mock('../api/api', () => ({ api: { post: vi.fn() } }));
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('../components/Notification', () => ({ useNotification: () => ({ setNotification: notify }) }));
vi.mock('../utils/fingerprint', () => ({
  getFingerprint: async () => 'fingerprint', getClientIP: async () => '127.0.0.1',
}));

function deferred() {
  let resolve!: (value: any) => void;
  const promise = new Promise<any>((done) => { resolve = done; });
  return { resolve, promise };
}

describe('email link lifecycle', () => {
  beforeEach(() => { vi.clearAllMocks(); query.value = 'token=first'; });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('submits a one-time email verification only once during StrictMode replay', async () => {
    const response = deferred();
    vi.mocked(api.post).mockReturnValueOnce(response.promise);
    render(<StrictMode><EmailVerifyPage /></StrictMode>);
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    await act(async () => { response.resolve({ data: { success: true } }); });
    expect(screen.getByText('验证成功！')).toBeInTheDocument();
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('does not let an old verification replace the current token result', async () => {
    const first = deferred();
    const second = deferred();
    vi.mocked(api.post).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { rerender } = render(<EmailVerifyPage />);
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    query.value = 'token=second';
    rerender(<EmailVerifyPage />);
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    await act(async () => { second.resolve({ data: { success: false, error: '当前链接已失效' } }); });
    await act(async () => { first.resolve({ data: { success: true } }); });
    expect(screen.getByText('当前链接已失效')).toBeInTheDocument();
    expect(screen.queryByText('验证成功！')).not.toBeInTheDocument();
  });

  it('cancels the success redirect when leaving the verification page', async () => {
    vi.useFakeTimers();
    vi.mocked(api.post).mockResolvedValueOnce({ data: { success: true } });
    const { unmount } = render(<EmailVerifyPage />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText('验证成功！')).toBeInTheDocument();
    unmount();
    await act(async () => { vi.advanceTimersByTime(3000); });
    expect(navigate).not.toHaveBeenCalled();
  });

  it('keeps reset submission unavailable when a newer token is invalid', async () => {
    const first = deferred();
    const second = deferred();
    vi.mocked(api.post).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { rerender } = render(<ResetPasswordLinkPage />);
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    query.value = 'token=second';
    rerender(<ResetPasswordLinkPage />);
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    await act(async () => { second.resolve({ data: { valid: false, error: '新链接无效' } }); });
    await act(async () => { first.resolve({ data: { valid: true } }); });
    expect(screen.getByText('新链接无效')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重置密码' })).not.toBeInTheDocument();
  });
});
