import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ notify: vi.fn(), confirm: vi.fn(), fetch: vi.fn() }));
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'admin', role: 'superadmin' } }) }));
vi.mock('../components/Notification', () => ({ useNotification: () => ({ setNotification: mocks.notify }) }));
vi.mock('../components/confirm/ConfirmDialogProvider', () => ({ useConfirm: () => mocks.confirm }));
vi.mock('../api', () => ({ default: () => '', getApiBaseUrl: () => '' }));
vi.mock('../api/api', () => ({ getApiBaseUrl: () => '' }));
vi.mock('../components/ImageUploadSection', () => ({ default: () => null }));

import FBIWantedManager from '../components/FBIWantedManager';
import ApiKeyManager from '../components/ApiKeyManager';

const key = {
  keyId: 'key-one', name: 'Existing key', userId: 'owner', permissions: ['status'], rateLimit: 60,
  expiresAt: '2020-01-01T03:04:05.000Z', enabled: true, usageCount: 0, createdAt: '2019-01-01T00:00:00Z',
};
const response = (data: unknown) => ({ ok: true, json: async () => data });
const deletes = () => mocks.fetch.mock.calls.filter(([, options]) => options?.method === 'DELETE');
const puts = () => mocks.fetch.mock.calls.filter(([, options]) => options?.method === 'PUT');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.confirm.mockResolvedValue(true);
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.fetch.mockImplementation(async (url: string) => {
    if (url.includes('/fbi-wanted/statistics')) return response({ data: null });
    if (url.includes('/fbi-wanted')) return response({ data: [], pagination: { pages: 1 }, message: 'done' });
    if (url.endsWith('/apikeys/all')) return response({ keys: [key] });
    if (url.endsWith('/apikeys/permissions')) return response({ permissions: ['status'] });
    return response({});
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('FBI destructive confirmation', () => {
  it.each([false, undefined, null])('never deletes when confirmation resolves to %s', async (answer) => {
    mocks.confirm.mockResolvedValue(answer);
    render(<FBIWantedManager />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '删除所有记录' })); });
    expect(mocks.confirm).toHaveBeenCalledOnce();
    expect(deletes()).toHaveLength(0);
  });

  it('sends explicit all-record confirmation only for the all-record action', async () => {
    render(<FBIWantedManager />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '删除所有记录' })); });
    expect(JSON.parse(deletes()[0][1].body)).toEqual({ filter: {}, confirmAll: true });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '删除死亡记录' })); });
    expect(JSON.parse(deletes()[1][1].body)).toEqual({ filter: { status: 'DECEASED' } });
  });

  it('keeps trailing separators in the charge draft and clears it for a new record', async () => {
    render(<FBIWantedManager />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '添加通缉犯' })); });
    const charges = screen.getByPlaceholderText('输入罪名，多个罪名用逗号分隔');
    fireEvent.change(charges, { target: { value: 'first,' } });
    expect(charges).toHaveValue('first,');
    fireEvent.change(charges, { target: { value: 'first,second' } });
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    fireEvent.click(screen.getByRole('button', { name: '添加通缉犯' }));
    expect(screen.getByPlaceholderText('输入罪名，多个罪名用逗号分隔')).toHaveValue('');
  });
});

describe('API key expiry editing', () => {
  it('keeps an expired key expired when only its name changes', async () => {
    render(<ApiKeyManager />);
    fireEvent.click(await screen.findByTitle('编辑'));
    fireEvent.change(screen.getByDisplayValue('Existing key'), { target: { value: 'Renamed key' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    const body = JSON.parse(puts()[0][1].body);
    expect(body.name).toBe('Renamed key');
    expect(body).not.toHaveProperty('expiresInDays');
  });

  it('changes validity only after an explicit edit of the expiry field', async () => {
    render(<ApiKeyManager />);
    fireEvent.click(await screen.findByTitle('编辑'));
    fireEvent.change(screen.getByLabelText('重新设置有效期（天）；不修改则保留原到期时间'), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(JSON.parse(puts()[0][1].body).expiresInDays).toBe(7);
  });
});
