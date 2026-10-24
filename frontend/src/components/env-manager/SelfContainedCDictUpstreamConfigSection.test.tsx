import type { HTMLAttributes, ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CDictUpstreamConfigSetting } from './types';

const h = vi.hoisted(() => ({ fetch: vi.fn(), notify: vi.fn(), confirm: vi.fn(), role: 'superadmin' }));
vi.mock('../../hooks/useAuth', () => ({ useAuth: () => ({ user: { role: h.role } }) }));
vi.mock('../Notification', () => ({ useNotification: () => ({ setNotification: h.notify }) }));
vi.mock('../confirm/ConfirmDialogProvider', () => ({ useConfirm: () => h.confirm }));
vi.mock('./api', () => ({
  CDICT_UPSTREAM_API: '/api/admin/cdict-upstream/setting', authFetch: h.fetch,
  getAuthHeaders: () => ({ 'x-test-auth': 'shared-headers' }),
}));
vi.mock('framer-motion', async () => {
  const React = await vi.importActual<typeof import('react')>('react');
  type MotionProps = HTMLAttributes<HTMLElement> & { initial?: unknown; animate?: unknown; transition?: unknown };
  return {
    useReducedMotion: () => false,
    m: {
      section: ({ initial: _initial, animate: _animate, transition: _transition, ...props }: MotionProps) => (
        React.createElement('section', props)
      ),
    },
  };
});
vi.mock('../studioFeedback', () => ({
  StudioLoadingState: ({ text }: { text: string }) => <div role="status">{text}</div>,
  StudioErrorState: ({ message, onRetry }: { message: ReactNode; onRetry?: () => void }) => (
    <div role="alert">{message}{onRetry && <button onClick={onRetry}>重试</button>}</div>
  ),
}));

import SelfContainedCDictUpstreamConfigSection from './SelfContainedCDictUpstreamConfigSection';

const CONFIG: CDictUpstreamConfigSetting = {
  translateBaseUrl: 'https://translate.example.test', translateAppId: 'translate-app',
  ttsUrl: 'https://tts.example.test/synthesize', ttsAppId: 'tts-app',
  ttsAppKey: 'viv********key', hasTtsAppKey: true,
};
const NON_SECRET = {
  translateBaseUrl: CONFIG.translateBaseUrl, translateAppId: CONFIG.translateAppId,
  ttsUrl: CONFIG.ttsUrl, ttsAppId: CONFIG.ttsAppId,
};
const RESPONSE_CONFIG = (patch: Partial<CDictUpstreamConfigSetting> = {}) => ({
  success: true, setting: { config: { ...CONFIG, ...patch }, updatedAt: '2026-10-24T00:00:00.000Z' },
});
function response(data: unknown, ok = true): Response {
  return { ok, json: async () => data } as Response;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const input = (env: string) => screen.getByLabelText(new RegExp(`（${env}）`));
const keyInput = () => input('VIVO_TTS_APP_KEY');
const saveButton = () => screen.getByRole('button', { name: '保存/更新' });
const resetButton = () => screen.getByRole('button', { name: '恢复部署默认值' });
function methods(): string[] {
  return h.fetch.mock.calls.map((call) => (call[1] as RequestInit).method ?? 'GET');
}
function lastPayload() {
  const post = h.fetch.mock.calls.filter((call) => (call[1] as RequestInit).method === 'POST').at(-1);
  return JSON.parse((post![1] as RequestInit).body as string);
}
async function openLoaded() {
  fireEvent.click(screen.getByRole('button', { name: '展开' }));
  await waitFor(() => expect(input('VIVO_TRANSLATE_APP_ID')).toHaveValue(CONFIG.translateAppId));
  await waitFor(() => expect(screen.getByRole('button', { name: '刷新' })).toBeEnabled());
}

beforeEach(() => {
  h.fetch.mockReset(); h.notify.mockReset(); h.confirm.mockReset();
  h.role = 'superadmin';
  h.fetch.mockResolvedValue(response(RESPONSE_CONFIG()));
  h.confirm.mockResolvedValue(true);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('SelfContainedCDictUpstreamConfigSection', () => {
  it('reads lazily once, renders all five settings, and never echoes a masked key into the input', async () => {
    render(<SelfContainedCDictUpstreamConfigSection />);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '刷新' })).toBeDisabled();
    await openLoaded();
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.fetch).toHaveBeenCalledWith('/api/admin/cdict-upstream/setting', expect.objectContaining({
      method: 'GET', headers: { 'x-test-auth': 'shared-headers' }, signal: expect.any(AbortSignal),
    }));
    expect(input('VIVO_TRANSLATE_BASE_URL')).toHaveValue(CONFIG.translateBaseUrl);
    expect(input('VIVO_TRANSLATE_APP_ID')).toHaveValue(CONFIG.translateAppId);
    expect(input('VIVO_TTS_URL')).toHaveValue(CONFIG.ttsUrl);
    expect(input('VIVO_TTS_APP_ID')).toHaveValue(CONFIG.ttsAppId);
    expect(keyInput()).toHaveAttribute('type', 'password');
    expect(keyInput()).toHaveValue('');
    expect(screen.getByText(/当前朗读密钥：已设置/)).toBeInTheDocument();
    expect(screen.queryByText(CONFIG.ttsAppKey)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '收起' }));
    fireEvent.click(screen.getByRole('button', { name: '展开' }));
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it('posts exactly the four non-secret values and omits a blank key to preserve it', async () => {
    render(<SelfContainedCDictUpstreamConfigSection />);
    await openLoaded();
    fireEvent.change(input('VIVO_TRANSLATE_BASE_URL'), { target: { value: ' https://new-translate.example.test ' } });
    fireEvent.change(input('VIVO_TRANSLATE_APP_ID'), { target: { value: ' new-translate-app ' } });
    fireEvent.change(input('VIVO_TTS_URL'), { target: { value: ' https://new-tts.example.test ' } });
    fireEvent.change(input('VIVO_TTS_APP_ID'), { target: { value: ' new-tts-app ' } });
    h.fetch.mockResolvedValueOnce(response({ success: true })).mockResolvedValueOnce(response(RESPONSE_CONFIG()));
    fireEvent.click(saveButton());
    await waitFor(() => expect(methods()).toEqual(['GET', 'POST', 'GET']));
    expect(lastPayload()).toEqual({
      translateBaseUrl: 'https://new-translate.example.test', translateAppId: 'new-translate-app',
      ttsUrl: 'https://new-tts.example.test', ttsAppId: 'new-tts-app',
    });
    const post = h.fetch.mock.calls[1][1] as RequestInit;
    expect(post.headers).toEqual({ 'x-test-auth': 'shared-headers', 'Content-Type': 'application/json' });
    await waitFor(() => expect(saveButton()).toBeEnabled());
    expect(keyInput()).toHaveValue('');
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it('accepts a new vivo key shorter than Android signing keys and blanks it after saving', async () => {
    render(<SelfContainedCDictUpstreamConfigSection />);
    await openLoaded();
    fireEvent.change(keyInput(), { target: { value: 'vivo-key' } });
    h.fetch.mockResolvedValueOnce(response({ success: true })).mockResolvedValueOnce(response(RESPONSE_CONFIG()));
    fireEvent.click(saveButton());
    await waitFor(() => expect(methods()).toEqual(['GET', 'POST', 'GET']));
    expect(lastPayload()).toEqual({ ...NON_SECRET, ttsAppKey: 'vivo-key' });
    await waitFor(() => expect(saveButton()).toBeEnabled());
    expect(keyInput()).toHaveValue('');
    expect(screen.getByText(/当前朗读密钥：已设置/)).toBeInTheDocument();
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('requires explicit confirmation for clearTtsAppKey, disables the new-key input, and sends no replacement', async () => {
    render(<SelfContainedCDictUpstreamConfigSection />);
    await openLoaded();
    fireEvent.change(keyInput(), { target: { value: 'unused-new-key' } });
    fireEvent.click(screen.getByRole('checkbox'));
    expect(keyInput()).toBeDisabled();
    h.confirm.mockResolvedValueOnce(false);
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveButton()).toBeEnabled());
    expect(methods()).toEqual(['GET']);
    expect(screen.getByRole('checkbox')).toBeChecked();
    expect(h.confirm).toHaveBeenCalledWith(expect.objectContaining({ tone: 'danger', title: '清除朗读密钥并停用在线朗读？' }));
    h.fetch.mockResolvedValueOnce(response({ success: true })).mockResolvedValueOnce(response(RESPONSE_CONFIG({ ttsAppKey: '', hasTtsAppKey: false })));
    fireEvent.click(saveButton());
    await waitFor(() => expect(methods()).toEqual(['GET', 'POST', 'GET']));
    expect(lastPayload()).toEqual({ ...NON_SECRET, clearTtsAppKey: true });
    await waitFor(() => expect(saveButton()).toBeEnabled());
    expect(screen.getByRole('checkbox')).not.toBeChecked();
    expect(keyInput()).toHaveValue('');
    expect(screen.getByText(/当前朗读密钥：未设置/)).toBeInTheDocument();
  });

  it('allows an admin to read but not edit, save, clear, or reset', async () => {
    h.role = 'admin';
    render(<SelfContainedCDictUpstreamConfigSection />);
    await openLoaded();
    for (const env of ['VIVO_TRANSLATE_BASE_URL', 'VIVO_TRANSLATE_APP_ID', 'VIVO_TTS_URL', 'VIVO_TTS_APP_ID', 'VIVO_TTS_APP_KEY']) {
      expect(input(env)).toBeDisabled();
    }
    expect(screen.getByRole('checkbox')).toBeDisabled();
    expect(saveButton()).toBeDisabled(); expect(resetButton()).toBeDisabled();
    fireEvent.click(saveButton()); fireEvent.click(resetButton());
    expect(methods()).toEqual(['GET']);
    expect(h.confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(methods()).toEqual(['GET', 'GET']));
  });

  it('blocks writes during initial loading and after an API load error until retry succeeds', async () => {
    const read = deferred<Response>();
    h.fetch.mockReturnValueOnce(read.promise);
    render(<SelfContainedCDictUpstreamConfigSection />);
    fireEvent.click(screen.getByRole('button', { name: '展开' }));
    expect(screen.getByRole('status')).toHaveTextContent('正在读取');
    expect(saveButton()).toBeDisabled(); expect(resetButton()).toBeDisabled();
    expect(keyInput()).toBeDisabled();
    await act(async () => read.resolve(response({ error: '读取被拒绝' }, false)));
    expect(await screen.findByRole('alert')).toHaveTextContent('读取被拒绝');
    expect(saveButton()).toBeDisabled(); expect(resetButton()).toBeDisabled();
    fireEvent.click(saveButton()); fireEvent.click(resetButton());
    expect(methods()).toEqual(['GET']);
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(saveButton()).toBeEnabled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it.each([
    { success: true, setting: { config: { translateAppId: 'partial' } } },
    { success: false, error: '读取失败' },
    null,
  ])('does not interpret an incomplete or unsuccessful read as editable defaults (%j)', async (data) => {
    h.fetch.mockResolvedValueOnce(response(data));
    render(<SelfContainedCDictUpstreamConfigSection />);
    fireEvent.click(screen.getByRole('button', { name: '展开' }));
    await screen.findByRole('alert');
    expect(saveButton()).toBeDisabled(); expect(resetButton()).toBeDisabled();
    expect(input('VIVO_TRANSLATE_APP_ID')).toHaveValue('');
  });

  it('confirms reset, preserves drafts on cancellation, and DELETE-refetches deploy defaults on acceptance', async () => {
    render(<SelfContainedCDictUpstreamConfigSection />);
    await openLoaded();
    fireEvent.change(input('VIVO_TTS_APP_ID'), { target: { value: 'unsaved-app' } });
    fireEvent.change(keyInput(), { target: { value: 'unsaved-key' } });
    h.confirm.mockResolvedValueOnce(false);
    fireEvent.click(resetButton());
    await waitFor(() => expect(resetButton()).toBeEnabled());
    expect(methods()).toEqual(['GET']);
    expect(input('VIVO_TTS_APP_ID')).toHaveValue('unsaved-app'); expect(keyInput()).toHaveValue('unsaved-key');
    expect(h.confirm).toHaveBeenCalledWith(expect.objectContaining({ tone: 'danger', description: expect.stringContaining('所有后台覆盖') }));
    h.fetch.mockResolvedValueOnce(response({ success: true })).mockResolvedValueOnce(response(RESPONSE_CONFIG({ ttsAppId: 'deploy-app' })));
    fireEvent.click(resetButton());
    await waitFor(() => expect(methods()).toEqual(['GET', 'DELETE', 'GET']));
    expect(h.fetch.mock.calls[1][1]).toEqual(expect.objectContaining({ method: 'DELETE', headers: { 'x-test-auth': 'shared-headers' } }));
    expect(h.fetch.mock.calls[1][1]).not.toHaveProperty('body');
    await waitFor(() => expect(input('VIVO_TTS_APP_ID')).toHaveValue('deploy-app'));
    expect(keyInput()).toHaveValue('');
    expect(screen.getByText(/当前朗读密钥：已设置/)).toBeInTheDocument();
  });

  it('shows save API errors without wiping the unsaved key or other inputs', async () => {
    render(<SelfContainedCDictUpstreamConfigSection />);
    await openLoaded();
    fireEvent.change(keyInput(), { target: { value: 'retry-key' } });
    fireEvent.change(input('VIVO_TTS_APP_ID'), { target: { value: 'retry-app' } });
    h.fetch.mockResolvedValueOnce(response({ success: false, error: '保存被拒绝' }, false));
    fireEvent.click(saveButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('保存被拒绝');
    expect(keyInput()).toHaveValue('retry-key'); expect(input('VIVO_TTS_APP_ID')).toHaveValue('retry-app');
    expect(methods()).toEqual(['GET', 'POST']);
    await waitFor(() => expect(saveButton()).toBeEnabled());
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('shows DELETE failures and keeps the draft instead of pretending defaults were restored', async () => {
    render(<SelfContainedCDictUpstreamConfigSection />);
    await openLoaded();
    fireEvent.change(keyInput(), { target: { value: 'keep-key' } });
    h.fetch.mockResolvedValueOnce(response({ success: false, error: '删除被拒绝' }, false));
    fireEvent.click(resetButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('删除被拒绝');
    expect(keyInput()).toHaveValue('keep-key');
    expect(methods()).toEqual(['GET', 'DELETE']);
    await waitFor(() => expect(resetButton()).toBeEnabled());
  });

  it('clears the key on successful saving even when refetch fails, and blocks further writes', async () => {
    render(<SelfContainedCDictUpstreamConfigSection />);
    await openLoaded();
    fireEvent.change(keyInput(), { target: { value: 'accepted-key' } });
    h.fetch.mockResolvedValueOnce(response({ success: true })).mockRejectedValueOnce(new Error('读回中断'));
    fireEvent.click(saveButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('读回中断');
    expect(keyInput()).toHaveValue(''); expect(saveButton()).toBeDisabled(); expect(resetButton()).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(saveButton()).toBeEnabled());
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it('does not save a copied masked placeholder', async () => {
    render(<SelfContainedCDictUpstreamConfigSection />);
    await openLoaded();
    fireEvent.change(keyInput(), { target: { value: CONFIG.ttsAppKey } });
    fireEvent.click(saveButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('不能保存脱敏占位内容');
    expect(methods()).toEqual(['GET']);
  });

  it('refresh cancellation preserves edits, then locks the draft while an accepted refresh owns its response', async () => {
    render(<SelfContainedCDictUpstreamConfigSection />);
    await openLoaded();
    fireEvent.change(input('VIVO_TTS_APP_ID'), { target: { value: 'draft-app' } });
    fireEvent.change(keyInput(), { target: { value: 'draft-key' } });
    h.confirm.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(saveButton()).toBeEnabled());
    expect(methods()).toEqual(['GET']);
    expect(input('VIVO_TTS_APP_ID')).toHaveValue('draft-app'); expect(keyInput()).toHaveValue('draft-key');
    const refresh = deferred<Response>();
    h.fetch.mockReturnValueOnce(refresh.promise);
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(methods()).toEqual(['GET', 'GET']));
    expect(saveButton()).toBeDisabled(); expect(resetButton()).toBeDisabled(); expect(keyInput()).toBeDisabled();
    fireEvent.change(keyInput(), { target: { value: 'late-key' } });
    expect(keyInput()).toHaveValue('draft-key');
    await act(async () => refresh.resolve(response(RESPONSE_CONFIG({ ttsAppId: 'refreshed-app' }))));
    await waitFor(() => expect(saveButton()).toBeEnabled());
    expect(input('VIVO_TTS_APP_ID')).toHaveValue('refreshed-app'); expect(keyInput()).toHaveValue('');
    fireEvent.change(keyInput(), { target: { value: 'newer-draft' } });
    expect(keyInput()).toHaveValue('newer-draft');
  });

  it('blocks concurrent actions and late edits throughout saving and its follow-up read', async () => {
    render(<SelfContainedCDictUpstreamConfigSection />); await openLoaded();
    fireEvent.change(keyInput(), { target: { value: 'submitted-key' } });
    const write = deferred<Response>(); const readback = deferred<Response>();
    h.fetch.mockReturnValueOnce(write.promise).mockReturnValueOnce(readback.promise);
    fireEvent.click(saveButton());
    expect(keyInput()).toBeDisabled(); expect(resetButton()).toBeDisabled();
    expect(screen.getByRole('button', { name: '刷新' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '保存中...' }));
    fireEvent.click(resetButton()); fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    expect(methods()).toEqual(['GET', 'POST']);
    await act(async () => write.resolve(response({ success: true })));
    await waitFor(() => expect(methods()).toEqual(['GET', 'POST', 'GET']));
    expect(keyInput()).toHaveValue(''); expect(keyInput()).toBeDisabled();
    fireEvent.change(keyInput(), { target: { value: 'late-key' } });
    expect(keyInput()).toHaveValue('');
    await act(async () => readback.resolve(response(RESPONSE_CONFIG())));
    await waitFor(() => expect(saveButton()).toBeEnabled());
    fireEvent.change(keyInput(), { target: { value: 'next-key' } });
    expect(keyInput()).toHaveValue('next-key');
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it('locks concurrent save/reset/refresh clicks while reset confirmation is pending', async () => {
    render(<SelfContainedCDictUpstreamConfigSection />);
    await openLoaded();
    const confirmation = deferred<boolean>();
    h.confirm.mockReturnValueOnce(confirmation.promise);
    fireEvent.click(resetButton());
    expect(saveButton()).toBeDisabled(); expect(screen.getByRole('button', { name: '刷新' })).toBeDisabled();
    fireEvent.click(saveButton()); fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    fireEvent.click(screen.getByRole('button', { name: '恢复中...' }));
    expect(h.confirm).toHaveBeenCalledTimes(1); expect(methods()).toEqual(['GET']);
    await act(async () => confirmation.resolve(false));
    await waitFor(() => expect(saveButton()).toBeEnabled());
  });

  it('does not write after role downgrade during a pending confirmation', async () => {
    const view = render(<SelfContainedCDictUpstreamConfigSection />);
    await openLoaded();
    const confirmation = deferred<boolean>();
    h.confirm.mockReturnValueOnce(confirmation.promise);
    fireEvent.click(resetButton());
    h.role = 'admin'; view.rerender(<SelfContainedCDictUpstreamConfigSection />);
    await act(async () => confirmation.resolve(true));
    await waitFor(() => expect(resetButton()).toBeDisabled());
    expect(methods()).toEqual(['GET']);
  });

  it('aborts an unmounted read and does not let its stale response overwrite a later instance draft', async () => {
    const oldRead = deferred<Response>();
    h.fetch.mockReturnValueOnce(oldRead.promise);
    const old = render(<SelfContainedCDictUpstreamConfigSection />);
    fireEvent.click(screen.getByRole('button', { name: '展开' }));
    const signal = (h.fetch.mock.calls[0][1] as RequestInit).signal!;
    old.unmount(); expect(signal.aborted).toBe(true);
    render(<SelfContainedCDictUpstreamConfigSection />); await openLoaded();
    fireEvent.change(keyInput(), { target: { value: 'new-instance-key' } });
    await act(async () => oldRead.resolve(response(RESPONSE_CONFIG({ ttsAppId: 'stale-app' }))));
    expect(input('VIVO_TTS_APP_ID')).toHaveValue(CONFIG.ttsAppId); expect(keyInput()).toHaveValue('new-instance-key');
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('does not proceed with reset or notify after unmount during confirmation', async () => {
    const view = render(<SelfContainedCDictUpstreamConfigSection />); await openLoaded();
    const confirmation = deferred<boolean>(); h.confirm.mockReturnValueOnce(confirmation.promise);
    fireEvent.click(resetButton()); view.unmount();
    await act(async () => confirmation.resolve(true));
    expect(methods()).toEqual(['GET']); expect(h.notify).not.toHaveBeenCalled();
  });

  it('keeps credentials out of browser storage throughout read, editing, and save', async () => {
    const writeStorage = vi.spyOn(Storage.prototype, 'setItem');
    const readStorage = vi.spyOn(Storage.prototype, 'getItem');
    const view = render(<SelfContainedCDictUpstreamConfigSection />); await openLoaded();
    fireEvent.change(keyInput(), { target: { value: 'ephemeral-key' } });
    h.fetch.mockResolvedValueOnce(response({ success: true })).mockResolvedValueOnce(response(RESPONSE_CONFIG()));
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveButton()).toBeEnabled());
    view.unmount();
    expect(writeStorage).not.toHaveBeenCalled(); expect(readStorage).not.toHaveBeenCalled();
  });
});
