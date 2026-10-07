import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MailSystemConfigManager from '../components/MailSystemConfigManager';

const { notify, confirm } = vi.hoisted(() => ({ notify: vi.fn(), confirm: vi.fn() }));
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { role: 'superadmin' } }) }));
vi.mock('../components/Notification', () => ({ useNotification: () => ({ setNotification: notify }) }));
vi.mock('../components/confirm/ConfirmDialogProvider', () => ({ useConfirm: () => confirm }));
vi.mock('../api/api', () => ({ getApiBaseUrl: () => 'https://api.example.test' }));

describe('MailSystemConfigManager', () => {
  beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('fetch', vi.fn()); });

  it('does not save default values after the initial load fails and recovers on refresh', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('offline'));
    render(<MailSystemConfigManager />);
    const save = await screen.findByRole('button', { name: '保存' });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(fetch).toHaveBeenCalledTimes(1);

    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => ({
      success: true, setting: { config: {
        enabled: true, resendDomain: 'example.com', resendApiKey: 'masked', quotaTotal: 700,
        outemailEnabled: false, outemailDomain: 'example.com', outemailQuotaTotal: 800,
      } },
    }) } as Response);
    fireEvent.click(screen.getByRole('button', { name: /刷新/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: '保存' })).toBeEnabled());
    expect(screen.getByLabelText('每位用户每日手动发信配额')).toHaveValue(700);
  });
});
