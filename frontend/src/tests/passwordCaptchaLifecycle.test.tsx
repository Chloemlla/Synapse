import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  reset: vi.fn(),
  fetch: vi.fn(),
  fingerprint: vi.fn(),
  notify: vi.fn(),
}));

vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('../components/Notification', () => ({ useNotification: () => ({ setNotification: h.notify }) }));
vi.mock('../api', () => ({ default: () => 'https://synapse.example' }));
vi.mock('../utils/fingerprint', () => ({
  getFingerprint: () => h.fingerprint(),
  getClientIP: async () => '127.0.0.1',
}));
vi.mock('../components/ManagedCaptcha', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  return {
    default: React.forwardRef<any, any>((props, ref) => {
      React.useImperativeHandle(ref, () => ({ reset: () => {
        h.reset();
        props.onCleared();
      } }));
      React.useEffect(() => {
        props.onStatusChange({ required: true, loading: false, error: null, provider: 'turnstile', solved: false });
      }, [props.onStatusChange]);
      return <button type="button" onClick={() => props.onSolved({ token: 'one-use-token', provider: 'turnstile' })}>solve captcha</button>;
    }),
  };
});

import { ForgotPasswordPage } from '../components/ForgotPasswordPage';
import { ResetPasswordPage } from '../components/ResetPasswordPage';

beforeEach(() => {
  vi.clearAllMocks();
  h.fingerprint.mockResolvedValue('fingerprint');
  vi.stubGlobal('fetch', h.fetch);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function openPage(resetPassword: boolean) {
  const view = render(<MemoryRouter>{resetPassword ? <ResetPasswordPage /> : <ForgotPasswordPage />}</MemoryRouter>);
  fireEvent.change(screen.getByLabelText('邮箱地址'), { target: { value: 'reader@example.com' } });
  if (resetPassword) {
    fireEvent.change(screen.getByLabelText('验证码'), { target: { value: '12345678' } });
    fireEvent.change(screen.getByLabelText('新密码'), { target: { value: 'Password123!' } });
    fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: 'Password123!' } });
  }
  fireEvent.click(screen.getByRole('button', { name: 'solve captcha' }));
  return view.container.querySelector('form')!;
}

describe.each([false, true])('password request captcha lifecycle (reset=%s)', (resetPassword) => {
  it('sends a solved token only once while the request is pending', async () => {
    let resolveRequest!: (response: unknown) => void;
    h.fetch.mockImplementationOnce(() => new Promise((resolve) => { resolveRequest = resolve; }));
    const form = openPage(resetPassword);
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(1));
    resolveRequest({ ok: false, json: async () => ({ error: 'Rejected' }) });
    await waitFor(() => expect(h.reset).toHaveBeenCalledTimes(1));
  });

  it.each(['business rejection', 'network failure', 'invalid response'])('requires a new token after %s', async (failure) => {
    if (failure === 'network failure') h.fetch.mockRejectedValueOnce(new TypeError('Network Error'));
    else h.fetch.mockResolvedValueOnce({
      ok: false,
      json: failure === 'invalid response' ? async () => { throw new SyntaxError('Invalid JSON'); } : async () => ({ success: false, error: 'Rejected' }),
    });
    const form = openPage(resetPassword);
    fireEvent.submit(form);
    await waitFor(() => expect(h.reset).toHaveBeenCalledTimes(1));
    fireEvent.submit(form);
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it('preserves a solved challenge when local validation rejects the form', () => {
    const form = openPage(resetPassword);
    fireEvent.change(screen.getByLabelText('邮箱地址'), { target: { value: '' } });
    fireEvent.submit(form);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.reset).not.toHaveBeenCalled();
  });

  it('preserves the challenge when fingerprint lookup fails before sending', async () => {
    h.fingerprint.mockRejectedValueOnce(new Error('Fingerprint unavailable'));
    fireEvent.submit(openPage(resetPassword));
    await waitFor(() => expect(h.notify).toHaveBeenCalled());
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.reset).not.toHaveBeenCalled();
  });
});
