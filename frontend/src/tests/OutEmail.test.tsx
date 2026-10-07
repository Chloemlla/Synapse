import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/api';
import OutEmail from '../components/OutEmail';

const { user, notify } = vi.hoisted(() => ({ user: { role: 'superadmin' }, notify: vi.fn() }));
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user }) }));
vi.mock('../components/Notification', () => ({ useNotification: () => ({ setNotification: notify }) }));
vi.mock('../api/api', () => ({ api: { get: vi.fn(), post: vi.fn() } }));
vi.mock('../api', () => ({ default: () => 'https://api.example.test' }));

function fillBatch(count: number) {
  fireEvent.change(screen.getByPlaceholderText('请输入邮件主题'), { target: { value: 'Notice' } });
  fireEvent.change(screen.getByPlaceholderText('请输入邮件内容'), { target: { value: 'Hello' } });
  fireEvent.change(screen.getByPlaceholderText('请输入验证码'), { target: { value: 'secret' } });
  fireEvent.click(screen.getByRole('checkbox', { name: /批量发送/ }));
  fireEvent.change(screen.getByPlaceholderText(/foo@example.com/), {
    target: { value: Array.from({ length: count }, (_, index) => `user${index}@example.com`).join('\n') },
  });
}

describe('OutEmail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.get).mockResolvedValue({ data: { success: true, used: 0, total: 100 } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ available: true, domain: 'example.com' }),
    }));
  });

  it('rejects batches larger than the real recipient limit before sending', async () => {
    render(<MemoryRouter><OutEmail /></MemoryRouter>);
    fillBatch(21);
    fireEvent.click(screen.getByRole('button', { name: '批量发送' }));
    expect(await screen.findByText('一次最多发送给20位收件人，每分钟也按实际收件人数计数')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('displays the backend rate-limit message and duration for an allowed batch', async () => {
    vi.mocked(api.post).mockRejectedValueOnce({ response: { data: {
      error: '请稍后再试', code: 'EMAIL_RATE_LIMITED', retryAfterSeconds: 30,
    } } });
    render(<MemoryRouter><OutEmail /></MemoryRouter>);
    fillBatch(20);
    fireEvent.click(screen.getByRole('button', { name: '批量发送' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('请稍后再试')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /秒后可重试/ })).toBeDisabled();
    expect(vi.mocked(api.post).mock.calls[0][1].messages).toHaveLength(20);
  });
});
