import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ fetch: vi.fn(), notify: vi.fn(), config: vi.fn(), jobs: vi.fn(), detail: vi.fn(), upload: vi.fn(), create: vi.fn() }));
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { role: 'superadmin' } }) }));
vi.mock('../components/Notification', () => ({ useNotification: () => ({ setNotification: h.notify }) }));
vi.mock('../api', () => ({ default: () => 'https://synapse.example' }));
vi.mock('../components/env-manager/api', () => ({ REGISTRATION_INVITE_API: '/invite-setting', authFetch: h.fetch, getAuthHeaders: () => ({}) }));
vi.mock('../api/transcribe', () => ({
  OUTPUT_LABELS: { plain: '纯文本', timed: '时间线', srt: '字幕' },
  transcribeApi: { config: h.config, listJobs: h.jobs, getJob: h.detail, upload: h.upload, createJob: h.create },
}));
vi.mock('../components/speech-to-text/TranscriptView', () => ({ default: ({ item }: { item: { text: string } }) => <div>{item.text}</div> }));

import SelfContainedRegistrationInviteConfigSection from '../components/env-manager/SelfContainedRegistrationInviteConfigSection';
import SpeechToTextPage from '../components/speech-to-text/SpeechToTextPage';
import TicketComposer from '../components/ticket/TicketComposer';
import { ConfirmDialogProvider, useConfirm } from '../components/confirm/ConfirmDialogProvider';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  h.config.mockResolvedValue({ enabled: true, limits: { defaultOutputs: ['plain'], acceptedExts: ['.wav'], maxFilesPerJob: 5, maxActiveJobs: 2, activeJobs: 0 } });
  h.jobs.mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('audit feature state boundaries', () => {
  it('blocks invite config writes after failed reading and allows a successful retry', async () => {
    h.fetch.mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'Offline' }) });
    render(<SelfContainedRegistrationInviteConfigSection />);
    fireEvent.click(screen.getByRole('button', { name: '展开' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: '保存' })).toBeDisabled();
    expect(screen.getByText(/当前状态：尚未读取/)).toBeInTheDocument();
    h.fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ setting: { config: { required: true } } }) });
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '保存' })).toBeEnabled());
    expect(screen.getByRole('checkbox')).toBeChecked();
  });

  it('retains all pending uploads until they can be submitted together and resets the file input', async () => {
    const second = deferred<{ rel: string }>();
    h.upload.mockResolvedValueOnce({ rel: 'first.wav' }).mockReturnValueOnce(second.promise);
    const { container } = render(<SpeechToTextPage />);
    await waitFor(() => expect(h.config).toHaveBeenCalled());
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(['a'], 'first.wav'), new File(['b'], 'second.wav')] } });
    await waitFor(() => expect(h.upload).toHaveBeenCalledTimes(2));
    expect(input.value).toBe('');
    expect(screen.getByRole('button', { name: '开始转写' })).toBeDisabled();
    expect(h.create).not.toHaveBeenCalled();
    await act(async () => { second.resolve({ rel: 'second.wav' }); });
    await waitFor(() => expect(screen.getByRole('button', { name: '开始转写' })).toBeEnabled());
    h.create.mockResolvedValue({ id: 'created' });
    fireEvent.click(screen.getByRole('button', { name: '开始转写' }));
    await waitFor(() => expect(h.create).toHaveBeenCalledWith(['first.wav', 'second.wav'], ['plain']));
  });

  it('reloads an empty running result after the job reaches completion', async () => {
    const job = { id: 'job-1', status: 'running', stage: 'run', progress: 1, createdAt: new Date().toISOString(), input: { values: ['x.wav'] } };
    h.jobs.mockResolvedValueOnce([job]).mockResolvedValue([{ ...job, status: 'succeeded' }]);
    h.detail.mockResolvedValueOnce({ transcripts: [] }).mockResolvedValue({ transcripts: [{ index: 0, text: 'Completed transcript', files: {} }] });
    render(<SpeechToTextPage />);
    fireEvent.click(await screen.findByRole('button', { name: /转写中/ }));
    await waitFor(() => expect(h.detail).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText('Completed transcript')).toBeInTheDocument(), { timeout: 4500 });
  });

  it('flushes the last draft on immediate unmount and does not resurrect sent text', async () => {
    const props = { draftKey: 'ticket-a', isAdmin: false, canWriteInternal: false, onSend: vi.fn().mockResolvedValue(true) };
    const first = render(<TicketComposer {...props} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Last typed words' } });
    first.unmount();
    expect(JSON.parse(localStorage.getItem('synapse:ticket-draft:ticket-a')!).content).toBe('Last typed words');
    const second = render(<TicketComposer {...props} />);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(props.onSend).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole('textbox')).toHaveValue(''));
    second.unmount();
    expect(localStorage.getItem('synapse:ticket-draft:ticket-a')).toBeNull();
  });

  it('wraps confirmation focus and returns it to the trigger on Escape', async () => {
    const Trigger = () => {
      const confirm = useConfirm();
      return <button onClick={() => void confirm({ title: 'Delete data?', tone: 'danger' })}>Open confirmation</button>;
    };
    render(<ConfirmDialogProvider><Trigger /><button>Background</button></ConfirmDialogProvider>);
    const trigger = screen.getByRole('button', { name: 'Open confirmation' });
    trigger.focus();
    fireEvent.click(trigger);
    const cancel = screen.getByRole('button', { name: '取消' });
    await waitFor(() => expect(cancel).toHaveFocus());
    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true });
    expect(screen.getByRole('button', { name: '确认执行' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: 'Escape' });
    expect(trigger).toHaveFocus();
  });
});
