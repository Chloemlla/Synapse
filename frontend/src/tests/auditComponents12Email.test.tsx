import React, { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(), fetch: vi.fn(), notify: vi.fn(), navigate: vi.fn(),
  query: { value: 'token=old-route' },
}));
vi.mock('../api/api', () => ({ api: { get: mocks.get, post: mocks.post }, getApiBaseUrl: () => '' }));
vi.mock('../components/Notification', () => ({ useNotification: () => ({ setNotification: mocks.notify }) }));
vi.mock('../components/MarkdownPreview', () => ({ default: () => null }));
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('../utils/fingerprint', () => ({ getFingerprint: async () => 'fingerprint' }));
vi.mock('react-router-dom', () => ({
  Link: ({ children, to, ...rest }: { children?: React.ReactNode; to: string }) => <a href={to} {...rest}>{children}</a>,
  useNavigate: () => mocks.navigate,
  useSearchParams: () => [new URLSearchParams(mocks.query.value)],
}));

// Exercise the real shared request helper and quota hook; only their transports are mocked.
import EmailSender from '../components/EmailSender';
import EmailVerifyPage from '../components/EmailVerifyPage';

type ApiReply = { data: Record<string, unknown> };
function deferred() {
  let resolve!: (value: ApiReply) => void;
  const promise = new Promise<ApiReply>(done => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.query.value = 'token=old-route';
  mocks.get.mockImplementation(async (url: string) => {
    if (url === '/api/email/quota') return { data: { used: 3, total: 100 } };
    if (url === '/api/outemail/quota') return { data: { used: 8, total: 500 } };
    if (url === '/api/email/domains') return { data: { domains: ['chloemlla.com', 'second.example'] } };
    if (url === '/api/email/status') return { data: { available: true } };
    return { data: { success: true, settings: [] } };
  });
  mocks.post.mockImplementation(async (url: string) => {
    if (url === '/api/email/validate') return { data: { valid: [], invalid: [] } };
    return { data: { success: true, acceptedCount: 1 } };
  });
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => ({ available: true, domain: 'public.example' }) });
  vi.stubGlobal('fetch', mocks.fetch);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function openSender() {
  render(<EmailSender />);
  await screen.findByText('3 / 100');
  await screen.findByText('8 / 500');
  fireEvent.click(screen.getByRole('button', { name: '站内发信' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '发送站内邮件' })).toBeEnabled());
}

const internalQuotaRequests = () => mocks.get.mock.calls.filter(([url]) => url === '/api/email/quota');

describe('merged email sender contract', () => {
  it('preserves edits made during delivery and refreshes the shared user budget', async () => {
    const delivery = deferred();
    mocks.post.mockImplementation((url: string) => url === '/api/email/send-simple'
      ? delivery.promise : Promise.resolve({ data: { valid: [], invalid: [] } }));
    await openSender();
    fireEvent.click(screen.getByRole('button', { name: '纯文本' }));
    fireEvent.change(screen.getByPlaceholderText('收件人 1'), { target: { value: 'first@example.com' } });
    fireEvent.change(screen.getByPlaceholderText('请输入邮件主题'), { target: { value: 'First message' } });
    fireEvent.change(screen.getByPlaceholderText('请输入纯文本内容'), { target: { value: 'First body' } });
    fireEvent.click(screen.getByRole('button', { name: '发送站内邮件' }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith('/api/email/send-simple', expect.objectContaining({
      to: ['first@example.com'], subject: 'First message', content: 'First body',
    })));

    fireEvent.change(screen.getByPlaceholderText('收件人 1'), { target: { value: 'next@example.com' } });
    fireEvent.change(screen.getByPlaceholderText('请输入邮件主题'), { target: { value: 'Next message' } });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'second.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Markdown' }));
    fireEvent.change(screen.getByPlaceholderText('请输入 Markdown 内容'), { target: { value: '# Next body' } });
    await act(async () => { delivery.resolve({ data: { success: true, acceptedCount: 1 } }); });

    expect(screen.getByPlaceholderText('收件人 1')).toHaveValue('next@example.com');
    expect(screen.getByPlaceholderText('请输入邮件主题')).toHaveValue('Next message');
    expect(screen.getByPlaceholderText('请输入完整发件人邮箱')).toHaveValue('noreply@second.example');
    expect(screen.getByPlaceholderText('请输入 Markdown 内容')).toHaveValue('# Next body');
    expect(mocks.notify).toHaveBeenCalledWith({ message: '已向 1 位收件人发送', type: 'success' });
    expect(internalQuotaRequests()).toHaveLength(2);
    expect(mocks.get.mock.calls.some(([url]) => typeof url === 'string' && url.includes('/quota?'))).toBe(false);
  });

  it('keeps one user budget across sender domains and isolates the public budget', async () => {
    await openSender();
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'second.example' } });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'chloemlla.com' } });
    fireEvent.click(screen.getByRole('button', { name: '总览' }));
    expect(screen.getByText('3 / 100')).toBeInTheDocument();
    expect(screen.getByText('8 / 500')).toBeInTheDocument();
    expect(internalQuotaRequests()).toHaveLength(1);
    expect(mocks.get.mock.calls.filter(([url]) => url === '/api/outemail/quota')).toHaveLength(1);
  });
});

it('shares StrictMode verification, ignores the previous route, and retries the current token', async () => {
  const first = deferred();
  const second = deferred();
  mocks.post.mockReset();
  mocks.post.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    .mockResolvedValueOnce({ data: { success: true, message: '当前链接验证成功' } });
  const { rerender } = render(<StrictMode><EmailVerifyPage /></StrictMode>);
  await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
  expect(mocks.post).toHaveBeenLastCalledWith('/api/auth/verify-email-link', { token: 'old-route', fingerprint: 'fingerprint' });

  mocks.query.value = 'token=new-route';
  rerender(<StrictMode><EmailVerifyPage /></StrictMode>);
  await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(2));
  await act(async () => { second.resolve({ data: { success: false, error: '当前请求需要重试' } }); });
  await act(async () => { first.resolve({ data: { success: true, message: '旧链接验证成功' } }); });
  expect(screen.getByText('当前请求需要重试')).toBeInTheDocument();
  expect(screen.queryByText('验证成功！')).not.toBeInTheDocument();
  expect(mocks.notify).not.toHaveBeenCalledWith(expect.objectContaining({ message: '旧链接验证成功' }));
  expect(mocks.navigate).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: '重新验证' }));
  await screen.findByText('验证成功！');
  expect(mocks.post).toHaveBeenCalledTimes(3);
  expect(mocks.post).toHaveBeenLastCalledWith('/api/auth/verify-email-link', { token: 'new-route', fingerprint: 'fingerprint' });
  expect(mocks.notify).toHaveBeenCalledWith({ message: '当前链接验证成功', type: 'success' });
});
